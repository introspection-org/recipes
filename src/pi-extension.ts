import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  createRecipeChildAgentRunner,
  promptResultText,
  type CreateRecipeChildAgentRunner,
  type RecipeChildAgentRunner,
  type RecipeChildToolEvent,
} from "./child-agent.js";
import { loadRecipeExtensionFactory } from "./recipe-extensions.js";
import {
  bindRecipeExtensionFactory,
  createRecipeExtensionRegistrationRegistry,
  recipeExtensionToolAllowlist,
  type RecipeExtensionRegistrationRegistry,
} from "./extensions.js";
import {
  ChildAgentRunStore,
  type ChildRunSnapshot,
  type ChildToolActivity,
} from "./child-agent-store.js";
import {
  ChildCompletionQueue,
  envelopeFromRun,
  renderCompletionNotice,
  type ChildCompletionEnvelope,
} from "./child-agent-completions.js";
import {
  AGENT_RUN_EVENT_ENTRY_TYPE,
  type AgentRunEvent,
  type AgentRunEventObserver,
  notifyAgentRunEvent,
} from "./agents.js";
import {
  clearMcpSession,
  clearSessionMcpCli,
  configureMcpLocalConfigPath,
  createIsolatedMcpEnvironment,
  formatMcpConfigurationDiagnostics,
  materializeMcpSession,
  materializeSessionMcpCli,
  resolveAgentMcpSelections,
  stopMcpDaemon,
} from "./mcp.js";
import {
  clearMcpCatalogPreload,
  preloadMcpCatalogs,
} from "./mcp-catalog.js";
import { type RecipeAgentDefinition } from "./recipe-agent.js";
import type { RecipeAgentMcpMode } from "./recipe-agent.js";
import { createMcpToolSet } from "./mcp-tools.js";
import {
  applyRecipeAgentPayloadPolicy,
  applyRecipeAgentModelConfigToModel,
  cloneModelForRecipe,
} from "./recipe-model.js";
import {
  resolveRecipe,
  type ResolvedRecipeAgent,
  type ResolvedRecipe,
} from "./recipe/resolve.js";
import {
  createAgentTool,
  type AgentRunController,
  type AgentRunSummary,
} from "./agents.js";
import { loadRecipeConnectors } from "./connector-tools.js";
import {
  createRecipeToolSearchTools,
  LEGACY_MCP_TOOL_SEARCH_NAME,
  RECIPE_TOOL_SEARCH_NAME,
} from "./tool-search.js";

export interface RecipesExtensionOptions {
  env?: NodeJS.ProcessEnv;
  createChildAgentRunner?: CreateRecipeChildAgentRunner;
  /** Observe canonical Pi events from every child run. */
  onAgentRunEvent?: AgentRunEventObserver;
}

interface AgentCallParams {
  action?: string;
  id?: string;
  name?: string;
  label?: string;
}

/** Mid-turn completion delivery retries on this cadence until the session idles. */
const COMPLETION_DELIVERY_RETRY_MS = 100;
/** Published by the Runtime's proxy-preload.js (introspection-cloud managed-fetch.ts). */
const MANAGED_FETCH_INSTALLER_SYMBOL = Symbol.for(
  "introspection.installManagedFetch"
);
const MANAGED_EGRESS_URL_ENV = "INTROSPECTION_EGRESS_URL";

/**
 * Recompose the Runtime's managed fetch over the fetch Pi installs during its
 * own bootstrap. Returns whether an installer was present.
 */
function ensureManagedFetch(): boolean {
  const install = Reflect.get(globalThis, MANAGED_FETCH_INSTALLER_SYMBOL);
  if (typeof install !== "function") return false;
  install();
  return true;
}

/** Managed egress with no installer means provider requests bypass credential injection. */
function managedFetchMissingWarning(
  env: NodeJS.ProcessEnv
): string | undefined {
  if (!env[MANAGED_EGRESS_URL_ENV]) return undefined;
  return (
    `${MANAGED_EGRESS_URL_ENV} is set but the Runtime's managed fetch is not ` +
    "installed; load proxy-preload.js through NODE_OPTIONS before starting pi"
  );
}

interface ChildRun extends ChildRunSnapshot {
  runner: RecipeChildAgentRunner;
  promise: Promise<ChildRun>;
  notifyUpdate(): void;
}

interface RecipeLaunchState {
  key: string;
  cwd: string;
  resolvedRecipe: ResolvedRecipe;
  resolved: ResolvedRecipeAgent;
  extensionRegistrations: RecipeExtensionRegistrationRegistry;
  extensionsLoaded: boolean;
  extensionFailure?: string;
  configured: boolean;
  mcpConfigured: boolean;
  agentMcpMode: RecipeAgentMcpMode;
  initialMcpToolNames: string[];
  mcpDeferredToolNames: string[];
  initialConnectorToolNames: string[];
  connectorToolNames: string[];
  connectorDeferredToolNames: string[];
  toolSearchRegistered: boolean;
  extensionAllowedToolNames: Set<string>;
  mcpPrivateEnv?: NodeJS.ProcessEnv;
  mcpPrivateDirectory?: string;
  mcpAmbientMcporterConfig?: string;
}

const require = createRequire(import.meta.url);

class RecipeLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeLaunchError";
  }
}

