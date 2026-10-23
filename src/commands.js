// Command table. Each command declares its arity the way Redis does:
// a positive number is an exact argument count (including the command name),
// a negative number is a minimum. Handlers receive (ctx, args) where args
// excludes the command name, and return a reply value for resp.encode().

import { OK, PONG, simple, error } from "./resp.js";
import { globToRegExp, WrongTypeError } from "./store.js";
import { Deque } from "./deque.js";

/** Returned by handlers that write their own replies (e.g. SUBSCRIBE sends one per channel). */
export const NO_REPLY = Symbol("no-reply");

const ERR_INT = "ERR value is not an integer or out of range";
const ERR_SYNTAX = "ERR syntax error";

class CommandError extends Error {}
const fail = (msg) => { throw new CommandError(msg); };

function int(s) {
  if (!/^-?\d+$/.test(s)) fail(ERR_INT);
  const n = Number(s);
  if (!Number.isSafeInteger(n)) fail(ERR_INT);
  return n;
}

function positiveTimeout(n, cmd) {
  if (n <= 0) fail(`ERR invalid expire time in '${cmd}' command`);
  return n;
}

/** Redis list indexes may be negative (from the end). Clamp to [0, len]. */
function normalizeRange(start, stop, len) {
  if (start < 0) start = Math.max(0, len + start);
  if (stop < 0) stop = len + stop;
  stop = Math.min(stop, len - 1);
  return [start, stop];
}

// ---------- strings ----------

function incrBy(ctx, key, delta) {
  const current = ctx.store.get(key, "string");
  const n = current === undefined ? 0 : int(current);
  const next = n + delta;
  if (!Number.isSafeInteger(next)) fail("ERR increment or decrement would overflow");
  ctx.store.set(key, "string", String(next), { keepTtl: true });
  return next;
}

function set(ctx, [key, value, ...opts]) {
  let nx = false, xx = false, get = false, keepTtl = false, deadline;
  for (let i = 0; i < opts.length; i++) {
    const opt = opts[i].toUpperCase();
    if (opt === "NX") nx = true;
    else if (opt === "XX") xx = true;
    else if (opt === "GET") get = true;
    else if (opt === "KEEPTTL") keepTtl = true;
    else if (["EX", "PX", "EXAT", "PXAT"].includes(opt) && i + 1 < opts.length && deadline === undefined) {
      const n = positiveTimeout(int(opts[++i]), "set");
      deadline = { EX: ctx.store.now() + n * 1000, PX: ctx.store.now() + n, EXAT: n * 1000, PXAT: n }[opt];
    } else fail(ERR_SYNTAX);
  }
  if ((nx && xx) || (keepTtl && deadline !== undefined)) fail(ERR_SYNTAX);

  const previous = get ? ctx.store.get(key, "string") : undefined;
  const exists = ctx.store.has(key);
  if ((nx && exists) || (xx && !exists)) return get ? previous ?? null : null;

  ctx.store.set(key, "string", value, { keepTtl });
  if (deadline !== undefined) ctx.store.expireAt(key, deadline);
  return get ? previous ?? null : OK;
}

// ---------- lists ----------

function push(ctx, key, values, left, onlyIfExists = false) {
  if (onlyIfExists && !ctx.store.has(key)) {
    ctx.store.get(key, "list"); // still raise WRONGTYPE for non-lists
    return 0;
  }
  const list = ctx.store.getOrCreate(key, "list", () => new Deque());
  for (const v of values) left ? list.unshift(v) : list.push(v);
  ctx.store.touch();
  return list.length;
}

function pop(ctx, [key, count], left) {
  const list = ctx.store.get(key, "list");
  const n = count === undefined ? null : int(count);
  if (n !== null && n < 0) fail("ERR value is out of range, must be positive");
  if (list === undefined) return null;

  const take = n ?? 1;
  const items = [];
  while (items.length < take && list.length > 0) items.push(left ? list.shift() : list.pop());
  ctx.store.deleteIfEmpty(key, list.length);
  ctx.store.touch();
  return n === null ? items[0] ?? null : items;
}

// ---------- hashes ----------

function hash(ctx, key) {
  return ctx.store.get(key, "hash");
}

// ---------- keyspace ----------

