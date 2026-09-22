import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { getModel, type Model } from "@earendil-works/pi-ai/compat";
import {
  createBashToolDefinition,
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntimeDiagnostic,
  type EventBus,
  type ExtensionFactory,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  instrumentSession,
  type AgentMeta,
  type InstrumentSessionOptions,
} from "@introspection-sdk/introspection-pi";
import {
  createAgentTool,
  type AgentRunController,
  type AgentRunEventObserver,
} from "./agents.js";
import { loadRecipeConnectors } from "./connector-tools.js";
import {
  clearMcpCatalogPreload,
  preloadMcpCatalogs,
} from "./mcp-catalog.js";
import {
  createIsolatedMcpEnvironment,
  configureMcpLocalConfigPath,
  isolateMcpEnvironment,
  materializeMcpSession,
  materializeSessionMcpCli,
  readMcpSessionConfig,
  restoreMcpEnvironment,
  resolveAgentMcpSelections,
  snapshotMcpEnvironment,
  stopMcpDaemon,
  type McpLocalConfig,
  type ScopedMcpToolSelection,
} from "./mcp.js";
import { createMcpToolSet } from "./mcp-tools.js";
import {
  createRecipeToolSearchTools,
  LEGACY_MCP_TOOL_SEARCH_NAME,
  RECIPE_TOOL_SEARCH_NAME,
} from "./tool-search.js";
import {
  assertRecipeModelTransport,
  RecipeCredentialError,
  RecipeModelError,
  RecipeModelTransportError,
  resolveRecipeCredentials,
} from "./model-binding.js";
import { loadRecipeExtensionFactory } from "./recipe-extensions.js";
import {
  bindRecipeExtensionFactory,
  createRecipeExtensionRegistrationRegistry,
  recipeExtensionToolAllowlist,
  type RecipeExtensionSessionContext,
} from "./extensions.js";
import {
  applyRecipeAgentModelConfigToModel,
  applyRecipeAgentModelConfigToSession,
  cloneModelForRecipe,
} from "./recipe-model.js";
import {
  type ResolvedRecipeAgent,
  type ResolvedRecipe,
} from "./recipe/resolve.js";
import {
  formatMemoryForPrompt,
  loadMemoryIndex,
  type MemoryContextOverride,
  type MemoryContextSource,
} from "./memory.js";

export { expectedProviderEnvVars } from "./provider-env.js";

function sessionSettingsManager(
  base: SettingsManager,
  sessionSettings: Record<string, unknown> | undefined
): SettingsManager {
  if (!sessionSettings) return base;
  const merge = (
    left: Record<string, unknown>,
    right: Record<string, unknown>
  ): Record<string, unknown> => {
    const result = { ...left };
    for (const [key, value] of Object.entries(right)) {
      const current = result[key];
      result[key] =
        current && value &&
        typeof current === "object" && !Array.isArray(current) &&
        typeof value === "object" && !Array.isArray(value)
          ? merge(
              current as Record<string, unknown>,
              value as Record<string, unknown>
            )
          : value;
    }
    return result;
  };
  return SettingsManager.inMemory(
    merge(
      merge(
        base.getGlobalSettings() as Record<string, unknown>,
        base.getProjectSettings() as Record<string, unknown>
      ),
      sessionSettings
    ) as never
  );
}

/**
 * Everything between "resolved recipe" and "live Pi session", done once:
 * model construction and credentials, MCP materialization, skills /
 * extensions / system-prompt wiring, subagent tool registration.
 *
 * Fails closed at construction: recipe resolution errors propagate, a
 * `required: true` MCP server with no binding throws `McpBindingError`, and a
 * model whose provider has no credential throws `RecipeCredentialError`.
 */
