import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import {
  recipeProductivityPackageName,
  type RecipePackageProductivity,
} from "../recipe/package.js";
import {
  loadProviderModules,
  type ProviderFamily,
} from "../recipe/providers.js";
import { createProductivityHttp } from "./http.js";
import {
  productivityCapabilitiesProblem,
  productivityCommandsFor,
  registerProductivityTools,
  type RegisterProductivityToolsOptions,
} from "./tools.js";
import {
  PRODUCTIVITY_COMMANDS,
  PRODUCTIVITY_TOOLS,
  type ProductivityCapabilities,
  type ProductivityCommand,
  type ProductivityFetch,
  type ProductivitySession,
  type ProductivitySessionOptions,
  type ProductivityTool,
} from "./types.js";
import type { RecipeToolExposure } from "../recipe/agent.js";
import type { RecipeClock } from "../clock.js";

/**
 * The productivity contract this host implements. A provider module declares
 * the version it was written against, and the host refuses one that differs;
 * bump it on any breaking change to `RecipeProductivityModule` or the session
 * interfaces in `types.ts`.
 */
export const PRODUCTIVITY_MODULE_API_VERSION = 1 as const;

/**
 * What a provider package exports as its default: a plain descriptor. The host
 * builds the `mail`, `calendar` and `drive` tools from `capabilities` and calls
 * `createSession` for one person's connection, so a provider package needs no
 * run-time import of `@introspection-ai/recipes`, only its types.
 */
export interface RecipeProductivityModule {
  readonly kind: "productivity";
  /** The contract version, `PRODUCTIVITY_MODULE_API_VERSION` when written. */
  readonly apiVersion: typeof PRODUCTIVITY_MODULE_API_VERSION;
  /** The provider's id: first-party ones are served as `@introspection-ai/recipe-productivity-<provider>`. */
  readonly provider: string;
  /** Static, so the loader can build the tools before any session exists. */
  readonly capabilities: ProductivityCapabilities;
  /**
   * The transport for one person's connection. Called once per run, on the
   * first command, so a run that never uses the tools never needs a
   * connection.
   */
  createSession(
    options: ProductivitySessionOptions,
  ): ProductivitySession | Promise<ProductivitySession>;
}

/** The core `productivity` skill, offered to every agent that selects `mail`, `calendar` or `drive`. It ships beside `dist/`. */
export const PRODUCTIVITY_SKILL = fileURLToPath(
  new URL("../../skills/productivity/SKILL.md", import.meta.url),
);

/** Where fetched attachments and downloads go: the runtime files folder, else `files/` in the workspace. */
export function productivityDownloadRoot(
  provider: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  const runtimeFiles = env.INTROSPECTION_RUNTIME_FILES_DIR?.trim();
  return resolve(runtimeFiles || resolve(cwd, "files"), provider);
}

/** The productivity family for `loadProviderModules`: one package per first-party provider. */
export const PRODUCTIVITY_PROVIDER_FAMILY: ProviderFamily<RecipeProductivityModule> =
  {
    kind: "productivity",
    apiName: "productivity module",
    apiVersion: PRODUCTIVITY_MODULE_API_VERSION,
    firstPartyPackage: recipeProductivityPackageName,
    idOf: (module) => module.provider,
  };

function parseProductivityModule(
  module: RecipeProductivityModule,
  declaration: RecipePackageProductivity,
): RecipeProductivityModule {
  const from =
    declaration.package ?? recipeProductivityPackageName(declaration.provider);
  const problem =
    typeof module.createSession !== "function"
      ? "has an invalid module contract"
      : productivityCapabilitiesProblem(module.capabilities);
  if (problem)
    throw new Error(
      `Recipe productivity provider '${declaration.provider}' (${from}) ${problem.startsWith("has") ? problem : `has an invalid descriptor: ${problem}`}`,
    );
  return module;
}

export interface LoadedRecipeProductivity {
  extension?: { owner: string; factory: ExtensionFactory };
  toolNames: string[];
  /** The core `productivity` skill, when the agent selects one of the tools. */
  skillPaths?: string[];
}

/**
 * Load the Recipe's `pi.productivity` provider and, for the tools the agent
 * selects, one extension registering them for one person's connection and
 * offering the core `productivity` skill.
 *
 * One provider per Recipe. The declaration's per-tool allowlists narrow what
 * the provider supports; an unknown or unsupported command fails here, and an
 * agent naming a tool the declaration does not enable fails too.
 */
