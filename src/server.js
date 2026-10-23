import net from "node:net";
import { RequestParser, ProtocolError, encode, error, OK, QUEUED } from "./resp.js";
import { Store, globToRegExp } from "./store.js";
import { lookup, execute, isPubSubAllowed, isImmediate, NO_REPLY } from "./commands.js";
import { saveSnapshot, loadSnapshot } from "./persistence.js";

export const VERSION = "1.0.0";

const ACTIVE_EXPIRE_INTERVAL_MS = 100;

/**
 * Create an emberkv server.
 *
 * @param {object}  [options]
 * @param {number}  [options.port=6379]          0 picks a free port
 * @param {string}  [options.host="127.0.0.1"]
 * @param {string}  [options.dbFile]             snapshot path; omit to run purely in memory
 * @param {number}  [options.saveIntervalMs=60000] how often to check for changes to save
 * @param {() => number} [options.now]           clock, injectable for tests
 * @param {(msg: string) => void} [options.log]
 */
export function createServer({
  port = 6379,
  host = "127.0.0.1",
  dbFile = null,
  saveIntervalMs = 60_000,
  now = Date.now,
  log = () => {},
} = {}) {
  const store = new Store({ now });
  const clients = new Set();
  const channels = new Map(); // channel -> Set<client>
  const patterns = new Map(); // pattern -> { re, clients: Set<client> }
  const startedAt = Date.now();
  let lastSave = Date.now();
  let totalConnections = 0;
  let totalCommands = 0;
  let nextClientId = 1;
  let timers = [];

  if (dbFile) {
    const n = loadSnapshot(store, dbFile);
    if (n) log(`loaded ${n} keys from ${dbFile}`);
  }

  // ---------- server-level operations used by commands ----------

  const serverApi = {
    stats: () => ({
      version: VERSION,
      port: tcp.address()?.port,
      uptimeMs: Date.now() - startedAt,
      clients: clients.size,
      totalConnections,
      totalCommands,
      lastSave,
      pubsubChannels: channels.size,
    }),

    save() {
      if (!dbFile) return;
      const n = saveSnapshot(store, dbFile);
      lastSave = Date.now();
      log(`saved ${n} keys to ${dbFile}`);
    },

    subscribe(client, names, isPattern) {
      for (const name of names) {
        if (isPattern) {
          if (!patterns.has(name)) patterns.set(name, { re: globToRegExp(name), clients: new Set() });
          patterns.get(name).clients.add(client);
          client.patterns.add(name);
        } else {
          if (!channels.has(name)) channels.set(name, new Set());
          channels.get(name).add(client);
          client.subscriptions.add(name);
        }
        client.push([isPattern ? "psubscribe" : "subscribe", name, subscriptionCount(client)]);
      }
      return NO_REPLY;
    },

    unsubscribe(client, names, isPattern) {
      const kind = isPattern ? "punsubscribe" : "unsubscribe";
      const own = isPattern ? client.patterns : client.subscriptions;
      const targets = names.length ? names : [...own];
      if (targets.length === 0) {
        client.push([kind, null, subscriptionCount(client)]);
        return NO_REPLY;
      }
      for (const name of targets) {
        removeSubscription(client, name, isPattern);
        client.push([kind, name, subscriptionCount(client)]);
      }
      return NO_REPLY;
    },

    publish(channel, message) {
      let receivers = 0;
      for (const c of channels.get(channel) ?? []) {
        c.push(["message", channel, message]);
        receivers++;
      }
      for (const [pattern, { re, clients: subs }] of patterns) {
        if (!re.test(channel)) continue;
        for (const c of subs) {
          c.push(["pmessage", pattern, channel, message]);
          receivers++;
        }
      }
      return receivers;
    },
  };

  function subscriptionCount(client) {
    return client.subscriptions.size + client.patterns.size;
  }

  function removeSubscription(client, name, isPattern) {
    if (isPattern) {
      client.patterns.delete(name);
      const entry = patterns.get(name);
      entry?.clients.delete(client);
      if (entry && entry.clients.size === 0) patterns.delete(name);
    } else {
      client.subscriptions.delete(name);
      const subs = channels.get(name);
      subs?.delete(client);
      if (subs && subs.size === 0) channels.delete(name);
    }
  }

  // ---------- per-command dispatch ----------

  function dispatch(client, args) {
    totalCommands++;
    const ctx = { store, server: serverApi, client };
    const found = lookup(args);

    if (found.error) {
      if (client.multi) client.multi.dirty = true;
      return found.error;
    }
    const { name, spec } = found;

    if (subscriptionCount(client) > 0 && !isPubSubAllowed(spec)) {
      return error(`ERR Can't execute '${name}': only (P)SUBSCRIBE / (P)UNSUBSCRIBE / PING / QUIT are allowed in this context`);
    }

    switch (name) {
      case "multi":
        if (client.multi) return error("ERR MULTI calls can not be nested");
        client.multi = { queue: [], dirty: false };
        return OK;
      case "discard":
        if (!client.multi) return error("ERR DISCARD without MULTI");
        client.multi = null;
        return OK;
      case "exec": {
        if (!client.multi) return error("ERR EXEC without MULTI");
        const { queue, dirty } = client.multi;
        client.multi = null;
        if (dirty) return error("EXECABORT Transaction discarded because of previous errors.");
        // Node is single-threaded, so running the queue synchronously makes it atomic.
        return queue.map(({ name: n, spec: s, args: a }) => execute(ctx, n, s, a));
      }
    }

    if (client.multi) {
      if (isImmediate(spec)) return error(`ERR Command not allowed inside a transaction`);
      client.multi.queue.push({ name, spec, args: args.slice(1) });
      return QUEUED;
    }

    return execute(ctx, name, spec, args.slice(1));
  }

  // ---------- connections ----------

  const tcp = net.createServer((socket) => {
    totalConnections++;
    socket.setNoDelay(true);

    const parser = new RequestParser();
    const client = {
      id: nextClientId++,
      name: "",
      socket,
      subscriptions: new Set(),
      patterns: new Set(),
      multi: null,
      closeAfterReply: false,
      out: [],
      flushScheduled: false,
      // Replies are batched and flushed once per tick, so a pipelined burst
      // of commands becomes a single socket write.
      push(value) {
        this.out.push(encode(value));
        if (!this.flushScheduled) {
          this.flushScheduled = true;
          queueMicrotask(() => this.flush());
        }
      },
      flush() {
        this.flushScheduled = false;
        if (this.out.length === 0 || socket.destroyed) return;
        socket.write(this.out.join(""), "latin1");
        this.out = [];
        if (this.closeAfterReply) socket.end();
      },
    };
    clients.add(client);

    socket.on("data", (chunk) => {
      let commands;
      try {
        commands = parser.feed(chunk);
      } catch (e) {
        if (!(e instanceof ProtocolError)) throw e;
        client.push(error(`ERR Protocol error: ${e.message}`));
        client.closeAfterReply = true;
        return;
      }
      for (const args of commands) {
        if (client.closeAfterReply) break;
        let reply;
        try {
          reply = dispatch(client, args);
        } catch (e) {
          log(`internal error: ${e.stack}`);
          reply = error("ERR internal server error");
        }
        if (reply !== NO_REPLY) client.push(reply);
      }
    });

    const cleanup = () => {
      if (!clients.delete(client)) return;
      for (const ch of [...client.subscriptions]) removeSubscription(client, ch, false);
      for (const p of [...client.patterns]) removeSubscription(client, p, true);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  return {
    store,

    /** Start listening. Resolves with the bound port. */
    listen() {
      return new Promise((resolve, reject) => {
        tcp.once("error", reject);
        tcp.listen(port, host, () => {
          tcp.off("error", reject);
          const expire = setInterval(() => store.activeExpireCycle(), ACTIVE_EXPIRE_INTERVAL_MS);
          const save = setInterval(() => { if (store.dirty > 0) serverApi.save(); }, saveIntervalMs);
          timers = [expire, save];
          timers.forEach((t) => t.unref());
          resolve(tcp.address().port);
        });
      });
    },

    /** Stop accepting connections, drop clients and write a final snapshot. */
    close() {
      timers.forEach(clearInterval);
      for (const c of clients) c.socket.destroy();
      if (store.dirty > 0) serverApi.save();
      return new Promise((resolve) => tcp.close(() => resolve()));
    },

    save: () => serverApi.save(),
  };
}
