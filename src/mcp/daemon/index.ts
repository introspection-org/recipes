#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { startMcpDaemonServer } from "./server.js";
import {
  MCP_DAEMON_FINGERPRINT_ENV,
  MCP_DAEMON_PARENT_PID_ENV,
  MCP_DAEMON_SOCKET_ENV,
  MCP_DAEMON_TOKEN_ENV,
} from "./protocol.js";

const socketPath = process.env[MCP_DAEMON_SOCKET_ENV];
const token = process.env[MCP_DAEMON_TOKEN_ENV];
const fingerprint = process.env[MCP_DAEMON_FINGERPRINT_ENV];
if (!socketPath || !token || !fingerprint) {
  throw new Error("MCP daemon environment is incomplete.");
}

/**
 * The daemon runs from two layouts. `build-mcp-daemon.mjs` bundles it to
 * `dist/mcp-daemon.js` with the worker beside it as `dist/mcp-run-worker.js`,
 * while tsc emits this module at `dist/mcp/daemon/index.js` with the worker at
 * `dist/mcp/cli/run-worker.js`. Neither path is visible to the type checker,
 * and picking the wrong one fails only once a run starts a worker.
 */
function runWorkerPath(): string {
  const bundled = new URL("./mcp-run-worker.js", import.meta.url);
  if (existsSync(bundled)) return fileURLToPath(bundled);
  return fileURLToPath(new URL("../cli/run-worker.js", import.meta.url));
}

const server = await startMcpDaemonServer({
  socketPath,
  token,
  fingerprint,
  env: process.env,
  runWorkerPath: runWorkerPath(),
  onStop: () => process.exit(0),
});
const exit = () => void server.close().then(() => process.exit(0));

const ownerPid = Number(process.env[MCP_DAEMON_PARENT_PID_ENV]);
if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
  const ownerWatch = setInterval(() => {
    try {
      process.kill(ownerPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        clearInterval(ownerWatch);
        exit();
      }
    }
  }, 1_000);
  ownerWatch.unref();
}
process.once("SIGINT", exit);
process.once("SIGTERM", exit);
process.once("SIGQUIT", exit);
