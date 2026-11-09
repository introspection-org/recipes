import {
  createToolSearchExtension,
  type ExtensionAPI,
  type ExtensionFactory,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";

import type { RecipeToolExposure } from "./recipe/agent.js";

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
  includeLegacyMcpAlias: boolean,
  unsearchable: (tool: ToolInfo) => boolean = () => false,
): ToolDefinition[] {
  let search: ToolDefinition | undefined;
  createToolSearchExtension()({
    getActiveTools: () => tools.getActiveTools(),
    setActiveTools: (names: string[]) => tools.setActiveTools(names),
    getAllTools: () =>
      tools.getAllTools().filter((tool) => !unsearchable(tool)),
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
  deferredToolNames: readonly string[],
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
                : definition,
            );
        },
      }),
    );
}

/**
 * Register each tool that sets no `exposure` with the one `exposure` gives
 * it, so a first-party tool a host or Recipe extension registers, such as
 * `web_search`, follows the agent's `tools` policy.
 */
export function withToolExposure(
  factory: ExtensionFactory,
  exposure: (name: string) => RecipeToolExposure,
): ExtensionFactory {
  return (pi) =>
    factory(
      new Proxy(pi, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property !== "registerTool" || typeof value !== "function") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (definition: ToolDefinition, ...rest: unknown[]) =>
            value.call(target, withExposure(definition, exposure), ...rest);
        },
      }),
    );
}

/** A tool definition that sets no `exposure`, given the one `exposure` chooses; see {@link withToolExposure}. */
export function withExposure<
  T extends Pick<ToolDefinition, "name" | "exposure">,
>(definition: T, exposure: (name: string) => RecipeToolExposure): T {
  if (definition.exposure !== undefined) return definition;
  const chosen = exposure(definition.name);
  return chosen === "direct" ? definition : { ...definition, exposure: chosen };
}
