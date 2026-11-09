import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import {
  mergeRecipeAgentModelConfig,
  parseRecipeAgentAiConfig,
  parseRecipeAgentModelConfig,
  RecipeModelConfigError,
  type RecipeAgentModelConfig,
} from "./model.js";
import {
  mergeRecipeAgentSessionConfig,
  parseRecipeAgentSessionConfig,
  RecipeSessionConfigError,
  type RecipeAgentSessionConfig,
} from "./session.js";
import {
  assertRecipePathContained,
  isValidRecipeMcpToolSelection,
  packageResourcePaths,
  parseRecipeMcpToolSelection,
  readPiPackageManifest,
  RecipePackageError,
  type PiPackageManifest,
  type RecipeMcpToolSelection,
} from "./package.js";
import { ISSUES_FALLBACK_PROVIDER } from "../issues/types.js";
import { PRODUCTIVITY_TOOLS } from "../productivity/types.js";
import { mcpSelectionAllowsTool, normalizeMcpServerId } from "../mcp/policy.js";

export interface RecipeSystemInstructions {
  mode: "append" | "replace";
  content: string;
}

/**
 * The selectors an agent's `tools` block and each of its `mcp.servers` share:
 * `include`/`exclude` authorize, `defer`/`eager` choose what the model sees.
 */
interface RecipeAgentToolSelectors extends RecipeMcpToolSelection {
  /** Authorized tools hidden from the model until tool search loads them. */
  defer?: string[];
  /** Exceptions to `defer`, or in codemode tools declared as well. */
  eager?: string[];
}

interface RecipeAgentMcpServer extends RecipeAgentToolSelectors {
  /**
   * The tools whose own calls alone may reach this server. The model, codemode
   * scripts and every other tool are refused.
   */
  behind?: string[];
}

/** How selected tools reach the model, for `tools.mode` and `mcp.mode` alike. */
export type RecipeAgentToolMode = "cli" | "tools" | "codemode";

export interface RecipeAgentMcp {
  /** Omission inherits the parent mode or defaults the resolved root to CLI. */
  mode?: RecipeAgentToolMode;
  /** Authorization selection, still upper-bounded by package.json#pi.mcp. */
  servers: Record<string, RecipeAgentMcpServer>;
}

const INVALID_AGENT_MCP = Symbol("invalidAgentMcp");

/** The first-party tools whose exposure `tools.mode`, `defer` and `eager` govern. */
export const PLATFORM_TOOL_NAMES = [
  "issues",
  "mail",
  "calendar",
  "drive",
  "web_search",
] as const;

/** The agent `tools` block; `include` is the definition's `tools` list. */
export interface RecipeAgentToolPolicy extends Omit<
  RecipeAgentToolSelectors,
  "include"
> {
  /** Omission means `tools`: each selected tool is declared to the model. */
  mode?: RecipeAgentToolMode;
}

/** How a tool registers with Pi: declared, codemode scripts only, or loaded by tool search. */
export type RecipeToolExposure = "direct" | "codemode" | "deferred";

const selects = (selectors: readonly string[] | undefined, name: string) =>
  (selectors ?? []).some((selector) => selector === "*" || selector === name);

/**
 * How a first-party tool registers for an agent. Every other tool is declared:
 * the policy governs only {@link PLATFORM_TOOL_NAMES}.
 */
export function platformToolExposure(
  policy: RecipeAgentToolPolicy | undefined,
  toolName: string,
): RecipeToolExposure {
  if (!(PLATFORM_TOOL_NAMES as readonly string[]).includes(toolName))
    return "direct";
  // In cli the `tools` command calls them through the bash call, so they stay
  // callable without being declared, as in codemode.
  if (policy?.mode === "cli") return "codemode";
  if (selects(policy?.eager, toolName)) return "direct";
  if (policy?.mode === "codemode") return "codemode";
  return selects(policy?.defer, toolName) ? "deferred" : "direct";
}

/** Pi's built-in tools and the Recipe built-ins: what `include: ["*"]` always selects. */
const BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "ask_user_question",
  "show_artifact",
  "review_artifacts",
  "introspection_open",
  "today",
] as const;

/** Whether `pi.issues` leaves a provider, as `issuesProviderDeclarations` does: an undeclared fallback is implicit. */
function issuesRegisters(declared: PiPackageManifest["issues"]): boolean {
  return (
    declared !== undefined &&
    (declared.some((declaration) => declaration.enabled !== false) ||
      !declared.some(
        (declaration) => declaration.provider === ISSUES_FALLBACK_PROVIDER,
      ))
  );
}

/**
 * The tools an agent selects, with `include: ["*"]` expanded to the built-ins
 * and the first-party tools the Recipe declares, less `exclude`. A Recipe's own
 * extension and connector tools are never in `*`: they are named. `wildcard`
 * is what `*` added, which a session drops when its host does not offer it.
 */
