#!/usr/bin/env node
// Throughput benchmark: N concurrent clients each pipelining batches of SET/GET.
// Usage: node bin/bench.js [--clients 50] [--requests 200000] [--pipeline 16] [--port 6379]
// Without --port it starts an in-process server on a free port.

import { parseArgs } from "node:util";
import { Client } from "../src/client.js";
import { createServer } from "../src/server.js";

const { values } = parseArgs({
  options: {
    clients: { type: "string", default: "50" },
    requests: { type: "string", default: "200000" },
    pipeline: { type: "string", default: "16" },
    port: { type: "string" },
  },
});
const clients = Number(values.clients);
const total = Number(values.requests);
const depth = Number(values.pipeline);

let server;
let port = values.port && Number(values.port);
if (!port) {
  server = createServer({ port: 0 });
  port = await server.listen();
}

async function run(label, makeCommand) {
  const conns = await Promise.all(Array.from({ length: clients }, () => Client.connect(port)));
  const perClient = Math.ceil(total / clients);
  const start = process.hrtime.bigint();

  await Promise.all(
    conns.map(async (c, ci) => {
      for (let sent = 0; sent < perClient; sent += depth) {
        const batch = [];
        for (let j = 0; j < depth && sent + j < perClient; j++) batch.push(makeCommand(ci * perClient + sent + j));
        await c.pipeline(batch);
      }
    })
  );

  const seconds = Number(process.hrtime.bigint() - start) / 1e9;
  const ops = Math.round((perClient * clients) / seconds);
  console.log(`${label.padEnd(5)} ${ops.toLocaleString("en-US").padStart(10)} ops/sec  (${(perClient * clients).toLocaleString("en-US")} requests in ${seconds.toFixed(2)}s)`);
  await Promise.all(conns.map((c) => c.close()));
}

console.log(`emberkv benchmark: ${clients} clients, pipeline depth ${depth}, Node ${process.version}\n`);
await run("SET", (i) => ["SET", `key:${i % 10000}`, "value"]);
await run("GET", (i) => ["GET", `key:${i % 10000}`]);
await run("INCR", () => ["INCR", "counter"]);
await run("LPUSH", () => ["LPUSH", "list", "x"]);

await server?.close();
