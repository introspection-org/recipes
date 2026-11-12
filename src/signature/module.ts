import { fileURLToPath } from "node:url";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { RecipePackageSignature } from "../recipe/package.js";
import {
  loadProviderModules,
  type ProviderFamily,
} from "../recipe/providers.js";
import type { ProductivityFetch } from "../productivity/types.js";
import { registerSignatureTool, type SignatureToolProvider } from "./tool.js";
import {
  SIGNATURE_MODULE_API_VERSION,
  SIGNATURE_PROVIDER_COMMANDS,
  SIGNATURE_TOOL_NAME,
  type RecipeSignatureProviderModule,
  type SignaturePublishDocument,
} from "./types.js";

/** The package that serves the first-party signature providers, a companion of Recipes. */
export const SIGNATURE_PROVIDERS_PACKAGE = "@introspection-ai/recipe-signature";

/** The `signature` skill, offered to every agent that selects the tool. It ships beside `dist/`. */
export const SIGNATURE_SKILL = fileURLToPath(
  new URL("../../skills/signature/SKILL.md", import.meta.url),
);

/** The signature family for `loadProviderModules`: every first-party id is in one bundle. */
export const SIGNATURE_PROVIDER_FAMILY: ProviderFamily<RecipeSignatureProviderModule> =
  {
    kind: "signature",
    apiName: "signature module",
    apiVersion: SIGNATURE_MODULE_API_VERSION,
    firstPartyPackage: () => SIGNATURE_PROVIDERS_PACKAGE,
    firstPartyBundle: true,
    idOf: (module) => module.id,
  };

function contractProblem(
  module: RecipeSignatureProviderModule,
): string | undefined {
  if (typeof module.createSession !== "function") return "has no createSession";
  const capabilities = module.capabilities as unknown;
  if (!capabilities || typeof capabilities !== "object")
    return "has no capabilities";
  const {
    commands,
    extensions,
    document,
    status_interval_seconds: interval,
    hosts,
    options,
  } = capabilities as RecipeSignatureProviderModule["capabilities"];
  if (
    !Array.isArray(commands) ||
    !commands.includes("send") ||
    !commands.includes("status") ||
    commands.some(
      (command) =>
        !(SIGNATURE_PROVIDER_COMMANDS as readonly string[]).includes(command),
    )
  )
    return `must serve send and status, and only ${SIGNATURE_PROVIDER_COMMANDS.join(", ")}`;
  if (!Array.isArray(extensions) || extensions.length === 0)
    return "declares no capabilities.extensions";
  if (
    !Array.isArray(document) ||
    document.length === 0 ||
    document.some((path) => path !== "link" && path !== "upload")
  )
    return "declares no capabilities.document (link, upload)";
  if (typeof interval !== "number" || !(interval >= 0))
    return "declares no capabilities.status_interval_seconds";
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
  if (module.mcp !== undefined) {
    const { url, server, tools } = module.mcp;
    if (typeof url !== "string" || typeof server !== "string" || !server)
      return "has an MCP adapter without a url and server";
    if (!Array.isArray(tools) || tools.length === 0)
      return "has an MCP adapter without tools";
  }
  return undefined;
}

export interface LoadedRecipeSignature {
  extension?: { owner: string; factory: ExtensionFactory };
  toolNames: string[];
  skillPaths?: string[];
  /** The hosts the loaded provider declares, whether or not the agent selects the tool. */
  hosts?: readonly string[];
}

/**
 * Load the Recipe's `pi.signature` provider and, when the agent selects the
 * `signature` tool, one extension registering it. Without `pi.signature`
 * nothing loads and no tool is offered.
 */
export async function loadRecipeSignature(
  declarations: readonly RecipePackageSignature[] | undefined,
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
    /** Publishes the marked copy at a short-lived signed link; absent, the provider uploads it. */
    publishDocument?: SignaturePublishDocument;
  },
): Promise<LoadedRecipeSignature> {
  if (declarations === undefined || declarations.length === 0)
    return { toolNames: [] };
  if (declarations.length > 1)
    throw new Error(
      `Recipe declares ${declarations.length} signature providers; a Recipe sends through one`,
    );
  const [loaded] = await loadProviderModules(
    SIGNATURE_PROVIDER_FAMILY,
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
      `Recipe signature provider '${declaration.provider}' ${problem}`,
    );
  const settings = (declaration as RecipePackageSignature).options ?? {};
  const schema = module.capabilities.options ?? {};
  for (const [name, value] of Object.entries(settings)) {
    if (schema[name] === undefined)
      throw new Error(
        `Recipe signature provider '${declaration.provider}' takes no option '${name}'${Object.keys(schema).length ? `; it takes ${Object.keys(schema).join(", ")}` : ""}`,
      );
    if (typeof value !== schema[name])
      throw new Error(
        `Recipe signature provider '${declaration.provider}' option '${name}' must be a ${schema[name]}`,
      );
  }
  const server = settings.server;
  const provider: SignatureToolProvider = {
    module,
    config: { provider: declaration.provider, options: settings },
    ...(module.mcp
      ? { server: typeof server === "string" ? server : module.mcp.server }
      : {}),
  };
  const hosts = module.capabilities.hosts;
  if (!agentTools.includes(SIGNATURE_TOOL_NAME))
    return { toolNames: [], hosts };
  return {
    toolNames: [SIGNATURE_TOOL_NAME],
    hosts,
    skillPaths: [SIGNATURE_SKILL],
    extension: {
      owner: "<signature>",
      factory: (pi) => {
        registerSignatureTool(pi, {
          provider,
          env: options.env ?? process.env,
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.publishDocument
            ? { publishDocument: options.publishDocument }
            : {}),
        });
      },
    },
  };
}
