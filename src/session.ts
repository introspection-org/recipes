import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Api, CredentialStore } from "@earendil-works/pi-ai";
import { getModel, type Model } from "@earendil-works/pi-ai/compat";
import {
  createBashToolDefinition,
  createCodemodeExtension,
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntimeDiagnostic,
  type EventBus,
  type ExtensionAPI,
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
  MAX_AGENT_RUN_DEPTH,
  type AgentRunController,
  type AgentRunEventObserver,
} from "./agents.js";
import {
  askUserQuestionExtension,
  wantsAskUserQuestion,
} from "./ask-user-question.js";
import {
  introspectionOpenExtension,
  wantsIntrospectionOpen,
} from "./introspection-open.js";
import type { ArtifactRepositoryResolver, ArtifactStore } from "./artifact.js";
import {
  artifactViewerExtension,
  wantsArtifactViewer,
} from "./artifact-viewer.js";
import { loadRecipeConnectors } from "./connector-tools.js";
import {
  activateRecipePython,
  prepareRecipePython,
  RECIPE_PYTHON_ROOT_ENV,
} from "./recipe/python.js";
import { clearMcpCatalogPreload, preloadMcpCatalogs } from "./mcp/catalog.js";
import {
  createIsolatedMcpEnvironment,
  configureMcpLocalConfigPath,
  endpointBindings,
  isolateMcpEnvironment,
  materializeMcpSession,
  materializeSessionMcpCli,
  readMcpSessionConfig,
  restoreMcpEnvironment,
  resolveAgentMcpSelections,
  resolveMcpSessionServers,
  snapshotMcpEnvironment,
  stopMcpDaemon,
  type McpLocalConfig,
  type McpSessionServer,
  type ScopedMcpToolSelection,
} from "./mcp/index.js";
import { mcpServersBehindTools } from "./mcp/policy.js";
import {
  createMcpBehindGuard,
  createPiMcpServersExtension,
  hideServersBehindTools,
  createRecipeMcpClientExtension,
  piMcpToolNamePrefix,
  PI_MCP_RESOURCE_TOOL_NAMES,
  piMcpServerRegistrations,
  piMcpToolOrigin,
  serverBehindTools,
  waitForPiMcpServers,
  type PiMcpServerRegistration,
  assertPiSupportsCodemode,
} from "./mcp/pi-client.js";
import {
  createMcpToolSet,
  type McpDiscoveryRequirement,
  type McpToolSet,
} from "./mcp/tools.js";
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
import { PLATFORM_TOOL_NAMES, platformToolExposure } from "./recipe/agent.js";
import { loadRecipeExtensionFactory } from "./recipe/extensions.js";
import { recipeSkillMatcher } from "./recipe/skills.js";
import {
  bindRecipeExtensionFactory,
  createRecipeExtensionSessionContext,
  createRecipeExtensionRegistrationRegistry,
  recipeExtensionToolAllowlist,
  type RecipeExtensionRegistrationRegistry,
  type RecipeExtensionSessionContext,
} from "./extensions.js";
import {
  applyRecipeAgentModelConfigToModel,
  applyRecipeAgentModelConfigToSession,
  cloneModelForRecipe,
} from "./recipe/model.js";
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
import { recipeStepExtensions, type RecipeStep } from "./skill-progress.js";
import {
  materializeToolsShim,
  toolsShellEnv,
  withToolsCommand,
} from "./tools/shell.js";