function expire(ctx, [key, amount, ...flags], toDeadline) {
  const n = int(amount);
  const deadline = toDeadline(n, ctx.store.now());
  const flag = flags[0]?.toUpperCase();
  if (flags.length > 1 || (flag && !["NX", "XX", "GT", "LT"].includes(flag))) fail(ERR_SYNTAX);
  if (!ctx.store.has(key)) return 0;

  const current = ctx.store.ttl(key); // -1 = no ttl
  const currentDeadline = current === -1 ? Infinity : ctx.store.now() + current;
  if (flag === "NX" && current !== -1) return 0;
  if (flag === "XX" && current === -1) return 0;
  if (flag === "GT" && !(deadline > currentDeadline)) return 0;
  if (flag === "LT" && !(deadline < currentDeadline)) return 0;
  return ctx.store.expireAt(key, deadline) ? 1 : 0;
}

function ttl(ctx, key, divisor) {
  const ms = ctx.store.ttl(key);
  return ms < 0 ? ms : Math.round(ms / divisor);
}

function scan(ctx, [cursor, ...opts]) {
  let start = int(cursor);
  let match = null, count = 10, type = null;
  for (let i = 0; i < opts.length; i += 2) {
    const opt = opts[i].toUpperCase();
    const val = opts[i + 1];
    if (val === undefined) fail(ERR_SYNTAX);
    if (opt === "MATCH") match = globToRegExp(val);
    else if (opt === "COUNT") count = Math.max(1, int(val));
    else if (opt === "TYPE") type = val.toLowerCase();
    else fail(ERR_SYNTAX);
  }
  // Keys are walked in sorted order, so a numeric cursor is stable between calls.
  const keys = ctx.store.keys().sort();
  const page = keys.slice(start, start + count);
  const next = start + count >= keys.length ? 0 : start + count;
  const filtered = page.filter((k) => (!match || match.test(k)) && (!type || ctx.store.type(k) === type));
  return [String(next), filtered];
}

// ---------- server ----------

function info(ctx) {
  const s = ctx.server.stats();
  const sections = {
    Server: {
      redis_version: "7.0.0",
      emberkv_version: s.version,
      process_id: process.pid,
      tcp_port: s.port,
      uptime_in_seconds: Math.floor(s.uptimeMs / 1000),
    },
    Clients: { connected_clients: s.clients },
    Memory: { used_memory: process.memoryUsage().heapUsed },
    Persistence: {
      rdb_changes_since_last_save: ctx.store.dirty,
      rdb_last_save_time: Math.floor(s.lastSave / 1000),
    },
    Stats: {
      total_connections_received: s.totalConnections,
      total_commands_processed: s.totalCommands,
      expired_keys: ctx.store.stats.expiredKeys,
      keyspace_hits: ctx.store.stats.hits,
      keyspace_misses: ctx.store.stats.misses,
      pubsub_channels: s.pubsubChannels,
    },
    Keyspace: { db0: `keys=${ctx.store.size()},expires=${ctx.store.expires.size}` },
  };
  return Object.entries(sections)
    .map(([name, fields]) => `# ${name}\r\n${Object.entries(fields).map(([k, v]) => `${k}:${v}`).join("\r\n")}`)
    .join("\r\n\r\n") + "\r\n";
}

// Read-only view of settings that tools like redis-benchmark probe on startup.
const CONFIG = { save: "60 1", appendonly: "no", databases: "1" };

// ---------- table ----------

const W = "write";
const R = "readonly";
const PUBSUB = "pubsub";   // allowed while subscribed
const NOMULTI = "nomulti"; // executed immediately, never queued