export function selectedAgentTools(
  include: readonly string[],
  policy: RecipeAgentToolPolicy | undefined,
  manifest: Pick<PiPackageManifest, "issues" | "productivity" | "search">,
): { tools: string[]; wildcard: string[] } {
  const named = include.filter((name) => name !== "*");
  const wildcard = include.includes("*")
    ? [
        ...BUILTIN_TOOL_NAMES,
        ...(issuesRegisters(manifest.issues) ? ["issues"] : []),
        // An omitted allowlist exposes every supported command; only an empty
        // one disables the tool.
        ...(manifest.productivity ?? []).flatMap((declaration) =>
          PRODUCTIVITY_TOOLS.filter(
            (tool) => declaration.tools?.[tool]?.length !== 0,
          ),
        ),
        ...(manifest.search?.length ? ["web_search"] : []),
      ].filter((name) => !named.includes(name))
    : [];
  const excluded = new Set(policy?.exclude ?? []);
  return {
    tools: [...new Set([...named, ...wildcard])].filter(
      (name) => !excluded.has(name),
    ),
    wildcard: wildcard.filter((name) => !excluded.has(name)),
  };
}

const INVALID_AGENT_TOOLS = Symbol("invalidAgentTools");

type ParsedRecipeAgentToolPolicy = RecipeAgentToolPolicy & {
  [INVALID_AGENT_TOOLS]?: string;
};

type ParsedRecipeAgentMcp = RecipeAgentMcp & {
  [INVALID_AGENT_MCP]?: true;
};

export interface RecipeAgentDefinition {
  name: string;
  from?: string;
  description?: string;
  model?: {
    name?: string;
    thinkingLevel?: string;
  };
  /**
   * The full validated `ai:` block (or legacy `model:` block),
   * merged along the `from:` chain. `model` is its `{name, thinkingLevel}`
   * projection, kept for callers that only route on the spec.
   */
  modelConfig?: RecipeAgentModelConfig;
  /** Portable Pi session behavior declared under `session:`. */
  sessionConfig?: RecipeAgentSessionConfig;
  tools: string[];
  /** MCP tool selection, separate from the exact Pi/extension tool allowlist. */
  mcp?: RecipeAgentMcp;
  /** The `tools` mapping's `mode`, `exclude`, `defer` and `eager`; `tools` holds its `include`. */
  toolPolicy?: RecipeAgentToolPolicy;
  skills: string[];
  /**
   * The phases the agent moves through, in order (`[build, improve]`): each
   * is the prefix of its step skills (`build-draft`). Pi's footer shows the
   * phase of the step last read; the agent's other skills are helpers.
   */
  phases?: string[];
  subagents: string[];
  systemInstructions?: RecipeSystemInstructions;
  /** Fields authored on this definition rather than inherited through `from`. */
  declaredFields?: readonly RecipeAgentConfigField[];
}

export type RecipeAgentConfigField =
  | "description"
  | "model"
  | "ai"
  | "session"
  | "tools"
  | "mcp"
  | "skills"
  | "phases"
  | "subagents"
  | "system_instructions";

type ParsedRecipeAgentDefinition = Omit<
  RecipeAgentDefinition,
  "tools" | "skills" | "subagents"
> & {
  tools?: string[];
  skills?: string[];
  subagents?: string[];
};

export interface RecipeAgentValidationFinding {
  agentName: string;
  field: "name" | "from" | "file" | "mcp" | "tools" | "model.name";
  code?: string;
  message: string;
}

interface RecipeAgentSource {
  definition: ParsedRecipeAgentDefinition;
}

const AGENT_YAML_KEYS = new Set([
  "name",
  "from",
  "description",
  "model",
  "ai",
  "session",
  "tools",
  "mcp",
  "skills",
  "phases",
  "subagents",
  "system_instructions",
]);

const PORTABLE_AGENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_INHERITANCE_DEPTH = 128;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
    : [];
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && Boolean(item.trim()))
  );
}

