# emberkv

[![CI](https://github.com/Tendo505/emberkv/actions/workflows/ci.yml/badge.svg)](https://github.com/Tendo505/emberkv/actions/workflows/ci.yml)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)
![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-339933)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

A **Redis-compatible in-memory data store**, written from scratch in Node.js with zero dependencies.

emberkv speaks the real Redis wire protocol (RESP), so the official `redis-cli`, `redis-benchmark`, and standard Redis client libraries connect to it unchanged. It supports strings, lists, hashes, key expiry, transactions, pub/sub, and snapshot persistence.

```console
$ node bin/emberkv.js --port 6379
12:00:01.204 * emberkv 1.0.0 ready on 127.0.0.1:6379 (pid 4120)

$ redis-cli SET greeting "hello world" EX 60
OK
$ redis-cli GET greeting
"hello world"
$ redis-cli TTL greeting
(integer) 58
```

## Highlights

- **Wire-compatible with Redis.** It has an incremental, binary-safe RESP parser that handles pipelining and inline (telnet-style) commands. Error messages match Redis byte for byte, and **CI checks compatibility against the official `redis-cli` and `redis-benchmark`** on every push.
- **78 commands** across strings, lists, hashes, keyspace, transactions, pub/sub, and server introspection.
- **Redis-style expiry.** Keys expire lazily (checked on access) *and* actively: a background cycle samples keys that have a TTL and repeats while more than 25% of a sample has expired, the same adaptive algorithm Redis uses.
- **Atomic transactions.** `MULTI` / `EXEC` / `DISCARD` follow Redis semantics: a queue-time error aborts with `EXECABORT`, while a runtime error inside `EXEC` doesn't roll back the other commands.
- **Pub/sub** with channel and glob-pattern subscriptions (`SUBSCRIBE`, `PSUBSCRIBE`, `PUBLISH`). Subscribed clients are restricted to pub/sub commands, as in Redis.
- **Crash-safe persistence.** Snapshots are written to a temp file and atomically renamed, so a crash mid-save never corrupts the database. The server saves periodically when data has changed and again on graceful shutdown.
- **O(1) lists.** Lists are backed by a growable ring-buffer deque, so `LPUSH`/`RPUSH`/`LPOP`/`RPOP` are constant time at both ends.
- **Well tested.** 71 tests (unit + end-to-end over real TCP) run on Linux, macOS and Windows with Node 20 and 22.

## Architecture

```
               TCP socket
                   │  raw bytes (may contain partial or many pipelined commands)
                   ▼
┌──────────────────────────────────┐
│ RequestParser        resp.js     │  incremental, binary-safe (latin1), bounded lengths
└──────────────────────────────────┘
                   │  ["SET", "k", "v"]
                   ▼
┌──────────────────────────────────┐
│ dispatch             server.js   │  arity check → pub/sub mode guard → MULTI queueing
└──────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────┐      ┌───────────────────────────┐
│ command table        commands.js │ ───▶ │ Store           store.js  │
│ 78 handlers, Redis error texts   │      │ typed values, lazy+active │
└──────────────────────────────────┘      │ expiry, snapshot/restore  │
                   │  JS reply value       └───────────────────────────┘
                   ▼                                    │
┌──────────────────────────────────┐      ┌───────────────────────────┐
│ encode → per-client out buffer   │      │ persistence.js            │
│ flushed once per microtask       │      │ temp file + atomic rename │
└──────────────────────────────────┘      └───────────────────────────┘
```

Design notes:

- **Single-threaded by design.** Like Redis, all commands run on one event loop, so every command and every `EXEC` block is atomic without locks.
- **Reply batching.** Replies are buffered per client and flushed once per microtask, so a pipeline of 1,000 commands becomes one `socket.write()` instead of 1,000.
- **Binary safety.** The parser and encoder treat data as `latin1` (one char per byte), so any byte sequence, including `\r\n` and `\0`, round-trips exactly. Bulk lengths are counted in bytes.
- **Defensive parsing.** Malformed frames get a `Protocol error` reply and the connection is closed. Bulk strings over 64 MB and absurd array lengths are rejected before any allocation.
- **Testable time.** The store takes an injectable clock, so expiry logic is tested deterministically without sleeping.

## Supported commands

| Group | Commands |
| --- | --- |
| Strings | `GET` `SET` (EX/PX/EXAT/PXAT/NX/XX/GET/KEEPTTL) `SETNX` `SETEX` `PSETEX` `GETSET` `GETDEL` `MGET` `MSET` `APPEND` `STRLEN` `GETRANGE` `INCR` `DECR` `INCRBY` `DECRBY` |
| Lists | `LPUSH` `RPUSH` `LPUSHX` `RPUSHX` `LPOP` `RPOP` (with count) `LLEN` `LINDEX` `LRANGE` `LSET` `LTRIM` `LREM` |
| Hashes | `HSET` `HSETNX` `HGET` `HMGET` `HDEL` `HGETALL` `HKEYS` `HVALS` `HLEN` `HEXISTS` `HINCRBY` |
| Keyspace | `DEL` `UNLINK` `EXISTS` `TYPE` `RENAME` `KEYS` `SCAN` (MATCH/COUNT/TYPE) `RANDOMKEY` `DBSIZE` `FLUSHDB` `FLUSHALL` `EXPIRE` `PEXPIRE` `EXPIREAT` `PEXPIREAT` (NX/XX/GT/LT) `TTL` `PTTL` `PERSIST` |
| Transactions | `MULTI` `EXEC` `DISCARD` |
| Pub/Sub | `SUBSCRIBE` `UNSUBSCRIBE` `PSUBSCRIBE` `PUNSUBSCRIBE` `PUBLISH` |
| Server | `PING` `ECHO` `INFO` `SAVE` `BGSAVE` `LASTSAVE` `TIME` `DBSIZE` `SELECT 0` `CLIENT` `HELLO 2` `COMMAND` `CONFIG GET` `QUIT` |

## Getting started

```bash
git clone https://github.com/Tendo505/emberkv.git
cd emberkv
npm start                     # listens on 127.0.0.1:6379, snapshots to ./dump.json
```

Options:

```
-p, --port <n>         TCP port (default 6379)
    --host <addr>      bind address (default 127.0.0.1)
    --dir <path>       directory for the snapshot file (default .)
    --dbfilename <f>   snapshot file name (default dump.json)
    --save <seconds>   snapshot interval when data changed (default 60)
    --no-persist       keep data in memory only
```

No `redis-cli`? Plain netcat works too, thanks to inline command support:

```console
$ printf 'SET a 1\r\nINCR a\r\n' | nc localhost 6379
+OK
:2
```

### Use as a library

```js
// npm install github:Tendo505/emberkv
import { createServer } from "emberkv";
import { Client } from "emberkv/client";

const server = createServer({ port: 0 });        // 0 = pick a free port
const port = await server.listen();

const client = await Client.connect(port);
await client.call("HSET", "user:1", "name", "Ada");
console.log(await client.call("HGETALL", "user:1")); // [ 'name', 'Ada' ]

await client.close();
await server.close();
```

## Performance

`npm run bench` runs 50 concurrent clients pipelining 16 commands each, with client and server **in the same Node process** (so the clients' CPU use is counted against the server):

| Command | ops/sec |
| --- | --- |
| SET | ~33,000 |
| GET | ~34,000 |
| INCR | ~38,000 |
| LPUSH | ~43,000 |

A single client pipelining 100k commands reaches **~62,000 ops/sec**, with a sequential round-trip latency of about **0.15 ms**. Measured on Node 25, Windows 11, on a laptop. The CI job also runs the official `redis-benchmark` and prints its results in the job log.

Two optimizations came out of profiling:

1. **LPUSH 16x faster** (2.7k → 43k ops/s). The first version stored lists as JS arrays, and `Array.unshift` is O(n), so pushing to the head of a long list was quadratic overall. Swapping in a ring-buffer deque made it O(1).
2. **Pipelining 14x faster** (4.5k → 62k ops/s). The client's pending-reply queue used `Array.shift()`, which is O(n) on a queue that is 100k deep. It now uses the same deque.

## Testing

```bash
npm test                 # 71 unit + integration tests, node:test, no dependencies
bash test/redis-cli.sh   # compatibility suite against the official redis-cli (needs redis-tools)
```

The tests cover parser edge cases (every possible chunk split point, binary data, malformed frames), expiry with a fake clock, the active-expiry algorithm, every command group, transactions, pub/sub cleanup on disconnect, 4,000-command pipelines, 20 concurrent clients incrementing one counter without losing updates, and persistence across restarts.

## Limitations

emberkv is a learning-grade reimplementation, not a production Redis replacement:

- One logical database (`SELECT 0` only), and no sets, sorted sets, streams, `WATCH`, Lua scripting, replication, or ACLs.
- Snapshots are JSON written synchronously. That's fine for small datasets, but a large keyspace would block the event loop while saving (Redis forks for `BGSAVE`).

## License

[MIT](LICENSE) © Tendo505
