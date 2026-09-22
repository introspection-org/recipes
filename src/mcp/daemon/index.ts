#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { context } from "@opentelemetry/api";

import { createRuntime } from "mcporter";
import {
  installMcpCommandIoRouting,
  type McpRuntime,
} from "../cli/command-context.js";
import { discoverMcpCatalogs, executeMcpCommand } from "../cli/core.js";
import {
  MCP_DAEMON_FINGERPRINT_ENV,
  MCP_DAEMON_MAX_FRAME_BYTES,
  MCP_DAEMON_PARENT_PID_ENV,
  MCP_DAEMON_SOCKET_ENV,
  MCP_DAEMON_TOKEN_ENV,
  type McpCatalogServer,
  type McpDaemonEnvelope,
  type McpDaemonRequest,
  serializeMcpDaemonEnvelope,
} from "./protocol.js";
import { mcpDaemonRequestContext } from "../../mcp-trace-context.js";

const configuredSocketPath = process.env[MCP_DAEMON_SOCKET_ENV];
const configuredToken = process.env[MCP_DAEMON_TOKEN_ENV];
const configuredFingerprint = process.env[MCP_DAEMON_FINGERPRINT_ENV];
if (!configuredSocketPath || !configuredToken || !configuredFingerprint) {
  throw new Error("MCP daemon environment is incomplete.");
}
const socketPath = configuredSocketPath;
const token = configuredToken;
const fingerprint = configuredFingerprint;

const restoreIo = installMcpCommandIoRouting();
let runtimePromise: Promise<McpRuntime> | undefined;
let catalogPreloadPromise: Promise<McpCatalogServer[]> | undefined;
let catalogPreloadResult: McpCatalogServer[] | undefined;
let wakeCatalogRetry: (() => void) | undefined;
let catalogDemanded = false;
let stopping = false;
const active = new Map<string, AbortController>();
const SHUTDOWN_GRACE_MS = 1_000;
const CATALOG_PRELOAD_BACKOFF_MS = [100, 250, 500, 1_000, 2_000] as const;

function runtime(): Promise<McpRuntime> {
  runtimePromise ??= createRuntime({ configPath: process.env.MCPORTER_CONFIG }).catch(
    (error) => {
      runtimePromise = undefined;
      throw error;
    }
  );
  return runtimePromise;
}

function catalogHealthy(catalogs: McpCatalogServer[]): boolean {
  return catalogs.every((server) => !server.error);
}

async function catalogRetryDelay(timeoutMs: number): Promise<void> {
  await Promise.race([
    delay(timeoutMs),
    new Promise<void>((resolve) => {
      wakeCatalogRetry = resolve;
    }),
  ]);
  wakeCatalogRetry = undefined;
}

function preloadCatalogs(
  timeoutMs: number
): Promise<McpCatalogServer[]> {
  if (catalogPreloadResult && catalogHealthy(catalogPreloadResult)) {
    return Promise.resolve(catalogPreloadResult);
  }
  if (catalogPreloadPromise) return catalogPreloadPromise;

  catalogDemanded = false;
  const preload = (async () => {
    let latest: McpCatalogServer[] = [];
    let latestError: unknown;
    for (
      let attempt = 0;
      attempt <= CATALOG_PRELOAD_BACKOFF_MS.length;
      attempt += 1
    ) {
      try {
        latest = await discoverMcpCatalogs(await runtime(), timeoutMs);
        latestError = undefined;
        // Preserve the last generation even when optional servers failed.
        // Healthy tools from this snapshot must remain callable without
        // rediscovering every server on the call's deadline.
        catalogPreloadResult = latest;
        if (catalogHealthy(latest)) {
          return latest;
        }
      } catch (error) {
        latestError = error;
      }
      // Once a real command is waiting, make one immediate retry and then
      // return control to that command's normal discovery/error path. The
      // background retry policy must not turn into user-visible backoff.
      if (catalogDemanded && attempt > 0) break;
      const backoffMs = CATALOG_PRELOAD_BACKOFF_MS[attempt];
      if (backoffMs === undefined) break;
      await catalogRetryDelay(backoffMs);
    }
    if (latestError && latest.length === 0) throw latestError;
    return latest;
  })();
  catalogPreloadPromise = preload;
  void preload.then(
    () => {
      if (catalogPreloadPromise === preload) catalogPreloadPromise = undefined;
    },
    () => {
      if (catalogPreloadPromise === preload) catalogPreloadPromise = undefined;
    }
  );
  return preload;
}

async function joinCatalogPreload(): Promise<void> {
  const preload = catalogPreloadPromise;
  if (!preload) return;
  catalogDemanded = true;
  wakeCatalogRetry?.();
  await preload.catch(() => {});
}

function send(
  socket: Socket,
  envelope: McpDaemonEnvelope,
  serializationError = "response_too_large"
): void {
  if (!socket.destroyed && !socket.writableEnded) {
    try {
      socket.write(serializeMcpDaemonEnvelope(envelope), () => {});
    } catch {
      socket.write(
        `${JSON.stringify({
          id: envelope.id,
          error: serializationError,
        })}\n`,
        () => {}
      );
    }
  }
}