function invalidAgentField(data: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(data, "name")) {
    return "name is required";
  }
  for (const key of ["name", "from"] as const) {
    if (
      Object.hasOwn(data, key) &&
      (typeof data[key] !== "string" || !data[key].trim())
    ) {
      return `${key} must be a non-empty string`;
    }
    if (
      Object.hasOwn(data, key) &&
      typeof data[key] === "string" &&
      !PORTABLE_AGENT_NAME.test(data[key])
    ) {
      return `${key} must use lowercase kebab-case`;
    }
  }
  if (
    Object.hasOwn(data, "description") &&
    typeof data.description !== "string"
  ) {
    return "description must be a string";
  }
  for (const key of ["tools", "skills", "phases", "subagents"] as const) {
    // A `tools` mapping is checked with the selectors it shares with `mcp`.
    if (
      key === "tools" &&
      data.tools &&
      typeof data.tools === "object" &&
      !Array.isArray(data.tools)
    )
      continue;
    if (Object.hasOwn(data, key) && !isNonEmptyStringArray(data[key])) {
      return `${key} must be an array of non-empty strings`;
    }
    if (
      Object.hasOwn(data, key) &&
      new Set(stringArray(data[key])).size !== stringArray(data[key]).length
    ) {
      return `${key} must not contain duplicate entries`;
    }
  }
  const reservedTools = stringArray(data.tools).filter(
    (tool) => tool === "agent",
  );
  if (reservedTools.length > 0) {
    return `tools must not declare session-generated tool(s): ${reservedTools.join(", ")}`;
  }
  if (Object.hasOwn(data, "system_instructions")) {
    const value = data.system_instructions;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return "system_instructions must be an object";
    }
    const instructions = value as Record<string, unknown>;
    const unknown = Object.keys(instructions).filter(
      (key) => key !== "mode" && key !== "content",
    );
    if (unknown.length > 0) {
      return `system_instructions has unsupported key(s): ${unknown.join(", ")}`;
    }
    if (typeof instructions.content !== "string") {
      return "system_instructions.content must be a string";
    }
    if (
      Object.hasOwn(instructions, "mode") &&
      instructions.mode !== "append" &&
      instructions.mode !== "replace"
    ) {
      return "system_instructions.mode must be append or replace";
    }
  }
  return undefined;
}

function modelProjection(config: RecipeAgentModelConfig | undefined):
  | {
      name?: string;
      thinkingLevel?: string;
    }
  | undefined {
  if (!config) return undefined;
  if (!config.name && !config.thinkingLevel) return undefined;
  return {
    ...(config.name ? { name: config.name } : {}),
    ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
  };
}

function parseSystemInstructions(
  data: Record<string, unknown>,
): RecipeSystemInstructions | undefined {
  const raw = asRecord(data.system_instructions);
  if (Object.hasOwn(raw, "content") && typeof raw.content === "string") {
    const mode = raw.mode === "replace" ? "replace" : "append";
    return { mode, content: raw.content.trim() };
  }
  return undefined;
}

function mergeSystemInstructions(
  base: RecipeSystemInstructions | undefined,
  child: RecipeSystemInstructions | undefined,
): RecipeSystemInstructions | undefined {
  if (!base) return child;
  if (!child) return base;
  if (child.mode === "replace") return child;
  return {
    mode: base.mode,
    content: `${base.content}\n\n${child.content}`,
  };
}

function normalizedMcpServerId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "mcp"
  );
}

function hasNormalizedMcpServerCollision(values: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizedMcpServerId(value);
    if (seen.has(normalized)) return true;
    seen.add(normalized);
  }
  return false;
}

function validActivationSelectors(selectors: string[] | undefined): boolean {
  if (selectors === undefined) return true;
  return (
    selectors.every(
      (selector) =>
        Boolean(selector.trim()) &&
        (!selector.includes("*") || selector === "*"),
    ) &&
    (!selectors.includes("*") || selectors.length === 1)
  );
}

/** A non-empty list of exact tool names, never with `defer` or `eager`. */
function validBehind(server: Record<string, unknown>): boolean {
  const behind = server.behind;
  return (
    Array.isArray(behind) &&
    behind.length > 0 &&
    behind.every(
      (name) =>
        typeof name === "string" && Boolean(name.trim()) && !name.includes("*"),
    ) &&
    new Set(behind).size === behind.length &&
    !Object.hasOwn(server, "defer") &&
    !Object.hasOwn(server, "eager")
  );
}