function sessionSettingsManager(
  base: SettingsManager,
  sessionSettings: Record<string, unknown> | undefined,
): SettingsManager {
  const merge = (
    left: Record<string, unknown>,
    right: Record<string, unknown>,
  ): Record<string, unknown> => {
    const result = { ...left };
    for (const [key, value] of Object.entries(right)) {
      const current = result[key];
      result[key] =
        current &&
        value &&
        typeof current === "object" &&
        !Array.isArray(current) &&
        typeof value === "object" &&
        !Array.isArray(value)
          ? merge(
              current as Record<string, unknown>,
              value as Record<string, unknown>,
            )
          : value;
    }
    return result;
  };
  // Pi reloads the manager from storage while it builds the session, which
  // discards `applyOverrides`, so the effective settings are baked into a
  // session-local copy. `getSettings` (Pi >=0.99) includes the host's
  // overrides; older Pi exposes only the file-backed scopes.
  const effective =
    (base as { getSettings?: () => object }).getSettings?.() ??
    merge(
      base.getGlobalSettings() as Record<string, unknown>,
      base.getProjectSettings() as Record<string, unknown>,
    );
  return SettingsManager.inMemory(
    merge(effective as Record<string, unknown>, sessionSettings ?? {}) as never,
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
  modelOverride?: Model<Api>;
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
  /**
   * `"defer"` when the host boots this session only to prepare it, such as a
   * bake (see `McpDiscoveryRequirement`). Default `"require"`.
   */
  mcpDiscovery?: McpDiscoveryRequirement;
  /** `${VAR}` resolution source and MCP runtime environment. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Where the host prepared the Recipe's `pi.runtime.python` environments
   * (see `prepareRecipePython`'s `environmentRoot`). Default:
   * `env.PI_RECIPES_PYTHON_ROOT`, else the shared cache under
   * `~/.introspection/python`. The session only checks them, never installs:
   * a missing or outdated environment fails construction.
   */
  pythonEnvironmentRoot?: string;
  /** Default: `SessionManager.inMemory(cwd)`. */
  sessionManager?: SessionManager;
  /**
   * Host settings, including any `applyOverrides` on Pi >=0.99. The agent's `session`
   * policy is layered over them on a session-local copy. Default:
   * `SettingsManager.create(cwd, recipe.recipeDir)`.
   */
  settingsManager?: SettingsManager;
  /** Host extensions appended after the recipe's own extensions. */
  extensionFactories?: ExtensionFactory[];
  /**
   * Where the agent is, as Pi's footer shows it (`build ✓ brainstorm ▸ draft`),
   * for a host that draws its own: called when the agent's step or whether its
   * clock runs changes, and once when a resumed session has a step.
   */
  onRecipeStep?: (step: RecipeStep) => void;
  /**
   * Where `show_artifact` keeps a file too large to carry in its result, for a
   * host that renders artifacts from its own store (see `ArtifactViewerOptions`).
   */
  storeArtifact?: ArtifactStore;
  /**
   * The host's id for a git repository it serves, so `show_artifact` names a
   * committed, pushed file by repository instead of carrying it.
   */
  artifactRepository?: ArtifactRepositoryResolver;
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
  /**
   * The delegated run this session serves, for a host that runs children
   * itself. Root sessions omit it (depth 0). Below `MAX_AGENT_RUN_DEPTH` a
   * session whose agent declares subagents gets the default controller, which
   * starts its runs one level deeper, attributed to this run id; at the bound
   * it never delegates. Settle its runs with `createDelegatedRuns`.
   */
  agentRun?: { id: string; depth: number };
  /** Configuration for the default in-process controller. Ignored when injected. */
  inProcessRunController?: { concurrency?: number };
  /**
   * Extra skill roots beyond the recipe's, added deliberately by the host. The
   * session otherwise offers only the Recipe's resolved skills and the
   * documents tool's skills: nothing from Pi's discovery or an extension.
   */
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
export interface CreateAgentSessionInternalOptions extends CreateAgentSessionOptions {
  /** @internal Credentials already resolved from Pi's authenticated registry. */
  credentialsResolved?: boolean;
  mcpRuntimeDir?: string;
  sessionRole: RecipeExtensionSessionContext["session"]["role"];
  /** @internal Child session factory inherited by this session's own runs. */
  sessionFactory?: (
    options: CreateAgentSessionInternalOptions,
  ) => Promise<RecipeSessionHandle>;
}

export interface RecipeSessionOtelOptions extends Omit<
  InstrumentSessionOptions,
  "meta" | "mcpTool"
> {
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

export { RecipeCredentialError, RecipeModelError, RecipeModelTransportError };

type MutableAgentSession = {
  agent?: { state?: { tools?: Array<{ parameters?: unknown }> } };
};

type SchemaPosition = "schema" | "schema-map" | "literal";

function schemaChildPosition(
  position: SchemaPosition,
  key: PropertyKey,
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
  position: SchemaPosition = "schema",
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
        schemaChildPosition(position, key),
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
  model: Model<Api>,
): void {
  const isGemini = [model.id, model.name].some((value) =>
    value?.toLowerCase().includes("gemini"),
  );
  if (!isGemini) return;
  const mutableSession = session as MutableAgentSession;
  for (const tool of mutableSession.agent?.state?.tools ?? []) {
    tool.parameters = stripAdditionalProperties(tool.parameters);
  }
}

function scopedMcpSelections(
  recipe: ResolvedRecipeAgent,
): ScopedMcpToolSelection[] {
  return resolveAgentMcpSelections(recipe.mcp);
}

interface MaterializedSessionMcp {
  available: boolean;
  materialized: boolean;
  tools?: ToolDefinition[];
  initialActiveToolNames?: string[];
  deferredToolNames?: string[];
  /** `tools` resolves a codemode tool through the session's definitions. */
  mcpToolOrigin?: (
    piName: string,
    tools?: Pick<AgentSession, "getToolDefinition">,
  ) => ReturnType<McpToolSet["mcpToolOrigin"]>;
  /** `mcp.mode: codemode`: the servers Pi's own MCP support connects. */
  piServers?: PiMcpServerRegistration[];
  release?: () => Promise<void>;
}

const leasedMcpEnvironments = new WeakSet<NodeJS.ProcessEnv>();
const CODEMODE_TOOL_NAME = "codemode";

export class RecipeMcpEnvironmentInUseError extends Error {
  override readonly name = "RecipeMcpEnvironmentInUseError";

  constructor() {
    super(
      'This environment already belongs to a live materialized Recipe MCP session; use a separate env object per concurrent session or let the host materialize MCP once and pass mcpProvisioning: "host"',
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
  opts: Pick<CreateAgentSessionOptions, "mcpBindings" | "mcpBindingsPath"> = {},
): Promise<{ materialized: boolean }> {
  const selections = splitMcpSelections(recipe).runtime;
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

/**
 * The selections the agent's MCP mode runs, and those kept on Pi's client
 * behind a tool: every server is on Pi's client in codemode, so nothing is
 * split off there.
 */
function splitMcpSelections(recipe: ResolvedRecipeAgent): {
  runtime: ScopedMcpToolSelection[];
  behind: ScopedMcpToolSelection[];
} {
  const selections = scopedMcpSelections(recipe);
  const behind = mcpServersBehindTools(recipe.mcp);
  if (recipe.mcp?.mode === "codemode" || behind.size === 0) {
    return { runtime: selections, behind: [] };
  }
  return {
    runtime: selections.filter((entry) => !behind.has(entry.serverId)),
    behind: selections.filter((entry) => behind.has(entry.serverId)),
  };
}

/** Servers behind a tool outside codemode: on Pi's client, never written for the `mcp` command or daemon. */
function piServersBehindTools(
  recipe: ResolvedRecipeAgent,
  selections: readonly ScopedMcpToolSelection[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: CreateAgentSessionInternalOptions,
): { piServers: PiMcpServerRegistration[]; servers: McpSessionServer[] } {
  if (selections.length === 0) return { piServers: [], servers: [] };
  const bindingEnv = { ...env };
  if (opts.mcpBindingsPath) {
    bindingEnv.PI_RECIPES_MCP_LOCAL_CONFIG = opts.mcpBindingsPath;
  } else if (!opts.mcpBindings) {
    configureMcpLocalConfigPath({
      cwd,
      recipeDir: recipe.recipeDir,
      env: bindingEnv,
    });
  }
  const { servers } = resolveMcpSessionServers({
    cwd: opts.mcpRuntimeDir ?? cwd,
    manifest: recipe.manifest,
    agentMcp: selections,
    env: bindingEnv,
    ...(opts.mcpBindings ? { localConfig: opts.mcpBindings } : {}),
  });
  return {
    servers,
    piServers: piMcpServerRegistrations({
      session: { version: 1, servers },
      bindings: endpointBindings(bindingEnv, cwd, opts.mcpBindings),
      mcp: recipe.mcp!,
      env: bindingEnv,
    }),
  };
}

async function configureSessionMcp(
  recipe: ResolvedRecipeAgent,
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: CreateAgentSessionInternalOptions,
): Promise<MaterializedSessionMcp> {
  const { runtime: selections, behind } = splitMcpSelections(recipe);
  const behindTools = piServersBehindTools(recipe, behind, cwd, env, opts);
  const behindOrigin: NonNullable<MaterializedSessionMcp["mcpToolOrigin"]> = (
    name,
    tools,
  ) =>
    piMcpToolOrigin(
      { version: 1, servers: behindTools.servers },
      tools?.getToolDefinition(name),
    );
  if (selections.length === 0) {
    return behindTools.piServers.length > 0
      ? {
          available: false,
          materialized: false,
          piServers: behindTools.piServers,
          mcpToolOrigin: behindOrigin,
        }
      : { available: false, materialized: false };
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
    if (!hostProvisioned && (mode === "tools" || mode === "codemode")) {
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

    if (mode === "codemode") {
      const piServers = piMcpServerRegistrations({
        session,
        bindings: endpointBindings(runtimeEnv, cwd, opts.mcpBindings),
        mcp: recipe.mcp!,
        env: runtimeEnv,
      });
      return {
        available: true,
        materialized: !hostProvisioned,
        piServers,
        mcpToolOrigin: (name, tools) =>
          piMcpToolOrigin(session, tools?.getToolDefinition(name)),
        release,
      };
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
        discovery: opts.mcpDiscovery,
      });
      return {
        available: true,
        materialized: !hostProvisioned,
        tools: materialized.tools,
        initialActiveToolNames: materialized.initialActiveToolNames,
        deferredToolNames: materialized.deferredToolNames,
        mcpToolOrigin: (name, tools) =>
          materialized.mcpToolOrigin(name) ?? behindOrigin(name, tools),
        piServers: behindTools.piServers,
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
      piServers: behindTools.piServers,
      mcpToolOrigin: behindOrigin,
      release,
    };
  } catch (error) {
    await release();
    throw error;
  }
}

async function createSessionForAgent(
  recipe: ResolvedRecipeAgent,
  opts: CreateAgentSessionInternalOptions,
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
  const otel = opts.otel
    ? {
        ...opts.otel,
        meta: {
          conversationId: opts.otel.meta?.conversationId ?? randomUUID(),
          agentId:
            opts.otel.meta?.agentId ?? `${recipe.manifest.name}/${recipe.name}`,
          agentName: opts.otel.meta?.agentName ?? recipe.name,
        },
      }
    : undefined;

  // Model + credentials, fail-closed before any MCP runtime starts.
  const modelSpec = recipe.modelSpec;
  const { lookupProvider, modelId } = assertRecipeModelTransport(
    modelSpec,
    opts.modelOverride,
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
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
  });

  // Subagents: the shared `agent` tool against an injected or in-process
  // controller. `runController: null` disables delegation outright, and a
  // session at the maximum run depth never delegates.
  const wantsSubagents =
    recipe.subagents.size > 0 &&
    opts.runController !== null &&
    (opts.agentRun?.depth ?? 0) < MAX_AGENT_RUN_DEPTH;

  let model: Model<Api> | undefined;
  let session: AgentSession | undefined;
  let agentRuns: AgentRunController | undefined;
  let unsubscribe: (() => void) | undefined;
  let detachInstrumentation: (() => void) | undefined;
  // Python: check only, fail-closed before any MCP runtime starts. The host
  // prepares the environments (sync mode) before it creates sessions.
  const pythonEnvironmentRoot =
    opts.pythonEnvironmentRoot ??
    (env[RECIPE_PYTHON_ROOT_ENV]?.trim() || undefined);
  const python = await prepareRecipePython(recipe.recipeDir, {
    mode: "check",
    env,
    ...(pythonEnvironmentRoot
      ? { environmentRoot: pythonEnvironmentRoot }
      : {}),
  });
  const pythonActivation = python.recipe?.activation;
  const recipeExtensionContext = createRecipeExtensionSessionContext({
    recipe: recipe.manifest.name,
    agent: recipe.name,
    role: opts.sessionRole,
    python: python.packages,
  });
  const mcp = await configureSessionMcp(recipe, cwd, env, opts);
  const {
    piServers,
    usesPiMcp,
    codemodeToolNames,
    piMcpResourceToolNames,
    piMcpSessionOptions,
  } = piMcpSessionTools(mcp.piServers, recipe.mcp, recipe.toolPolicy);
  let piMcp: ExtensionAPI | undefined;

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
    const recipeRegistrations = createRecipeExtensionRegistrationRegistry();
    for (const toolName of [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      ...(opts.customTools ?? []).map((tool) => tool.name),
      ...(wantsSubagents ? ["agent"] : []),
    ]) {
      recipeRegistrations.claim("tool", toolName, "<host>");
    }
    const connectors = await loadRecipeConnectors(
      recipe.manifest,
      recipe.tools,
      {
        recipeDir: recipe.recipeDir,
        env,
        cwd,
        python: python.packages,
        exposure: (name) => platformToolExposure(recipe.toolPolicy, name),
      },
    );
    const connectorLoadout = connectors.loadout;
    for (const toolName of [
      ...(connectorLoadout.deferredToolNames.length > 0 ||
      (mcp.deferredToolNames?.length ?? 0) > 0
        ? [RECIPE_TOOL_SEARCH_NAME]
        : []),
      ...((mcp.deferredToolNames?.length ?? 0) > 0
        ? [LEGACY_MCP_TOOL_SEARCH_NAME]
        : []),
      ...codemodeToolNames,
      ...piMcpResourceToolNames,
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
          recipeExtensionToolAllowlist(recipe.tools, wantsSubagents, [
            ...connectorLoadout.toolNames,
            ...(mcp.tools?.map((tool) => tool.name) ?? []),
            ...(connectorLoadout.deferredToolNames.length > 0 ||
            (mcp.deferredToolNames?.length ?? 0) > 0
              ? [RECIPE_TOOL_SEARCH_NAME]
              : []),
            ...((mcp.deferredToolNames?.length ?? 0) > 0
              ? [LEGACY_MCP_TOOL_SEARCH_NAME]
              : []),
          ]),
          usesPiMcp,
        ),
      );
    }
    for (const extensionPath of recipe.extensionPaths) {
      inlineExtensions.push(
        bindRecipeExtensionFactory(
          await loadRecipeExtensionFactory(recipe.recipeDir, extensionPath),
          recipeExtensionContext,
          recipeRegistrations,
          extensionPath,
          recipeExtensionToolAllowlist(recipe.tools, wantsSubagents, [
            ...(mcp.tools?.map((tool) => tool.name) ?? []),
            ...(connectorLoadout.deferredToolNames.length > 0 ||
            (mcp.deferredToolNames?.length ?? 0) > 0
              ? [RECIPE_TOOL_SEARCH_NAME]
              : []),
            ...((mcp.deferredToolNames?.length ?? 0) > 0
              ? [LEGACY_MCP_TOOL_SEARCH_NAME]
              : []),
          ]),
          usesPiMcp,
        ),
      );
    }
    inlineExtensions.push(
      ...piMcpExtensions(
        piServers,
        codemodeToolNames.length > 0,
        recipe.toolPolicy?.mode === "codemode",
        opts.mcpRuntimeDir,
        cwd,
        (pi) => {
          piMcp = pi;
        },
      ),
    );
    // The first-party ask_user_question tool loads after the Recipe's own
    // extensions, so a Recipe that still ships its own keeps it.
    inlineExtensions.push(
      ...interactionToolExtensions(recipe.tools, recipeRegistrations, env),
    );
    // Likewise the first-party artifact viewer (show_artifact and /recipe view).
    if (wantsArtifactViewer(recipe.tools)) {
      inlineExtensions.push(
        artifactViewerExtension(
          recipeRegistrations,
          {
            storeArtifact: opts.storeArtifact,
            artifactRepository: opts.artifactRepository,
          },
          recipe.tools,
          env,
        ),
      );
    }
    inlineExtensions.push(...recipeStepExtensions(recipe, opts.onRecipeStep));
    inlineExtensions.push(...(opts.extensionFactories ?? []));

    const baseSettingsManager =
      opts.settingsManager ?? SettingsManager.create(cwd, recipe.recipeDir);
    const settingsManager = sessionSettingsManager(
      baseSettingsManager,
      recipe.sessionConfig?.settings,
    );
    const offeredSkillPaths = [
      ...(opts.materializedSkillPaths ?? recipe.skillPaths),
      ...(opts.additionalSkillPaths ?? []),
    ];
    const isOfferedSkill = recipeSkillMatcher(
      [...offeredSkillPaths, ...connectors.skillPaths],
      cwd,
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
        additionalSkillPaths: offeredSkillPaths,
        // Offer exactly the Recipe's skills, the host's explicit additions and
        // the documents tool's skills; no extension adds one through
        // resources_discover, matching `pi --recipe`.
        skillsOverride: ({ skills, diagnostics }) => ({
          skills: skills.filter((skill) => isOfferedSkill(skill.filePath)),
          diagnostics,
        }),
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
    const extensionLoadErrors = services.resourceLoader.getExtensions().errors;
    const fatalDiagnostics = diagnostics.filter(
      (diagnostic) => diagnostic.type === "error",
    );
    if (fatalDiagnostics.length > 0 || extensionLoadErrors.length > 0) {
      throw new Error(
        `Recipe extension startup failed:\n${[
          ...extensionLoadErrors.map(
            ({ path, error }) => `- ${path}: ${error}`,
          ),
          ...fatalDiagnostics.map((diagnostic) => `- ${diagnostic.message}`),
        ].join("\n")}`,
      );
    }
    const selectedModel =
      opts.modelOverride ??
      services.modelRuntime.getModel(lookupProvider, modelId) ??
      modelRuntime.getModel(lookupProvider, modelId) ??
      (getModel(lookupProvider as never, modelId as never) as
        Model<Api> | undefined);
    if (!selectedModel) {
      throw new RecipeModelError(modelSpec);
    }
    model = cloneModelForRecipe(selectedModel);
    applyRecipeAgentModelConfigToModel(model, recipe.modelConfig);

    if (opts.runController) {
      agentRuns = opts.runController;
    } else {
      const { createInProcessRunController, inertRunController } =
        await import("./run-controller.js");
      agentRuns = wantsSubagents
        ? createInProcessRunController({
            recipe: opts.recipe!,
            cwd,
            env,
            // Children check the environments this session checked, wherever
            // the host prepared them, not the shared cache.
            ...(pythonEnvironmentRoot ? { pythonEnvironmentRoot } : {}),
            ...(opts.credentials ? { credentials: opts.credentials } : {}),
            ...(opts.settingsManager
              ? { settingsManager: opts.settingsManager }
              : {}),
            concurrency: opts.inProcessRunController?.concurrency,
            depth: (opts.agentRun?.depth ?? 0) + 1,
            ...(opts.agentRun ? { parentAgentRunId: opts.agentRun.id } : {}),
            ...(opts.sessionFactory
              ? { sessionFactory: opts.sessionFactory }
              : {}),
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
        (tool) => !connectorLoadout.toolNames.includes(tool),
      ),
      ...(wantsSubagents ? ["agent"] : []),
    ];
    const mcpToolNames = mcp.tools?.map((tool) => tool.name) ?? [];
    const recipeExtensionTools = services.resourceLoader
      .getExtensions()
      .extensions.flatMap((extension) =>
        [...extension.tools.values()].map((tool) => tool.definition),
      );
    const recipeExtensionToolNames = new Set(
      recipeExtensionTools.map((tool) => tool.name),
    );
    const occupiedToolNames = new Set([
      ...tools,
      ...(opts.customTools ?? []).map((tool) => tool.name),
      ...(wantsSubagents ? ["agent"] : []),
    ]);
    const collisions = mcpToolNames.filter(
      (name) =>
        occupiedToolNames.has(name) || recipeExtensionToolNames.has(name),
    );
    if (collisions.length > 0) {
      throw new Error(
        `Recipe MCP tool name collision: ${collisions.join(", ")}`,
      );
    }
    const hasDeferredTools =
      connectorLoadout.deferredToolNames.length > 0 ||
      (mcp.deferredToolNames?.length ?? 0) > 0;
    const toolSearchTools = hasDeferredTools
      ? createRecipeToolSearchTools(
          {
            getAllTools: () => session?.getAllTools() ?? [],
            getActiveTools: () => session?.getActiveToolNames() ?? [],
            setActiveTools: (names) => session?.setActiveToolsByName(names),
          },
          (mcp.deferredToolNames?.length ?? 0) > 0,
          (tool) => serverBehindTools(piServers, tool) !== undefined,
        )
      : [];
    const occupiedSearchTool = toolSearchTools.find((tool) =>
      occupiedToolNames.has(tool.name),
    );
    if (occupiedSearchTool) {
      throw new Error(
        `Recipe tool name '${occupiedSearchTool.name}' is reserved by the session`,
      );
    }
    const selectedToolNames = [
      ...tools,
      ...connectorLoadout.toolNames,
      ...mcpToolNames,
      ...toolSearchTools.map((tool) => tool.name),
      ...codemodeToolNames,
      // Naming the Recipe's servers keeps their tools and drops any other MCP
      // server's; each tool's exposure then decides what the model sees. A
      // prefix that also covers another of these servers is harmless, as only
      // the Recipe's servers are on this session's MCP client.
      ...piServers.map((server) => `${piMcpToolNamePrefix(server.id)}*`),
    ];
    // The bash tool runs in `env` when the session's MCP CLI lives there, and
    // in the Recipe's Python shell environment when it declares one.
    const mcpShellEnv =
      (recipe.mcp?.mode ?? "cli") === "cli" &&
      mcp.available &&
      env !== process.env;
    const environmentBash = await sessionBash(recipe, {
      cwd,
      env,
      tools,
      mcpShellEnv,
      pythonActivation,
      settingsManager,
      binRoot: opts.mcpRuntimeDir ?? cwd,
      customTools: opts.customTools ?? [],
    });
    const customTools = [
      ...(environmentBash ? [environmentBash] : []),
      ...(opts.customTools ?? []),
      ...(wantsSubagents
        ? [createAgentTool(agentRuns, recipe.subagents, opts.agentToolOptions)]
        : []),
      ...(mcp.tools ?? []),
      ...toolSearchTools,
    ];

    const created = await createAgentSessionFromServices({
      services,
      sessionManager: opts.sessionManager ?? SessionManager.inMemory(cwd),
      model,
      ...(recipe.thinkingLevel ? { thinkingLevel: recipe.thinkingLevel } : {}),
      tools: selectedToolNames,
      ...piMcpSessionOptions,
      customTools,
    });
    session = created.session;
    if (recipe.sessionConfig?.toolExecution) {
      session.agent.toolExecution = recipe.sessionConfig.toolExecution;
    }
    normalizeSessionToolsForModel(session, model);
    applyRecipeAgentModelConfigToSession(session, recipe.modelConfig);
    await session.bindExtensions({});
    await waitForRequiredPiMcpServers(piMcp, piServers, opts.mcpDiscovery, env);
    const registered = new Set(session.getAllTools().map((tool) => tool.name));
    const missingDeclaredTools = selectedToolNames.filter(
      (name) =>
        !name.includes("*") &&
        !registered.has(name) &&
        !recipe.wildcardTools?.includes(name),
    );
    if (missingDeclaredTools.length > 0) {
      throw new Error(
        `Recipe agent "${recipe.name}" declares unavailable tool(s): ${missingDeclaredTools.join(", ")}`,
      );
    }
    const missingConnectorTools = connectorLoadout.toolNames.filter(
      (name) => !registered.has(name),
    );
    if (missingConnectorTools.length > 0) {
      throw new Error(
        `Pi did not register Recipe connector tool(s): ${missingConnectorTools.join(", ")}`,
      );
    }
    if (mcp.tools || connectorLoadout.toolNames.length > 0) {
      const missingRegistered = mcpToolNames.filter(
        (name) => !registered.has(name),
      );
      if (missingRegistered.length > 0) {
        throw new Error(
          `Pi did not register Recipe MCP tool(s): ${missingRegistered.join(", ")}`,
        );
      }
      const activeTools = [
        ...tools.filter(
          (name) => !connectorLoadout.scriptOnlyToolNames.includes(name),
        ),
        ...connectorLoadout.initialActiveToolNames,
        ...(mcp.initialActiveToolNames ?? []),
        ...toolSearchTools.map((tool) => tool.name),
        ...codemodeToolNames,
      ];
      session.setActiveToolsByName(activeTools);
      const applied = new Set(session.getActiveToolNames());
      const missing = activeTools.filter((name) => !applied.has(name));
      if (missing.length > 0) {
        throw new Error(
          `Pi did not activate Recipe tool(s): ${missing.join(", ")}`,
        );
      }
    }

    unsubscribe = opts.onEvent ? session.subscribe(opts.onEvent) : undefined;
    detachInstrumentation = otel
      ? instrumentSession(session, {
          ...otel,
          ...(mcp.mcpToolOrigin
            ? { mcpTool: sessionMcpToolOrigin(mcp.mcpToolOrigin, session) }
            : {}),
        }).detach
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
  opts: CreateAgentSessionOptions,
): Promise<RecipeSessionHandle> {
  return createSessionForAgent(opts.recipe.selectAgent(opts.agentName), {
    ...opts,
    sessionRole: "root",
  });
}

/** @internal Construct a child with Recipes-owned lifecycle state. */
export async function createAgentSessionInternal(
  opts: CreateAgentSessionInternalOptions,
): Promise<RecipeSessionHandle> {
  return createSessionForAgent(opts.recipe.selectAgent(opts.agentName), opts);
}

function sessionMcpToolOrigin(
  origin: NonNullable<MaterializedSessionMcp["mcpToolOrigin"]>,
  session: Pick<AgentSession, "getToolDefinition">,
) {
  return (piName: string) => origin(piName, session);
}

/**
 * Pi's MCP client with the Recipe's servers on it (every server in codemode,
 * else those behind a tool), codemode in codemode, and the guard keeping
 * servers behind their tools.
 */
function piMcpExtensions(
  piServers: PiMcpServerRegistration[],
  codemode: boolean,
  platformCodemode: boolean,
  runtimeDir: string | undefined,
  cwd: string,
  onPi: (pi: ExtensionAPI) => void,
): ExtensionFactory[] {
  // First-party tools in codemode need the codemode tool even with no server.
  if (piServers.length === 0)
    return platformCodemode ? [createCodemodeExtension({ models: false })] : [];
  // A script's `models.*` calls would spend on models the Recipe never
  // declared, so scripts get tools only.
  return [
    ...(codemode ? [createCodemodeExtension({ models: false })] : []),
    createRecipeMcpClientExtension(join(runtimeDir ?? cwd, ".pi", "mcp.log")),
    createPiMcpServersExtension(piServers, onPi),
    ...(piServers.some((server) => server.behind)
      ? [
          createMcpBehindGuard(() => piServers),
          (pi: ExtensionAPI) => {
            pi.on("before_agent_start", (event) =>
              hideServersBehindTools(
                event.systemPromptOptions.sections,
                piServers,
              ),
            );
          },
        ]
      : []),
  ];
}

/**
 * Pi connects in the background; a required server must be up before the
 * first turn, as its catalog must be on the daemon stack.
 */
async function waitForRequiredPiMcpServers(
  piMcp: ExtensionAPI | undefined,
  piServers: PiMcpServerRegistration[],
  mcpDiscovery: McpDiscoveryRequirement | undefined,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!piMcp) return;
  await waitForPiMcpServers(
    piMcp,
    piServers
      .filter(
        (server) =>
          server.required &&
          !(mcpDiscovery === "defer" && server.deferrableDiscovery),
      )
      .map((server) => server.id),
    env,
  );
}

/** What codemode adds to a session's tools: from `mcp.mode` when a server is on Pi's client, or from `tools.mode`. */
function piMcpSessionTools(
  servers: PiMcpServerRegistration[] | undefined,
  mcp: ResolvedRecipeAgent["mcp"],
  toolPolicy: ResolvedRecipeAgent["toolPolicy"],
) {
  const codemode = mcp?.mode === "codemode";
  const piServers = servers ?? [];
  const usesPiMcp = piServers.length > 0;
  const platformCodemode = toolPolicy?.mode === "codemode";
  if (platformCodemode) assertPiSupportsCodemode("tools.mode codemode");
  return {
    piServers,
    usesPiMcp,
    codemodeToolNames:
      (usesPiMcp && codemode) || platformCodemode ? [CODEMODE_TOOL_NAME] : [],
    piMcpResourceToolNames: usesPiMcp ? [...PI_MCP_RESOURCE_TOOL_NAMES] : [],
    piMcpSessionOptions: usesPiMcp
      ? { excludeTools: [...PI_MCP_RESOURCE_TOOL_NAMES] }
      : {},
  };
}

/** The first-party interaction tools the agent lists, after the Recipe's own extensions so a Recipe's own tool wins. */
function interactionToolExtensions(
  tools: readonly string[],
  registrations: RecipeExtensionRegistrationRegistry,
  env: NodeJS.ProcessEnv | undefined,
): ExtensionFactory[] {
  return [
    ...(wantsAskUserQuestion(tools)
      ? [askUserQuestionExtension(registrations, env)]
      : []),
    ...(wantsIntrospectionOpen(tools)
      ? [introspectionOpenExtension(registrations, env)]
      : []),
  ];
}

/**
 * The session's own bash, when the shell needs the Recipe's environment, its
 * Python or, with `tools.mode: cli`, the `tools` command on each call's PATH.
 */
async function sessionBash(
  recipe: ResolvedRecipeAgent,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    tools: readonly string[];
    mcpShellEnv: boolean;
    pythonActivation: Parameters<typeof activateRecipePython>[1] | undefined;
    settingsManager: SettingsManager;
    binRoot: string;
    customTools: readonly ToolDefinition[];
  },
): Promise<ToolDefinition | undefined> {
  const { cwd, env, mcpShellEnv, pythonActivation, settingsManager } = options;
  const firstParty = (PLATFORM_TOOL_NAMES as readonly string[]).filter((name) =>
    recipe.tools.includes(name),
  );
  const toolsBinDir =
    recipe.toolPolicy?.mode === "cli" && firstParty.length > 0
      ? join(options.binRoot, ".pi", "tools", "bin")
      : undefined;
  if (
    !(mcpShellEnv || pythonActivation || toolsBinDir) ||
    !options.tools.includes("bash") ||
    options.customTools.some((tool) => tool.name === "bash")
  )
    return undefined;
  if (toolsBinDir) await materializeToolsShim(toolsBinDir);
  const bash = createBashToolDefinition(cwd, {
    commandPrefix: settingsManager.getShellCommandPrefix(),
    shellPath: settingsManager.getShellPath(),
    spawnHook: (context) => {
      const base = mcpShellEnv
        ? { ...context.env, ...env }
        : { ...context.env };
      const shellEnv = toolsBinDir ? toolsShellEnv(base, toolsBinDir) : base;
      return {
        ...context,
        env: pythonActivation
          ? activateRecipePython(shellEnv, pythonActivation)
          : shellEnv,
      };
    },
  }) as ToolDefinition;
  return toolsBinDir ? withToolsCommand(bash, firstParty) : bash;
}
