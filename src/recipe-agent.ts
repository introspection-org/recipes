import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import {
  mergeRecipeAgentModelConfig,
  parseRecipeAgentAiConfig,
  parseRecipeAgentModelConfig,
  RecipeModelConfigError,
  type RecipeAgentModelConfig,
} from "./recipe-model.js";
import {
  mergeRecipeAgentSessionConfig,
  parseRecipeAgentSessionConfig,
  RecipeSessionConfigError,
  type RecipeAgentSessionConfig,
} from "./recipe-session.js";
import {
  assertRecipePathContained,
  isValidRecipeMcpToolSelection,
  packageResourcePaths,
  parseRecipeMcpToolSelection,
  readPiPackageManifest,
  RecipePackageError,
} from "./recipe-package.js";
import {
  mcpSelectionAllowsTool,
  normalizeMcpServerId,
} from "./mcp-policy.js";

export interface RecipeSystemInstructions {
  mode: "append" | "replace";
  content: string;
}

export interface RecipeAgentMcpServer {
  /** Exact tool names or the reserved whole-toolset `*` sentinel. */
  include?: string[];
  /** Exact tool names removed after inclusion. */
  exclude?: string[];
  /** Authorized tools hidden from the model until activated. */
  defer?: string[];
  /** Deferred tools made visible at session start. */
  eager?: string[];
}

export type RecipeAgentMcpMode = "cli" | "tools";

export interface RecipeAgentMcp {
  /** Omission inherits the parent mode or defaults the resolved root to CLI. */
  mode?: RecipeAgentMcpMode;
  /** Authorization selection, still upper-bounded by package.json#pi.mcp. */
  servers: Record<string, RecipeAgentMcpServer>;
}

const INVALID_AGENT_MCP = Symbol("invalidAgentMcp");

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
  skills: string[];
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
  field: "name" | "from" | "file" | "mcp" | "model.name";
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

function invalidAgentField(
  data: Record<string, unknown>
): string | undefined {
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
  for (const key of ["tools", "skills", "subagents"] as const) {
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
    (tool) => tool === "agent"
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
      (key) => key !== "mode" && key !== "content"
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
  data: Record<string, unknown>
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
  child: RecipeSystemInstructions | undefined
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
        (!selector.includes("*") || selector === "*")
    ) &&
    (!selectors.includes("*") || selectors.length === 1)
  );
}

function parseMcp(data: Record<string, unknown>): RecipeAgentMcp | undefined {
  if (!Object.hasOwn(data, "mcp")) return undefined;
  const value = data.mcp;
  const validObject = Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
              selector.trim()
            ),
          }
        : {}),
      ...(Object.hasOwn(serverRaw, "eager")
        ? {
            eager: stringArray(serverRaw.eager).map((selector) =>
              selector.trim()
            ),
          }
        : {}),
    };
  }
  const mode =
    raw.mode === "cli" || raw.mode === "tools"
      ? raw.mode as RecipeAgentMcpMode
      : undefined;
  const mcp: ParsedRecipeAgentMcp = {
    ...(mode ? { mode } : {}),
    servers,
  };
  const malformedServers = Object.entries(rawServers).some(
    ([, serverValue]) => {
      const server = asRecord(serverValue);
      return (
        !serverValue ||
        typeof serverValue !== "object" ||
        Array.isArray(serverValue) ||
        Object.keys(server).some(
          (key) => !["include", "exclude", "defer", "eager"].includes(key)
        ) ||
        ["include", "exclude", "defer", "eager"].some((key) => {
          if (!Object.hasOwn(server, key)) return false;
          const values = stringArray(server[key]);
          return new Set(values).size !== values.length;
        }) ||
        ["defer", "eager"].some(
          (key) =>
            Object.hasOwn(server, key) &&
            (!Array.isArray(server[key]) ||
              (server[key] as unknown[]).some(
                (selector) => typeof selector !== "string"
              ))
        ) ||
        !validActivationSelectors(
          Object.hasOwn(server, "defer")
            ? stringArray(server.defer).map((selector) => selector.trim())
            : undefined
        ) ||
        !validActivationSelectors(
          Object.hasOwn(server, "eager")
            ? stringArray(server.eager).map((selector) => selector.trim())
            : undefined
        ) ||
        (mode === "cli" &&
          (Object.hasOwn(server, "defer") || Object.hasOwn(server, "eager")))
      );
    }
  );
  const malformedStructured =
    malformedServers ||
    !Object.hasOwn(raw, "servers") ||
    (Object.hasOwn(raw, "mode") &&
        raw.mode !== "cli" &&
        raw.mode !== "tools") ||
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