function parseMcp(data: Record<string, unknown>): RecipeAgentMcp | undefined {
  if (!Object.hasOwn(data, "mcp")) return undefined;
  const value = data.mcp;
  const validObject =
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const raw = asRecord(value);
  const rawServers = asRecord(raw.servers);
  const servers: Record<string, RecipeAgentMcpServer> = {};
  for (const [serverId, serverValue] of Object.entries(rawServers)) {
    const serverRaw = asRecord(serverValue);
    servers[normalizedMcpServerId(serverId)] = {
      ...parseRecipeMcpToolSelection(serverValue),
      ...(Object.hasOwn(serverRaw, "defer")
        ? {
            defer: stringArray(serverRaw.defer).map((selector) =>
              selector.trim(),
            ),
          }
        : {}),
      ...(Object.hasOwn(serverRaw, "eager")
        ? {
            eager: stringArray(serverRaw.eager).map((selector) =>
              selector.trim(),
            ),
          }
        : {}),
      ...(Object.hasOwn(serverRaw, "behind")
        ? { behind: stringArray(serverRaw.behind) }
        : {}),
    };
  }
  const mode =
    raw.mode === "cli" || raw.mode === "tools" || raw.mode === "codemode"
      ? (raw.mode as RecipeAgentToolMode)
      : undefined;
  const mcp: ParsedRecipeAgentMcp = {
    ...(mode ? { mode } : {}),
    servers,
  };
  const malformedServers = Object.values(rawServers).some(
    (serverValue) =>
      !serverValue ||
      typeof serverValue !== "object" ||
      Array.isArray(serverValue) ||
      toolSelectorsProblem(asRecord(serverValue), mode, ["behind"]) !==
        undefined ||
      (Object.hasOwn(asRecord(serverValue), "behind") &&
        !validBehind(asRecord(serverValue))),
  );
  const malformedStructured =
    malformedServers ||
    !Object.hasOwn(raw, "servers") ||
    (Object.hasOwn(raw, "mode") &&
      raw.mode !== "cli" &&
      raw.mode !== "tools" &&
      raw.mode !== "codemode") ||
    Object.keys(rawServers).some((serverId) => !serverId.trim()) ||
    hasNormalizedMcpServerCollision(Object.keys(rawServers)) ||
    !raw.servers ||
    typeof raw.servers !== "object" ||
    Array.isArray(raw.servers) ||
    Object.keys(raw).some((key) => !["mode", "servers"].includes(key));
  if (!validObject || malformedStructured) {
    Object.defineProperty(mcp, INVALID_AGENT_MCP, {
      value: true,
      enumerable: false,
    });
  }
  return mcp;
}

const SELECTOR_KEYS = ["include", "exclude", "defer", "eager"] as const;

/**
 * Why a `tools` block or one `mcp.servers` entry breaks the rules the two
 * share, or undefined. `extra` names the keys the caller adds (`behind`).
 */
function toolSelectorsProblem(
  raw: Record<string, unknown>,
  mode: unknown,
  extra: readonly string[] = [],
): string | undefined {
  const unknown = Object.keys(raw).filter(
    (key) =>
      !(SELECTOR_KEYS as readonly string[]).includes(key) &&
      !extra.includes(key),
  );
  if (unknown.length > 0)
    return `unsupported key(s): ${unknown.join(", ")}; it takes ${[...SELECTOR_KEYS, ...extra].join(", ")}`;
  const lists: Partial<Record<(typeof SELECTOR_KEYS)[number], string[]>> = {};
  for (const key of SELECTOR_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== "string" || !item.trim())
    )
      return `${key} must be a list of tool names`;
    const names = (value as string[]).map((item) => item.trim());
    if (new Set(names).size !== names.length)
      return `${key} names a tool twice`;
    if (names.some((name) => name.includes("*") && name !== "*"))
      return `${key} takes exact tool names or "*"`;
    if (key === "exclude" && names.includes("*"))
      return 'exclude takes exact tool names, not "*"';
    if (
      (key === "defer" || key === "eager") &&
      names.includes("*") &&
      names.length > 1
    )
      return `${key} takes "*" alone`;
    lists[key] = names;
  }
  if (mode === "cli" && (lists.defer || lists.eager))
    return "defer and eager are invalid in cli mode";
  if (mode === "codemode" && lists.defer) return "defer is invalid in codemode";
  const unselected = [...(lists.defer ?? []), ...(lists.eager ?? [])].filter(
    (name) =>
      name !== "*" &&
      !mcpSelectionAllowsTool(
        { include: lists.include ?? [], exclude: lists.exclude ?? [] },
        name,
      ),
  );
  if (unselected.length > 0)
    return `defer and eager name tool(s) include does not select: ${unselected.join(", ")}`;
  return undefined;
}

/**
 * `tools`: a list of tool names, or the mapping that mirrors one
 * `mcp.servers` entry plus `mode`. Either way `include` is the list.
 */
