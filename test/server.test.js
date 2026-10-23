// End-to-end tests: a real server on a random port, real TCP clients.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createServer } from "../src/server.js";
import { Client } from "../src/client.js";
import { ReplyError, SimpleString } from "../src/resp.js";

let server, port, c;

before(async () => {
  server = createServer({ port: 0 });
  port = await server.listen();
  c = await Client.connect(port);
});

after(async () => {
  await c.close();
  await server.close();
});

const ok = (reply) => assert.ok(reply instanceof SimpleString && reply.value === "OK", `expected OK, got ${JSON.stringify(reply)}`);
const err = async (promise, re) => {
  const reply = await promise;
  assert.ok(reply instanceof ReplyError, `expected error, got ${JSON.stringify(reply)}`);
  if (re) assert.match(reply.message, re);
};

describe("connection", () => {
  test("PING and ECHO", async () => {
    assert.equal((await c.call("PING")).value, "PONG");
    assert.equal(await c.call("PING", "hi"), "hi");
    assert.equal(await c.call("ECHO", "hello"), "hello");
  });

  test("unknown command and wrong arity", async () => {
    await err(c.send(["NOPE", "x"]), /^ERR unknown command 'NOPE'/);
    await err(c.send(["GET"]), /^ERR wrong number of arguments for 'get' command/);
  });

  test("commands are case-insensitive", async () => {
    ok(await c.call("sEt", "case", "1"));
    assert.equal(await c.call("get", "case"), "1");
  });

  test("inline commands work (telnet / netcat style)", async () => {
    const reply = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write("SET inline \"a b\"\r\nGET inline\r\n"));
      let data = "";
      s.on("data", (d) => {
        data += d;
        if (data.includes("a b")) { s.end(); resolve(data); }
      });
    });
    assert.equal(reply, "+OK\r\n$3\r\na b\r\n");
  });

  test("QUIT replies OK and closes the connection", async () => {
    const q = await Client.connect(port);
    const closed = new Promise((r) => q.socket.once("close", r));
    ok(await q.call("QUIT"));
    await closed;
  });

  test("protocol errors are reported and the connection closed", async () => {
    const data = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write("*1\r\n+bad\r\n"));
      let out = "";
      s.on("data", (d) => (out += d));
      s.on("close", () => resolve(out));
    });
    assert.match(data, /^-ERR Protocol error/);
  });
});

describe("strings", () => {
  test("SET options NX / XX / GET", async () => {
    await c.call("DEL", "s");
    ok(await c.call("SET", "s", "1", "NX"));
    assert.equal(await c.call("SET", "s", "2", "NX"), null);
    ok(await c.call("SET", "s", "3", "XX"));
    assert.equal(await c.call("SET", "s", "4", "GET"), "3");
    assert.equal(await c.call("SET", "missing-xx", "v", "XX"), null);
    await err(c.send(["SET", "s", "v", "NX", "XX"]), /syntax error/);
  });

  test("SET EX / PX set a TTL", async () => {
    ok(await c.call("SET", "ttl", "v", "EX", "100"));
    const ttl = await c.call("TTL", "ttl");
    assert.ok(ttl > 98 && ttl <= 100);
    ok(await c.call("SET", "ttl", "v", "PX", "5000"));
    const pttl = await c.call("PTTL", "ttl");
    assert.ok(pttl > 4900 && pttl <= 5000);
    await err(c.send(["SET", "ttl", "v", "EX", "0"]), /invalid expire time/);
  });

  test("INCR family and integer validation", async () => {
    await c.call("DEL", "n");
    assert.equal(await c.call("INCR", "n"), 1);
    assert.equal(await c.call("INCRBY", "n", "10"), 11);
    assert.equal(await c.call("DECR", "n"), 10);
    assert.equal(await c.call("DECRBY", "n", "15"), -5);
    await c.call("SET", "notnum", "abc");
    await err(c.send(["INCR", "notnum"]), /not an integer/);
    await c.call("SET", "big", String(Number.MAX_SAFE_INTEGER));
    await err(c.send(["INCR", "big"]), /overflow/);
  });

  test("MSET / MGET / APPEND / STRLEN / GETRANGE / GETDEL", async () => {
    ok(await c.call("MSET", "a", "1", "b", "2"));
    await c.call("RPUSH", "alist", "x");
    assert.deepEqual(await c.call("MGET", "a", "b", "nope", "alist"), ["1", "2", null, null]);
    await c.call("SET", "str", "Hello");
    assert.equal(await c.call("APPEND", "str", " World"), 11);
    assert.equal(await c.call("STRLEN", "str"), 11);
    assert.equal(await c.call("GETRANGE", "str", "0", "4"), "Hello");
    assert.equal(await c.call("GETRANGE", "str", "-5", "-1"), "World");
    assert.equal(await c.call("GETDEL", "str"), "Hello World");
    assert.equal(await c.call("EXISTS", "str"), 0);
  });

  test("binary values round-trip byte for byte", async () => {
    const value = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("");
    ok(await c.call("SET", "bin", value));
    assert.equal(await c.call("GET", "bin"), value);
    assert.equal(await c.call("STRLEN", "bin"), 256);
  });

  test("WRONGTYPE on type mismatch", async () => {
    await c.call("DEL", "l");
    await c.call("LPUSH", "l", "x");
    await err(c.send(["GET", "l"]), /^WRONGTYPE/);
    await err(c.send(["HGET", "l", "f"]), /^WRONGTYPE/);
  });
});

