import { existsSync } from "node:fs";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { context } from "@opentelemetry/api";

import { createMcpRuntime } from "../pi-runtime.js";
import {
  installMcpCommandIoRouting,
  runWithMcpCommandEnv,
  type McpRuntime,
} from "../cli/command-context.js";
import { discoverMcpCatalogs, executeMcpCommand } from "../cli/core.js";
import {
  isMcpDaemonSocketDirectory,
  MCP_DAEMON_MAX_FRAME_BYTES,
  type McpCatalogServer,
  type McpDaemonEnvelope,
  type McpDaemonRequest,
  serializeMcpDaemonEnvelope,
} from "./protocol.js";
import { mcpDaemonRequestContext } from "../trace-context.js";

const SHUTDOWN_GRACE_MS = 1_000;
const CATALOG_PRELOAD_BACKOFF_MS = [100, 250, 500, 1_000, 2_000] as const;
/** In-flight `execute` and `call` requests a server runs at once; the rest queue. */
export const MCP_DAEMON_MAX_IN_FLIGHT = 32;

export interface McpDaemonServerOptions {
  socketPath: string;
  token: string;
  fingerprint: string;
  /** The session environment the server's commands, runtime and run workers read. */
  env: NodeJS.ProcessEnv;
  /** The `mcp run` worker; the standalone entry passes the one beside it. */
  runWorkerPath?: string;
  maxInFlight?: number;
  /** Lets the process exit while the server listens, for a server hosted inside a session. */
  unref?: boolean;
  /** Runs once a client's `stop` request has closed the server. */
  onStop?: () => void;
}

export interface McpDaemonToolCall {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
}