function parseTools(data: Record<string, unknown>): {
  include?: string[];
  policy?: RecipeAgentToolPolicy;
} {
  if (!Object.hasOwn(data, "tools")) return {};
  const value = data.tools;
  if (Array.isArray(value)) return { include: stringArray(value) };
  const raw = asRecord(value);
  const policy: ParsedRecipeAgentToolPolicy = {
    ...(raw.mode === "tools" || raw.mode === "codemode" || raw.mode === "cli"
      ? { mode: raw.mode }
      : {}),
    ...(Object.hasOwn(raw, "exclude")
      ? { exclude: stringArray(raw.exclude) }
      : {}),
    ...(Object.hasOwn(raw, "defer") ? { defer: stringArray(raw.defer) } : {}),
    ...(Object.hasOwn(raw, "eager") ? { eager: stringArray(raw.eager) } : {}),
  };
  const firstPartyOnly = [
    ...(policy.defer ?? []),
    ...(policy.eager ?? []),
  ].filter(
    (name) =>
      name !== "*" &&
      !(PLATFORM_TOOL_NAMES as readonly string[]).includes(name),
  );
  const problem =
    !value || typeof value !== "object"
      ? "tools must be a list of tool names or a mapping"
      : Object.hasOwn(raw, "mode") &&
          raw.mode !== "tools" &&
          raw.mode !== "codemode" &&
          raw.mode !== "cli"
        ? "tools.mode must be tools, codemode or cli"
        : raw.mode === "cli" &&
            !(
              (stringArray(raw.include).includes("bash") ||
                stringArray(raw.include).includes("*")) &&
              !(policy.exclude ?? []).includes("bash")
            )
          ? "tools.mode cli runs the tools command from bash; select bash"
          : (toolSelectorsProblem(raw, raw.mode ?? "tools", ["mode"]) ??
            (firstPartyOnly.length > 0
              ? `defer and eager apply only to first-party tools (${PLATFORM_TOOL_NAMES.join(", ")}): ${firstPartyOnly.join(", ")}`
              : undefined));
  if (problem)
    Object.defineProperty(policy, INVALID_AGENT_TOOLS, {
      value: problem.startsWith("tools") ? problem : `tools: ${problem}`,
      enumerable: false,
    });
  return { include: stringArray(raw.include), policy };
}

function mergeMcp(
  base: RecipeAgentMcp | undefined,
  child: RecipeAgentMcp | undefined,
): RecipeAgentMcp | undefined {
  if (!base) return child;
  if (!child) return base;
  // Capability policy is a review boundary: once a child declares `mcp`, the
  // whole block replaces its base instead of silently retaining parent servers.
  return child;
}

function readYaml(path: string): Record<string, unknown> {
  return asRecord(parse(readFileSync(path, "utf8")));
}

function recipeManifest(recipeDir: string) {
  try {
    return readPiPackageManifest(recipeDir);
  } catch (err) {
    if (err instanceof RecipePackageError) return null;
    throw err;
  }
}

function yamlFilesFromPaths(paths: string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const stats = statSync(path);
    if (stats.isFile() && /\.ya?ml$/i.test(path)) {
      files.push(path);
      continue;
    }
    if (!stats.isDirectory()) continue;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
      files.push(join(path, entry.name));
    }
  }
  return files.sort();
}

function recipeAgentFiles(recipeDir: string): string[] {
  const manifest = recipeManifest(recipeDir);
  if (manifest)
    return yamlFilesFromPaths(packageResourcePaths(manifest, "agents"));
  return yamlFilesFromPaths([join(recipeDir, "agents")]);
}

function readRecipeAgentSources(
  recipeDir: string,
  opts: { onInvalidFile?: (path: string, error: Error) => void } = {},
): RecipeAgentSource[] {
  const sources: RecipeAgentSource[] = [];
  for (const path of recipeAgentFiles(recipeDir)) {
    const data = readYaml(path);

    const unknownKeys = Object.keys(data).filter(
      (key) => !AGENT_YAML_KEYS.has(key),
    );
    if (unknownKeys.length > 0) {
      opts.onInvalidFile?.(
        path,
        new Error(
          `Agent YAML at ${path} has unsupported key(s): ${unknownKeys.join(", ")}`,
        ),
      );
      continue;
    }
    const fieldError = invalidAgentField(data);
    if (fieldError) {
      opts.onInvalidFile?.(
        path,
        new Error(`Agent YAML at ${path}: ${fieldError}`),
      );
      continue;
    }
    const name = data.name as string;

    let modelConfig: RecipeAgentModelConfig | undefined;
    let sessionConfig: RecipeAgentSessionConfig | undefined;
    try {
      if (Object.hasOwn(data, "model") && Object.hasOwn(data, "ai")) {
        throw new RecipeModelConfigError(
          `Agent YAML at ${path} cannot declare both model and ai`,
        );
      }
      modelConfig = Object.hasOwn(data, "ai")
        ? parseRecipeAgentAiConfig(`Agent YAML at ${path}`, data.ai)
        : parseRecipeAgentModelConfig(`Agent YAML at ${path}`, data.model);
      sessionConfig = parseRecipeAgentSessionConfig(
        `Agent YAML at ${path}`,
        data.session,
      );
    } catch (err) {
      if (
        !(err instanceof RecipeModelConfigError) &&
        !(err instanceof RecipeSessionConfigError)
      )
        throw err;
      opts.onInvalidFile?.(path, err);
      continue;
    }

    const parsedTools = parseTools(data);
    sources.push({
      definition: {
        name,
        from: typeof data.from === "string" ? data.from : undefined,
        description:
          typeof data.description === "string" ? data.description : undefined,
        model: modelProjection(modelConfig),
        modelConfig,
        sessionConfig,
        tools: parsedTools.include,
        ...(parsedTools.policy ? { toolPolicy: parsedTools.policy } : {}),
        mcp: parseMcp(data),
        skills: Object.hasOwn(data, "skills")
          ? stringArray(data.skills)
          : undefined,
        phases: Object.hasOwn(data, "phases")
          ? stringArray(data.phases)
          : undefined,
        subagents: Object.hasOwn(data, "subagents")
          ? stringArray(data.subagents)
          : undefined,
        systemInstructions: parseSystemInstructions(data),
        declaredFields: [
          "description",
          "model",
          "ai",
          "session",
          "tools",
          "mcp",
          "skills",
          "phases",
          "subagents",
          "system_instructions",
        ].filter((key): key is RecipeAgentConfigField =>
          Object.hasOwn(data, key),
        ),
      },
    });
  }
  return sources;
}