export interface CreateAgentSessionOptions {
  /** Immutable Recipe graph used by this root session and all of its children. */
  recipe: ResolvedRecipe;
  /** Default: the agent named `agent`, else the recipe's single-agent rule. */
  agentName?: string;
  /** Agent workspace. Default: `process.cwd()`. */
  cwd?: string;
  /** Model credentials. Default: derived from provider env keys. */
  credentials?: CredentialStore;
  /**
   * Host-constructed model transport. The recipe still owns its model
   * configuration; this replaces only catalog lookup and transport wiring.
   */
  modelOverride?: Model<any>;
  /** Explicit local MCP binding file. Default: `<cwd|recipe.recipeDir>/.pi/mcp.local.json`. */
  mcpBindingsPath?: string;
  /** Inline MCP bindings, for hosts that synthesize them instead of reading a file. */
  mcpBindings?: McpLocalConfig;
  /**
   * MCP provisioning owner. "session" (default) resolves bindings and
   * prepares the session MCP runtime in `env`; "host" trusts that the host
   * already materialized a runtime covering exactly this agent's policy.
   */
  mcpProvisioning?: "session" | "host";
  /** `${VAR}` resolution source and MCP runtime environment. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Default: `SessionManager.inMemory(cwd)`. */
  sessionManager?: SessionManager;
  /** Host-owned settings (compaction, retry). Default: `SettingsManager.create(cwd, recipe.recipeDir)`. */
  settingsManager?: SettingsManager;
  /** Host extensions appended after the recipe's own extensions. */
  extensionFactories?: ExtensionFactory[];
  /** Host event bus shared with the surrounding application. */
  eventBus?: EventBus;
  /** Host-owned tools. Recipe tool selection still decides which names are live. */
  customTools?: ToolDefinition[];
  /**
   * Subagent run controller. Default: an in-process controller spawning
   * child Recipe sessions. Pass `null` to disable the `agent` tool
   * even when the recipe declares subagents.
   */
  runController?: AgentRunController | null;
  /** Host hooks for the shared `agent` tool UI contract. */
  agentToolOptions?: {
    acknowledgeCompletions?(ids: readonly string[]): void;
  };
  /** Configuration for the default in-process controller. Ignored when injected. */
  inProcessRunController?: { concurrency?: number };
  /** Extra skill roots beyond the recipe's. */
  additionalSkillPaths?: string[];
  /** Host-materialized replacement for the Recipe's resolved skill roots. */
  materializedSkillPaths?: string[];
  /** Host-bound durable memory index rendered into the system prompt. */
  memory?: MemoryContextSource;
  /** Filter, replace, or disable the loaded memory index before rendering. */
  memoryOverride?: MemoryContextOverride;
  /** Append or transform host context after portable prompt resolution. */
  transformSystemPrompt?: (resolved: string) => string;
  /** Observe Pi resource diagnostics during construction. */
  onDiagnostics?: (diagnostics: AgentSessionRuntimeDiagnostic[]) => void;
  /** Tap on `session.subscribe`, detached at dispose. */
  onEvent?: (event: AgentSessionEvent) => void;
  /** Observe canonical Pi events from every default in-process child run. */
  onAgentRunEvent?: AgentRunEventObserver;
  /**
   * Attach GenAI semantic-convention instrumentation with a host-owned OTel
   * tracer. Recipes creates no provider, processor, exporter, or global
   * context; those remain the host's responsibility.
   */
  otel?: RecipeSessionOtelOptions;
}

/** @internal Construction state owned by Recipes, never by an embedding host. */
export interface CreateAgentSessionInternalOptions
  extends CreateAgentSessionOptions {
  /** @internal Credentials already resolved from Pi's authenticated registry. */
  credentialsResolved?: boolean;
  mcpRuntimeDir?: string;
  sessionRole: RecipeExtensionSessionContext["session"]["role"];
}

export interface RecipeSessionOtelOptions
  extends Omit<InstrumentSessionOptions, "meta"> {
  /**
   * Span identity. Missing fields derive from the resolved Recipe; a fresh
   * conversation id is generated per session by default.
   */
  meta?: Partial<AgentMeta>;
}