describe("lists", () => {
  test("push, pop, range, index", async () => {
    await c.call("DEL", "q");
    assert.equal(await c.call("RPUSH", "q", "a", "b", "c"), 3);
    assert.equal(await c.call("LPUSH", "q", "z"), 4);
    assert.deepEqual(await c.call("LRANGE", "q", "0", "-1"), ["z", "a", "b", "c"]);
    assert.deepEqual(await c.call("LRANGE", "q", "-2", "100"), ["b", "c"]);
    assert.deepEqual(await c.call("LRANGE", "q", "5", "10"), []);
    assert.equal(await c.call("LINDEX", "q", "-1"), "c");
    assert.equal(await c.call("LPOP", "q"), "z");
    assert.equal(await c.call("RPOP", "q"), "c");
    assert.deepEqual(await c.call("LPOP", "q", "5"), ["a", "b"]);
    assert.equal(await c.call("EXISTS", "q"), 0, "empty lists are removed");
    assert.equal(await c.call("LPOP", "q"), null);
  });

  test("LPUSH inserts each value at the head in order", async () => {
    await c.call("DEL", "q");
    await c.call("LPUSH", "q", "1", "2", "3");
    assert.deepEqual(await c.call("LRANGE", "q", "0", "-1"), ["3", "2", "1"]);
  });

  test("LSET / LTRIM / LREM / PUSHX", async () => {
    await c.call("DEL", "q");
    await c.call("RPUSH", "q", "a", "x", "b", "x", "c", "x");
    assert.equal(await c.call("LREM", "q", "2", "x"), 2);
    assert.deepEqual(await c.call("LRANGE", "q", "0", "-1"), ["a", "b", "c", "x"]);
    assert.equal(await c.call("LREM", "q", "-1", "x"), 1);
    ok(await c.call("LSET", "q", "0", "A"));
    await err(c.send(["LSET", "q", "10", "v"]), /index out of range/);
    ok(await c.call("LTRIM", "q", "0", "1"));
    assert.deepEqual(await c.call("LRANGE", "q", "0", "-1"), ["A", "b"]);
    assert.equal(await c.call("LPUSHX", "nolist", "v"), 0);
    assert.equal(await c.call("EXISTS", "nolist"), 0);
  });
});

describe("hashes", () => {
  test("HSET / HGET / HGETALL / HDEL / HINCRBY", async () => {
    await c.call("DEL", "h");
    assert.equal(await c.call("HSET", "h", "name", "ada", "age", "36"), 2);
    assert.equal(await c.call("HSET", "h", "name", "grace"), 0);
    assert.equal(await c.call("HGET", "h", "name"), "grace");
    assert.deepEqual(await c.call("HMGET", "h", "name", "nope"), ["grace", null]);
    assert.deepEqual(await c.call("HGETALL", "h"), ["name", "grace", "age", "36"]);
    assert.deepEqual(await c.call("HKEYS", "h"), ["name", "age"]);
    assert.equal(await c.call("HLEN", "h"), 2);
    assert.equal(await c.call("HEXISTS", "h", "age"), 1);
    assert.equal(await c.call("HINCRBY", "h", "age", "4"), 40);
    await err(c.send(["HINCRBY", "h", "name", "1"]), /not an integer/);
    assert.equal(await c.call("HSETNX", "h", "name", "x"), 0);
    assert.equal(await c.call("HDEL", "h", "name", "age", "nope"), 2);
    assert.equal(await c.call("EXISTS", "h"), 0);
  });
});

