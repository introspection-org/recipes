import { createRuntime } from "mcporter";

import type { McpRuntime } from "./cli/command-context.js";

/** Selects the client the `mcp` command and its daemon connect with. */
export const MCP_CLIENT_ENV = "PI_RECIPES_MCP_CLIENT";

export function usesPiMcpClient(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MCP_CLIENT_ENV]?.trim() === "pi-mcp";
}

/** The session's MCP runtime: mcporter's, or pi-mcp's when {@link MCP_CLIENT_ENV} selects it. */
export async function createMcpRuntime(
  configPath: string | undefined = process.env.MCPORTER_CONFIG,
): Promise<McpRuntime> {
  // Loaded only here, so the default mcporter path never loads pi-mcp.
  if (usesPiMcpClient())
    return (await import("./pi-mcp-runtime.js")).PiMcpRuntime.fromConfigFile(
      configPath,
    );
  return await createRuntime(configPath ? { configPath } : {});
}
