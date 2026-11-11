import type { McpDaemonServer } from "./server.js";

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
