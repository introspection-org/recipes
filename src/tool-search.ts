import {
  createToolSearchExtension,
  type ExtensionAPI,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const RECIPE_TOOL_SEARCH_NAME = "tool_search";
export const LEGACY_MCP_TOOL_SEARCH_NAME = "mcp_search";

export type RecipeToolActivation = Pick<
  ExtensionAPI,
  "getAllTools" | "getActiveTools" | "setActiveTools"
>;

/**
 * Pi's `tool_search`, plus `mcp_search` as an alias when MCP tools are
 * deferred. It searches tools registered with `deferred` exposure and declares
 * the matches for the next model request.
 */
export function createRecipeToolSearchTools(
  tools: RecipeToolActivation,
  includeLegacyMcpAlias: boolean
): ToolDefinition[] {
  let search: ToolDefinition | undefined;
  createToolSearchExtension()({
    ...tools,
    registerTool: (definition: ToolDefinition) => {
      search = definition;
    },
  } as unknown as ExtensionAPI);
  if (!search) throw new Error("Pi did not provide tool_search");
  const { defaultActive: _defaultActive, ...definition } = search;
  return includeLegacyMcpAlias
    ? [
        definition,
        {
          ...definition,
          name: LEGACY_MCP_TOOL_SEARCH_NAME,
          label: LEGACY_MCP_TOOL_SEARCH_NAME,
        },
      ]
    : [definition];
}

/** Register the named tools with `deferred` exposure, so tool search can load them. */
export function deferTools(
  factory: ExtensionFactory,
  deferredToolNames: readonly string[]
): ExtensionFactory {
  if (deferredToolNames.length === 0) return factory;
  const deferred = new Set(deferredToolNames);
  return (pi) =>
    factory(
      new Proxy(pi, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property !== "registerTool" || typeof value !== "function") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (definition: ToolDefinition) =>
            value.call(
              target,
              deferred.has(definition.name)
                ? { ...definition, exposure: "deferred" }
                : definition
            );
        },
      })
    );
}