function mergeMcp(
  base: RecipeAgentMcp | undefined,
  child: RecipeAgentMcp | undefined
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
  if (manifest) return yamlFilesFromPaths(packageResourcePaths(manifest, "agents"));
  return yamlFilesFromPaths([join(recipeDir, "agents")]);
}

function readRecipeAgentSources(
  recipeDir: string,
  opts: { onInvalidFile?: (path: string, error: Error) => void } = {}
): RecipeAgentSource[] {
  const sources: RecipeAgentSource[] = [];
  for (const path of recipeAgentFiles(recipeDir)) {
    const data = readYaml(path);

    const unknownKeys = Object.keys(data).filter((key) => !AGENT_YAML_KEYS.has(key));
    if (unknownKeys.length > 0) {
      opts.onInvalidFile?.(
        path,
        new Error(`Agent YAML at ${path} has unsupported key(s): ${unknownKeys.join(", ")}`)
      );
      continue;
    }
    const fieldError = invalidAgentField(data);
    if (fieldError) {
      opts.onInvalidFile?.(
        path,
        new Error(`Agent YAML at ${path}: ${fieldError}`)
      );
      continue;
    }
    const name = data.name as string;

    let modelConfig: RecipeAgentModelConfig | undefined;
    let sessionConfig: RecipeAgentSessionConfig | undefined;
    try {
      if (Object.hasOwn(data, "model") && Object.hasOwn(data, "ai")) {
        throw new RecipeModelConfigError(
          `Agent YAML at ${path} cannot declare both model and ai`
        );
      }
      modelConfig = Object.hasOwn(data, "ai")
        ? parseRecipeAgentAiConfig(`Agent YAML at ${path}`, data.ai)
        : parseRecipeAgentModelConfig(`Agent YAML at ${path}`, data.model);
      sessionConfig = parseRecipeAgentSessionConfig(
        `Agent YAML at ${path}`,
        data.session
      );
    } catch (err) {
      if (
        !(err instanceof RecipeModelConfigError) &&
        !(err instanceof RecipeSessionConfigError)
      ) throw err;
      opts.onInvalidFile?.(path, err);
      continue;
    }

    sources.push({
      definition: {
        name,
        from: typeof data.from === "string" ? data.from : undefined,
        description:
          typeof data.description === "string" ? data.description : undefined,
        model: modelProjection(modelConfig),
        modelConfig,
        sessionConfig,
        tools: Object.hasOwn(data, "tools") ? stringArray(data.tools) : undefined,
        mcp: parseMcp(data),
        skills: Object.hasOwn(data, "skills") ? stringArray(data.skills) : undefined,
        subagents: Object.hasOwn(data, "subagents") ? stringArray(data.subagents) : undefined,
        systemInstructions: parseSystemInstructions(data),
        declaredFields: [
          "description",
          "model",
          "ai",
          "session",
          "tools",
          "mcp",
          "skills",
          "subagents",
          "system_instructions",
        ].filter((key): key is RecipeAgentConfigField =>
          Object.hasOwn(data, key)
        ),
      },
    });
  }
  return sources;
}