describe("keyspace", () => {
  test("EXPIRE / PERSIST / TTL and real expiry", async () => {
    await c.call("SET", "e", "v");
    assert.equal(await c.call("TTL", "e"), -1);
    assert.equal(await c.call("TTL", "never-existed"), -2);
    assert.equal(await c.call("PEXPIRE", "e", "50"), 1);
    assert.equal(await c.call("PERSIST", "e"), 1);
    assert.equal(await c.call("TTL", "e"), -1);
    await c.call("PEXPIRE", "e", "30");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(await c.call("GET", "e"), null);
  });

  test("EXPIRE NX / XX / GT / LT flags", async () => {
    await c.call("SET", "f", "v");
    assert.equal(await c.call("EXPIRE", "f", "100", "XX"), 0);
    assert.equal(await c.call("EXPIRE", "f", "100", "NX"), 1);
    assert.equal(await c.call("EXPIRE", "f", "50", "GT"), 0);
    assert.equal(await c.call("EXPIRE", "f", "200", "GT"), 1);
    assert.equal(await c.call("EXPIRE", "f", "10", "LT"), 1);
    assert.ok((await c.call("TTL", "f")) <= 10);
  });

  test("KEYS, SCAN, TYPE, RENAME, DBSIZE", async () => {
    await c.call("FLUSHDB");
    await c.call("MSET", "user:1", "a", "user:2", "b", "order:1", "c");
    await c.call("HSET", "user:hash", "f", "v");
    assert.deepEqual((await c.call("KEYS", "user:?")).sort(), ["user:1", "user:2"]);
    assert.equal(await c.call("DBSIZE"), 4);
    assert.equal((await c.call("TYPE", "user:hash")).value, "hash");
    assert.equal((await c.call("TYPE", "nope")).value, "none");

    const seen = [];
    let cursor = "0";
    do {
      const [next, keys] = await c.call("SCAN", cursor, "MATCH", "user:*", "COUNT", "2");
      seen.push(...keys);
      cursor = next;
    } while (cursor !== "0");
    assert.deepEqual(seen.sort(), ["user:1", "user:2", "user:hash"]);

    const [, hashes] = await c.call("SCAN", "0", "COUNT", "100", "TYPE", "hash");
    assert.deepEqual(hashes, ["user:hash"]);

    await c.call("EXPIRE", "order:1", "100");
    ok(await c.call("RENAME", "order:1", "order:renamed"));
    assert.ok((await c.call("TTL", "order:renamed")) > 0, "RENAME keeps the TTL");
    await err(c.send(["RENAME", "nope", "x"]), /no such key/);
  });
});

describe("transactions", () => {
  test("MULTI / EXEC runs queued commands atomically", async () => {
    await c.call("DEL", "tx");
    ok(await c.call("MULTI"));
    assert.equal((await c.call("INCR", "tx")).value, "QUEUED");
    assert.equal((await c.call("INCR", "tx")).value, "QUEUED");
    assert.equal((await c.call("GET", "tx")).value, "QUEUED");
    assert.deepEqual(await c.call("EXEC"), [1, 2, "2"]);
  });

  test("a runtime error inside EXEC does not abort the other commands", async () => {
    await c.call("SET", "txs", "abc");
    await c.call("MULTI");
    await c.call("INCR", "txs");
    await c.call("SET", "txs2", "ok");
    const [first, second] = await c.call("EXEC");
    assert.ok(first instanceof ReplyError);
    assert.equal(second.value, "OK");
  });

  test("a queue-time error aborts EXEC", async () => {
    await c.call("MULTI");
    await c.send(["NOTACOMMAND"]);
    await c.call("SET", "never", "set");
    await err(c.send(["EXEC"]), /^EXECABORT/);
    assert.equal(await c.call("EXISTS", "never"), 0);
  });

  test("DISCARD and misuse errors", async () => {
    await c.call("MULTI");
    await c.call("SET", "discarded", "v");
    ok(await c.call("DISCARD"));
    assert.equal(await c.call("EXISTS", "discarded"), 0);
    await err(c.send(["EXEC"]), /EXEC without MULTI/);
    await err(c.send(["DISCARD"]), /DISCARD without MULTI/);
    await c.call("MULTI");
    await err(c.send(["MULTI"]), /can not be nested/);
    await c.call("DISCARD");
  });
});

