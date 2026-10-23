#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { createServer, VERSION } from "../src/server.js";

const { values: opts } = parseArgs({
  options: {
    port: { type: "string", short: "p", default: "6379" },
    host: { type: "string", default: "127.0.0.1" },
    dir: { type: "string", default: "." },
    dbfilename: { type: "string", default: "dump.json" },
    save: { type: "string", default: "60" },
    "no-persist": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", short: "v", default: false },
  },
});

if (opts.help) {
  console.log(`emberkv ${VERSION} — a Redis-compatible in-memory data store

Usage: emberkv [options]

  -p, --port <n>         TCP port (default 6379)
      --host <addr>      bind address (default 127.0.0.1)
      --dir <path>       directory for the snapshot file (default .)
      --dbfilename <f>   snapshot file name (default dump.json)
      --save <seconds>   snapshot interval when data changed (default 60)
      --no-persist       keep data in memory only
  -v, --version          print version
  -h, --help             show this help`);
  process.exit(0);
}
if (opts.version) {
  console.log(VERSION);
  process.exit(0);
}

const time = () => new Date().toISOString().slice(11, 23);
const log = (msg) => console.log(`${time()} * ${msg}`);

const server = createServer({
  port: Number(opts.port),
  host: opts.host,
  dbFile: opts["no-persist"] ? null : path.resolve(opts.dir, opts.dbfilename),
  saveIntervalMs: Number(opts.save) * 1000,
  log,
});

const port = await server.listen();
log(`emberkv ${VERSION} ready on ${opts.host}:${port} (pid ${process.pid})`);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, saving and shutting down`);
    await server.close();
    process.exit(0);
  });
}