export interface RecipeSessionHandle {
  /** The live Pi session: prompt / steer / followUp / abort / subscribe. */
  session: AgentSession;
  /** The selected executable agent plan used to create this session. */
  agent: ResolvedRecipeAgent;
  /** The subagent run controller serving this session's `agent` tool. */
  agentRuns: AgentRunController;
  /** Abort any in-flight turn, dispose the session, stop session MCP. */
  dispose(): Promise<void>;
}

export {
  RecipeCredentialError,
  RecipeModelError,
  RecipeModelTransportError,
};

type MutableAgentSession = {
  agent?: { state?: { tools?: Array<{ parameters?: unknown }> } };
};

type SchemaPosition = "schema" | "schema-map" | "literal";

function schemaChildPosition(
  position: SchemaPosition,
  key: PropertyKey
): SchemaPosition {
  if (position === "schema-map") return "schema";
  if (position === "literal") return "literal";
  if (
    key === "properties" ||
    key === "patternProperties" ||
    key === "$defs" ||
    key === "definitions" ||
    key === "dependentSchemas"
  ) {
    return "schema-map";
  }
  if (
    key === "default" ||
    key === "const" ||
    key === "examples" ||
    key === "enum"
  ) {
    return "literal";
  }
  return "schema";
}

function stripAdditionalProperties(
  value: unknown,
  position: SchemaPosition = "schema"
): unknown {
  if (value === null || typeof value !== "object") return value;
  const clone: object = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(value));
  for (const key of Reflect.ownKeys(value)) {
    if (position === "schema" && key === "additionalProperties") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ("value" in descriptor) {
      descriptor.value = stripAdditionalProperties(
        descriptor.value,
        schemaChildPosition(position, key)
      );
    }
    Object.defineProperty(clone, key, descriptor);
  }
  return clone;
}

/**
 * Gemini rejects JSON Schema's `additionalProperties` keyword in tool
 * declarations. Normalize the final Recipe toolset after host tools and the
 * shared agent tool have been registered so every host gets the same behavior.
 */
function normalizeSessionToolsForModel(
  session: AgentSession,
  model: Model<any>
): void {
  const isGemini = [model.id, model.name].some((value) =>
    value?.toLowerCase().includes("gemini")
  );
  if (!isGemini) return;
  const mutableSession = session as MutableAgentSession;
  for (const tool of mutableSession.agent?.state?.tools ?? []) {
    tool.parameters = stripAdditionalProperties(tool.parameters);
  }
}

function scopedMcpSelections(recipe: ResolvedRecipeAgent): ScopedMcpToolSelection[] {
  return resolveAgentMcpSelections(recipe.mcp);
}

interface MaterializedSessionMcp {
  available: boolean;
  materialized: boolean;
  tools?: ToolDefinition[];
  initialActiveToolNames?: string[];
  deferredToolNames?: string[];
  release?: () => Promise<void>;
}

const leasedMcpEnvironments = new WeakSet<NodeJS.ProcessEnv>();

export class RecipeMcpEnvironmentInUseError extends Error {
  override readonly name = "RecipeMcpEnvironmentInUseError";

  constructor() {
    super(
      "This environment already belongs to a live materialized Recipe MCP session; use a separate env object per concurrent session or let the host materialize MCP once and pass mcpProvisioning: \"host\""
    );
  }
}

/**
 * Materialize the session MCP runtime for a recipe scope into `env` at
 * `cwd`. Exposed for hosts that materialize once per process and create their
 * sessions with `mcpProvisioning: "host"`.
 */
export async function materializeRecipeSessionMcp(
  recipe: ResolvedRecipeAgent,
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: Pick<
    CreateAgentSessionOptions,
    "mcpBindings" | "mcpBindingsPath"
  > = {}
): Promise<{ materialized: boolean }> {
  const selections = scopedMcpSelections(recipe);
  if (selections.length === 0) return { materialized: false };
  if (opts.mcpBindingsPath) {
    env.PI_RECIPES_MCP_LOCAL_CONFIG = opts.mcpBindingsPath;
  } else if (!opts.mcpBindings) {
    configureMcpLocalConfigPath({ cwd, recipeDir: recipe.recipeDir, env });
  }
  if (recipe.mcp?.mode === "cli") {
    await materializeSessionMcpCli({ cwd, env });
  }
  await materializeMcpSession({
    cwd,
    manifest: recipe.manifest,
    agentMcp: selections,
    env,
    ...(opts.mcpBindings ? { localConfig: opts.mcpBindings } : {}),
  });
  return { materialized: true };
}

