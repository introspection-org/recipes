import { randomUUID } from "node:crypto";

import {
  ensureMcpDaemon,
  exchangeMcpDaemon,
  mcpDaemonEnvironment,
} from "./daemon/client.js";
import type { McpCatalogServer } from "./daemon/protocol.js";

const DEFAULT_CATALOG_ATTEMPT_TIMEOUT_MS = 5_000;
const catalogPreloads = new Map<string, Promise<McpCatalogServer[]>>();

function preloadKey(env: NodeJS.ProcessEnv, allowPartial = false): string {
  const { socketPath, fingerprint } = mcpDaemonEnvironment(env);
  return `${socketPath}\0${fingerprint}\0${allowPartial ? "partial" : "strict"}`;
}

export function preloadMcpCatalogs(options: {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  allowPartial?: boolean;
} = {}): Promise<McpCatalogServer[]> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CATALOG_ATTEMPT_TIMEOUT_MS;
  const key = preloadKey(env, options.allowPartial);
  const existing = catalogPreloads.get(key);
  if (existing) return existing;

  const requestCatalogs = async (): Promise<McpCatalogServer[]> => {
    await ensureMcpDaemon(env);
    const { token, fingerprint } = mcpDaemonEnvironment(env);
    const id = randomUUID();
    let catalogs: McpCatalogServer[] | undefined;
    let daemonError: string | undefined;
    await exchangeMcpDaemon(
      {
        type: "catalog",
        id,
        token,
        fingerprint,
        timeoutMs,
        ...(options.allowPartial ? { allowPartial: true } : {}),
      },
      (envelope, socket) => {
        if ("catalogs" in envelope) {
          catalogs = envelope.catalogs;
          socket.end();
        } else if ("error" in envelope) {
          daemonError = envelope.error;
          socket.end();
        }
      },
      env
    );
    if (daemonError) throw new Error(`MCP daemon: ${daemonError}`);
    if (!catalogs) throw new Error("MCP daemon returned no catalog result.");
    const failures = catalogs.filter((server) => server.error);
    if (failures.length > 0 && !options.allowPartial) {
      throw new Error(
        `MCP catalog preload failed for ${failures
          .map((server) => `${server.id}: ${server.error}`)
          .join("; ")}`
      );
    }
    return catalogs;
  };
  const preload = requestCatalogs();
  catalogPreloads.set(key, preload);
  const forget = () => {
    if (catalogPreloads.get(key) === preload) catalogPreloads.delete(key);
  };
  // Concurrent callers share one request. Once it settles, only a fully
  // discovered result is reused: a partial one would hand a later session a
  // server's failure after the server has recovered, so the next caller asks
  // the daemon again. The cost is one more discovery attempt, bounded by
  // `timeoutMs`, for each later session while a server stays down.
  void preload.then(
    (catalogs) => {
      if (catalogs.some((server) => server.error)) forget();
    },
    forget
  );
  return preload;
}

export function clearMcpCatalogPreload(env: NodeJS.ProcessEnv = process.env): void {
  try {
    catalogPreloads.delete(preloadKey(env, false));
    catalogPreloads.delete(preloadKey(env, true));
  } catch {
    // An incomplete daemon environment has no preload state to clear.
  }
}

export type { McpCatalogServer } from "./daemon/protocol.js";
