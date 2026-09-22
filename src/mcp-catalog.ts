import { randomUUID } from "node:crypto";

import {
  ensureMcpDaemon,
  exchangeMcpDaemon,
  mcpDaemonEnvironment,
} from "./mcp/daemon/client.js";
import type { McpCatalogServer } from "./mcp/daemon/protocol.js";

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
  void preload.catch(() => {
    if (catalogPreloads.get(key) === preload) catalogPreloads.delete(key);
  });
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

export type { McpCatalogServer } from "./mcp/daemon/protocol.js";
