import { fileURLToPath } from "node:url";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { RecipePackageSignatures } from "../recipe/package.js";
import {
  loadProviderModules,
  type ProviderFamily,
} from "../recipe/providers.js";
import type { ProductivityFetch } from "../productivity/types.js";
import { registerSignaturesTool, type SignaturesToolProvider } from "./tool.js";
import {
  SIGNATURES_COMMANDS,
  SIGNATURES_MODULE_API_VERSION,
  SIGNATURES_TOOL_NAME,
  type RecipeSignaturesProviderModule,
} from "./types.js";

/** The package that serves the first-party signatures providers, a companion of Recipes. */
export const SIGNATURES_PROVIDERS_PACKAGE =
  "@introspection-ai/recipe-signatures";

/** The `signatures` skill, offered to every agent that selects the tool. It ships beside `dist/`. */
export const SIGNATURES_SKILL = fileURLToPath(
  new URL("../../skills/signatures/SKILL.md", import.meta.url),
);

/** The signatures family for `loadProviderModules`: every first-party id is in one bundle. */
export const SIGNATURES_PROVIDER_FAMILY: ProviderFamily<RecipeSignaturesProviderModule> =
  {
    kind: "signatures",
    apiName: "signatures module",
    apiVersion: SIGNATURES_MODULE_API_VERSION,
    firstPartyPackage: () => SIGNATURES_PROVIDERS_PACKAGE,
    firstPartyBundle: true,
    idOf: (module) => module.id,
  };

function contractProblem(
  module: RecipeSignaturesProviderModule,
): string | undefined {
  if (typeof module.createSession !== "function") return "has no createSession";
  const capabilities = module.capabilities as unknown;
  if (!capabilities || typeof capabilities !== "object")
    return "has no capabilities";
  const { commands, extensions, hosts, options } =
    capabilities as RecipeSignaturesProviderModule["capabilities"];
  if (
    !Array.isArray(commands) ||
    SIGNATURES_COMMANDS.some((command) => !commands.includes(command))
  )
    return `must serve every command: ${SIGNATURES_COMMANDS.join(", ")}`;
  if (!Array.isArray(extensions) || extensions.length === 0)
    return "declares no capabilities.extensions";
  if (!Array.isArray(hosts) || hosts.length === 0)
    return "declares no capabilities.hosts";
  if (
    options !== undefined &&
    (!options ||
      typeof options !== "object" ||
      Object.values(options).some(
        (type) => type !== "string" && type !== "boolean",
      ))
  )
    return "declares capabilities.options that are not a map of option name to string or boolean";
  return undefined;
}

export interface LoadedRecipeSignatures {
  extension?: { owner: string; factory: ExtensionFactory };
  toolNames: string[];
  skillPaths?: string[];
  /** The hosts the loaded provider declares, whether or not the agent selects the tool. */
  hosts?: readonly string[];
}

/**
 * Load the Recipe's `pi.signatures` provider and, when the agent selects the
 * `signatures` tool, one extension registering it. Without `pi.signatures`
 * nothing loads and no tool is offered.
 */
export async function loadRecipeSignatures(
  declarations: readonly RecipePackageSignatures[] | undefined,
  agentTools: readonly string[],
  options: {
    recipeDir: string;
    env?: NodeJS.ProcessEnv;
    /** Where companion packages resolve from. Default: where `@introspection-ai/recipes` is installed. */
    hostDir?: string;
    /** Where `outputs/` is. Default: the process's working directory. */
    cwd?: string;
    /** A host's request hook that attaches the credential itself. */
    fetch?: ProductivityFetch;
  },
): Promise<LoadedRecipeSignatures> {
  if (declarations === undefined || declarations.length === 0)
    return { toolNames: [] };
  if (declarations.length > 1)
    throw new Error(
      `Recipe declares ${declarations.length} signatures providers; a Recipe sends through one`,
    );
  const [loaded] = await loadProviderModules(
    SIGNATURES_PROVIDER_FAMILY,
    declarations,
    {
      recipeDir: options.recipeDir,
      ...(options.hostDir !== undefined ? { hostDir: options.hostDir } : {}),
    },
  );
  const { declaration, module } = loaded!;
  const problem = contractProblem(module);
  if (problem)
    throw new Error(
      `Recipe signatures provider '${declaration.provider}' ${problem}`,
    );
  const settings = (declaration as RecipePackageSignatures).options ?? {};
  const schema = module.capabilities.options ?? {};
  for (const [name, value] of Object.entries(settings)) {
    if (schema[name] === undefined)
      throw new Error(
        `Recipe signatures provider '${declaration.provider}' takes no option '${name}'${Object.keys(schema).length ? `; it takes ${Object.keys(schema).join(", ")}` : ""}`,
      );
    if (typeof value !== schema[name])
      throw new Error(
        `Recipe signatures provider '${declaration.provider}' option '${name}' must be a ${schema[name]}`,
      );
  }
  const provider: SignaturesToolProvider = {
    module,
    config: { provider: declaration.provider, options: settings },
  };
  const hosts = module.capabilities.hosts;
  if (!agentTools.includes(SIGNATURES_TOOL_NAME))
    return { toolNames: [], hosts };
  return {
    toolNames: [SIGNATURES_TOOL_NAME],
    hosts,
    skillPaths: [SIGNATURES_SKILL],
    extension: {
      owner: "<signatures>",
      factory: (pi) => {
        registerSignaturesTool(pi, {
          provider,
          env: options.env ?? process.env,
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
      },
    },
  };
}
