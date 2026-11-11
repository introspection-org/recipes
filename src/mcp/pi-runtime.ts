import { readFileSync } from "node:fs";

import type { McpRuntime } from "./cli/command-context.js";
import type { McporterConfig } from "./index.js";

/** `mcporter` keeps the `mcp` command on mcporter's runtime, for a release or two after pi-mcp became the default. */
export const MCP_CLIENT_ENV = "PI_RECIPES_MCP_CLIENT";

export function usesPiMcpClient(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MCP_CLIENT_ENV]?.trim() !== "mcporter";
}

/**
 * Whether pi-mcp can hold this session's connections. It needs the session's
 * config, runs no OAuth flow (mcporter does, on a person's machine) and has
 * no HTTP/1 fetch, so a config asking for either stays on mcporter.
 */
function piMcpServes(configPath: string | undefined): boolean {
  if (!configPath) return false;
  const config = JSON.parse(readFileSync(configPath, "utf8")) as McporterConfig;
  return !Object.values(config.mcpServers ?? {}).some(
    (server) => server.auth === "oauth" || server.httpFetch === "node-http1",
  );
}

/** Which client {@link createMcpRuntime} gives a session: pi-mcp, or mcporter when {@link MCP_CLIENT_ENV} asks for it or pi-mcp cannot serve the config. */
export function mcpRuntimeKind(
  configPath: string | undefined = process.env.MCPORTER_CONFIG,
  env: NodeJS.ProcessEnv = process.env,
): "pi-mcp" | "mcporter" {
  return usesPiMcpClient(env) && piMcpServes(configPath)
    ? "pi-mcp"
    : "mcporter";
}

/** The session's MCP runtime, on the client {@link mcpRuntimeKind} picks. */
export async function createMcpRuntime(
  configPath: string | undefined = process.env.MCPORTER_CONFIG,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpRuntime> {
  // Each client is loaded only here, so a session loads only the one it uses.
  if (mcpRuntimeKind(configPath, env) === "pi-mcp")
    return (await import("./pi-mcp-runtime.js")).PiMcpRuntime.fromConfigFile(
      configPath,
      env,
    );
  const { createRuntime } = await import("mcporter");
  return await createRuntime(configPath ? { configPath } : {});
}