async function configureSessionMcp(
  recipe: ResolvedRecipeAgent,
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: CreateAgentSessionInternalOptions
): Promise<MaterializedSessionMcp> {
  const selections = scopedMcpSelections(recipe);
  if (selections.length === 0) {
    return { available: false, materialized: false };
  }
  const mode = recipe.mcp?.mode ?? "cli";
  const hostProvisioned = opts.mcpProvisioning === "host";
  const mcpCwd = opts.mcpRuntimeDir ?? cwd;
  const snapshot =
    !hostProvisioned && mode === "cli"
      ? snapshotMcpEnvironment(env)
      : undefined;
  let runtimeEnv = env;
  let privateDirectory: string | undefined;
  let privateMcporterConfigPath: string | undefined;

  if (snapshot) {
    if (leasedMcpEnvironments.has(env)) {
      throw new RecipeMcpEnvironmentInUseError();
    }
    leasedMcpEnvironments.add(env);
    isolateMcpEnvironment(env);
  }

  const release = async () => {
    if (hostProvisioned) return;
    clearMcpCatalogPreload(runtimeEnv);
    await stopMcpDaemon(runtimeEnv);
    if (privateDirectory) {
      await rm(privateDirectory, { recursive: true, force: true });
    }
    if (snapshot) {
      restoreMcpEnvironment(env, snapshot);
      leasedMcpEnvironments.delete(env);
    }
  };

  try {
    if (!hostProvisioned && mode === "tools") {
      const isolated = await createIsolatedMcpEnvironment(env);
      runtimeEnv = isolated.env;
      privateDirectory = isolated.directory;
      privateMcporterConfigPath = isolated.mcporterConfigPath;
    }

    let session;
    if (hostProvisioned) {
      session = readMcpSessionConfig(cwd, runtimeEnv);
    } else {
      if (opts.mcpBindingsPath) {
        runtimeEnv.PI_RECIPES_MCP_LOCAL_CONFIG = opts.mcpBindingsPath;
      } else if (!opts.mcpBindings) {
        configureMcpLocalConfigPath({
          cwd,
          recipeDir: recipe.recipeDir,
          env: runtimeEnv,
        });
      }
      if (mode === "cli") {
        await materializeSessionMcpCli({ cwd: mcpCwd, env: runtimeEnv });
      }
      session = await materializeMcpSession({
        cwd: mcpCwd,
        manifest: recipe.manifest,
        agentMcp: selections,
        env: runtimeEnv,
        ...(opts.mcpBindings ? { localConfig: opts.mcpBindings } : {}),
        ...(privateMcporterConfigPath
          ? { mcporterConfigPath: privateMcporterConfigPath }
          : {}),
      });
    }

    if (mode === "tools") {
      const catalogs =
        session.servers.length > 0
          ? await preloadMcpCatalogs({
              env: runtimeEnv,
              allowPartial: true,
            })
          : [];
      const materialized = createMcpToolSet({
        session,
        catalogs,
        mcp: recipe.mcp!,
        env: runtimeEnv,
      });
      return {
        available: true,
        materialized: !hostProvisioned,
        tools: materialized.tools,
        initialActiveToolNames: materialized.initialActiveToolNames,
        deferredToolNames: materialized.deferredToolNames,
        release,
      };
    }

    if (session.servers.length > 0) {
      // Warm tool catalogs in the background; sessions work without the warmup.
      void preloadMcpCatalogs({ env: runtimeEnv }).catch(() => {});
    }
    return {
      available: true,
      materialized: !hostProvisioned,
      release,
    };
  } catch (error) {
    await release();
    throw error;
  }
}