function definitionsFromSources(
  sources: RecipeAgentSource[],
): Map<string, RecipeAgentDefinition> {
  const rawDefinitions = new Map<string, ParsedRecipeAgentDefinition>();
  const resolvedDefinitions = new Map<string, RecipeAgentDefinition>();
  const definitions = new Map<string, RecipeAgentDefinition>();

  for (const source of sources) {
    rawDefinitions.set(source.definition.name, source.definition);
  }

  function resolveDefinition(
    name: string,
    stack: string[] = [],
  ): RecipeAgentDefinition | undefined {
    if (resolvedDefinitions.has(name)) return resolvedDefinitions.get(name);
    if (stack.length >= MAX_INHERITANCE_DEPTH) return undefined;
    if (stack.includes(name)) return undefined;
    const raw = rawDefinitions.get(name);
    if (!raw) return undefined;

    const base = raw.from
      ? resolveDefinition(raw.from, [...stack, name])
      : undefined;
    if (raw.from && !base) return undefined;

    const modelConfig = mergeRecipeAgentModelConfig(
      base?.modelConfig,
      raw.modelConfig,
    );
    const sessionConfig = mergeRecipeAgentSessionConfig(
      base?.sessionConfig,
      raw.sessionConfig,
    );
    const definition: RecipeAgentDefinition = {
      name: raw.name,
      ...(raw.from ? { from: raw.from } : {}),
      description: raw.description ?? base?.description,
      model: modelProjection(modelConfig),
      ...(modelConfig ? { modelConfig } : {}),
      ...(sessionConfig ? { sessionConfig } : {}),
      // A child's `tools` replaces its parent's whole block, as `mcp` does.
      tools: raw.tools ?? base?.tools ?? [],
      ...((raw.tools ? raw.toolPolicy : base?.toolPolicy)
        ? { toolPolicy: raw.tools ? raw.toolPolicy : base?.toolPolicy }
        : {}),
      mcp: mergeMcp(base?.mcp, raw.mcp),
      skills: raw.skills ?? base?.skills ?? [],
      ...((raw.phases ?? base?.phases)
        ? { phases: raw.phases ?? base?.phases }
        : {}),
      subagents: raw.subagents ?? base?.subagents ?? [],
      systemInstructions: mergeSystemInstructions(
        base?.systemInstructions,
        raw.systemInstructions,
      ),
      declaredFields: [...(raw.declaredFields ?? [])],
    };
    resolvedDefinitions.set(name, definition);
    return definition;
  }

  for (const name of rawDefinitions.keys()) {
    const definition = resolveDefinition(name);
    if (!definition) continue;
    definitions.set(name, definition);
  }
  return definitions;
}

