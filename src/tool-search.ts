import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const RECIPE_TOOL_SEARCH_NAME = "tool_search";
export const LEGACY_MCP_TOOL_SEARCH_NAME = "mcp_search";

export interface RecipeToolActivation {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export interface RecipeToolSearchOptions {
  tools: readonly RecipeSearchableTool[];
  deferredToolNames: readonly string[];
  activation: RecipeToolActivation;
}

export interface RecipeSearchableTool {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly parameters?: unknown;
}

interface ScoredTool {
  tool: RecipeSearchableTool;
  score: number;
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function schemaSearchTerms(schema: unknown): {
  propertyNames: string;
  propertyDescriptions: string;
} {
  const propertyNames: string[] = [];
  const propertyDescriptions: string[] = [];
  const visited = new Set<object>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    const record = value as Record<string, unknown>;
    if (record.properties && typeof record.properties === "object") {
      for (const [name, property] of Object.entries(
        record.properties as Record<string, unknown>
      )) {
        propertyNames.push(name);
        if (property && typeof property === "object") {
          const description = (property as Record<string, unknown>).description;
          if (typeof description === "string") {
            propertyDescriptions.push(description);
          }
        }
        visit(property);
      }
    }
    for (const keyword of [
      "allOf",
      "anyOf",
      "oneOf",
      "items",
      "additionalProperties",
    ]) {
      const nested = record[keyword];
      if (Array.isArray(nested)) {
        for (const entry of nested) visit(entry);
      } else {
        visit(nested);
      }
    }
  };

  visit(schema);
  return {
    propertyNames: propertyNames.join(" ").toLowerCase(),
    propertyDescriptions: propertyDescriptions.join(" ").toLowerCase(),
  };
}

function scoreTool(tool: RecipeSearchableTool, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return 0;
  const name = tool.name.toLowerCase();
  const label = (tool.label ?? tool.name).toLowerCase();
  const description = tool.description.toLowerCase();
  const { propertyNames, propertyDescriptions } = schemaSearchTerms(
    tool.parameters
  );
  let score = 0;
  if (name === normalizedQuery) score += 500;
  if (label === normalizedQuery) score += 300;
  if (name.includes(normalizedQuery)) score += 120;
  if (label.includes(normalizedQuery)) score += 100;
  if (description.includes(normalizedQuery)) score += 60;

  const nameTerms = new Set(words(name));
  const labelTerms = new Set(words(label));
  const propertyNameTerms = new Set(words(propertyNames));
  for (const term of words(normalizedQuery)) {
    if (nameTerms.has(term)) score += 40;
    else if (name.includes(term)) score += 20;
    if (labelTerms.has(term)) score += 30;
    else if (label.includes(term)) score += 15;
    if (description.includes(term)) score += 16;
    if (propertyNameTerms.has(term)) score += 12;
    else if (propertyNames.includes(term)) score += 6;
    if (propertyDescriptions.includes(term)) score += 6;
  }
  return score;
}

export function createRecipeToolSearch(
  options: RecipeToolSearchOptions
): ToolDefinition | undefined {
  const toolsByName = new Map(
    options.tools.map((tool) => [tool.name, tool] as const)
  );
  const deferred = [...new Set(options.deferredToolNames)].map((name) => {
    const tool = toolsByName.get(name);
    if (!tool) {
      throw new Error(
        `Recipe deferred tool '${name}' was not registered before tool search`
      );
    }
    return tool;
  });
  if (deferred.length === 0) return undefined;
  if (toolsByName.has(RECIPE_TOOL_SEARCH_NAME)) {
    throw new Error(
      `Recipe tool name '${RECIPE_TOOL_SEARCH_NAME}' is reserved by the session`
    );
  }

  return {
    name: RECIPE_TOOL_SEARCH_NAME,
    label: "Tool search",
    description:
      "Search inactive tools allowed for this Recipe and enable the best matches for the next model request.",
    parameters: Type.Object({
      query: Type.String({
        description: "Capability or task to find a tool for.",
      }),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 10, default: 3 })
      ),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const input = params as { query?: unknown; limit?: unknown };
      const query = typeof input.query === "string" ? input.query : "";
      const limit = typeof input.limit === "number" ? input.limit : 3;
      const active = new Set(options.activation.getActiveTools());
      const matches = deferred
        .filter((tool) => !active.has(tool.name))
        .map((tool): ScoredTool => ({ tool, score: scoreTool(tool, query) }))
        .filter((match) => match.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.tool.name.localeCompare(right.tool.name)
        )
        .slice(0, limit);
      const added = matches.map((match) => match.tool.name);
      if (added.length > 0) {
        options.activation.setActiveTools([...active, ...added]);
      }
      const details = {
        matches: matches.map(({ tool }) => ({
          name: tool.name,
          label: tool.label ?? tool.name,
          description: tool.description,
        })),
        added,
      };
      const text =
        matches.length === 0
          ? `No inactive Recipe tools matched "${query}".`
          : [
              `Enabled ${matches.length} Recipe tool(s) for the next model request:`,
              ...matches.map(
                ({ tool }) =>
                  `- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`
              ),
            ].join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details,
      };
    },
  };
}

export function createRecipeToolSearchTools(
  options: RecipeToolSearchOptions,
  includeLegacyMcpAlias: boolean
): ToolDefinition[] {
  const search = createRecipeToolSearch(options);
  if (!search) return [];
  if (!includeLegacyMcpAlias) return [search];
  if (options.tools.some((tool) => tool.name === LEGACY_MCP_TOOL_SEARCH_NAME)) {
    throw new Error(
      `Recipe tool name '${LEGACY_MCP_TOOL_SEARCH_NAME}' is reserved by the session`
    );
  }
  return [
    search,
    {
      ...search,
      name: LEGACY_MCP_TOOL_SEARCH_NAME,
      label: "MCP search",
    },
  ];
}
