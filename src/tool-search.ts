import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const RECIPE_TOOL_SEARCH_NAME = "tool_search";
export const RECIPE_EXECUTE_TOOL_NAME = "execute";
export const LEGACY_MCP_TOOL_SEARCH_NAME = "mcp_search";

export interface RecipeToolActivation {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export interface RecipeToolSearchOptions {
  tools: readonly RecipeSearchableTool[];
  deferredToolNames: readonly string[];
  activation: RecipeToolActivation;
  /**
   * Capabilities callable through `execute` rather than registered with Pi.
   *
   * There is nothing to activate for these, so a match is answered with the
   * signature the program needs. Same tool, same query, different mechanics —
   * which is what lets one skill be written against either MCP mode.
   */
  disclosed?: readonly RecipeDisclosedTool[];
  /** Register even with nothing to search, for modes that promise the tool. */
  alwaysRegister?: boolean;
}

export interface RecipeDisclosedTool extends RecipeSearchableTool {
  /** How the program names it, e.g. `attio.search_records` or `tools["a-b"].x`. */
  readonly callable: string;
}

export interface RecipeSearchableTool {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly parameters?: unknown;
}

const DESCRIPTION_MAX_CHARS = 200;
const SCHEMA_NAME_MAX_CHARS = 60;
const SCHEMA_NAMES_MAX_CHARS = 400;
const SCHEMA_MAX_CHARS = 1_200;

/**
 * A disclosed tool's arguments, bounded.
 *
 * A search returns up to ten of these and they are model-visible, so an
 * unbounded serialization of a large catalog schema would blow past the limits
 * `execute` applies to its own output. A truncated JSON blob is worse than
 * useless for writing a call, so an oversized schema degrades to its property
 * names and required set instead.
 */
function renderParameters(parameters: unknown): string {
  const rendered = JSON.stringify(parameters ?? {});
  if (rendered.length <= SCHEMA_MAX_CHARS) return rendered;
  const schema = parameters as {
    properties?: Record<string, unknown>;
    required?: unknown;
  };
  const names = nameList(Object.keys(schema?.properties ?? {}));
  const required = nameList(
    Array.isArray(schema?.required) ? schema.required.map(String) : []
  );
  return names
    ? `{ properties: ${names}${required ? `; required: ${required}` : ""} } (schema too large to show in full)`
    : "(schema too large to show)";
}

/**
 * A comma-separated list of names, itself bounded.
 *
 * The fallback exists because the schema was already too large; a schema with
 * thousands of properties would otherwise route around the very limit that
 * sent it here.
 */
function nameList(names: readonly string[]): string {
  const kept: string[] = [];
  let length = 0;
  for (const name of names) {
    const clipped = clip(name, SCHEMA_NAME_MAX_CHARS);
    if (length + clipped.length > SCHEMA_NAMES_MAX_CHARS) {
      kept.push(`…${names.length - kept.length} more`);
      break;
    }
    kept.push(clipped);
    length += clipped.length + 2;
  }
  return kept.join(", ");
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * A disclosed tool's description, bounded.
 *
 * Ten of these are model-visible in one result. The schema beside them was
 * already clamped; leaving the prose unbounded routed around that.
 */
function clipDescription(description: string): string {
  return clip(description.split("\n")[0] ?? "", DESCRIPTION_MAX_CHARS);
}

interface ScoredTool<T extends RecipeSearchableTool = RecipeSearchableTool> {
  tool: T;
  score: number;
}

/**
 * A candidate carries which catalog it came from, so one ranked list can be
 * split back into activations and signatures without matching on name.
 */
interface RankedCandidate extends ScoredTool {
  disclosed: boolean;
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
  const disclosed = options.disclosed ?? [];
  // Execute mode documents a stable two-tool surface, so its `tool_search` is
  // registered even with nothing to disclose — a skill that calls it should get
  // a no-match answer, not an unavailable tool.
  if (deferred.length === 0 && disclosed.length === 0 && !options.alwaysRegister) {
    return undefined;
  }
  if (toolsByName.has(RECIPE_TOOL_SEARCH_NAME)) {
    throw new Error(
      `Recipe tool name '${RECIPE_TOOL_SEARCH_NAME}' is reserved by the session`
    );
  }

  return {
    name: RECIPE_TOOL_SEARCH_NAME,
    label: "Tool search",
    description:
      disclosed.length > 0
        ? "Search the tools allowed for this Recipe. Matches that run inside `execute` come back as signatures to call from a program; matches registered with Pi are enabled for the next model request."
        : "Search inactive tools allowed for this Recipe and enable the best matches for the next model request.",
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
      // Ranked as one list, not once per kind: two independent `slice(0, limit)`
      // calls would return 2x the requested matches and, worse, activate
      // deferred tools that were not among the best `limit` overall.
      const candidates: RankedCandidate[] = [
        ...deferred
          .filter((tool) => !active.has(tool.name))
          .map((tool) => ({ tool, disclosed: false as const })),
        ...disclosed.map((tool) => ({ tool, disclosed: true as const })),
      ]
        .map(
          ({ tool, disclosed }): RankedCandidate => ({
            tool,
            disclosed,
            score: scoreTool(tool, query),
          })
        )
        .filter((match) => match.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.tool.name.localeCompare(right.tool.name)
        )
        .slice(0, limit);
      const matches = candidates.filter((match) => !match.disclosed);
      const signatures = candidates.filter(
        (match): match is RankedCandidate & { tool: RecipeDisclosedTool } =>
          match.disclosed
      );
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
        signatures: signatures.map(({ tool }) => ({
          name: tool.name,
          callable: tool.callable,
          description: tool.description,
          parameters: tool.parameters,
        })),
      };
      const sections: string[] = [];
      if (matches.length > 0) {
        sections.push(
          [
            `Enabled ${matches.length} Recipe tool(s) for the next model request:`,
            ...matches.map(
              ({ tool }) =>
                `- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`
            ),
          ].join("\n")
        );
      }
      if (signatures.length > 0) {
        sections.push(
          [
            `Call these from an \`${RECIPE_EXECUTE_TOOL_NAME}\` program:`,
            ...signatures.map(({ tool }) =>
              [
                `- ${tool.callable}(args)${
                  tool.description ? ` — ${clipDescription(tool.description)}` : ""
                }`,
                `  args: ${renderParameters(tool.parameters)}`,
              ].join("\n")
            ),
          ].join("\n")
        );
      }
      const text =
        sections.length === 0
          ? `No inactive Recipe tools matched "${query}".`
          : sections.join("\n\n");
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