function validateResolvedRecipeAgentSource(
  opts: {
    recipeDir: string;
    agentName: string;
  },
  sources: RecipeAgentSource[],
): RecipeAgentValidationFinding[] {
  const rawDefinitions = new Map<string, ParsedRecipeAgentDefinition>();
  for (const source of sources) {
    rawDefinitions.set(source.definition.name, source.definition);
  }

  function inheritanceFinding(
    name: string,
    stack: string[] = [],
  ): RecipeAgentValidationFinding | undefined {
    if (stack.length >= MAX_INHERITANCE_DEPTH) {
      return {
        agentName: name,
        field: "from",
        message: `Recipe agent "${name}" exceeds the maximum from depth of ${MAX_INHERITANCE_DEPTH}`,
      };
    }
    const definition = rawDefinitions.get(name);
    if (!definition) {
      return {
        agentName: name,
        field: "from",
        message: `Recipe agent "${name}" was not found`,
      };
    }
    if (!definition.from) return undefined;

    const resolvedFrom = definition.from;
    if (stack.includes(resolvedFrom)) {
      return {
        agentName: name,
        field: "from",
        message: `Recipe agent "${name}" has cyclic from chain: ${[
          ...stack,
          name,
          resolvedFrom,
        ].join(" -> ")}`,
      };
    }
    if (!rawDefinitions.has(resolvedFrom)) {
      return {
        agentName: name,
        field: "from",
        message: `Recipe agent "${name}" inherits from missing agent "${definition.from}"`,
      };
    }
    return inheritanceFinding(definition.from, [...stack, name]);
  }

  function resolvedModelProvided(name: string, stack: string[] = []): boolean {
    if (stack.includes(name) || stack.length >= MAX_INHERITANCE_DEPTH)
      return false;
    const definition = rawDefinitions.get(name);
    if (!definition) return false;
    if (definition.model?.name) return true;
    return definition.from
      ? resolvedModelProvided(definition.from, [...stack, name])
      : false;
  }

  function resolvedMcp(
    name: string,
    stack: string[] = [],
  ): RecipeAgentMcp | undefined {
    if (stack.includes(name) || stack.length >= MAX_INHERITANCE_DEPTH)
      return undefined;
    const definition = rawDefinitions.get(name);
    if (!definition) return undefined;
    const base = definition.from
      ? resolvedMcp(definition.from, [...stack, name])
      : undefined;
    return mergeMcp(base, definition.mcp);
  }

  /** The policy of the definition whose `tools` the agent resolves to. */
  function resolvedToolPolicy(
    name: string,
    stack: string[] = [],
  ): RecipeAgentToolPolicy | undefined {
    if (stack.includes(name) || stack.length >= MAX_INHERITANCE_DEPTH)
      return undefined;
    const definition = rawDefinitions.get(name);
    if (!definition) return undefined;
    if (definition.tools) return definition.toolPolicy;
    return definition.from
      ? resolvedToolPolicy(definition.from, [...stack, name])
      : undefined;
  }

  function resolvedTools(name: string, stack: string[] = []): string[] {
    if (stack.includes(name) || stack.length >= MAX_INHERITANCE_DEPTH)
      return [];
    const definition = rawDefinitions.get(name);
    if (!definition) return [];
    if (definition.tools) return definition.tools;
    return definition.from
      ? resolvedTools(definition.from, [...stack, name])
      : [];
  }

  function rawMcpChainInvalid(name: string, stack: string[] = []): boolean {
    if (stack.includes(name) || stack.length >= MAX_INHERITANCE_DEPTH)
      return false;
    const definition = rawDefinitions.get(name);
    if (!definition) return false;
    const rawMcp = definition.mcp as ParsedRecipeAgentMcp | undefined;
    if (
      rawMcp?.[INVALID_AGENT_MCP] ||
      Object.values(rawMcp?.servers ?? {}).some(
        (selection) => !isValidRecipeMcpToolSelection(selection),
      )
    ) {
      return true;
    }
    return definition.from
      ? rawMcpChainInvalid(definition.from, [...stack, name])
      : false;
  }

  const agentName = opts.agentName;
  const findings: RecipeAgentValidationFinding[] = [];

  const inheritance = inheritanceFinding(agentName);
  if (inheritance) findings.push(inheritance);

  if (!resolvedModelProvided(agentName)) {
    findings.push({
      agentName,
      field: "model.name",
      message: `Recipe agent "${agentName}" must declare ai.model (or legacy model.name) directly or inherit it with from`,
    });
  }

  const mcp = resolvedMcp(agentName);
  const manifest = recipeManifest(opts.recipeDir);
  const packageMcpServers = manifest
    ? new Map(
        manifest.mcp.servers.map((server) => [
          normalizeMcpServerId(server.id),
          server.tools,
        ]),
      )
    : undefined;
  // The Recipe checker owns detailed authoring diagnostics. This session guard
  // only ensures malformed raw policies fail closed before agent startup.
  const invalidMcpPolicy =
    rawMcpChainInvalid(agentName) ||
    Object.entries(mcp?.servers ?? {}).some(([serverId, selection]) => {
      if (!serverId.trim() || !isValidRecipeMcpToolSelection(selection)) {
        return true;
      }
      if (!packageMcpServers) return false;
      const packageSelection = packageMcpServers.get(
        normalizeMcpServerId(serverId),
      );
      if (!packageSelection) return true;
      return (selection.include ?? []).some((toolName) => {
        const value = toolName.trim();
        return (
          value !== "*" && !mcpSelectionAllowsTool(packageSelection, value)
        );
      });
    }) ||
    Object.values(mcp?.servers ?? {}).some(
      (selection) =>
        (mcp?.mode !== "tools" && selection.defer !== undefined) ||
        (mcp?.mode !== "tools" &&
          mcp?.mode !== "codemode" &&
          selection.eager !== undefined) ||
        !validActivationSelectors(selection.defer) ||
        !validActivationSelectors(selection.eager) ||
        [...(selection.defer ?? []), ...(selection.eager ?? [])].some(
          (selector) =>
            selector !== "*" && !mcpSelectionAllowsTool(selection, selector),
        ),
    );
  if (invalidMcpPolicy) {
    findings.push({
      agentName,
      field: "mcp",
      code: "mcp_invalid",
      message: `Recipe agent "${agentName}" has an invalid MCP policy`,
    });
  }
  const tools = new Set(resolvedTools(agentName));
  for (const [serverId, selection] of Object.entries(mcp?.servers ?? {})) {
    const missing = tools.has("*")
      ? []
      : (selection.behind ?? []).filter((name) => !tools.has(name));
    if (missing.length === 0) continue;
    findings.push({
      agentName,
      field: "mcp",
      code: "mcp_invalid",
      message: `Recipe agent "${agentName}" puts MCP server '${serverId}' behind tool(s) it does not declare: ${missing.join(", ")}`,
    });
  }

  const toolsProblem = (
    resolvedToolPolicy(agentName) as ParsedRecipeAgentToolPolicy | undefined
  )?.[INVALID_AGENT_TOOLS];
  if (toolsProblem)
    findings.push({
      agentName,
      field: "tools",
      code: "tools_invalid",
      message: `Recipe agent "${agentName}": ${toolsProblem}`,
    });

  return findings;
}

