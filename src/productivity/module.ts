import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { loadRecipePackageModule } from "../recipe/companions.js";
import {
  recipeProductivityPackageName,
  type RecipePackageProductivity,
} from "../recipe/package.js";
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
  /** Served as `@introspection-ai/recipe-productivity-<provider>`. */
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

function parseProductivityModule(
  value: unknown,
  declaration: RecipePackageProductivity,
): RecipeProductivityModule {
  const packageName = recipeProductivityPackageName(declaration.provider);
  const module = (
    value && typeof value === "object" && "default" in value
      ? (value as { default: unknown }).default
      : value
  ) as Partial<RecipeProductivityModule> | undefined;
  const problem =
    !module ||
    module.kind !== "productivity" ||
    module.provider !== declaration.provider ||
    typeof module.createSession !== "function"
      ? "has an invalid module contract"
      : productivityCapabilitiesProblem(module.capabilities);
  if (problem)
    throw new Error(
      `Recipe productivity package ${packageName} ${problem.startsWith("has") ? problem : `has an invalid descriptor: ${problem}`}`,
    );
  return module as RecipeProductivityModule;
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
 * agent selecting a tool the declaration does not enable fails too.
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
  const imported = await loadRecipePackageModule(
    options.recipeDir,
    recipeProductivityPackageName(declaration.provider),
    {
      what: `Recipe productivity provider '${declaration.provider}'`,
      api: {
        name: "productivity module",
        version: PRODUCTIVITY_MODULE_API_VERSION,
      },
      ...(options.hostDir !== undefined ? { hostDir: options.hostDir } : {}),
    },
  );
  const module = parseProductivityModule(imported, declaration);
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
  const selected = PRODUCTIVITY_TOOLS.filter((tool) =>
    agentTools.includes(tool),
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
              ...(options.fetch ? { fetch: options.fetch } : {}),
            }),
        });
        pi.on("resources_discover", () => ({ skillPaths }));
      },
    },
  };
}