function stream(id: string, name: "stdout" | "stderr", socket: Socket): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      send(socket, { id, stream: name, data: String(chunk) });
      callback();
    },
  });
}

function runTimeoutMs(): number {
  const value = Number(process.env.PI_RECIPES_MCP_RUN_TIMEOUT_MS ?? 120_000);
  return Number.isSafeInteger(value) && value > 0 ? value : 120_000;
}

async function executeRun(
  request: Extract<McpDaemonRequest, { type: "execute" }>,
  socket: Socket,
  controller: AbortController
): Promise<number> {
  const sharedRuntime = await runtime();
  const worker = new Worker(
    fileURLToPath(new URL("../cli/run-worker.js", import.meta.url)),
    {
      workerData: {
        args: request.args,
        stdin: request.stdin,
        servers: sharedRuntime.listServers(),
      },
    }
  );
  const hardTimeout = setTimeout(
    () => void worker.terminate(),
    runTimeoutMs() + 2_000
  );
  const abort = () => void worker.terminate();
  controller.signal.addEventListener("abort", abort, { once: true });
  try {
    return await new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (task: () => void) => {
        if (settled) return;
        settled = true;
        task();
      };
      worker.on("message", (message: Record<string, unknown>) => {
        if (message.type === "stream") {
          send(socket, {
            id: request.id,
            stream: message.stream as "stdout" | "stderr",
            data: String(message.data),
          });
          return;
        }
        if (message.type === "toolCall") {
          void sharedRuntime
            .callTool(String(message.server), String(message.tool), message.options as never)
            .then(
              (result) => worker.postMessage({ type: "toolResult", id: message.id, result }),
              (error) =>
                worker.postMessage({
                  type: "toolError",
                  id: message.id,
                  message: error instanceof Error ? error.message : String(error),
                })
            );
          return;
        }
        if (message.type === "complete") {
          finish(() => resolve(Number(message.exitCode)));
        } else if (message.type === "failed") {
          finish(() => reject(new Error(String(message.message))));
        }
      });
      worker.once("error", (error) => finish(() => reject(error)));
      worker.once("exit", (code) => {
        if (settled) return;
        if (controller.signal.aborted) finish(() => resolve(130));
        else finish(() => reject(new Error(`mcp run worker exited before completion (${code}).`)));
      });
    });
  } finally {
    clearTimeout(hardTimeout);
    controller.signal.removeEventListener("abort", abort);
    await worker.terminate().catch(() => {});
  }
}

async function execute(request: Extract<McpDaemonRequest, { type: "execute" }>, socket: Socket) {
  return context.with(mcpDaemonRequestContext(request.trace), () =>
    executeRequest(request, socket)
  );
}

async function executeRequest(
  request: Extract<McpDaemonRequest, { type: "execute" }>,
  socket: Socket
) {
  const controller = new AbortController();
  active.set(request.id, controller);
  socket.once("close", () => controller.abort());
  try {
    await joinCatalogPreload();
    if (controller.signal.aborted) {
      send(socket, { id: request.id, exitCode: 130 });
      return;
    }
    const exitCode =
      request.args[0] === "run"
        ? await executeRun(request, socket, controller)
        : await executeMcpCommand({
            args: request.args,
            runtime: await runtime(),
            stdin: Readable.from([request.stdin]),
            stdout: stream(request.id, "stdout", socket),
            stderr: stream(request.id, "stderr", socket),
            signal: controller.signal,
          });
    send(socket, { id: request.id, exitCode });
  } catch (error) {
    send(socket, {
      id: request.id,
      stream: "stderr",
      data: `${error instanceof Error ? error.message : String(error)}\n`,
    });
    send(socket, { id: request.id, exitCode: 1 });
  } finally {
    active.delete(request.id);
    socket.end();
  }
}

async function callTool(
  request: Extract<McpDaemonRequest, { type: "call" }>,
  socket: Socket
): Promise<void> {
  return context.with(mcpDaemonRequestContext(request.trace), () =>
    callToolRequest(request, socket)
  );
}