function isValidRecipeModelSpec(spec: string): boolean {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return false;
  const provider = spec.slice(0, slash);
  return !/[\s:]/.test(provider);
}

function validateRecipeAgentModelSpecs(
  sources: RecipeAgentSource[],
): RecipeAgentValidationFinding[] {
  const findings: RecipeAgentValidationFinding[] = [];
  for (const source of sources) {
    const spec = source.definition.model?.name;
    if (!spec || isValidRecipeModelSpec(spec)) continue;
    findings.push({
      agentName: source.definition.name,
      field: "model.name",
      message: `Recipe agent "${source.definition.name}" has invalid model.name "${spec}" - expected "<provider>/<model_id>"`,
    });
  }
  return findings;
}

function validateRecipeAgentNames(
  sources: RecipeAgentSource[],
): RecipeAgentValidationFinding[] {
  const findings: RecipeAgentValidationFinding[] = [];
  const nameCounts = new Map<string, number>();

  for (const source of sources) {
    nameCounts.set(
      source.definition.name,
      (nameCounts.get(source.definition.name) ?? 0) + 1,
    );
  }

  for (const [name, count] of nameCounts) {
    if (count <= 1) continue;
    findings.push({
      agentName: name,
      field: "name",
      message: `Recipe agent name "${name}" is declared by multiple files`,
    });
  }

  return findings;
}

function validateRecipeAgentSources(
  recipeDir: string,
  sources: RecipeAgentSource[],
  invalidFileFindings: RecipeAgentValidationFinding[],
): RecipeAgentValidationFinding[] {
  const agentNames = [
    ...new Set(sources.map((source) => source.definition.name)),
  ].sort();
  return [
    ...invalidFileFindings,
    ...validateRecipeAgentNames(sources),
    ...validateRecipeAgentModelSpecs(sources),
    ...agentNames.flatMap((agentName) =>
      validateResolvedRecipeAgentSource(
        {
          recipeDir,
          agentName,
        },
        sources,
      ),
    ),
  ];
}

export interface ValidatedRecipeAgentDefinitions {
  definitions: Map<string, RecipeAgentDefinition>;
  findings: RecipeAgentValidationFinding[];
}

/**
 * Parse agent YAML once, then validate and resolve the complete inheritance
 * Recipe snapshot from that exact source.
 */
export function loadValidatedRecipeAgentDefinitions(
  recipeDir: string,
): ValidatedRecipeAgentDefinitions {
  const invalidFileFindings: RecipeAgentValidationFinding[] = [];
  const sources = readRecipeAgentSources(recipeDir, {
    onInvalidFile: (path, error) => {
      invalidFileFindings.push({
        agentName: basename(path).replace(/\.ya?ml$/i, ""),
        field: "file",
        message: error.message,
      });
    },
  });
  const definitions = definitionsFromSources(sources);
  return {
    definitions,
    findings: validateRecipeAgentSources(
      recipeDir,
      sources,
      invalidFileFindings,
    ),
  };
}

export function validateRecipeAgentDefinitions(
  recipeDir: string,
): RecipeAgentValidationFinding[] {
  return loadValidatedRecipeAgentDefinitions(recipeDir).findings;
}

export function loadRecipeSystemPrompt(recipeDir: string): string | undefined {
  const path = join(recipeDir, "SYSTEM.md");
  if (!existsSync(path)) return undefined;
  assertRecipePathContained(recipeDir, path, "SYSTEM.md");
  const content = readFileSync(path, "utf8").trim();
  return content || undefined;
}
