function envPrefixForServer(id: string): string {
  const normalized = id
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized.replace(/_MCP$/, "") || "MCP";
}

/** The generated-binding env var names for a package MCP server id. */
export function generatedBindingEnvVars(serverId: string): string[] {
  const prefix = envPrefixForServer(serverId);
  return [`${prefix}_MCP_URL`, `${prefix}_MCP_TOKEN`];
}