function stringFlag(value: boolean | string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recipeNotFoundMessage(input: string, resolvedPath: string): string {
  const lines = [`Recipe "${input}" was not found.`];
  lines.push(`Resolved path: ${resolvedPath}`);
  lines.push("Pass a local Recipe directory containing package.json with a pi block.");
  lines.push("Then launch again with `pi --recipe <recipe>`.");
  return lines.join("\n");
}

function recipeLoadErrorMessage(input: string, reason: string): string {
  return [
    `Recipe "${input}" could not be loaded.`,
    reason,
    "Run `introspection check` from the repository for a validation report.",
  ].join("\n");
}

function modelParts(spec: string): { provider: string; model: string } {
  const index = spec.indexOf("/");
  if (index < 0) {
    throw new Error(
      `Invalid recipe model "${spec}" - expected "<provider>/<model_id>"`
    );
  }
  return {
    provider: spec.slice(0, index),
    model: spec.slice(index + 1),
  };
}

function visibleSubagents(state: RecipeLaunchState): RecipeAgentDefinition[] {
  return [...state.resolved.subagents.values()];
}

function mcpSelectionsForAgent(agent: RecipeAgentDefinition) {
  return resolveAgentMcpSelections(agent.mcp);
}

function resolvedMcpMode(state: RecipeLaunchState): RecipeAgentMcpMode {
  return state.resolved.mcp?.mode ?? "cli";
}

function textResult<TDetails>(text: string, details: TDetails) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      return record?.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function resultText(result: unknown): string {
  const record = asRecord(result);
  return contentText(record?.content).trim();
}

function themeFg(theme: { fg?: (name: any, text: string) => string } | undefined, name: string, text: string): string {
  return theme?.fg ? theme.fg(name, text) : text;
}

function themeBold(theme: { bold?: (text: string) => string } | undefined, text: string): string {
  return theme?.bold ? theme.bold(text) : text;
}

function truncateLine(text: string, max = 120): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 3)}...` : singleLine;
}

function formatAgentCall(
  args: AgentCallParams,
  theme: { fg?: (name: any, text: string) => string; bold?: (text: string) => string } | undefined
): string {
  const action = args.action ?? "start";
  const agent = args.name ?? args.id ?? "agent";
  const label = args.label ? ` ${themeFg(theme, "muted", `(${args.label})`)}` : "";
  return `${themeFg(theme, "toolTitle", themeBold(theme, `agent ${action}`))} ${themeFg(theme, "accent", agent)}${label}`;
}

// Stable wire value used by persisted transcripts and the renderer.
const AGENT_COMPLETIONS_TYPE = "recipe-agent-completions";

interface AgentCompletionsDetails {
  completions: ChildCompletionEnvelope[];
}

function formatDurationMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** Compact TUI rendering for a completion wake-up notice (pi-subagents style). */
function formatCompletionMessage(
  batch: readonly ChildCompletionEnvelope[],
  options: { expanded: boolean },
  theme: { fg?: (name: any, text: string) => string; bold?: (text: string) => string } | undefined
): string {
  const blocks = batch.map((envelope) => {
    const icon =
      envelope.status === "completed"
        ? themeFg(theme, "success", "✓")
        : themeFg(theme, "error", "✗");
    const label = envelope.label
      ? ` ${themeFg(theme, "muted", `(${envelope.label})`)}`
      : "";
    const duration =
      envelope.duration_ms !== undefined
        ? ` ${themeFg(theme, "muted", `· ${formatDurationMs(envelope.duration_ms)}`)}`
        : "";
    let text = `${icon} ${themeBold(theme, envelope.agent)} ${themeFg(theme, "muted", envelope.id)}${label} ${themeFg(theme, "muted", envelope.status)}${duration}`;
    const preview =
      (envelope.status === "failed"
        ? envelope.error ?? envelope.output_preview
        : envelope.output_preview
      )?.trim() ?? "";
    const lines = preview.split("\n").filter((line) => line.trim());
    const shown = options.expanded ? lines : lines.slice(0, 1);
    for (const line of shown.length > 0 ? shown : ["(no output)"]) {
      text += `\n  ${themeFg(theme, "muted", `⎿  ${options.expanded ? line : truncateLine(line)}`)}`;
    }
    if (!options.expanded && lines.length > 1) {
      text += `\n  ${themeFg(theme, "muted", "⎿  … (expand for full output)")}`;
    }
    return text;
  });
  return blocks.join("\n");
}

function snapshotOf(run: ChildRunSnapshot): ChildRunSnapshot {
  return {
    id: run.id,
    agent: run.agent,
    label: run.label,
    prompt: run.prompt,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    output: run.output,
    error: run.error,
    toolCalls: run.toolCalls.map((call) => ({ ...call })),
  };
}

function controllerSummary(
  run: ChildRunSnapshot,
  status: AgentRunSummary["status"] = run.status
): AgentRunSummary {
  const startedAt = Date.parse(run.startedAt);
  const completedAt = run.completedAt ? Date.parse(run.completedAt) : undefined;
  const currentTool = [...run.toolCalls]
    .reverse()
    .find((call) => call.status === "running")?.name;
  return {
    agent_run_id: run.id,
    invocation_name: run.agent,
    agent_name: run.agent,
    label: run.label ?? run.agent,
    prompt: run.prompt,
    status,
    started_at: Number.isFinite(startedAt) ? startedAt : Date.now(),
    ...(completedAt !== undefined && Number.isFinite(completedAt)
      ? { completed_at: completedAt }
      : {}),
    last_activity_at:
      completedAt !== undefined && Number.isFinite(completedAt)
        ? completedAt
        : Number.isFinite(startedAt)
          ? startedAt
          : Date.now(),
    ...(currentTool ? { current_tool: currentTool } : {}),
    nested_tools: run.toolCalls.map((call) => ({
      toolName: call.name,
      verb: call.name,
      detail: call.output ?? call.error ?? "",
      ...(asRecord(call.args) ? { toolInput: asRecord(call.args)! } : {}),
    })),
    output_preview: run.output,
    output: run.output,
    error: run.error,
  };
}

function nameList(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "(none)";
}

function bulletList(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `  - ${item}`) : ["  - none"];
}

function activeRecipeTools(
  state: RecipeLaunchState,
  activeTools: string[]
): string[] {
  const active = new Set(activeTools);
  const recipeTools = new Set([
    ...state.resolved.tools,
    ...(state.resolved.subagents.size > 0 ? ["agent"] : []),
  ]);
  return [...recipeTools]
    .filter((tool) => active.has(tool))
    .sort();
}

function recipeSummary(state: RecipeLaunchState, activeTools: string[]): string {
  const subagents = visibleSubagents(state).map((agent) => agent.name);
  return [
    "Active Recipe",
    `Name: ${state.resolved.manifest.name}@${state.resolved.manifest.version}`,
    state.resolved.manifest.description ? `Description: ${state.resolved.manifest.description}` : undefined,
    `Agent: ${state.resolved.name}`,
    `Model: ${state.resolved.definition.model?.name ?? "(session default)"}`,
    `Thinking level: ${state.resolved.definition.model?.thinkingLevel ?? "(session default)"}`,
    `Subagents: ${nameList(subagents)}`,
    "",
    "Active recipe tools:",
    ...bulletList(activeRecipeTools(state, activeTools)),
    "",
    `Package extensions: ${state.resolved.extensionPaths.length}`,
    `Package prompts: ${state.resolved.promptPaths.length}`,
    "Host layer: trusted ambient Pi hooks and settings may also apply",
    "",
    `Directory: ${state.resolved.recipeDir}`,
    `Workspace: ${state.cwd}`,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function applyChildToolEvent(run: ChildRun, event: RecipeChildToolEvent): void {
  const existing = run.toolCalls.find((call) => call.id === event.id);
  if (event.type === "start") {
    if (existing) {
      existing.name = event.name;
      existing.args = event.args;
      existing.status = "running";
      existing.completedAt = undefined;
      existing.output = undefined;
      existing.error = undefined;
      return;
    }
    run.toolCalls.push({
      id: event.id,
      name: event.name,
      args: event.args,
      status: "running",
      startedAt: new Date().toISOString(),
    });
    return;
  }

  const call =
    existing ??
    (() => {
      const created: ChildToolActivity = {
        id: event.id,
        name: event.name,
        args: event.args,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      run.toolCalls.push(created);
      return created;
    })();

  call.name = event.name;
  call.args = event.args;
  if (event.type === "update") {
    const text = resultText(event.partialResult);
    if (text) call.output = text;
    return;
  }

  call.completedAt = new Date().toISOString();
  call.status = event.isError ? "failed" : "completed";
  const text = resultText(event.result);
  if (text) call.output = text;
  if (event.isError) call.error = text || "Tool failed";
}

export function createRecipesExtension(
  opts: RecipesExtensionOptions = {}
): ExtensionFactory {
  const env = opts.env ?? process.env;
  const createChildAgentRunner =
    opts.createChildAgentRunner ?? createRecipeChildAgentRunner;
  let state: RecipeLaunchState | null = null;
  let lastLaunchErrorKey: string | null = null;
  let childRunIndex = 0;
  const childRuns = new Map<string, ChildRun>();
  // Runs restored from a previous Pi process via rehydrateChildRuns(). They
  // have no live runner: readable (status/wait) but not controllable.
  const archivedRuns = new Map<string, ChildRunSnapshot>();
  let runStore: { cwd: string; store: ChildAgentRunStore } | null = null;
  // Background completions pending delivery to the parent model.
  const completions = new ChildCompletionQueue();
  // Latest extension context, for the idle check gating completion delivery.
  let sessionCtx: Pick<ExtensionContext, "isIdle"> | null = null;
  let localAgentContext: ExtensionContext | null = null;
  let extensionApi: ExtensionAPI | null = null;
  let sessionConfigurationError: string | null = null;
  const visibleAgentDefinitions = new Map<string, RecipeAgentDefinition>();

  function storeFor(cwd: string): ChildAgentRunStore {
    if (runStore?.cwd !== cwd) {
      runStore = { cwd, store: new ChildAgentRunStore(cwd) };
    }
    return runStore.store;
  }

  async function persistRun(cwd: string, run: ChildRunSnapshot): Promise<void> {
    try {
      await storeFor(cwd).writeStatus(snapshotOf(run));
    } catch {
      // persistence is best-effort; the live run stays authoritative
    }
  }

  function nextChildRunId(): string {
    return `agent-run-${++childRunIndex}`;
  }

  /**
   * Restore run snapshots persisted under `.pi/agents/` by a previous Pi
   * process, so run ids referenced in a resumed conversation stay resolvable.
   * A run persisted as `running` died with the old process — it is flipped to
   * `interrupted` (never silently "resumed"). Returns the number restored.
   */
  async function rehydrateChildRuns(cwd: string): Promise<number> {
    const store = storeFor(cwd);
    const persisted = await store.readPersistedSnapshots();
    let restored = 0;
    for (const snapshot of persisted) {
      const indexMatch = /^(?:agent-run|recipe-agent)-(\d+)$/.exec(snapshot.id);
      if (indexMatch) {
        childRunIndex = Math.max(childRunIndex, Number(indexMatch[1]));
      }
      if (childRuns.has(snapshot.id) || archivedRuns.has(snapshot.id)) {
        continue;
      }
      if (snapshot.status === "running") {
        snapshot.status = "interrupted";
        snapshot.completedAt = snapshot.completedAt ?? new Date().toISOString();
        snapshot.error = "Pi session restarted while the run was in flight";
        await persistRun(cwd, snapshot);
      }
      archivedRuns.set(snapshot.id, snapshot);
      restored += 1;
    }
    return restored;
  }

  function findRunSnapshot(id: string): ChildRunSnapshot | undefined {
    return childRuns.get(id) ?? archivedRuns.get(id);
  }

  const localRunController: AgentRunController = {
    list() {
      return [
        ...childRuns.values(),
        ...[...archivedRuns.values()].filter(
          (snapshot) => !childRuns.has(snapshot.id)
        ),
      ].map((run) => controllerSummary(run));
    },
    get(id) {
      const run = findRunSnapshot(id);
      return run ? controllerSummary(run) : null;
    },
    async start(input) {
      if (!state || !localAgentContext) {
        throw new Error("No recipe session is active");
      }
      const run = await runChildAgent(
        state,
        input.name,
        input.prompt,
        input.label,
        localAgentContext,
        input.onUpdate
      );
      return controllerSummary(run);
    },
    async wait(id, signal) {
      const run = findRunSnapshot(id);
      if (!run) throw new Error(`Unknown agent run: ${id}`);
      if (run.status !== "running" || !childRuns.has(id)) {
        return controllerSummary(run);
      }
      await waitForRun(childRuns.get(id)!, signal);
      return controllerSummary(findRunSnapshot(id)!);
    },
    async message(id, message) {
      if (archivedRuns.has(id) && !childRuns.has(id)) {
        throw new Error(
          `Agent run ${id} belongs to a previous Pi session and cannot be controlled`
        );
      }
      const run = childRuns.get(id);
      if (!run) throw new Error(`Unknown agent run: ${id}`);
      if (run.status === "running") {
        await run.runner.steer(message);
        return controllerSummary(run);
      }
      run.status = "running";
      run.completedAt = undefined;
      run.error = undefined;
      run.output = undefined;
      run.promise = executeChildPrompt(run, message, state?.cwd ?? process.cwd());
      void persistRun(state?.cwd ?? process.cwd(), run);
      return controllerSummary(run);
    },
    async interrupt(id) {
      if (archivedRuns.has(id) && !childRuns.has(id)) {
        throw new Error(
          `Agent run ${id} belongs to a previous Pi session and cannot be controlled`
        );
      }
      const run = childRuns.get(id);
      if (!run) throw new Error(`Unknown agent run: ${id}`);
      if (run.status === "running") {
        run.status = "interrupted";
        run.completedAt = run.completedAt ?? new Date().toISOString();
        await run.runner.cancel();
        if (state) void persistRun(state.cwd, run);
      }
      return controllerSummary(run);
    },
    async close(id) {
      if (archivedRuns.has(id) && !childRuns.has(id)) {
        throw new Error(
          `Agent run ${id} belongs to a previous Pi session and cannot be controlled`
        );
      }
      const run = childRuns.get(id);
      if (!run) throw new Error(`Unknown agent run: ${id}`);
      if (run.status === "running") {
        run.status = "interrupted";
        await run.runner.cancel();
        await run.promise;
      }
      await run.runner.shutdown();
      childRuns.delete(id);
      return controllerSummary(run, "closed");
    },
    async shutdown() {
      await closeAllChildRuns();
    },
  };

  async function closeAllChildRuns(): Promise<void> {
    await Promise.all(
      [...childRuns.keys()].map((id) => localRunController.close(id))
    );
  }

  async function closeRootMcpRuntime(): Promise<void> {
    const privateEnv = state?.mcpPrivateEnv;
    const privateDirectory = state?.mcpPrivateDirectory;
    if (privateEnv) {
      clearMcpCatalogPreload(privateEnv);
      await stopMcpDaemon(privateEnv);
    }
    if (privateDirectory) {
      await rm(privateDirectory, { recursive: true, force: true });
    }
    if (state) {
      state.mcpPrivateEnv = undefined;
      state.mcpPrivateDirectory = undefined;
      if (state.mcpAmbientMcporterConfig) {
        env.MCPORTER_CONFIG = state.mcpAmbientMcporterConfig;
        state.mcpAmbientMcporterConfig = undefined;
      }
    }
  }

  function archivedControlError(id: string) {
    return {
      ...textResult(
        `Agent run ${id} belongs to a previous Pi session and cannot be controlled; only status and wait are available.`,
        { id }
      ),
      isError: true,
    };
  }

  // Launch selection is immutable for the lifetime of this extension. Resolved
  // values are exported below for shell tools, but must not become inputs to a
  // later session load in the same process.
  const launchRecipeDir = stringFlag(env.PI_RECIPE_DIR);
  const launchAgentName = stringFlag(env.PI_AGENT_NAME);
  const originalRecipeDirEnv = env.PI_RECIPE_DIR;
  const originalAgentNameEnv = env.PI_AGENT_NAME;

  function recipeFlag(pi: Parameters<ExtensionFactory>[0]): string | undefined {
    return stringFlag(pi.getFlag("recipe")) ?? launchRecipeDir;
  }

  function selectedAgentName(pi: Parameters<ExtensionFactory>[0]): string | undefined {
    return stringFlag(pi.getFlag("agent")) ?? launchAgentName;
  }

  function loadState(pi: Parameters<ExtensionFactory>[0], cwd: string): RecipeLaunchState | null {
    const flag = recipeFlag(pi);
    if (!flag) return null;

    const recipeDir = resolve(cwd, flag);
    if (!existsSync(recipeDir)) {
      throw new RecipeLaunchError(recipeNotFoundMessage(flag, recipeDir));
    }
    const requestedAgentName = selectedAgentName(pi);
    const key = [cwd, recipeDir, requestedAgentName ?? ""].join("\0");
    if (state?.key === key) return state;

    let resolvedRecipe: ResolvedRecipe;
    let resolved: ResolvedRecipeAgent;
    try {
      resolvedRecipe = resolveRecipe({ recipeDir });
      resolved = resolvedRecipe.selectAgent(requestedAgentName);
    } catch (err) {
      throw new RecipeLaunchError(
        recipeLoadErrorMessage(flag, err instanceof Error ? err.message : String(err))
      );
    }
    // Keep the recipe selected by CLI flags visible to shell commands and
    // recipe-authored instructions. In production `env` is process.env, so
    // built-in shell tools and child agents inherit these resolved values.
    env.PI_RECIPE_DIR = recipeDir;
    env.PI_AGENT_NAME = resolved.name;

    state = {
      key,
      cwd,
      resolvedRecipe,
      resolved,
      extensionRegistrations: createRecipeExtensionRegistrationRegistry(),
      extensionsLoaded: false,
      configured: false,
      mcpConfigured: false,
      agentMcpMode: "cli",
      initialMcpToolNames: [],
      mcpDeferredToolNames: [],
      initialConnectorToolNames: [],
      connectorToolNames: [],
      connectorDeferredToolNames: [],
      toolSearchRegistered: false,
      extensionAllowedToolNames: new Set([
        ...resolved.tools,
        ...(resolved.subagents.size > 0 ? ["agent"] : []),
      ]),
    };
    return state;
  }

  function safeLoadState(
    pi: Parameters<ExtensionFactory>[0],
    cwd: string,
    ctx?: Pick<ExtensionContext, "ui" | "mode">
  ): RecipeLaunchState | null {
    try {
      return loadState(pi, cwd);
    } catch (err) {
      if (!(err instanceof RecipeLaunchError)) throw err;
      const key = [cwd, recipeFlag(pi) ?? "", err.message].join("\0");
      if (lastLaunchErrorKey !== key) {
        failRecipeSession(pi, err.message, ctx);
        lastLaunchErrorKey = key;
      } else {
        sessionConfigurationError = err.message;
        pi.setActiveTools([]);
      }
      return null;
    }
  }

  function failRecipeSession(
    pi: Parameters<ExtensionFactory>[0],
    message: string,
    ctx?: Pick<ExtensionContext, "ui" | "mode">
  ): void {
    sessionConfigurationError = message;
    pi.setActiveTools([]);
    ctx?.ui.notify(`Recipe session cannot start: ${message}`, "warning");
    if (ctx?.mode === "json" || ctx?.mode === "print") {
      process.exitCode = 1;
    }
  }

  async function loadRecipeExtensions(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    launchState: RecipeLaunchState
  ): Promise<void> {
    if (launchState.extensionFailure) {
      throw new Error(launchState.extensionFailure);
    }
    if (launchState.extensionsLoaded) return;
    // Pi cannot unload registrations made by an earlier factory if a later
    // factory fails. Mark the closure attempted before execution so the same
    // live runner never retries a partially installed closure.
    launchState.extensionsLoaded = true;
    for (const tool of pi.getAllTools()) {
      launchState.extensionRegistrations.claim(
        "tool",
        tool.name,
        "<host>"
      );
    }
    let loadedCount = 0;
    try {
      const connectors = await loadRecipeConnectors(
        launchState.resolved.manifest,
        launchState.resolved.tools,
        {
          recipeDir: launchState.resolved.recipeDir,
          env,
          cwd: launchState.cwd,
        }
      );
      launchState.initialConnectorToolNames =
        connectors.loadout.initialActiveToolNames;
      launchState.connectorToolNames = connectors.loadout.toolNames;
      launchState.connectorDeferredToolNames =
        connectors.loadout.deferredToolNames;
      if (launchState.connectorDeferredToolNames.length > 0) {
        launchState.extensionRegistrations.claim(
          "tool",
          RECIPE_TOOL_SEARCH_NAME,
          "<host>"
        );
      }
      for (const toolName of connectors.loadout.toolNames) {
        launchState.extensionAllowedToolNames.add(toolName);
      }
      for (const connector of connectors.extensions) {
        const factory = bindRecipeExtensionFactory(
          connector.factory,
          Object.freeze({
            recipe: Object.freeze({ name: launchState.resolved.manifest.name }),
            agent: Object.freeze({ name: launchState.resolved.name }),
            session: Object.freeze({ role: "root" as const }),
          }),
          launchState.extensionRegistrations,
          connector.owner,
          launchState.extensionAllowedToolNames
        );
        await factory(pi);
      }
      for (const extensionPath of launchState.resolved.extensionPaths) {
        const factory = bindRecipeExtensionFactory(
          await loadRecipeExtensionFactory(
            launchState.resolved.recipeDir,
            extensionPath
          ),
          Object.freeze({
            recipe: Object.freeze({ name: launchState.resolved.manifest.name }),
            agent: Object.freeze({ name: launchState.resolved.name }),
            session: Object.freeze({
              role: "root" as const,
            }),
          }),
          launchState.extensionRegistrations,
          extensionPath,
          launchState.extensionAllowedToolNames
        );
        await factory(pi);
        loadedCount += 1;
      }
    } catch (error) {
      launchState.extensionFailure =
        error instanceof Error ? error.message : String(error);
      throw error;
    }
    if (launchState.resolved.extensionPaths.length > 0) {
      ctx.ui.notify(
        `Recipe extensions: ${loadedCount}/${launchState.resolved.extensionPaths.length} loaded`,
        "info"
      );
    }
  }

  async function configureSession(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    launchState: RecipeLaunchState
  ): Promise<void> {
    if (launchState.configured) return;

    const unsupportedPortableConfig = [
      launchState.resolved.modelConfig?.streamOptions
        ? "ai.options (or legacy model request options)"
        : undefined,
      launchState.resolved.sessionConfig ? "session" : undefined,
    ].filter((value): value is string => Boolean(value));
    if (unsupportedPortableConfig.length > 0) {
      throw new Error(
        `Pi's extension API cannot apply Recipe ${unsupportedPortableConfig.join(
          " and "
        )}; use the embedded Recipe session API until Pi exposes request-default and session-policy setters`
      );
    }

    const labelParts = [
      `${launchState.resolved.manifest.name}@${launchState.resolved.manifest.version}`,
      `agent:${launchState.resolved.name}`,
    ].filter(Boolean);
    pi.setSessionName(labelParts.join(" "));

    const { provider, model } = modelParts(launchState.resolved.modelSpec);
    const lookupProvider = provider === "gemini" ? "google" : provider;
    const registeredModel = ctx.modelRegistry.find(lookupProvider, model);
    if (!registeredModel) {
      throw new Error(
        `Recipe model is not available: ${launchState.resolved.modelSpec}`
      );
    }
    const resolvedModel = cloneModelForRecipe(registeredModel);
    applyRecipeAgentModelConfigToModel(
      resolvedModel,
      launchState.resolved.modelConfig
    );
    const ok = await pi.setModel(resolvedModel);
    if (!ok) {
      throw new Error(
        `Recipe model has no configured API key: ${launchState.resolved.modelSpec}`
      );
    }

    if (launchState.resolved.thinkingLevel) {
      pi.setThinkingLevel(launchState.resolved.thinkingLevel);
    }

    const deferredToolNames = [
      ...launchState.connectorDeferredToolNames,
      ...launchState.mcpDeferredToolNames,
    ];
    if (deferredToolNames.length > 0 && !launchState.toolSearchRegistered) {
      const toolSearchTools = createRecipeToolSearchTools({
        tools: pi.getAllTools(),
        deferredToolNames,
        activation: {
          getActiveTools: () => pi.getActiveTools(),
          setActiveTools: (names) => pi.setActiveTools(names),
        },
      }, launchState.mcpDeferredToolNames.length > 0);
      if (toolSearchTools.length === 0) {
        throw new Error("Recipe tool search has no deferred tools");
      }
      for (const toolSearch of toolSearchTools) {
        launchState.extensionAllowedToolNames.add(toolSearch.name);
        pi.registerTool(toolSearch);
      }
      launchState.toolSearchRegistered = true;
    }
    const activeTools = new Set([
      ...launchState.resolved.tools.filter(
        (tool) => !launchState.connectorToolNames.includes(tool)
      ),
      ...launchState.initialConnectorToolNames,
      ...(launchState.resolved.subagents.size > 0 ? ["agent"] : []),
      ...launchState.initialMcpToolNames,
      ...(deferredToolNames.length > 0 ? [RECIPE_TOOL_SEARCH_NAME] : []),
      ...(launchState.mcpDeferredToolNames.length > 0
        ? [LEGACY_MCP_TOOL_SEARCH_NAME]
        : []),
    ]);
    const registeredTools = new Set(
      pi.getAllTools().map((tool) => tool.name)
    );
    const missingTools = [...activeTools].filter(
      (name) => !registeredTools.has(name)
    );
    if (missingTools.length > 0) {
      throw new Error(
        `Recipe agent "${launchState.resolved.name}" declares unavailable tool(s): ${missingTools.join(", ")}`
      );
    }
    pi.setActiveTools([...activeTools]);
    launchState.configured = true;
    sessionConfigurationError = null;
  }

  async function configureMcp(
    pi: ExtensionAPI,
    launchState: RecipeLaunchState,
    ctx: Pick<ExtensionContext, "ui">
  ): Promise<void> {
    if (launchState.mcpConfigured) return;
    launchState.agentMcpMode = resolvedMcpMode(launchState);
    launchState.initialMcpToolNames = [];
    launchState.mcpDeferredToolNames = [];
    configureMcpLocalConfigPath({
      cwd: launchState.cwd,
      recipeDir: launchState.resolved.recipeDir,
      env,
    });

    if (launchState.agentMcpMode === "cli") {
      const mcpSelections = resolveAgentMcpSelections(
        launchState.resolved.mcp
      );
      if (mcpSelections.length === 0) {
        await clearMcpSession(env, launchState.cwd);
        launchState.mcpConfigured = true;
        return;
      }
      const [, session] = await Promise.all([
        materializeSessionMcpCli({
          cwd: launchState.cwd,
          env,
        }),
        materializeMcpSession({
          cwd: launchState.cwd,
          manifest: launchState.resolved.manifest,
          agentMcp: mcpSelections,
          env,
        }),
      ]);
      if (session.servers.length > 0) {
        void preloadMcpCatalogs({ env }).catch((error) => {
          console.warn(
            `Recipe MCP catalog preload failed: ${error instanceof Error ? error.message : String(error)}`
          );
        });
        ctx.ui.notify(
          `Recipe MCP: ${session.servers.length} server(s) configured; runtime warming in background`,
          "info"
        );
      } else {
        const detail = formatMcpConfigurationDiagnostics(
          session.diagnostics ?? []
        );
        ctx.ui.notify(
          [
            "Recipe MCP: no servers are available to this agent. Check package policy and .pi/mcp.local.json.",
            ...(detail ? ["", detail] : []),
          ].join("\n"),
          "warning"
        );
      }
      const detail = formatMcpConfigurationDiagnostics(
        session.diagnostics ?? []
      );
      if (session.servers.length > 0 && detail) {
        ctx.ui.notify(
          [
            "Recipe MCP: some configured servers or tools were filtered.",
            "",
            detail,
          ].join("\n"),
          "warning"
        );
      }
      launchState.mcpConfigured = true;
      return;
    }

    const clearedCli = await clearSessionMcpCli(env, launchState.cwd);
    launchState.mcpAmbientMcporterConfig =
      clearedCli.previousMcporterConfig;
    const rootMcp = launchState.resolved.mcp;
    const rootSelections = mcpSelectionsForAgent(
      launchState.resolved.definition
    );
    if (!rootMcp || rootSelections.length === 0) {
      launchState.mcpConfigured = true;
      return;
    }

    const privateRuntime = await createIsolatedMcpEnvironment(env);
    launchState.mcpPrivateEnv = privateRuntime.env;
    launchState.mcpPrivateDirectory = privateRuntime.directory;
    try {
      const session = await materializeMcpSession({
        cwd: launchState.cwd,
        manifest: launchState.resolved.manifest,
        agentMcp: rootSelections,
        env: privateRuntime.env,
        mcporterConfigPath: privateRuntime.mcporterConfigPath,
      });
      if (session.servers.length === 0) {
        const detail = formatMcpConfigurationDiagnostics(
          session.diagnostics ?? []
        );
        ctx.ui.notify(
          [
            "Recipe MCP tools: no servers are available to the root agent.",
            ...(detail ? ["", detail] : []),
          ].join("\n"),
          "warning"
        );
        launchState.mcpConfigured = true;
        return;
      }
      const catalogs = await preloadMcpCatalogs({
        env: privateRuntime.env,
        allowPartial: true,
      });
      const materialized = createMcpToolSet({
        session,
        catalogs,
        mcp: rootMcp,
        env: privateRuntime.env,
      });
      const existing = new Set(pi.getAllTools().map((tool) => tool.name));
      for (const tool of materialized.tools) {
        if (existing.has(tool.name)) {
          throw new Error(
            `Cannot register MCP tool '${tool.name}': the Pi tool name is already in use.`
          );
        }
      }
      for (const tool of materialized.tools) pi.registerTool(tool);
      const registered = new Set(pi.getAllTools().map((tool) => tool.name));
      const missing = materialized.tools
        .map((tool) => tool.name)
        .filter((name) => !registered.has(name));
      if (missing.length > 0) {
        throw new Error(
          `Pi did not register MCP tool(s): ${missing.join(", ")}`
        );
      }
      launchState.initialMcpToolNames =
        materialized.initialActiveToolNames;
      launchState.mcpDeferredToolNames = materialized.deferredToolNames;
      for (const toolName of materialized.toolNames) {
        launchState.extensionAllowedToolNames.add(toolName);
      }
      ctx.ui.notify(
        `Recipe MCP tools: ${materialized.toolNames.length} registered, ${materialized.initialActiveToolNames.length} initially active${
          materialized.deferredToolNames.length > 0
            ? `, ${materialized.deferredToolNames.length} deferred`
            : ""
        }`,
        "info"
      );
      const diagnostics = [
        ...formatMcpConfigurationDiagnostics(session.diagnostics ?? [])
          .split("\n")
          .filter(Boolean),
        ...materialized.diagnostics,
      ];
      if (diagnostics.length > 0) {
        ctx.ui.notify(
          [
            "Recipe MCP: some configured tools were unavailable.",
            "",
            ...diagnostics,
          ].join("\n"),
          "warning"
        );
      }
      launchState.mcpConfigured = true;
    } catch (error) {
      clearMcpCatalogPreload(privateRuntime.env);
      await stopMcpDaemon(privateRuntime.env);
      await rm(privateRuntime.directory, { recursive: true, force: true });
      launchState.mcpPrivateEnv = undefined;
      launchState.mcpPrivateDirectory = undefined;
      throw error;
    }
  }

  async function runChildAgent(
    launchState: RecipeLaunchState,
    agentName: string,
    prompt: string,
    label: string | undefined,
    ctx: ExtensionContext,
    onUpdate?: (summary: AgentRunSummary) => void | Promise<void>
  ): Promise<ChildRun> {
    const id = nextChildRunId();
    let run: ChildRun | undefined;
    const notifyUpdate = () => {
      if (!run || !onUpdate) return;
      try {
        void Promise.resolve(onUpdate(controllerSummary(run))).catch(() => {});
      } catch {
        // Detached runs can outlive the parent tool call. Late UI updates are
        // cosmetic and must not stop the child or completion delivery.
      }
    };
    const runner = createChildAgentRunner({
      recipe: launchState.resolvedRecipe,
      workspaceDir: launchState.cwd,
      env,
      agentName,
      modelRegistry: ctx.modelRegistry,
      onEvent(event) {
        if (!run) return;
        const envelope: AgentRunEvent = {
          type: "agent_run_event",
          agent_run_id: run.id,
          parent_agent_run_id: "root",
          agent_name: run.agent,
          invocation_name: run.agent,
          depth: 1,
          event,
        };
        notifyAgentRunEvent(opts.onAgentRunEvent, envelope);
        // Custom entries join Pi's canonical session event stream without
        // entering model context. JSON mode serializes the resulting single
        // `entry_appended` event through Pi's guarded output writer.
        try {
          extensionApi?.appendEntry(AGENT_RUN_EVENT_ENTRY_TYPE, envelope);
        } catch {
          // Event capture is auxiliary. Session persistence failures must not
          // change the outcome of the child work being observed.
        }
      },
      onAssistantMessage(text, stream) {
        if (!run) return;
        if (stream === "delta") {
          run.output = `${run.output ?? ""}${text}`;
        } else if (!run.output?.trim()) {
          run.output = text;
        }
        notifyUpdate();
      },
      onToolEvent(event) {
        if (!run) return;
        applyChildToolEvent(run, event);
        notifyUpdate();
      },
    });
    run = {
      id,
      agent: agentName,
      label,
      prompt,
      status: "running",
      startedAt: new Date().toISOString(),
      toolCalls: [],
      runner,
      promise: Promise.resolve(undefined as never),
      notifyUpdate,
    };
    notifyUpdate();
    void persistRun(launchState.cwd, run);
    run.promise = executeChildPrompt(run, prompt, launchState.cwd);
    childRuns.set(id, run);
    return run;
  }

  function executeChildPrompt(
    run: ChildRun,
    prompt: string,
    cwd: string
  ): Promise<ChildRun> {
    return (async () => {
      try {
        await run.runner.start();
        const result = await run.runner.prompt(prompt);
        const finalOutput = promptResultText(result);
        if (finalOutput && finalOutput.length >= (run.output?.length ?? 0)) {
          run.output = finalOutput;
        } else if (!run.output?.trim()) {
          run.output = "(no final response)";
        }
        if (run.status === "running") run.status = "completed";
      } catch (err) {
        if (run.status !== "interrupted") {
          run.status = "failed";
          run.error = err instanceof Error ? err.message : String(err);
        }
      } finally {
        run.completedAt = new Date().toISOString();
        // Queue the parent wake-up BEFORE persisting. The deliverer reads the
        // in-memory queue (not disk), so enqueuing first makes a persisted
        // status.json imply the completion is already queued — closing a race
        // where the agent_end poke could observe the run's status.json but hit
        // an empty queue, deferring delivery to the full batch window. It also
        // still notifies if the disk write fails. Wait and terminal status
        // reads acknowledge it back out.
        const envelope = envelopeFromRun(run);
        if (envelope) completions.enqueue(envelope);
        run.notifyUpdate();
        await persistRun(cwd, run);
      }
      return run;
    })();
  }

  async function waitForRun(run: ChildRun, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await run.promise;
      return;
    }
    if (signal.aborted) return;
    let onAbort: () => void = () => {};
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    await Promise.race([run.promise, aborted]);
    signal.removeEventListener("abort", onAbort);
  }

  return (pi) => {
    extensionApi = pi;
    // Deliver queued background completions by waking the parent model with
    // a triggerTurn message. Delivery only happens when the session is
    // genuinely idle: a message queued while the parent turn is streaming
    // (or tearing down at the agent_end boundary) would be stranded in pi's
    // queues, and holding until idle also gives synchronous readers
    // (wait or terminal status) time to acknowledge results
    // the model already saw. While mid-turn, retry on a short timer armed by
    // the agent_end poke.
    let deliveryRetryTimer: NodeJS.Timeout | null = null;
    const deliverCompletions = () => {
      if (deliveryRetryTimer) {
        clearTimeout(deliveryRetryTimer);
        deliveryRetryTimer = null;
      }
      if (!completions.hasPending()) return;
      // The retry timer can outlive this extension instance across a reload,
      // where pi API calls throw as stale. Never crash the timer callback;
      // the reload rebuilds run state and drops the batch with it.
      try {
        if (!(sessionCtx?.isIdle?.() ?? true)) {
          deliveryRetryTimer = setTimeout(deliverCompletions, COMPLETION_DELIVERY_RETRY_MS);
          deliveryRetryTimer.unref?.();
          return;
        }
        const batch = completions.consumeBatch();
        if (batch.length === 0) return;
        pi.sendMessage(
          {
            customType: AGENT_COMPLETIONS_TYPE,
            content: renderCompletionNotice(batch),
            display: true,
            details: { completions: batch } satisfies AgentCompletionsDetails,
          },
          // followUp keeps a wake race-safe: if a user turn started between
          // the idle check and here, the notice queues behind it.
          { triggerTurn: true, deliverAs: "followUp" }
        );
      } catch {
        // swallow — see above
      }
    };
    completions.setDeliverer(deliverCompletions);

    pi.on("agent_end", (_event, ctx) => {
      sessionCtx = ctx;
      completions.poke();
    });

    pi.on("before_provider_request", (event, ctx) => {
      ensureManagedFetch();
      if (!state || !ctx.model) return undefined;
      return applyRecipeAgentPayloadPolicy(
        event.payload,
        ctx.model,
        state.resolved.modelConfig
      );
    });

    pi.registerMessageRenderer<AgentCompletionsDetails>(
      AGENT_COMPLETIONS_TYPE,
      (message, options, theme) => {
        const batch = (message.details as AgentCompletionsDetails | undefined)
          ?.completions;
        if (!batch?.length) return undefined;
        return new Text(formatCompletionMessage(batch, options, theme), 0, 0);
      }
    );

    pi.registerFlag("recipe", {
      description: "Recipe folder, installed recipe name, or installed recipe source to use for this Pi session",
      type: "string",
    });
    pi.registerFlag("agent", {
      description: "Agent to use",
      type: "string",
    });

    pi.registerCommand("recipe", {
      description: "Inspect or reload the active recipe",
      handler: async (args, ctx) => {
        const action = args.trim();
        if (action === "reload") {
          const launchState = safeLoadState(pi, ctx.cwd, ctx);
          if (!launchState) {
            if (!recipeFlag(pi)) {
              ctx.ui.notify("No recipe is active. Launch Pi with --recipe <recipe>.", "info");
            }
            return;
          }
          await closeAllChildRuns();
          await closeRootMcpRuntime();
          state = null;
          archivedRuns.clear();
          completions.clear();
          await ctx.waitForIdle();
          await ctx.reload();
          ctx.ui.notify(`Recipe reload requested: ${launchState.resolved.manifest.name}@${launchState.resolved.manifest.version}`, "info");
          return;
        }
        if (action) {
          ctx.ui.notify("Usage: /recipe [reload]", "info");
          return;
        }
        const launchState = safeLoadState(pi, ctx.cwd, ctx);
        if (!launchState) {
          if (!recipeFlag(pi)) {
            ctx.ui.notify("No recipe is active. Launch Pi with --recipe <recipe>.", "info");
          }
          return;
        }
        ctx.ui.notify(recipeSummary(launchState, pi.getActiveTools()), "info");
      },
    });

    const agentTool = createAgentTool(
      localRunController,
      visibleAgentDefinitions,
      {
        acknowledgeCompletions: (ids) => completions.acknowledge(ids),
      }
    );
    agentTool.label = "Agent";
    agentTool.renderCall = (params, theme, context) => {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatAgentCall(params as AgentCallParams, theme));
      return text;
    };
    pi.registerTool(agentTool);

    pi.on("session_start", async (_event, ctx) => {
      if (!ensureManagedFetch()) {
        const warning = managedFetchMissingWarning(env);
        if (warning !== undefined) ctx.ui.notify(warning, "warning");
      }
      sessionCtx = ctx;
      localAgentContext = ctx;
      const launchState = safeLoadState(pi, ctx.cwd, ctx);
      if (!launchState) return;
      launchState.configured = false;
      visibleAgentDefinitions.clear();
      for (const [name, definition] of launchState.resolved.subagents) {
        visibleAgentDefinitions.set(name, definition);
      }
      try {
        await loadRecipeExtensions(pi, ctx, launchState);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failRecipeSession(pi, `extension startup failed\n${message}`, ctx);
        return;
      }
      try {
        await configureMcp(pi, launchState, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sessionConfigurationError = message;
        pi.setActiveTools([]);
        ctx.ui.notify(
          `Recipe MCP failed to configure: ${message}`,
          "warning"
        );
        if (ctx.mode === "json" || ctx.mode === "print") {
          process.exitCode = 1;
        }
        return;
      }
      try {
        await configureSession(pi, ctx, launchState);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A recipe's declared model is part of its behavior contract. Continuing
        // with Pi's previously active model can produce plausible but invalid
        // results, so stop the session instead of silently falling back.
        failRecipeSession(pi, message, ctx);
        return;
      }
      // Restore run snapshots persisted by a previous Pi process so run ids
      // referenced in a resumed conversation stay resolvable (read-only).
      try {
        const restored = await rehydrateChildRuns(launchState.cwd);
        if (restored > 0) {
          ctx.ui.notify(
            `Agents: rehydrated ${restored} previous run(s) (read-only)`,
            "info"
          );
        }
      } catch {
        // rehydration is best-effort
      }
      ctx.ui.notify(
        `Recipe: ${launchState.resolved.manifest.name}@${launchState.resolved.manifest.version} (${basename(launchState.resolved.recipeDir)})`,
        "info"
      );
    });

    pi.on("session_shutdown", async () => {
      await closeAllChildRuns();
      await closeRootMcpRuntime();
      clearMcpCatalogPreload(env);
      await stopMcpDaemon(env);
      if (originalRecipeDirEnv === undefined) {
        delete env.PI_RECIPE_DIR;
      } else {
        env.PI_RECIPE_DIR = originalRecipeDirEnv;
      }
      if (originalAgentNameEnv === undefined) {
        delete env.PI_AGENT_NAME;
      } else {
        env.PI_AGENT_NAME = originalAgentNameEnv;
      }
    });

    pi.on("agent_start", (_event, ctx) => {
      if (!sessionConfigurationError) return;
      // setModel(false) leaves Pi's previously active model selected. Abort as
      // soon as the agent loop starts so that model can never receive a recipe
      // prompt after recipe configuration failed.
      ctx.abort();
    });

    pi.on("resources_discover", (event) => {
      const launchState = safeLoadState(pi, event.cwd);
      if (!launchState) return {};
      return {
        skillPaths: [...launchState.resolved.skillPaths],
        promptPaths: [...launchState.resolved.promptPaths],
      };
    });

    pi.on("before_agent_start", (event, ctx) => {
      const launchState = safeLoadState(pi, ctx.cwd, ctx);
      if (!launchState) return {};
      return {
        systemPrompt: launchState.resolved.systemPromptOverride(
          event.systemPrompt
        ),
      };
    });
  };
}

export default createRecipesExtension();