export interface McpDaemonServer {
  readonly socketPath: string;
  readonly token: string;
  readonly fingerprint: string;
  /** Settles once the server and its runtime have closed, however that happened. */
  readonly closed: Promise<void>;
  /**
   * Calls a tool the session's catalog authorizes, as a socket `call` request
   * does, in the caller's trace context.
   */
  callTool(call: McpDaemonToolCall, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * The run worker a session host starts. The host may load this module from
 * the package's tsc tree or from its own bundle, so the worker is found from
 * the package (`dist/mcp-run-worker.js`, beside the bundled daemon) before
 * the tsc tree's own copy.
 */
function packagedRunWorkerPath(): string {
  const packaged = new URL(
    "mcp-run-worker.js",
    import.meta.resolve("@introspection-ai/recipes"),
  );
  if (existsSync(packaged)) return fileURLToPath(packaged);
  return fileURLToPath(new URL("../cli/run-worker.js", import.meta.url));
}

function positiveIntegerEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** A FIFO limit on concurrent work; a waiter whose signal aborts leaves the queue. */
function createLimiter(limit: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };
  return async function acquire(signal: AbortSignal): Promise<() => void> {
    if (running < limit) {
      running += 1;
      return release;
    }
    return await new Promise<() => void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        resolve(release);
      };
      const onAbort = () => {
        const index = waiting.indexOf(grant);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      waiting.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };
}

/**
 * Serves the daemon's socket protocol for one MCP session: the standalone
 * `mcp-daemon.js` process, or a session host serving it from its own process.
 */
export async function startMcpDaemonServer(
  options: McpDaemonServerOptions,
): Promise<McpDaemonServer> {
  const { socketPath, token, fingerprint, env } = options;
  const runWorkerPath = options.runWorkerPath ?? packagedRunWorkerPath();
  const acquire = createLimiter(
    options.maxInFlight ?? MCP_DAEMON_MAX_IN_FLIGHT,
  );
  let runtimePromise: Promise<McpRuntime> | undefined;
  let catalogPreloadPromise: Promise<McpCatalogServer[]> | undefined;
  let catalogPreloadResult: McpCatalogServer[] | undefined;
  let wakeCatalogRetry: (() => void) | undefined;
  let catalogDemanded = false;
  let stopping: Promise<void> | undefined;
  const active = new Map<string, AbortController>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function runtime(): Promise<McpRuntime> {
    runtimePromise ??= createMcpRuntime(env.MCPORTER_CONFIG, env).catch(
      (error) => {
        runtimePromise = undefined;
        throw error;
      },
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

  function preloadCatalogs(timeoutMs: number): Promise<McpCatalogServer[]> {
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
        if (catalogPreloadPromise === preload)
          catalogPreloadPromise = undefined;
      },
      () => {
        if (catalogPreloadPromise === preload)
          catalogPreloadPromise = undefined;
      },
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
    serializationError = "response_too_large",
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
          () => {},
        );
      }
    }
  }

  function stream(
    id: string,
    name: "stdout" | "stderr",
    socket: Socket,
  ): Writable {
    return new Writable({
      write(chunk, _encoding, callback) {
        send(socket, { id, stream: name, data: String(chunk) });
        callback();
      },
    });
  }

  async function executeRun(
    request: Extract<McpDaemonRequest, { type: "execute" }>,
    socket: Socket,
    controller: AbortController,
  ): Promise<number> {
    const sharedRuntime = await runtime();
    const worker = new Worker(runWorkerPath, {
      env,
      workerData: {
        args: request.args,
        stdin: request.stdin,
        servers: sharedRuntime.listServers(),
      },
    });
    const hardTimeout = setTimeout(
      () => void worker.terminate(),
      positiveIntegerEnv(env.PI_RECIPES_MCP_RUN_TIMEOUT_MS, 120_000) + 2_000,
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
              .callTool(
                String(message.server),
                String(message.tool),
                message.options as never,
              )
              .then(
                (result) =>
                  worker.postMessage({
                    type: "toolResult",
                    id: message.id,
                    result,
                  }),
                (error) =>
                  worker.postMessage({
                    type: "toolError",
                    id: message.id,
                    message:
                      error instanceof Error ? error.message : String(error),
                  }),
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
          else
            finish(() =>
              reject(
                new Error(`mcp run worker exited before completion (${code}).`),
              ),
            );
        });
      });
    } finally {
      clearTimeout(hardTimeout);
      controller.signal.removeEventListener("abort", abort);
      await worker.terminate().catch(() => {});
    }
  }

  async function executeRequest(
    request: Extract<McpDaemonRequest, { type: "execute" }>,
    socket: Socket,
  ) {
    const controller = new AbortController();
    active.set(request.id, controller);
    socket.once("close", () => controller.abort());
    let release: (() => void) | undefined;
    try {
      release = await acquire(controller.signal).catch(() => undefined);
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
      release?.();
      active.delete(request.id);
      socket.end();
    }
  }

  /**
   * The authorization and dispatch a `call` request runs. Errors carry the
   * message the caller sees, marked once the call may have reached the server.
   */
  async function authorizedCall(
    call: McpDaemonToolCall,
    signal: AbortSignal,
  ): Promise<unknown> {
    const release = await acquire(signal).catch(() => {
      throw new Error(
        `MCP tool call '${call.server}.${call.tool}' was cancelled before execution.`,
      );
    });
    let dispatched = false;
    try {
      const cachedCatalog = catalogPreloadResult?.find(
        (server) =>
          server.id === call.server &&
          !server.error &&
          server.tools.some((tool) => tool.name === call.tool),
      );
      const catalogs = cachedCatalog
        ? catalogPreloadResult!
        : await preloadCatalogs(call.timeoutMs);
      const catalog =
        cachedCatalog ?? catalogs.find((server) => server.id === call.server);
      const allowed = catalog?.tools.some((tool) => tool.name === call.tool);
      if (!catalog || catalog.error || !allowed) {
        throw new Error(
          `MCP tool '${call.server}.${call.tool}' is not authorized in this daemon generation.`,
        );
      }
      if (signal.aborted) {
        throw new Error(
          `MCP tool call '${call.server}.${call.tool}' was cancelled before execution.`,
        );
      }
      const result = await runtime().then((value) => {
        dispatched = true;
        return value.callTool(call.server, call.tool, {
          args: call.arguments,
          timeoutMs: call.timeoutMs,
          disableOAuth: true,
          signal,
        });
      });
      if (signal.aborted) {
        throw new Error(
          `MCP tool call '${call.server}.${call.tool}' was cancelled; remote outcome is unknown.`,
        );
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        dispatched && !message.includes("do not retry automatically")
          ? `${message}; remote outcome is unknown; do not retry automatically.`
          : message,
        { cause: error },
      );
    } finally {
      release();
    }
  }

  async function callToolRequest(
    request: Extract<McpDaemonRequest, { type: "call" }>,
    socket: Socket,
  ): Promise<void> {
    const controller = new AbortController();
    active.set(request.id, controller);
    socket.once("close", () => controller.abort());
    try {
      const result = await authorizedCall(request, controller.signal);
      send(
        socket,
        { id: request.id, result },
        `MCP tool call '${request.server}.${request.tool}' completed but its response could not be returned; remote outcome is unknown; do not retry automatically.`,
      );
    } catch (error) {
      send(socket, {
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      active.delete(request.id);
      socket.end();
    }
  }

  function inSession<T>(
    trace: Parameters<typeof mcpDaemonRequestContext>[0],
    task: () => T,
  ): T {
    return context.with(mcpDaemonRequestContext(trace), () =>
      runWithMcpCommandEnv(env, task),
    );
  }

  function shutdown(): Promise<void> {
    stopping ??= (async () => {
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
      if (process.platform !== "win32") {
        await rm(socketPath, { force: true });
        await removeSocketDirectory(socketPath);
      }
      resolveClosed();
    })();
    return stopping;
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
      socket.end(() => void shutdown().then(() => options.onStop?.()));
      return;
    }
    if (stopping || request.fingerprint !== fingerprint) {
      send(socket, { id: request.id, error: "daemon_unavailable" });
      socket.end();
      return;
    }
    if (request.type === "catalog") {
      const catalogs = inSession(undefined, () =>
        request.allowPartial
          ? runtime()
              .then((value) => discoverMcpCatalogs(value, request.timeoutMs))
              .then((result) => {
                catalogPreloadResult = result;
                if (!catalogHealthy(result)) {
                  void preloadCatalogs(request.timeoutMs).catch(() => {});
                }
                return result;
              })
          : preloadCatalogs(request.timeoutMs),
      );
      void catalogs
        .then(
          (catalogs) => send(socket, { id: request.id, catalogs }),
          (error) =>
            send(socket, {
              id: request.id,
              error: error instanceof Error ? error.message : String(error),
            }),
        )
        .finally(() => socket.end());
      return;
    }
    if (request.type === "call") {
      void inSession(request.trace, () => callToolRequest(request, socket));
      return;
    }
    void inSession(request.trace, () => executeRequest(request, socket));
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

  const restoreIo = installMcpCommandIoRouting();
  try {
    if (process.platform !== "win32") {
      await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
      await rm(socketPath, { force: true });
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    restoreIo();
    throw error;
  }
  if (options.unref) server.unref();
  // Parse the session config and construct the runtime in the background, but
  // do not connect to endpoint servers until a real command arrives. Synthetic
  // task warmups may not carry endpoint credentials yet.
  void runtime().catch(() => {});

  return {
    socketPath,
    token,
    fingerprint,
    closed,
    callTool: (call, signal) => {
      if (stopping) {
        return Promise.reject(new Error("MCP daemon: daemon_unavailable"));
      }
      return runWithMcpCommandEnv(env, () => authorizedCall(call, signal));
    },
    close: shutdown,
  };
}

/** Removes the per-session socket directory once its socket has gone. */
async function removeSocketDirectory(socketPath: string): Promise<void> {
  const directory = dirname(socketPath);
  if (!isMcpDaemonSocketDirectory(directory)) return;
  await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
  });
}
