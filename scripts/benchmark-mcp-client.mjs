#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

if (process.platform === "win32") {
  throw new Error("The native MCP client benchmark currently requires Unix sockets.");
}

const root = resolve(import.meta.dirname, "..");
const nativeClient =
  process.env.MCP_CLIENT_BIN ?? join(root, "target", "release", "mcp-client");
// Asked for rather than hardcoded: this path has moved twice, and the SDK
// already owns the resolution the session shim uses. `bench:mcp-client` runs
// `build:ts` first, so dist is present.
const { mcpClientEntrypointPath } = await import(
  pathToFileURL(join(root, "dist", "mcp", "index.js")).href
);
const nodeClient = mcpClientEntrypointPath();
const iterations = Number(process.env.ITERATIONS ?? 50);
const parallelism = Number(process.env.PARALLELISM ?? 6);
const directory = await mkdtemp(join(tmpdir(), "recipes-mcp-benchmark-"));
const socketPath = join(directory, "mcp.sock");
const token = "benchmark-token";
const fingerprint = "benchmark-fingerprint";
const env = {
  ...process.env,
  PI_RECIPES_MCP_DAEMON_SOCKET: socketPath,
  PI_RECIPES_MCP_DAEMON_TOKEN: token,
  PI_RECIPES_MCP_DAEMON_FINGERPRINT: fingerprint,
};

const server = createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    if (request.type === "ping") {
      socket.end(`${JSON.stringify({ id: request.id, ready: true, fingerprint })}\n`);
    } else if (request.type === "execute") {
      socket.end(`${JSON.stringify({ id: request.id, exitCode: 0 })}\n`);
    } else {
      socket.end(`${JSON.stringify({ id: request.id, error: "unsupported" })}\n`);
    }
  });
});

await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(socketPath, resolveListen);
});

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { env, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`${command} exited with ${code}`));
      else resolveRun(performance.now() - started);
    });
  });
}

async function measure(command, args) {
  for (let index = 0; index < 5; index += 1) await run(command, args);
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    samples.push(await run(command, args));
  }
  samples.sort((left, right) => left - right);
  const sum = samples.reduce((total, sample) => total + sample, 0);
  return {
    mean: sum / samples.length,
    p50: samples[Math.floor(samples.length * 0.5)],
    p95: samples[Math.floor(samples.length * 0.95)],
  };
}

async function measureBatch(command, args) {
  for (let index = 0; index < 2; index += 1) {
    await Promise.all(Array.from({ length: parallelism }, () => run(command, args)));
  }
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await Promise.all(Array.from({ length: parallelism }, () => run(command, args)));
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const sum = samples.reduce((total, sample) => total + sample, 0);
  return {
    mean: sum / samples.length,
    p50: samples[Math.floor(samples.length * 0.5)],
    p95: samples[Math.floor(samples.length * 0.95)],
  };
}

try {
  const args = ["call", "stub.tool", "value=1"];
  const node = await measure(process.execPath, [nodeClient, ...args]);
  const native = await measure(nativeClient, args);
  const nodeBatch = await measureBatch(process.execPath, [nodeClient, ...args]);
  const nativeBatch = await measureBatch(nativeClient, args);
  console.log("single invocation (ms)");
  console.table({ node, native });
  console.log(`single mean speedup: ${(node.mean / native.mean).toFixed(1)}x`);
  console.log(`parallel batch of ${parallelism} (wall-clock ms)`);
  console.table({ node: nodeBatch, native: nativeBatch });
  console.log(`batch mean speedup: ${(nodeBatch.mean / nativeBatch.mean).toFixed(1)}x`);
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(directory, { recursive: true, force: true });
}