export const commands = {
  // connection
  ping:     { arity: -1, flags: [PUBSUB], run: (ctx, [msg]) => (ctx.client.subscriptions.size ? ["pong", msg ?? ""] : msg ?? PONG) },
  echo:     { arity: 2, run: (_, [msg]) => msg },
  select:   { arity: 2, run: (_, [db]) => (int(db) === 0 ? OK : fail("ERR DB index is out of range")) },
  quit:     { arity: -1, flags: [PUBSUB], run: (ctx) => { ctx.client.closeAfterReply = true; return OK; } },
  hello:    { arity: -1, run: (_, [ver]) => (ver && ver !== "2" ? fail("NOPROTO unsupported protocol version") : ["server", "emberkv", "version", "7.0.0", "proto", 2, "mode", "standalone", "role", "master"]) },
  client:   { arity: -2, run: (ctx, [sub, name]) => {
    switch (sub.toUpperCase()) {
      case "SETNAME": ctx.client.name = name ?? ""; return OK;
      case "GETNAME": return ctx.client.name || null;
      case "ID": return ctx.client.id;
      case "SETINFO": return OK;
      default: return fail(`ERR unknown subcommand '${sub}'`);
    }
  } },
  command:  { arity: -1, run: (_, [sub]) => (sub?.toUpperCase() === "COUNT" ? Object.keys(commands).length : []) },
  // Tools like redis-benchmark probe CONFIG GET on startup; there are no tunables to report.
  config:   { arity: -2, run: (_, [sub, ...params]) => {
    if (sub.toUpperCase() !== "GET") fail(`ERR CONFIG ${sub} is not supported`);
    const res = params.map(globToRegExp);
    return Object.entries(CONFIG).filter(([k]) => res.some((re) => re.test(k))).flat();
  } },

  // strings
  get:      { arity: 2, flags: [R], run: (ctx, [key]) => ctx.store.get(key, "string") ?? null },
  set:      { arity: -3, flags: [W], run: set },
  setnx:    { arity: 3, flags: [W], run: (ctx, [k, v]) => (ctx.store.has(k) ? 0 : (ctx.store.set(k, "string", v), 1)) },
  setex:    { arity: 4, flags: [W], run: (ctx, [k, s, v]) => set(ctx, [k, v, "EX", s]) },
  psetex:   { arity: 4, flags: [W], run: (ctx, [k, ms, v]) => set(ctx, [k, v, "PX", ms]) },
  getset:   { arity: 3, flags: [W], run: (ctx, [k, v]) => set(ctx, [k, v, "GET"]) },
  getdel:   { arity: 2, flags: [W], run: (ctx, [k]) => { const v = ctx.store.get(k, "string"); if (v !== undefined) ctx.store.delete(k); return v ?? null; } },
  mget:     { arity: -2, flags: [R], run: (ctx, keys) => keys.map((k) => { const e = ctx.store.entry(k); return e?.type === "string" ? e.value : null; }) },
  mset:     { arity: -3, flags: [W], run: (ctx, args) => {
    if (args.length % 2) fail("ERR wrong number of arguments for 'mset' command");
    for (let i = 0; i < args.length; i += 2) ctx.store.set(args[i], "string", args[i + 1]);
    return OK;
  } },
  append:   { arity: 3, flags: [W], run: (ctx, [k, v]) => { const next = (ctx.store.get(k, "string") ?? "") + v; ctx.store.set(k, "string", next, { keepTtl: true }); return next.length; } },
  strlen:   { arity: 2, flags: [R], run: (ctx, [k]) => (ctx.store.get(k, "string") ?? "").length },
  getrange: { arity: 4, flags: [R], run: (ctx, [k, s, e]) => {
    const v = ctx.store.get(k, "string") ?? "";
    const [start, stop] = normalizeRange(int(s), int(e), v.length);
    return start > stop ? "" : v.slice(start, stop + 1);
  } },
  incr:     { arity: 2, flags: [W], run: (ctx, [k]) => incrBy(ctx, k, 1) },
  decr:     { arity: 2, flags: [W], run: (ctx, [k]) => incrBy(ctx, k, -1) },
  incrby:   { arity: 3, flags: [W], run: (ctx, [k, n]) => incrBy(ctx, k, int(n)) },
  decrby:   { arity: 3, flags: [W], run: (ctx, [k, n]) => incrBy(ctx, k, -int(n)) },

  // lists
  lpush:    { arity: -3, flags: [W], run: (ctx, [k, ...v]) => push(ctx, k, v, true) },
  rpush:    { arity: -3, flags: [W], run: (ctx, [k, ...v]) => push(ctx, k, v, false) },
  lpushx:   { arity: -3, flags: [W], run: (ctx, [k, ...v]) => push(ctx, k, v, true, true) },
  rpushx:   { arity: -3, flags: [W], run: (ctx, [k, ...v]) => push(ctx, k, v, false, true) },
  lpop:     { arity: -2, flags: [W], run: (ctx, args) => pop(ctx, args, true) },
  rpop:     { arity: -2, flags: [W], run: (ctx, args) => pop(ctx, args, false) },
  llen:     { arity: 2, flags: [R], run: (ctx, [k]) => ctx.store.get(k, "list")?.length ?? 0 },
  lindex:   { arity: 3, flags: [R], run: (ctx, [k, i]) => { return ctx.store.get(k, "list")?.at(int(i)) ?? null; } },
  lrange:   { arity: 4, flags: [R], run: (ctx, [k, s, e]) => {
    const l = ctx.store.get(k, "list") ?? new Deque();
    const [start, stop] = normalizeRange(int(s), int(e), l.length);
    return start > stop ? [] : l.slice(start, stop + 1);
  } },
  lset:     { arity: 4, flags: [W], run: (ctx, [k, i, v]) => {
    const l = ctx.store.get(k, "list");
    if (!l) fail("ERR no such key");
    let n = int(i);
    if (n < 0) n += l.length;
    if (n < 0 || n >= l.length) fail("ERR index out of range");
    l.set(n, v);
    ctx.store.touch();
    return OK;
  } },
  ltrim:    { arity: 4, flags: [W], run: (ctx, [k, s, e]) => {
    const l = ctx.store.get(k, "list");
    if (!l) return OK;
    const [start, stop] = normalizeRange(int(s), int(e), l.length);
    const kept = start > stop ? [] : l.slice(start, stop + 1);
    l.replace(kept);
    ctx.store.deleteIfEmpty(k, l.length);
    ctx.store.touch();
    return OK;
  } },
  lrem:     { arity: 4, flags: [W], run: (ctx, [k, c, v]) => {
    const l = ctx.store.get(k, "list");
    if (!l) return 0;
    const count = int(c);
    let removed = 0;
    const limit = count === 0 ? Infinity : Math.abs(count);
    const items = l.toArray();
    const indexes = [...items.keys()];
    if (count < 0) indexes.reverse();
    const drop = new Set();
    for (const i of indexes) {
      if (removed >= limit) break;
      if (items[i] === v) { drop.add(i); removed++; }
    }
    if (removed) l.replace(items.filter((_, i) => !drop.has(i)));
    ctx.store.deleteIfEmpty(k, l.length);
    if (removed) ctx.store.touch();
    return removed;
  } },

  // hashes
  hset:     { arity: -4, flags: [W], run: (ctx, [k, ...pairs]) => {
    if (pairs.length % 2) fail("ERR wrong number of arguments for 'hset' command");
    const h = ctx.store.getOrCreate(k, "hash", () => new Map());
    let added = 0;
    for (let i = 0; i < pairs.length; i += 2) {
      if (!h.has(pairs[i])) added++;
      h.set(pairs[i], pairs[i + 1]);
    }
    ctx.store.touch();
    return added;
  } },
  hsetnx:   { arity: 4, flags: [W], run: (ctx, [k, f, v]) => {
    const h = ctx.store.getOrCreate(k, "hash", () => new Map());
    if (h.has(f)) return 0;
    h.set(f, v);
    ctx.store.touch();
    return 1;
  } },
  hget:     { arity: 3, flags: [R], run: (ctx, [k, f]) => hash(ctx, k)?.get(f) ?? null },
  hmget:    { arity: -3, flags: [R], run: (ctx, [k, ...fs]) => { const h = hash(ctx, k); return fs.map((f) => h?.get(f) ?? null); } },
  hdel:     { arity: -3, flags: [W], run: (ctx, [k, ...fs]) => {
    const h = hash(ctx, k);
    if (!h) return 0;
    const removed = fs.filter((f) => h.delete(f)).length;
    ctx.store.deleteIfEmpty(k, h.size);
    if (removed) ctx.store.touch();
    return removed;
  } },
  hgetall:  { arity: 2, flags: [R], run: (ctx, [k]) => [...(hash(ctx, k) ?? [])].flat() },
  hkeys:    { arity: 2, flags: [R], run: (ctx, [k]) => [...(hash(ctx, k)?.keys() ?? [])] },
  hvals:    { arity: 2, flags: [R], run: (ctx, [k]) => [...(hash(ctx, k)?.values() ?? [])] },
  hlen:     { arity: 2, flags: [R], run: (ctx, [k]) => hash(ctx, k)?.size ?? 0 },
  hexists:  { arity: 3, flags: [R], run: (ctx, [k, f]) => (hash(ctx, k)?.has(f) ? 1 : 0) },
  hincrby:  { arity: 4, flags: [W], run: (ctx, [k, f, n]) => {
    const delta = int(n);
    const h = ctx.store.getOrCreate(k, "hash", () => new Map());
    const current = h.has(f) ? h.get(f) : "0";
    if (!/^-?\d+$/.test(current)) fail("ERR hash value is not an integer");
    const next = Number(current) + delta;
    if (!Number.isSafeInteger(next)) fail("ERR increment or decrement would overflow");
    h.set(f, String(next));
    ctx.store.touch();
    return next;
  } },

  // keyspace
  del:      { arity: -2, flags: [W], run: (ctx, keys) => keys.filter((k) => ctx.store.delete(k)).length },
  unlink:   { arity: -2, flags: [W], run: (ctx, keys) => keys.filter((k) => ctx.store.delete(k)).length },
  exists:   { arity: -2, flags: [R], run: (ctx, keys) => keys.filter((k) => ctx.store.has(k)).length },
  type:     { arity: 2, flags: [R], run: (ctx, [k]) => simple(ctx.store.type(k)) },
  rename:   { arity: 3, flags: [W], run: (ctx, [from, to]) => {
    const e = ctx.store.entry(from);
    if (!e) fail("ERR no such key");
    const deadline = ctx.store.expires.get(from);
    ctx.store.delete(from);
    ctx.store.set(to, e.type, e.value);
    if (deadline !== undefined) ctx.store.expireAt(to, deadline);
    return OK;
  } },
  keys:     { arity: 2, flags: [R], run: (ctx, [pattern]) => { const re = globToRegExp(pattern); return ctx.store.keys().filter((k) => re.test(k)); } },
  scan:     { arity: -2, flags: [R], run: scan },
  randomkey:{ arity: 1, flags: [R], run: (ctx) => ctx.store.randomKey() },
  dbsize:   { arity: 1, flags: [R], run: (ctx) => ctx.store.size() },
  flushdb:  { arity: -1, flags: [W], run: (ctx) => { ctx.store.flush(); return OK; } },
  flushall: { arity: -1, flags: [W], run: (ctx) => { ctx.store.flush(); return OK; } },
  expire:   { arity: -3, flags: [W], run: (ctx, a) => expire(ctx, a, (n, now) => now + n * 1000) },
  pexpire:  { arity: -3, flags: [W], run: (ctx, a) => expire(ctx, a, (n, now) => now + n) },
  expireat: { arity: -3, flags: [W], run: (ctx, a) => expire(ctx, a, (n) => n * 1000) },
  pexpireat:{ arity: -3, flags: [W], run: (ctx, a) => expire(ctx, a, (n) => n) },
  ttl:      { arity: 2, flags: [R], run: (ctx, [k]) => ttl(ctx, k, 1000) },
  pttl:     { arity: 2, flags: [R], run: (ctx, [k]) => ttl(ctx, k, 1) },
  persist:  { arity: 2, flags: [W], run: (ctx, [k]) => (ctx.store.persist(k) ? 1 : 0) },

  // pub/sub
  subscribe:    { arity: -2, flags: [PUBSUB, NOMULTI], run: (ctx, channels) => ctx.server.subscribe(ctx.client, channels, false) },
  psubscribe:   { arity: -2, flags: [PUBSUB, NOMULTI], run: (ctx, patterns) => ctx.server.subscribe(ctx.client, patterns, true) },
  unsubscribe:  { arity: -1, flags: [PUBSUB, NOMULTI], run: (ctx, channels) => ctx.server.unsubscribe(ctx.client, channels, false) },
  punsubscribe: { arity: -1, flags: [PUBSUB, NOMULTI], run: (ctx, patterns) => ctx.server.unsubscribe(ctx.client, patterns, true) },
  publish:      { arity: 3, run: (ctx, [channel, message]) => ctx.server.publish(channel, message) },

  // persistence & server
  save:     { arity: 1, run: (ctx) => { ctx.server.save(); return OK; } },
  bgsave:   { arity: -1, run: (ctx) => { ctx.server.save(); return simple("Background saving started"); } },
  lastsave: { arity: 1, run: (ctx) => Math.floor(ctx.server.stats().lastSave / 1000) },
  info:     { arity: -1, run: info },
  time:     { arity: 1, run: (ctx) => { const ms = ctx.store.now(); return [String(Math.floor(ms / 1000)), String((ms % 1000) * 1000)]; } },

  // transactions are handled by the connection; listed here for arity checks and COMMAND COUNT
  multi:    { arity: 1, flags: [NOMULTI] },
  exec:     { arity: 1, flags: [NOMULTI] },
  discard:  { arity: 1, flags: [NOMULTI] },
};

/** Validate a command before running or queueing it. Returns an error reply or the spec. */
export function lookup(args) {
  const name = args[0].toLowerCase();
  const spec = commands[name];
  if (!spec) {
    // Matches Redis byte for byte, including the trailing space after each arg.
    const rest = args.slice(1).map((a) => `'${a}' `).join("");
    return { error: error(`ERR unknown command '${args[0]}', with args beginning with: ${rest}`) };
  }
  const n = args.length;
  if ((spec.arity > 0 && n !== spec.arity) || (spec.arity < 0 && n < -spec.arity)) {
    return { error: error(`ERR wrong number of arguments for '${name}' command`) };
  }
  return { name, spec };
}

/** Run a validated command, translating thrown errors into error replies. */
export function execute(ctx, name, spec, args) {
  try {
    return spec.run(ctx, args);
  } catch (e) {
    if (e instanceof CommandError || e instanceof WrongTypeError) {
      return error(e.message);
    }
    throw e;
  }
}

export const isPubSubAllowed = (spec) => spec.flags?.includes(PUBSUB);
export const isImmediate = (spec) => spec.flags?.includes(NOMULTI);