describe("pub/sub", () => {
  test("SUBSCRIBE receives PUBLISHed messages", async () => {
    const sub = await Client.connect(port);
    assert.deepEqual(await sub.subscribe("news", "alerts"), [
      ["subscribe", "news", 1],
      ["subscribe", "alerts", 2],
    ]);
    const received = [];
    sub.onMessage((m) => received.push(m));

    assert.equal(await c.call("PUBLISH", "news", "hello"), 1);
    assert.equal(await c.call("PUBLISH", "nobody", "x"), 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(received, [{ channel: "news", message: "hello" }]);
    await sub.close();
  });

  test("PSUBSCRIBE matches channel patterns", async () => {
    const sub = await Client.connect(port);
    await sub.psubscribe("orders.*");
    const received = [];
    sub.onMessage((m) => received.push(m));
    assert.equal(await c.call("PUBLISH", "orders.created", "#1"), 1);
    assert.equal(await c.call("PUBLISH", "users.created", "#2"), 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(received, [{ pattern: "orders.*", channel: "orders.created", message: "#1" }]);
    await sub.close();
  });

  test("subscribed clients can only run pub/sub commands", async () => {
    const sub = await Client.connect(port);
    await sub.subscribe("x");
    await err(sub.send(["GET", "a"]), /only \(P\)SUBSCRIBE/);
    assert.deepEqual(await sub.send(["PING"]), ["pong", ""]);
    assert.deepEqual(await sub.send(["UNSUBSCRIBE"]), ["unsubscribe", "x", 0]);
    sub.subscribed = false;
    ok(await sub.call("SET", "after-unsub", "1"));
    await sub.close();
  });

  test("disconnecting cleans up subscriptions", async () => {
    const sub = await Client.connect(port);
    await sub.subscribe("gone");
    await sub.close();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await c.call("PUBLISH", "gone", "x"), 0);
  });
});

describe("pipelining and concurrency", () => {
  test("replies arrive in order for a large pipeline", async () => {
    const cmds = Array.from({ length: 2000 }, (_, i) => ["SET", `p:${i}`, String(i)]);
    cmds.push(...Array.from({ length: 2000 }, (_, i) => ["GET", `p:${i}`]));
    const replies = await c.pipeline(cmds);
    assert.deepEqual(replies.slice(2000), Array.from({ length: 2000 }, (_, i) => String(i)));
  });

  test("concurrent INCRs from many clients are not lost", async () => {
    await c.call("DEL", "counter");
    const clients = await Promise.all(Array.from({ length: 20 }, () => Client.connect(port)));
    await Promise.all(clients.map((cl) => cl.pipeline(Array.from({ length: 100 }, () => ["INCR", "counter"]))));
    assert.equal(await c.call("GET", "counter"), "2000");
    await Promise.all(clients.map((cl) => cl.close()));
  });
});

describe("persistence", () => {
  test("data survives a restart via snapshot", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emberkv-"));
    const dbFile = path.join(dir, "dump.json");

    const s1 = createServer({ port: 0, dbFile });
    const p1 = await s1.listen();
    const c1 = await Client.connect(p1);
    await c1.call("SET", "persisted", "yes");
    await c1.call("RPUSH", "plist", "a", "b");
    await c1.call("HSET", "phash", "f", "v");
    await c1.call("SET", "pttl", "v", "EX", "100");
    ok(await c1.call("SAVE"));
    await c1.close();
    await s1.close();

    const s2 = createServer({ port: 0, dbFile });
    const p2 = await s2.listen();
    const c2 = await Client.connect(p2);
    assert.equal(await c2.call("GET", "persisted"), "yes");
    assert.deepEqual(await c2.call("LRANGE", "plist", "0", "-1"), ["a", "b"]);
    assert.equal(await c2.call("HGET", "phash", "f"), "v");
    assert.ok((await c2.call("TTL", "pttl")) > 90);
    await c2.close();
    await s2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("close() writes a final snapshot of unsaved changes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emberkv-"));
    const dbFile = path.join(dir, "dump.json");
    const s1 = createServer({ port: 0, dbFile });
    const c1 = await Client.connect(await s1.listen());
    await c1.call("SET", "unsaved", "1");
    await c1.close();
    await s1.close();
    assert.ok(fs.readFileSync(dbFile, "utf8").includes("unsaved"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("INFO", () => {
  test("reports server, stats and keyspace sections", async () => {
    const info = await c.call("INFO");
    for (const section of ["# Server", "# Clients", "# Stats", "# Keyspace"]) assert.ok(info.includes(section));
    assert.match(info, /connected_clients:\d+/);
    assert.match(info, /db0:keys=\d+,expires=\d+/);
  });
});