async function callToolRequest(
  request: Extract<McpDaemonRequest, { type: "call" }>,
  socket: Socket
): Promise<void> {
  const controller = new AbortController();
  let dispatched = false;
  active.set(request.id, controller);
  socket.once("close", () => controller.abort());
  try {
    const cachedCatalog = catalogPreloadResult?.find(
      (server) =>
        server.id === request.server &&
        !server.error &&
        server.tools.some((tool) => tool.name === request.tool)
    );
    const catalogs = cachedCatalog
      ? catalogPreloadResult!
      : await preloadCatalogs(request.timeoutMs);
    const catalog =
      cachedCatalog ??
      catalogs.find((server) => server.id === request.server);
    const allowed = catalog?.tools.some((tool) => tool.name === request.tool);
    if (!catalog || catalog.error || !allowed) {
      throw new Error(
        `MCP tool '${request.server}.${request.tool}' is not authorized in this daemon generation.`
      );
    }
    if (controller.signal.aborted) {
      throw new Error(
        `MCP tool call '${request.server}.${request.tool}' was cancelled before execution.`
      );
    }
    const result = await runtime().then((value) => {
      dispatched = true;
      return value.callTool(request.server, request.tool, {
        args: request.arguments,
        timeoutMs: request.timeoutMs,
        disableOAuth: true,
      });
    });
    if (controller.signal.aborted) {
      throw new Error(
        `MCP tool call '${request.server}.${request.tool}' was cancelled; remote outcome is unknown.`
      );
    }
    send(
      socket,
      { id: request.id, result },
      `MCP tool call '${request.server}.${request.tool}' completed but its response could not be returned; remote outcome is unknown; do not retry automatically.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(socket, {
      id: request.id,
      error:
        dispatched && !message.includes("do not retry automatically")
          ? `${message}; remote outcome is unknown; do not retry automatically.`
          : message,
    });
  } finally {
    active.delete(request.id);
    socket.end();
  }
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const controller of active.values()) controller.abort();
  server.close();
  if (runtimePromise) {
    await Promise.race([
      runtimePromise.then((value) => value.close()).catch(() => {}),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
        timer.unref();
      }),
    ]);
  }
  restoreIo();
  if (process.platform !== "win32") await rm(socketPath, { force: true });
}

function handle(request: McpDaemonRequest, socket: Socket): void {
  if (request.token !== token) {
    send(socket, { id: request.id, error: "unauthorized" });
    socket.end();
    return;
  }
  if (request.type === "ping") {
    if (stopping) {
      send(socket, { id: request.id, error: "daemon_unavailable" });
    } else if (request.fingerprint !== fingerprint) {
      send(socket, { id: request.id, error: "configuration_mismatch" });
    } else {
      send(socket, { id: request.id, ready: true, fingerprint });
    }
    socket.end();
    return;
  }
  if (
    (request.type === "execute" || request.type === "call") &&
    active.has(request.id)
  ) {
    send(socket, { id: request.id, error: "duplicate_request_id" });
    socket.end();
    return;
  }
  if (request.type === "cancel") {
    active.get(request.requestId)?.abort();
    send(socket, { id: request.id, exitCode: 0 });
    socket.end();
    return;
  }
  if (request.type === "stop") {
    send(socket, { id: request.id, exitCode: 0 });
    socket.end(() => void shutdown().then(() => process.exit(0)));
    return;
  }
  if (stopping || request.fingerprint !== fingerprint) {
    send(socket, { id: request.id, error: "daemon_unavailable" });
    socket.end();
    return;
  }
  if (request.type === "catalog") {
    const catalogs = request.allowPartial
      ? runtime()
          .then((value) => discoverMcpCatalogs(value, request.timeoutMs))
          .then((result) => {
            catalogPreloadResult = result;
            if (!catalogHealthy(result)) {
              void preloadCatalogs(request.timeoutMs).catch(() => {});
            }
            return result;
          })
      : preloadCatalogs(request.timeoutMs);
    void catalogs
      .then(
        (catalogs) => send(socket, { id: request.id, catalogs }),
        (error) =>
          send(socket, {
            id: request.id,
            error: error instanceof Error ? error.message : String(error),
          })
      )
      .finally(() => socket.end());
    return;
  }
  if (request.type === "call") {
    void callTool(request, socket);
    return;
  }
  void execute(request, socket);
}

const server = createServer((socket) => {
  // Client cancellation may close the command socket before its final
  // envelope is written. That is a connection-level outcome, not a daemon
  // failure.
  socket.on("error", () => {});
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (
      newline < 0 &&
      Buffer.byteLength(buffer, "utf8") > MCP_DAEMON_MAX_FRAME_BYTES
    ) {
      send(socket, { id: "unknown", error: "request_too_large" });
      socket.end();
      return;
    }
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (Buffer.byteLength(line, "utf8") > MCP_DAEMON_MAX_FRAME_BYTES) {
      send(socket, { id: "unknown", error: "request_too_large" });
      socket.end();
      return;
    }
    try {
      handle(JSON.parse(line) as McpDaemonRequest, socket);
    } catch {
      send(socket, { id: "unknown", error: "invalid_request" });
      socket.end();
    }
  });
});

if (process.platform !== "win32") await rm(socketPath, { force: true });
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(socketPath, () => {
    server.off("error", reject);
    resolve();
  });
});
// Parse the session config and construct mcporter in the background, but do
// not connect to endpoint servers until a real command arrives. Synthetic
// task warmups may not carry endpoint credentials yet.
void runtime().catch(() => {});

const ownerPid = Number(process.env[MCP_DAEMON_PARENT_PID_ENV]);
if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
  const ownerWatch = setInterval(() => {
    try {
      process.kill(ownerPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        clearInterval(ownerWatch);
        void shutdown().then(() => process.exit(0));
      }
    }
  }, 1_000);
  ownerWatch.unref();
}
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.once("SIGQUIT", () => void shutdown().then(() => process.exit(0)));
