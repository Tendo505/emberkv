// Minimal promise-based RESP client. Used by the test suite and benchmark,
// and handy for scripting against any Redis-compatible server.

import net from "node:net";
import { ReplyParser, ReplyError, encodeCommand } from "./resp.js";
import { Deque } from "./deque.js";

export class Client {
  static connect(port, host = "127.0.0.1") {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, host, () => {
        socket.off("error", reject);
        resolve(new Client(socket));
      });
      socket.once("error", reject);
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.parser = new ReplyParser();
    this.pending = new Deque(); // FIFO of { resolve, reject, remaining, replies }
    this.listeners = new Set();
    this.subscribed = false;

    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      for (const reply of this.parser.feed(chunk)) this.#onReply(reply);
    });
    socket.on("close", () => {
      for (const p of this.pending) p.reject(new Error("connection closed"));
      this.pending = new Deque();
    });
  }

  #onReply(reply) {
    // Out-of-band pub/sub pushes go to listeners, not to a pending call.
    if (this.subscribed && Array.isArray(reply) && (reply[0] === "message" || reply[0] === "pmessage")) {
      const [kind, ...rest] = reply;
      const msg = kind === "message"
        ? { channel: rest[0], message: rest[1] }
        : { pattern: rest[0], channel: rest[1], message: rest[2] };
      for (const fn of this.listeners) fn(msg);
      return;
    }
    const p = this.pending.peek();
    if (!p) return;
    p.replies.push(reply);
    if (--p.remaining === 0) {
      this.pending.shift();
      p.resolve(p.expected === 1 ? p.replies[0] : p.replies);
    }
  }

  /** Send a raw command. Error replies resolve as ReplyError (use `call` to throw). */
  send(args, expected = 1) {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject, remaining: expected, expected, replies: [] });
      this.socket.write(encodeCommand(args), "latin1");
    });
  }

  /** Send a command and throw on error replies. */
  async call(...args) {
    const reply = await this.send(args);
    if (reply instanceof ReplyError) throw new Error(reply.message);
    return reply;
  }

  /** Send many commands in one write and await all replies (pipelining). */
  pipeline(commands) {
    const promises = commands.map(
      (args) => new Promise((resolve, reject) => this.pending.push({ resolve, reject, remaining: 1, expected: 1, replies: [] }))
    );
    this.socket.write(commands.map(encodeCommand).join(""), "latin1");
    return Promise.all(promises);
  }

  async subscribe(...channels) {
    this.subscribed = true;
    return this.send(["SUBSCRIBE", ...channels], channels.length);
  }

  async psubscribe(...patterns) {
    this.subscribed = true;
    return this.send(["PSUBSCRIBE", ...patterns], patterns.length);
  }

  onMessage(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    return new Promise((resolve) => {
      if (this.socket.destroyed) return resolve();
      this.socket.once("close", resolve);
      this.socket.end();
    });
  }
}
