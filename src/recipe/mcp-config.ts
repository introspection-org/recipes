import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RecipePackageManifest } from "./package.js";

export interface RecipeMcpLocalConfigResult {
  path: string;
  created: boolean;
  source: "example" | "generated" | "existing";
  envVars: string[];
}

export function recipeMcpLocalExamplePath(recipeDir: string): string {
  return join(recipeDir, ".pi", "mcp.local.example.json");
}

export function recipeMcpLocalConfigPath(recipeDir: string): string {
  return join(recipeDir, ".pi", "mcp.local.json");
}

export function envPrefixForServer(id: string): string {
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

export function placeholderEnvVars(content: string): string[] {
  return Array.from(
    new Set(
      Array.from(content.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g))
        .map((match) => match[1]!)
        .sort()
    )
  );
}

function generatedMcpLocalConfig(manifest: RecipePackageManifest): string {
  const servers = manifest.mcp.servers.map((server) => {
    const prefix = envPrefixForServer(server.id);
    return {
      id: server.id,
      transport: "streamable_http",
      url: `\${${prefix}_MCP_URL}`,
      headers: {
        Authorization: `Bearer \${${prefix}_MCP_TOKEN}`,
      },
    };
  });

  return `${JSON.stringify({ servers }, null, 2)}\n`;
}

export async function materializeRecipeMcpLocalConfig(
  recipeDir: string,
  manifest: RecipePackageManifest
): Promise<RecipeMcpLocalConfigResult | undefined> {
  const target = recipeMcpLocalConfigPath(recipeDir);
  const example = recipeMcpLocalExamplePath(recipeDir);
  const hasExample = existsSync(example);
  const hasMcp =
    hasExample ||
    manifest.mcp.servers.length > 0 ||
    manifest.mcp.manifests.length > 0;

  if (!hasMcp) return undefined;

  if (existsSync(target)) {
    const content = await readFile(target, "utf8");
    return {
      path: target,
      created: false,
      source: "existing",
      envVars: placeholderEnvVars(content),
    };
  }

  await mkdir(dirname(target), { recursive: true });

  if (hasExample) {
    await copyFile(example, target);
    await chmod(target, 0o600);
    const content = await readFile(target, "utf8");
    return {
      path: target,
      created: true,
      source: "example",
      envVars: placeholderEnvVars(content),
    };
  }

  if (manifest.mcp.servers.length === 0) return undefined;

  const content = generatedMcpLocalConfig(manifest);
  await writeFile(target, content, { mode: 0o600 });
  return {
    path: target,
    created: true,
    source: "generated",
    envVars: placeholderEnvVars(content),
  };
}
