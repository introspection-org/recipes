import {
  MCP_DAEMON_FINGERPRINT_ENV,
  MCP_DAEMON_SOCKET_ENV,
  MCP_DAEMON_TOKEN_ENV,
} from "./protocol.js";
import type { McpDaemonServer, McpDaemonToolCall } from "./server.js";

/**
 * The daemon servers this process serves for its own sessions, by socket
 * path. A long-lived session host serves its session's socket from its own
 * process; a short-lived `mcp` command starts the standalone daemon instead.
 */
const starting = new Map<string, Promise<McpDaemonServer>>();
const serving = new Map<string, McpDaemonServer>();

interface HostedSession {
  socketPath: string;
  token: string;
  fingerprint: string;
}

/** The server this process hosts for the session, when it hosts one that is still open. */
export function hostedMcpDaemon(
  session: HostedSession,
): McpDaemonServer | undefined {
  const server = serving.get(session.socketPath);
  return server &&
    server.token === session.token &&
    server.fingerprint === session.fingerprint
    ? server
    : undefined;
}

/** Starts the session's server in this process, once per socket path. */
export function hostMcpDaemon(
  session: HostedSession,
  env: NodeJS.ProcessEnv,
): Promise<McpDaemonServer> {
  const existing = starting.get(session.socketPath);
  if (existing) return existing;
  const start = import("./server.js")
    .then(({ startMcpDaemonServer }) =>
      startMcpDaemonServer({ ...session, env, unref: true }),
    )
    .then((server) => {
      serving.set(session.socketPath, server);
      void server.closed.then(() => {
        if (serving.get(session.socketPath) === server)
          serving.delete(session.socketPath);
        if (starting.get(session.socketPath) === start)
          starting.delete(session.socketPath);
      });
      return server;
    });
  starting.set(session.socketPath, start);
  void start.catch(() => {
    if (starting.get(session.socketPath) === start)
      starting.delete(session.socketPath);
  });
  return start;
}

/** Closes the server this process hosts on the socket, if any; whether it hosted one. */
export async function closeHostedMcpDaemon(
  socketPath: string,
): Promise<boolean> {
  const start = starting.get(socketPath);
  if (!start) return false;
  const server = await start.catch(() => undefined);
  if (!server) return false;
  await server.close();
  return true;
}

/** The server this process hosts for the session `env` names, if any. */
export function hostedMcpDaemonFor(
  env: NodeJS.ProcessEnv,
): McpDaemonServer | undefined {
  const socketPath = env[MCP_DAEMON_SOCKET_ENV];
  const token = env[MCP_DAEMON_TOKEN_ENV];
  const fingerprint = env[MCP_DAEMON_FINGERPRINT_ENV];
  if (!socketPath || !token || !fingerprint) return undefined;
  return hostedMcpDaemon({ socketPath, token, fingerprint });
}

/**
 * Calls a tool on a server this process hosts, without the socket: the same
 * authorization, the same per-call timeout with a hard stop a second after
 * it, the same cancellation, and the same errors as `callMcpDaemonTool`.
 */
export async function callHostedMcpTool(
  daemon: McpDaemonServer,
  call: McpDaemonToolCall,
  signal?: AbortSignal,
): Promise<unknown> {
  const name = `${call.server}.${call.tool}`;
  if (signal?.aborted) {
    throw new Error(`MCP tool call '${name}' was cancelled before execution.`);
  }
  const controller = new AbortController();
  let timedOut = false;
  const stopped = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () =>
        reject(
          new Error(
            `MCP tool call '${name}' ${
              timedOut ? "timed out" : "was cancelled"
            }; remote outcome is unknown; do not retry automatically.`,
          ),
        ),
      { once: true },
    );
  });
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const hardTimeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, call.timeoutMs + 1_000);
  hardTimeout.unref();
  const result = daemon.callTool(call, controller.signal).catch((error) => {
    throw new Error(
      `MCP daemon: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  });
  try {
    return await Promise.race([result, stopped]);
  } finally {
    clearTimeout(hardTimeout);
    signal?.removeEventListener("abort", onAbort);
    // The call may still settle after a cancellation; its outcome is unknown.
    void result.catch(() => {});
    void stopped.catch(() => {});
  }
}