async function createSessionForAgent(
  recipe: ResolvedRecipeAgent,
  opts: CreateAgentSessionInternalOptions
): Promise<RecipeSessionHandle> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const loadedMemory = opts.memory
    ? loadMemoryIndex({ ...opts.memory, cwd })
    : { memory: null, diagnostics: [] };
  const memoryResult = opts.memoryOverride
    ? opts.memoryOverride(loadedMemory)
    : loadedMemory;
  const memoryPrompt = formatMemoryForPrompt(memoryResult.memory);
  const recipeExtensionContext: RecipeExtensionSessionContext = Object.freeze({
    recipe: Object.freeze({ name: recipe.manifest.name }),
    agent: Object.freeze({ name: recipe.name }),
    session: Object.freeze({
      role: opts.sessionRole,
    }),
  });
  const otel = opts.otel
    ? {
        ...opts.otel,
        meta: {
          conversationId: opts.otel.meta?.conversationId ?? randomUUID(),
          agentId:
            opts.otel.meta?.agentId ??
            `${recipe.manifest.name}/${recipe.name}`,
          agentName: opts.otel.meta?.agentName ?? recipe.name,
        },
      }
    : undefined;

  // Model + credentials, fail-closed before any MCP runtime starts.
  const modelSpec = recipe.modelSpec;
  const { lookupProvider, modelId } = assertRecipeModelTransport(
    modelSpec,
    opts.modelOverride
  );
  const credentialProvider = opts.modelOverride?.provider ?? lookupProvider;
  const credentials =
    opts.credentialsResolved && opts.credentials
      ? opts.credentials
      : await resolveRecipeCredentials({
          provider: credentialProvider,
          env,
          ...(opts.modelOverride ? { model: opts.modelOverride } : {}),
          ...(opts.credentials ? { credentials: opts.credentials } : {}),
        });
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });

  let model: Model<any> | undefined;
  let session: AgentSession | undefined;
  let agentRuns: AgentRunController | undefined;
  let unsubscribe: (() => void) | undefined;
  let detachInstrumentation: (() => void) | undefined;
  const mcp = await configureSessionMcp(recipe, cwd, env, opts);

  const cleanup = async (): Promise<void> => {
    try {
      unsubscribe?.();
    } catch {
      // Continue releasing the remaining session-owned resources.
    }
    unsubscribe = undefined;
    if (agentRuns) {
      try {
        await agentRuns.shutdown();
      } catch {
        // Child teardown is best-effort; the session still disposes.
      }
    }
    if (session) {
      try {
        await session.abort();
      } catch {
        // An idle session has nothing to abort.
      }
      try {
        session.dispose();
      } catch {
        // Continue releasing instrumentation and MCP state.
      }
      session = undefined;
    }
    try {
      detachInstrumentation?.();
    } catch {
      // Continue releasing MCP state.
    }
    detachInstrumentation = undefined;
    await mcp.release?.();
  };

  try {
    // Recipe extensions load through the shared jiti loader; host extensions
    // append after them, matching the Pi extension host's ordering.
    const inlineExtensions: InlineExtension[] = [];
    const recipeRegistrations =
      createRecipeExtensionRegistrationRegistry();
    for (const toolName of [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      ...(opts.customTools ?? []).map((tool) => tool.name),
      ...(recipe.subagents.size > 0 && opts.runController !== null
        ? ["agent"]
        : []),
    ]) {
      recipeRegistrations.claim("tool", toolName, "<host>");
    }
    const connectors = await loadRecipeConnectors(
      recipe.manifest,
      recipe.tools,
      { recipeDir: recipe.recipeDir, env, cwd }
    );
    const connectorLoadout = connectors.loadout;
    for (const toolName of [
      ...((connectorLoadout.deferredToolNames.length > 0 ||
        (mcp.deferredToolNames?.length ?? 0) > 0)
        ? [RECIPE_TOOL_SEARCH_NAME]
        : []),
      ...((mcp.deferredToolNames?.length ?? 0) > 0
        ? [LEGACY_MCP_TOOL_SEARCH_NAME]
        : []),
    ]) {
      recipeRegistrations.claim("tool", toolName, "<host>");
    }
    for (const connector of connectors.extensions) {
      inlineExtensions.push(
        bindRecipeExtensionFactory(
          connector.factory,
          recipeExtensionContext,
          recipeRegistrations,
          connector.owner,
          recipeExtensionToolAllowlist(
            recipe.tools,
            recipe.subagents.size > 0 && opts.runController !== null,
            [
              ...connectorLoadout.toolNames,
              ...(mcp.tools?.map((tool) => tool.name) ?? []),
              ...((connectorLoadout.deferredToolNames.length > 0 ||
                (mcp.deferredToolNames?.length ?? 0) > 0)
                ? [RECIPE_TOOL_SEARCH_NAME]
                : []),
              ...((mcp.deferredToolNames?.length ?? 0) > 0
                ? [LEGACY_MCP_TOOL_SEARCH_NAME]
                : []),
            ]
          )
        )
      );
    }
    for (const extensionPath of recipe.extensionPaths) {
      inlineExtensions.push(
        bindRecipeExtensionFactory(
          await loadRecipeExtensionFactory(recipe.recipeDir, extensionPath),
          recipeExtensionContext,
          recipeRegistrations,
          extensionPath,
          recipeExtensionToolAllowlist(
            recipe.tools,
            recipe.subagents.size > 0 && opts.runController !== null,
            [
              ...(mcp.tools?.map((tool) => tool.name) ?? []),
              ...((connectorLoadout.deferredToolNames.length > 0 ||
                (mcp.deferredToolNames?.length ?? 0) > 0)
                ? [RECIPE_TOOL_SEARCH_NAME]
                : []),
              ...((mcp.deferredToolNames?.length ?? 0) > 0
                ? [LEGACY_MCP_TOOL_SEARCH_NAME]
                : []),
            ]
          )
        )
      );
    }
    inlineExtensions.push(...(opts.extensionFactories ?? []));

    const baseSettingsManager =
      opts.settingsManager ?? SettingsManager.create(cwd, recipe.recipeDir);
    const settingsManager = sessionSettingsManager(
      baseSettingsManager,
      recipe.sessionConfig?.settings
    );
    const services = await createAgentSessionServices({
      cwd,
      agentDir: recipe.recipeDir,
      modelRuntime,
      settingsManager,
      resourceLoaderOptions: {
        eventBus: opts.eventBus,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
        additionalSkillPaths: [
          ...(opts.materializedSkillPaths ?? recipe.skillPaths),
          ...(opts.additionalSkillPaths ?? []),
        ],
        additionalPromptTemplatePaths: [...recipe.promptPaths],
        extensionFactories: inlineExtensions,
        systemPromptOverride: (base) => {
          const resolved = recipe.systemPromptOverride(base);
          const withMemory = [resolved, memoryPrompt]
            .filter(Boolean)
            .join("\n\n");
          return opts.transformSystemPrompt
            ? opts.transformSystemPrompt(withMemory)
            : withMemory || undefined;
        },
      },
    });
    const memoryDiagnostics = memoryResult.diagnostics.map((diagnostic) => ({
      type: diagnostic.type,
      message: diagnostic.path
        ? `${diagnostic.message} (${diagnostic.path})`
        : diagnostic.message,
    }));
    const diagnostics = [...memoryDiagnostics, ...services.diagnostics];
    opts.onDiagnostics?.(diagnostics);
    const extensionLoadErrors =
      services.resourceLoader.getExtensions().errors;
    const fatalDiagnostics = diagnostics.filter(
      (diagnostic) => diagnostic.type === "error"
    );
    if (fatalDiagnostics.length > 0 || extensionLoadErrors.length > 0) {
      throw new Error(
        `Recipe extension startup failed:\n${[
          ...extensionLoadErrors.map(
            ({ path, error }) => `- ${path}: ${error}`
          ),
          ...fatalDiagnostics.map(
            (diagnostic) => `- ${diagnostic.message}`
          ),
        ]
          .join("\n")}`
      );
    }
    const selectedModel =
      opts.modelOverride ??
      services.modelRuntime.getModel(lookupProvider, modelId) ??
      modelRuntime.getModel(lookupProvider, modelId) ??
      (getModel(lookupProvider as never, modelId as never) as
        | Model<any>
        | undefined);
    if (!selectedModel) {
      throw new RecipeModelError(modelSpec);
    }
    model = cloneModelForRecipe(selectedModel);
    applyRecipeAgentModelConfigToModel(model, recipe.modelConfig);

    // Subagents: the shared `agent` tool against an injected or in-process
    // controller. `runController: null` disables delegation outright.
    const wantsSubagents =
      recipe.subagents.size > 0 && opts.runController !== null;
    if (opts.runController) {
      agentRuns = opts.runController;
    } else {
      const { createInProcessRunController, inertRunController } = await import(
        "./run-controller.js"
      );
      agentRuns = wantsSubagents
        ? createInProcessRunController({
            recipe: opts.recipe!,
            cwd,
            env,
            ...(opts.credentials ? { credentials: opts.credentials } : {}),
            concurrency: opts.inProcessRunController?.concurrency,
            ...(opts.onAgentRunEvent
              ? { onAgentRunEvent: opts.onAgentRunEvent }
              : {}),
            ...(opts.memory ? { memory: opts.memory } : {}),
            ...(opts.memoryOverride
              ? { memoryOverride: opts.memoryOverride }
              : {}),
            ...(otel ? { otel } : {}),
          })
        : inertRunController();
    }
    const tools = [
      ...recipe.tools.filter(
        (tool) => !connectorLoadout.toolNames.includes(tool)
      ),
      ...(wantsSubagents ? ["agent"] : []),
    ];
    const mcpToolNames = mcp.tools?.map((tool) => tool.name) ?? [];
    const recipeExtensionTools = services.resourceLoader
      .getExtensions()
      .extensions.flatMap((extension) =>
        [...extension.tools.values()].map((tool) => tool.definition)
      );
    const recipeExtensionToolNames = new Set(
      recipeExtensionTools.map((tool) => tool.name)
    );
    const occupiedToolNames = new Set([
      ...tools,
      ...(opts.customTools ?? []).map((tool) => tool.name),
      ...(wantsSubagents ? ["agent"] : []),
    ]);
    const collisions = mcpToolNames.filter((name) =>
      occupiedToolNames.has(name) || recipeExtensionToolNames.has(name)
    );
    if (collisions.length > 0) {
      throw new Error(
        `Recipe MCP tool name collision: ${collisions.join(", ")}`
      );
    }
    const toolSearchTools = createRecipeToolSearchTools({
      tools: [...recipeExtensionTools, ...(mcp.tools ?? [])],
      deferredToolNames: [
        ...connectorLoadout.deferredToolNames,
        ...(mcp.deferredToolNames ?? []),
      ],
      activation: {
        getActiveTools: () => session?.getActiveToolNames() ?? [],
        setActiveTools: (names) => session?.setActiveToolsByName(names),
      },
    }, (mcp.deferredToolNames?.length ?? 0) > 0);
    const occupiedSearchTool = toolSearchTools.find((tool) =>
      occupiedToolNames.has(tool.name)
    );
    if (occupiedSearchTool) {
      throw new Error(
        `Recipe tool name '${occupiedSearchTool.name}' is reserved by the session`
      );
    }
    const selectedToolNames = [
      ...tools,
      ...connectorLoadout.toolNames,
      ...mcpToolNames,
      ...toolSearchTools.map((tool) => tool.name),
    ];
    const environmentBash: ToolDefinition | undefined =
      (recipe.mcp?.mode ?? "cli") === "cli" &&
      mcp.available &&
      env !== process.env &&
      tools.includes("bash") &&
      !(opts.customTools ?? []).some((tool) => tool.name === "bash")
        ? (createBashToolDefinition(cwd, {
            commandPrefix: settingsManager.getShellCommandPrefix(),
            shellPath: settingsManager.getShellPath(),
            spawnHook: (context) => ({
              ...context,
              env: { ...context.env, ...env },
            }),
          }) as ToolDefinition)
        : undefined;
    const customTools = [
      ...(environmentBash ? [environmentBash] : []),
      ...(opts.customTools ?? []),
      ...(wantsSubagents
        ? [
            createAgentTool(
              agentRuns,
              recipe.subagents,
              opts.agentToolOptions
            ),
          ]
        : []),
      ...(mcp.tools ?? []),
      ...toolSearchTools,
    ];

    const created = await createAgentSessionFromServices({
      services,
      sessionManager: opts.sessionManager ?? SessionManager.inMemory(cwd),
      model,
      ...(recipe.thinkingLevel
        ? { thinkingLevel: recipe.thinkingLevel }
        : {}),
      tools: selectedToolNames,
      customTools,
    });
    session = created.session;
    if (recipe.sessionConfig?.toolExecution) {
      session.agent.toolExecution = recipe.sessionConfig.toolExecution;
    }
    normalizeSessionToolsForModel(session, model);
    applyRecipeAgentModelConfigToSession(session, recipe.modelConfig);
    await session.bindExtensions({});
    const registered = new Set(
      session.getAllTools().map((tool) => tool.name)
    );
    const missingDeclaredTools = selectedToolNames.filter(
      (name) => !registered.has(name)
    );
    if (missingDeclaredTools.length > 0) {
      throw new Error(
        `Recipe agent "${recipe.name}" declares unavailable tool(s): ${missingDeclaredTools.join(", ")}`
      );
    }
    const missingConnectorTools = connectorLoadout.toolNames.filter(
      (name) => !registered.has(name)
    );
    if (missingConnectorTools.length > 0) {
      throw new Error(
        `Pi did not register Recipe connector tool(s): ${missingConnectorTools.join(", ")}`
      );
    }
    if (mcp.tools || connectorLoadout.toolNames.length > 0) {
      const missingRegistered = mcpToolNames.filter(
        (name) => !registered.has(name)
      );
      if (missingRegistered.length > 0) {
        throw new Error(
          `Pi did not register Recipe MCP tool(s): ${missingRegistered.join(", ")}`
        );
      }
      const activeTools = [
        ...tools,
        ...connectorLoadout.initialActiveToolNames,
        ...(mcp.initialActiveToolNames ?? []),
        ...toolSearchTools.map((tool) => tool.name),
      ];
      session.setActiveToolsByName(activeTools);
      const applied = new Set(session.getActiveToolNames());
      const missing = activeTools.filter((name) => !applied.has(name));
      if (missing.length > 0) {
        throw new Error(
          `Pi did not activate Recipe tool(s): ${missing.join(", ")}`
        );
      }
    }

    unsubscribe = opts.onEvent ? session.subscribe(opts.onEvent) : undefined;
    detachInstrumentation = otel
      ? instrumentSession(session, otel).detach
      : undefined;

    const liveSession = session;
    const liveRuns = agentRuns;
    let disposed = false;
    return {
      session: liveSession,
      agent: recipe,
      agentRuns: liveRuns,
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function createAgentSession(
  opts: CreateAgentSessionOptions
): Promise<RecipeSessionHandle> {
  return createSessionForAgent(opts.recipe.selectAgent(opts.agentName), {
    ...opts,
    sessionRole: "root",
  });
}

/** @internal Construct a child with Recipes-owned lifecycle state. */
export async function createAgentSessionInternal(
  opts: CreateAgentSessionInternalOptions
): Promise<RecipeSessionHandle> {
  return createSessionForAgent(opts.recipe.selectAgent(opts.agentName), opts);
}
