import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { RecipePackageIssues } from "../recipe/package.js";
import {
  loadProviderModules,
  type ProviderFamily,
} from "../recipe/providers.js";
import { registerIssuesTool, type IssuesToolProvider } from "./tool.js";
import {
  ISSUES_COMMANDS,
  ISSUES_FALLBACK_PROVIDER,
  ISSUES_MODULE_API_VERSION,
  ISSUES_TOOL_NAME,
  type RecipeIssuesProviderModule,
} from "./types.js";

/** The package that serves the first-party issues providers, a companion of Recipes. */
export const ISSUES_PROVIDERS_PACKAGE = "@introspection-ai/recipe-issues";

/** The issues family for `loadProviderModules`: every first-party id is in one bundle. */
export const ISSUES_PROVIDER_FAMILY: ProviderFamily<RecipeIssuesProviderModule> =
  {
    kind: "issues",
    apiName: "issues module",
    apiVersion: ISSUES_MODULE_API_VERSION,
    firstPartyPackage: () => ISSUES_PROVIDERS_PACKAGE,
    firstPartyBundle: true,
    idOf: (module) => module.id,
  };

/**
 * The providers a Recipe's `pi.issues` loads: each declared one, plus the
 * `introspection` fallback when it is not declared, and without it when it is
 * declared with `enabled: false`.
 */
export function issuesProviderDeclarations(
  declared: readonly RecipePackageIssues[],
): RecipePackageIssues[] {
  const kept = declared.filter((declaration) => declaration.enabled !== false);
  return declared.some(
    (declaration) => declaration.provider === ISSUES_FALLBACK_PROVIDER,
  )
    ? kept
    : [...kept, { provider: ISSUES_FALLBACK_PROVIDER }];
}

function contractProblem(
  module: RecipeIssuesProviderModule,
): string | undefined {
  if (typeof module.createSession !== "function") return "has no createSession";
  const capabilities = module.capabilities as unknown;
  if (!capabilities || typeof capabilities !== "object")
    return "has no capabilities";
  const { commands, fields, hosts } =
    capabilities as RecipeIssuesProviderModule["capabilities"];
  if (!commands || typeof commands !== "object")
    return "declares no capabilities.commands";
  const unknown = Object.keys(commands).filter(
    (command) => !(ISSUES_COMMANDS as readonly string[]).includes(command),
  );
  if (unknown.length > 0)
    return `declares unknown command(s): ${unknown.join(", ")}`;
  if (!Array.isArray(fields)) return "declares no capabilities.fields";
  if (!Array.isArray(hosts)) return "declares no capabilities.hosts";
  const { options } =
    capabilities as RecipeIssuesProviderModule["capabilities"];
  if (
    options !== undefined &&
    (!options ||
      typeof options !== "object" ||
      Object.values(options).some(
        (type) => type !== "string" && type !== "boolean",
      ))
  )
    return "declares capabilities.options that are not a map of option name to string or boolean";
  if (module.mcp !== undefined) {
    const { url, server, tools } = module.mcp;
    if (typeof url !== "string" || typeof server !== "string" || !server)
      return "has an MCP adapter without a url and server";
    if (!Array.isArray(tools) || tools.length === 0)
      return "has an MCP adapter without tools";
  }
  return undefined;
}

export interface LoadedRecipeIssues {
  extension?: { owner: string; factory: ExtensionFactory };
  toolNames: string[];
}

/**
 * Load the Recipe's `pi.issues` providers and, when the agent selects the
 * `issues` tool, one extension registering it. Without `pi.issues` nothing
 * loads and no tool is offered.
 */
export async function loadRecipeIssues(
  declarations: readonly RecipePackageIssues[] | undefined,
  agentTools: readonly string[],
  options: {
    recipeDir: string;
    env?: NodeJS.ProcessEnv;
    /** Where companion packages resolve from. Default: where `@introspection-ai/recipes` is installed. */
    hostDir?: string;
    /** How a first-party tool registers for the agent (`platform.mode`). Default: declared. */
    exposure?: (tool: string) => "direct" | "codemode";
  },
): Promise<LoadedRecipeIssues> {
  if (declarations === undefined) return { toolNames: [] };
  const effective = issuesProviderDeclarations(declarations);
  const loaded = await loadProviderModules(ISSUES_PROVIDER_FAMILY, effective, {
    recipeDir: options.recipeDir,
    ...(options.hostDir !== undefined ? { hostDir: options.hostDir } : {}),
  });
  const providers: IssuesToolProvider[] = loaded.map(
    ({ declaration, module }) => {
      const problem = contractProblem(module);
      if (problem)
        throw new Error(
          `Recipe issues provider '${declaration.provider}' ${problem}`,
        );
      const settings = (declaration as RecipePackageIssues).options ?? {};
      const schema = module.capabilities.options ?? {};
      for (const [name, value] of Object.entries(settings)) {
        if (schema[name] === undefined)
          throw new Error(
            `Recipe issues provider '${declaration.provider}' takes no option '${name}'${Object.keys(schema).length ? `; it takes ${Object.keys(schema).join(", ")}` : ""}`,
          );
        if (typeof value !== schema[name])
          throw new Error(
            `Recipe issues provider '${declaration.provider}' option '${name}' must be a ${schema[name]}`,
          );
      }
      const server = settings.server;
      return {
        module,
        config: { provider: declaration.provider, options: settings },
        ...(module.mcp
          ? {
              server: typeof server === "string" ? server : module.mcp.server,
            }
          : {}),
        fallback: declaration.provider === ISSUES_FALLBACK_PROVIDER,
      };
    },
  );
  if (!agentTools.includes(ISSUES_TOOL_NAME) || providers.length === 0)
    return { toolNames: [] };
  return {
    toolNames: [ISSUES_TOOL_NAME],
    extension: {
      owner: "<issues>",
      factory: (pi) => {
        registerIssuesTool(pi, {
          providers,
          env: options.env ?? process.env,
          ...(options.exposure
            ? { exposure: options.exposure(ISSUES_TOOL_NAME) }
            : {}),
        });
      },
    },
  };
}
