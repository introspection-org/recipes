import type { RecipeMcpToolSelection } from "../recipe/package.js";
import type { RecipeAgentMcp } from "../recipe/agent.js";

export interface ScopedMcpToolSelection {
  serverId: string;
  tools: RecipeMcpToolSelection;
}

export function normalizeMcpServerId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || "mcp";
}

export function resolveAgentMcpSelections(
  mcp: RecipeAgentMcp | undefined,
): ScopedMcpToolSelection[] {
  return Object.entries(mcp?.servers ?? {}).map(([serverId, selection]) => ({
    serverId: normalizeMcpServerId(serverId),
    tools: selection,
  }));
}

/** The servers an agent keeps behind wrapper tools: server id to the tools in front of it. */
export function mcpServersBehindTools(
  mcp: RecipeAgentMcp | undefined,
): Map<string, readonly string[]> {
  return new Map(
    Object.entries(mcp?.servers ?? {}).flatMap(([serverId, selection]) =>
      selection.behind
        ? [[normalizeMcpServerId(serverId), selection.behind] as const]
        : [],
    ),
  );
}

export function executableRecipeToolNames(tools: readonly string[]): string[] {
  return [...tools];
}

export function mcpSelectionAllowsTool(
  selection: RecipeMcpToolSelection,
  toolName: string,
): boolean {
  const included =
    selection.include?.some((selector) => {
      const trimmed = selector.trim();
      return trimmed === "*" || trimmed === toolName;
    }) ?? false;
  if (!included) return false;
  return !(selection.exclude ?? []).some(
    (selector) => selector.trim() === toolName,
  );
}