function definitionsFromSources(
  sources: RecipeAgentSource[]
): Map<string, RecipeAgentDefinition> {
  const rawDefinitions = new Map<string, ParsedRecipeAgentDefinition>();
  const resolvedDefinitions = new Map<string, RecipeAgentDefinition>();
  const definitions = new Map<string, RecipeAgentDefinition>();

  for (const source of sources) {
    rawDefinitions.set(source.definition.name, source.definition);
  }

  function resolveDefinition(
    name: string,
    stack: string[] = []
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
      raw.modelConfig
    );
    const sessionConfig = mergeRecipeAgentSessionConfig(
      base?.sessionConfig,
      raw.sessionConfig
    );
    const definition: RecipeAgentDefinition = {
      name: raw.name,
      ...(raw.from ? { from: raw.from } : {}),
      description: raw.description ?? base?.description,
      model: modelProjection(modelConfig),
      ...(modelConfig ? { modelConfig } : {}),
      ...(sessionConfig ? { sessionConfig } : {}),
      tools: raw.tools ?? base?.tools ?? [],
      mcp: mergeMcp(base?.mcp, raw.mcp),
      skills: raw.skills ?? base?.skills ?? [],
      subagents: raw.subagents ?? base?.subagents ?? [],
      systemInstructions: mergeSystemInstructions(
        base?.systemInstructions,
        raw.systemInstructions
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
  sources: RecipeAgentSource[]
): RecipeAgentValidationFinding[] {
  const rawDefinitions = new Map<string, ParsedRecipeAgentDefinition>();
  for (const source of sources) {
    rawDefinitions.set(source.definition.name, source.definition);
  }

  function inheritanceFinding(
    name: string,
    stack: string[] = []
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

  function resolvedModelProvided(
    name: string,
    stack: string[] = []
  ): boolean {
    if (
      stack.includes(name) ||
      stack.length >= MAX_INHERITANCE_DEPTH
    ) return false;
    const definition = rawDefinitions.get(name);
    if (!definition) return false;
    if (definition.model?.name) return true;
    return definition.from
      ? resolvedModelProvided(definition.from, [...stack, name])
      : false;
  }

  function resolvedTools(
    name: string,
    stack: string[] = []
  ): string[] | undefined {
    if (
      stack.includes(name) ||
      stack.length >= MAX_INHERITANCE_DEPTH
    ) return undefined;
    const definition = rawDefinitions.get(name);
    if (!definition) return undefined;
    if (definition.tools !== undefined) return definition.tools;
    return definition.from
      ? resolvedTools(definition.from, [...stack, name])
      : undefined;
  }

  function resolvedMcp(
    name: string,
    stack: string[] = []
  ): RecipeAgentMcp | undefined {
    if (
      stack.includes(name) ||
      stack.length >= MAX_INHERITANCE_DEPTH
    ) return undefined;
    const definition = rawDefinitions.get(name);
    if (!definition) return undefined;
    const base = definition.from
      ? resolvedMcp(definition.from, [...stack, name])
      : undefined;
    return mergeMcp(base, definition.mcp);
  }

  function rawMcpChainInvalid(name: string, stack: string[] = []): boolean {
    if (
      stack.includes(name) ||
      stack.length >= MAX_INHERITANCE_DEPTH
    ) return false;
    const definition = rawDefinitions.get(name);
    if (!definition) return false;
    const rawMcp = definition.mcp as ParsedRecipeAgentMcp | undefined;
    if (
      rawMcp?.[INVALID_AGENT_MCP] ||
      Object.values(rawMcp?.servers ?? {}).some(
        (selection) => !isValidRecipeMcpToolSelection(selection)
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
        ])
      )
    : undefined;
  // The Recipe checker owns detailed authoring diagnostics. This session guard
  // only ensures malformed raw policies fail closed before agent startup.
  const invalidMcpPolicy = rawMcpChainInvalid(agentName) ||
    Object.entries(mcp?.servers ?? {}).some(([serverId, selection]) => {
      if (!serverId.trim() || !isValidRecipeMcpToolSelection(selection)) {
        return true;
      }
      if (!packageMcpServers) return false;
      const packageSelection = packageMcpServers.get(normalizeMcpServerId(serverId));
      if (!packageSelection) return true;
      return (selection.include ?? []).some((toolName) => {
        const value = toolName.trim();
        return value !== "*" && !mcpSelectionAllowsTool(packageSelection, value);
      });
    }) ||
    Object.values(mcp?.servers ?? {}).some(
      (selection) =>
        (mcp?.mode !== "tools" &&
          (selection.defer !== undefined || selection.eager !== undefined)) ||
        !validActivationSelectors(selection.defer) ||
        !validActivationSelectors(selection.eager) ||
        [...(selection.defer ?? []), ...(selection.eager ?? [])].some(
          (selector) =>
            selector !== "*" && !mcpSelectionAllowsTool(selection, selector)
        )
    );
  if (invalidMcpPolicy) {
    findings.push({
      agentName,
      field: "mcp",
      code: "mcp_invalid",
      message: `Recipe agent "${agentName}" has an invalid MCP policy`,
    });
  }

  return findings;
}

export function validateResolvedRecipeAgentDefinition(opts: {
  recipeDir: string;
  agentName: string;
}): RecipeAgentValidationFinding[] {
  return validateResolvedRecipeAgentSource(
    opts,
    readRecipeAgentSources(opts.recipeDir)
  );
}

function isValidRecipeModelSpec(spec: string): boolean {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return false;
  const provider = spec.slice(0, slash);
  return !/[\s:]/.test(provider);
}

function validateRecipeAgentModelSpecs(
  sources: RecipeAgentSource[]
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
  sources: RecipeAgentSource[]
): RecipeAgentValidationFinding[] {
  const findings: RecipeAgentValidationFinding[] = [];
  const nameCounts = new Map<string, number>();

  for (const source of sources) {
    nameCounts.set(
      source.definition.name,
      (nameCounts.get(source.definition.name) ?? 0) + 1
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
  invalidFileFindings: RecipeAgentValidationFinding[]
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
        sources
      )
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
  recipeDir: string
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
      invalidFileFindings
    ),
  };
}

export function validateRecipeAgentDefinitions(
  recipeDir: string
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