export async function loadRecipeProductivity(
  declarations: readonly RecipePackageProductivity[],
  agentTools: readonly string[],
  options: {
    recipeDir: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    /** Where companion packages resolve from. Default: where `@introspection-ai/recipes` is installed. */
    hostDir?: string;
    /** The `fetch` providers use; a host attaching credentials with a request hook passes its own. */
    fetch?: ProductivityFetch;
    /** How a first-party tool registers for the agent (`tools.mode`). Default: declared. */
    exposure?: (tool: string) => RecipeToolExposure;
    /** What `include: ["*"]` added: one of these the provider does not enable is left out rather than refused. */
    wildcardTools?: readonly string[];
    /** The session's clock. Default: the host's. */
    clock?: RecipeClock;
  },
): Promise<LoadedRecipeProductivity> {
  if (declarations.length === 0) return { toolNames: [] };
  if (declarations.length > 1)
    throw new Error(
      `A Recipe declares one productivity provider; pi.productivity names ${declarations
        .map((declaration) => `'${declaration.provider}'`)
        .join(" and ")}`,
    );
  const declaration = declarations[0]!;
  const [loaded] = await loadProviderModules(
    PRODUCTIVITY_PROVIDER_FAMILY,
    [declaration],
    {
      recipeDir: options.recipeDir,
      ...(options.hostDir !== undefined ? { hostDir: options.hostDir } : {}),
    },
  );
  const module = parseProductivityModule(loaded!.module, declaration);
  const enabled: {
    [T in ProductivityTool]?: ProductivityCommand<T>[];
  } = {};
  for (const tool of Object.keys(declaration.tools ?? {})) {
    if (!(PRODUCTIVITY_TOOLS as readonly string[]).includes(tool))
      throw new Error(`Unknown productivity tool in pi.productivity: ${tool}`);
  }
  for (const tool of PRODUCTIVITY_TOOLS) {
    const supported = productivityCommandsFor(module.capabilities, tool);
    const allowed = declaration.tools?.[tool];
    for (const command of allowed ?? []) {
      if (!(PRODUCTIVITY_COMMANDS[tool] as readonly string[]).includes(command))
        throw new Error(
          `Unknown ${tool} command in pi.productivity allowlist: ${command}`,
        );
      if (!(supported as string[]).includes(command))
        throw new Error(
          `Productivity provider '${declaration.provider}' does not support ${tool} ${command}`,
        );
    }
    const commands =
      allowed === undefined
        ? supported
        : supported.filter((command) => allowed.includes(command));
    if (commands.length > 0)
      (enabled as Record<string, string[]>)[tool] = commands;
  }
  const selected = PRODUCTIVITY_TOOLS.filter(
    (tool) =>
      agentTools.includes(tool) &&
      (enabled[tool] !== undefined || !options.wildcardTools?.includes(tool)),
  );
  const disabled = selected.filter((tool) => !enabled[tool]);
  if (disabled.length > 0)
    throw new Error(
      `The agent selects ${disabled.join(", ")}, which pi.productivity provider '${declaration.provider}' does not enable`,
    );
  if (selected.length === 0) return { toolNames: [] };
  const skillPaths = [PRODUCTIVITY_SKILL];
  const tools = Object.fromEntries(
    selected.map((tool) => [tool, enabled[tool]!]),
  ) as RegisterProductivityToolsOptions["tools"];
  return {
    toolNames: [...selected],
    skillPaths,
    extension: {
      owner: `<productivity:${declaration.provider}>`,
      factory: (pi) => {
        const env = options.env ?? process.env;
        const cwd = options.cwd ?? process.cwd();
        registerProductivityTools(pi, {
          ...(options.exposure ? { exposure: options.exposure } : {}),
          ...(options.clock ? { clock: options.clock } : {}),
          provider: declaration.provider,
          capabilities: module.capabilities,
          tools,
          cwd,
          downloadsDir: productivityDownloadRoot(
            declaration.provider,
            env,
            cwd,
          ),
          session: () =>
            module.createSession({
              config: { provider: declaration.provider, tools: enabled },
              env,
              cwd,
              http: createProductivityHttp({
                provider: declaration.provider,
                env,
                ...(options.fetch ? { fetch: options.fetch } : {}),
              }),
            }),
        });
        pi.on("resources_discover", () => ({ skillPaths }));
      },
    },
  };
}
