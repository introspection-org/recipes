import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  MCP_DAEMON_FINGERPRINT_ENV,
  MCP_DAEMON_SOCKET_ENV,
  MCP_DAEMON_TOKEN_ENV,
  MCP_SESSION_ROOT_ENV,
  type McpDaemonEnvelope,
  type McpDaemonRequest,
} from "./protocol.js";
import { mcpTraceContextFromEnv } from "../trace-context.js";

const START_TIMEOUT_MS = 20_000;
const MAX_DAEMON_FRAME_BYTES = 10 * 1024 * 1024;

export function daemonPath(): string {
  // The BUNDLE, not this module's tsc sibling. `build-mcp-daemon.mjs` emits a
  // self-contained `dist/mcp-daemon.js`; spawning the unbundled daemon would
  // resolve the whole module graph at startup, which is the cost the bundle
  // exists to avoid. From source neither exists, so the fallback runs.
  const bundled = fileURLToPath(new URL("../../mcp-daemon.js", import.meta.url));
  if (existsSync(bundled)) return bundled;
  return fileURLToPath(new URL("../../../dist/mcp-daemon.js", import.meta.url));
}

export function mcpDaemonEnvironment(env: NodeJS.ProcessEnv = process.env): {
  socketPath: string;
  token: string;
  fingerprint: string;
} {
  const socketPath = env[MCP_DAEMON_SOCKET_ENV];
  const token = env[MCP_DAEMON_TOKEN_ENV];
  const fingerprint = env[MCP_DAEMON_FINGERPRINT_ENV];
  if (!socketPath || !token || !fingerprint) {
    throw new Error("MCP daemon environment is incomplete.");
  }
  return { socketPath, token, fingerprint };
}

export function exchangeMcpDaemon(
  request: McpDaemonRequest,
  onEnvelope: (envelope: McpDaemonEnvelope, socket: Socket) => void,
  env: NodeJS.ProcessEnv = process.env,
  onRequestWritten?: () => void
): Promise<void> {
  const { socketPath } = mcpDaemonEnvironment(env);
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
      onRequestWritten?.();
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (
        buffer.indexOf("\n") < 0 &&
        Buffer.byteLength(buffer, "utf8") > MAX_DAEMON_FRAME_BYTES
      ) {
        socket.destroy();
        reject(new Error("MCP daemon response exceeded the frame limit."));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") > MAX_DAEMON_FRAME_BYTES) {
          socket.destroy();
          reject(new Error("MCP daemon response exceeded the frame limit."));
          return;
        }
        if (line) onEnvelope(JSON.parse(line) as McpDaemonEnvelope, socket);
        newline = buffer.indexOf("\n");
      }
    });
    socket.once("end", resolve);
    socket.once("error", reject);
  });
}

async function ping(env: NodeJS.ProcessEnv): Promise<boolean> {
  const { token, fingerprint } = mcpDaemonEnvironment(env);
  let ready = false;
  await exchangeMcpDaemon(
    { type: "ping", id: randomUUID(), token, fingerprint },
    (envelope) => {
      if ("ready" in envelope && envelope.fingerprint === fingerprint) ready = true;
    },
    env
  ).catch(() => {});
  return ready;
}

export async function ensureMcpDaemon(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (await ping(env)) return;
  const { socketPath } = mcpDaemonEnvironment(env);
  const lockPath = `${socketPath}.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = Number(await readFile(lockPath, "utf8").catch(() => ""));
    if (Number.isSafeInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code === "ESRCH") {
          await rm(lockPath, { force: true });
          return ensureMcpDaemon(env);
        }
      }
    }
  }

  if (lock) {
    try {
      await lock.writeFile(String(process.pid));
      if (process.platform !== "win32") await rm(socketPath, { force: true });
      const child = spawn(process.execPath, [daemonPath()], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ...env },
        cwd: env[MCP_SESSION_ROOT_ENV] || process.cwd(),
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } catch (error) {
      await rm(lockPath, { force: true });
      throw error;
    } finally {
      await lock.close();
    }
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await ping(env)) {
      if (lock) await rm(lockPath, { force: true });
      return;
    }
    await delay(50);
  }
  if (lock) await rm(lockPath, { force: true });
  throw new Error("MCP daemon did not become ready before the startup deadline.");
}

export async function callMcpDaemonTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  options: {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}
): Promise<unknown> {
  const env = options.env ?? process.env;
  const traceContext = mcpTraceContextFromEnv(env);
  const signal = options.signal;
  if (signal?.aborted) {
    throw new Error(
      `MCP tool call '${server}.${tool}' was cancelled before execution.`
    );
  }
  await ensureMcpDaemon(env);
  if (signal?.aborted) {
    throw new Error(
      `MCP tool call '${server}.${tool}' was cancelled before execution.`
    );
  }
  const { token, fingerprint } = mcpDaemonEnvironment(env);
  const id = randomUUID();
  const timeoutMs = options.timeoutMs ?? 120_000;
  let result: unknown;
  let hasResult = false;
  let daemonError: string | undefined;
  let requestWritten = false;
  let aborted = false;
  let timedOut = false;
  let resolveAbort: (() => void) | undefined;
  const abortPromise = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const sendCancel = () => {
    let cancelToken: string;
    try {
      ({ token: cancelToken } = mcpDaemonEnvironment(env));
    } catch {
      return;
    }
    void exchangeMcpDaemon(
      {
        type: "cancel",
        id: randomUUID(),
        token: cancelToken,
        requestId: id,
      },
      () => {},
      env
    ).catch(() => {});
  };
  const onAbort = () => {
    aborted = true;
    resolveAbort?.();
    sendCancel();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const hardTimeout = setTimeout(() => {
    timedOut = true;
    aborted = true;
    resolveAbort?.();
    sendCancel();
  }, timeoutMs + 1_000);
  hardTimeout.unref?.();
  const exchange = exchangeMcpDaemon(
    {
      type: "call",
      id,
      token,
      fingerprint,
      server,
      tool,
      arguments: args,
      timeoutMs,
      ...(traceContext ? { trace: traceContext } : {}),
    },
    (envelope, socket) => {
      if ("result" in envelope) {
        result = envelope.result;
        hasResult = true;
        socket.end();
      } else if ("error" in envelope) {
        daemonError = envelope.error;
        socket.end();
      }
    },
    env,
    () => {
      requestWritten = true;
    }
  );
  try {
    await Promise.race([exchange, abortPromise]);
  } catch (error) {
    if (requestWritten) {
      throw new Error(
        `MCP tool call '${server}.${tool}' lost its daemon response after dispatch; remote outcome is unknown; do not retry automatically.`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    clearTimeout(hardTimeout);
    signal?.removeEventListener("abort", onAbort);
  }
  if (aborted) {
    // The remote request may already have crossed the transport boundary.
    // Cancellation is best-effort, so detach the exchange while retaining an
    // error handler and report the outcome as unknown immediately.
    void exchange.catch(() => {});
    throw new Error(
      `MCP tool call '${server}.${tool}' ${
        timedOut ? "timed out" : "was cancelled"
      }; remote outcome is unknown; do not retry automatically.`
    );
  }
  if (daemonError) throw new Error(`MCP daemon: ${daemonError}`);
  if (!hasResult) {
    throw new Error(
      requestWritten
        ? `MCP tool call '${server}.${tool}' returned no daemon result after dispatch; remote outcome is unknown; do not retry automatically.`
        : "MCP daemon returned no tool result."
    );
  }
  return result;
}
