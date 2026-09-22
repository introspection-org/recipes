import { createHash } from "node:crypto";

import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { callMcpDaemonTool } from "./mcp-daemon-client.js";
import type { McpCatalogServer } from "./mcp-daemon-protocol.js";
import { mcpSelectionAllowsTool } from "./mcp-policy.js";
import type {
  McpSessionConfig,
  McpToolCatalogEntry,
} from "./mcp.js";
import type { RecipeAgentMcp } from "./recipe-agent.js";
import {
  LEGACY_MCP_TOOL_SEARCH_NAME,
  RECIPE_TOOL_SEARCH_NAME,
} from "./tool-search.js";

const DEFAULT_OUTPUT_MAX_BYTES = 50 * 1024;
const DEFAULT_OUTPUT_MAX_LINES = 2_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

type Recordish = Record<string, unknown>;

export interface McpToolDetails {
  server: string;
  tool: string;
  structuredContent?: Recordish;
  outputSchema?: Recordish;
  truncated?: {
    originalBytes: number;
    originalLines: number;
    returnedBytes: number;
    returnedLines: number;
  };
}

export interface McpToolSet {
  tools: ToolDefinition[];
  toolNames: string[];
  initialActiveToolNames: string[];
  deferredToolNames: string[];
  diagnostics: string[];
  canonicalToPiName: ReadonlyMap<string, string>;
}

interface UsableMcpTool {
  serverId: string;
  serverName: string;
  catalog: McpToolCatalogEntry;
  canonicalName: string;
  piName: string;
  inputSchema: Recordish;
  validateInput: ValidateFunction;
  outputSchema?: Recordish;
  validateOutput?: ValidateFunction;
}

function asRecord(value: unknown): Recordish | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Recordish)
    : undefined;
}

function positiveInteger(
  value: string | undefined,
  fallback: number
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function schemaCompiler(schema: Recordish): Ajv | Ajv2020 {
  const dialect = typeof schema.$schema === "string" ? schema.$schema : "";
  return dialect.includes("draft-07")
    ? new Ajv({ strict: false, allErrors: true, validateFormats: false })
    : new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
}

function compileSchema(
  schema: Recordish,
  label: string
): ValidateFunction {
  try {
    return schemaCompiler(schema).compile(schema);
  } catch (error) {
    throw new Error(
      `${label} is not a compilable JSON Schema: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function jsonPointerValue(root: Recordish, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    throw new Error(`unsupported non-local JSON Schema reference '${ref}'`);
  }
  let current: unknown = root;
  for (const rawPart of ref.slice(2).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    const record = asRecord(current);
    if (!record || !Object.hasOwn(record, part)) {
      throw new Error(`unresolved JSON Schema reference '${ref}'`);
    }
    current = record[part];
  }
  return current;
}

function dereferenceSchema(
  root: Recordish,
  value: unknown,
  stack: readonly string[] = []
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => dereferenceSchema(root, entry, stack));
  }
  const record = asRecord(value);
  if (!record) return value;
  if (typeof record.$ref === "string") {
    if (stack.includes(record.$ref)) {
      throw new Error(
        `circular JSON Schema reference '${record.$ref}' is not provider-safe`
      );
    }
    const target = asRecord(jsonPointerValue(root, record.$ref));
    if (!target) {
      throw new Error(
        `JSON Schema reference '${record.$ref}' does not resolve to an object`
      );
    }
    const siblings = Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== "$ref")
    );
    return {
      ...(dereferenceSchema(root, target, [...stack, record.$ref]) as Recordish),
      ...(dereferenceSchema(root, siblings, stack) as Recordish),
    };
  }
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== "$defs" && key !== "definitions")
      .map(([key, entry]) => [key, dereferenceSchema(root, entry, stack)])
  );
}

function providerSafeInputSchema(
  schema: Recordish,
  label: string
): { schema: Recordish; validate: ValidateFunction } {
  const normalized = asRecord(dereferenceSchema(schema, schema));
  if (!normalized || normalized.type !== "object") {
    throw new Error(`${label} must be a JSON Schema object with type 'object'`);
  }
  return {
    schema: normalized,
    validate: compileSchema(normalized, label),
  };
}

function sanitizeNamePart(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return normalized || "tool";
}

export function piMcpToolName(serverId: string, toolName: string): string {
  const canonical = `${serverId}.${toolName}`;
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 10);
  const readable = `mcp_${sanitizeNamePart(serverId)}_${sanitizeNamePart(
    toolName
  )}`;
  const prefix = readable.slice(0, 64 - hash.length - 1).replace(/_+$/g, "");
  return `${prefix}_${hash}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameJsonText(text: string, value: unknown): boolean {
  try {
    return stableJson(JSON.parse(text)) === stableJson(value);
  } catch {
    return false;
  }
}

function embeddedResourceText(block: Recordish): string {
  const resource = asRecord(block.resource);
  const uri = typeof resource?.uri === "string" ? resource.uri : "resource";
  if (typeof resource?.text === "string") {
    return `[Embedded resource: ${uri}]\n${resource.text}`;
  }
  if (typeof resource?.blob === "string") {
    return `[Embedded binary resource: ${uri}; ${
      typeof resource.mimeType === "string"
        ? resource.mimeType
        : "application/octet-stream"
    }]`;
  }
  return `[Embedded resource: ${uri}]`;
}

function contentBlocks(
  result: Recordish,
  structuredContent: Recordish | undefined
): Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
> {
  const blocks: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > = [];
  if (structuredContent) {
    blocks.push({ type: "text", text: stableJson(structuredContent) });
  }
  for (const raw of Array.isArray(result.content) ? result.content : []) {
    const block = asRecord(raw);
    if (!block || typeof block.type !== "string") continue;
    if (block.type === "text" && typeof block.text === "string") {
      if (
        structuredContent &&
        sameJsonText(block.text, structuredContent)
      ) {
        continue;
      }
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      blocks.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      });
      continue;
    }
    if (block.type === "resource_link" && typeof block.uri === "string") {
      blocks.push({
        type: "text",
        text: `[Resource link: ${
          typeof block.name === "string" ? block.name : block.uri
        }]\n${block.uri}`,
      });
      continue;
    }
    if (block.type === "resource") {
      blocks.push({ type: "text", text: embeddedResourceText(block) });
      continue;
    }
    if (block.type === "audio") {
      blocks.push({
        type: "text",
        text: `[Audio content: ${
          typeof block.mimeType === "string" ? block.mimeType : "audio/*"
        }]`,
      });
      continue;
    }
    blocks.push({ type: "text", text: stableJson(block) });
  }
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "(empty result)" });
  }
  return blocks;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return text.slice(0, low);
}

function guardContent(
  content: ReturnType<typeof contentBlocks>,
  env: NodeJS.ProcessEnv
): {
  content: ReturnType<typeof contentBlocks>;
  truncated?: McpToolDetails["truncated"];
} {
  const maxBytes = positiveInteger(
    env.PI_RECIPES_MCP_MAX_OUTPUT_BYTES,
    DEFAULT_OUTPUT_MAX_BYTES
  );
  const maxLines = positiveInteger(
    env.PI_RECIPES_MCP_MAX_OUTPUT_LINES,
    DEFAULT_OUTPUT_MAX_LINES
  );
  const images = content.filter(
    (block): block is { type: "image"; data: string; mimeType: string } =>
      block.type === "image"
  );
  const text = content
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text"
    )
    .map((block) => block.text)
    .join("\n");
  const originalBytes = Buffer.byteLength(text, "utf8");
  const imageBytes = images.reduce(
    (total, image) => total + Buffer.byteLength(image.data, "base64"),
    0
  );
  const originalContentBytes = originalBytes + imageBytes;
  const originalLines = text.split("\n").length;
  if (originalContentBytes <= maxBytes && originalLines <= maxLines) {
    return { content };
  }
  const linePreview = text.split("\n").slice(0, maxLines).join("\n");
  const notice = `\n\n[Output truncated: ${originalContentBytes} bytes, ${originalLines} lines${
    images.length > 0 ? `, ${images.length} image(s) omitted` : ""
  }.]`;
  const preview = truncateUtf8(
    linePreview,
    Math.max(0, maxBytes - Buffer.byteLength(notice, "utf8"))
  );
  const guarded = `${preview}${notice}`;
  return {
    content: [{ type: "text", text: guarded }],
    truncated: {
      originalBytes: originalContentBytes,
      originalLines,
      returnedBytes: Buffer.byteLength(guarded, "utf8"),
      returnedLines: guarded.split("\n").length,
    },
  };
}

function errorText(
  result: Recordish,
  env: NodeJS.ProcessEnv
): string {
  const guarded = guardContent(contentBlocks(result, undefined), env);
  const text = guarded.content
    .filter(
      (value): value is { type: "text"; text: string } =>
        value.type === "text"
    )
    .map((value) => value.text)
    .join("\n")
    .trim();
  return text || "MCP tool execution failed.";
}

function validateResult(
  tool: UsableMcpTool,
  raw: unknown,
  env: NodeJS.ProcessEnv
) {
  const result = asRecord(raw);
  if (!result) {
    throw new Error(
      `MCP tool '${tool.canonicalName}' returned a malformed result.`
    );
  }
  if (result.isError === true) {
    throw new Error(errorText(result, env));
  }
  const structuredContent = asRecord(result.structuredContent);
  if (tool.validateOutput) {
    if (!structuredContent) {
      throw new Error(
        `MCP tool '${tool.canonicalName}' declares outputSchema but returned no structuredContent. The remote outcome is unknown; do not retry automatically.`
      );
    }
    if (!tool.validateOutput(structuredContent)) {
      throw new Error(
        `MCP tool '${tool.canonicalName}' returned structuredContent that does not match outputSchema: ${schemaErrors(
          tool.validateOutput
        )}. The remote outcome is unknown; do not retry automatically.`
      );
    }
  }
  const guarded = guardContent(
    contentBlocks(result, structuredContent),
    env
  );
  return {
    content: guarded.content,
    details: {
      server: tool.serverId,
      tool: tool.catalog.name,
      ...(structuredContent ? { structuredContent } : {}),
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(guarded.truncated ? { truncated: guarded.truncated } : {}),
    } satisfies McpToolDetails,
  };
}

function schemaErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .slice(0, 3)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
    .join("; ");
}

function activeCanonicalNames(
  mcp: RecipeAgentMcp,
  usable: readonly UsableMcpTool[]
): Set<string> {
  const result = new Set<string>();
  for (const tool of usable) {
    const policy = mcp.servers[tool.serverId];
    const deferred =
      policy.defer?.includes("*") === true ||
      policy.defer?.includes(tool.catalog.name) === true;
    const eager =
      policy.eager?.includes("*") === true ||
      policy.eager?.includes(tool.catalog.name) === true;
    if (!deferred || eager) result.add(tool.canonicalName);
  }
  return result;
}

function compileUsableTools(
  session: McpSessionConfig,
  catalogs: readonly McpCatalogServer[]
): { usable: UsableMcpTool[]; unusable: Map<string, string> } {
  const usable: UsableMcpTool[] = [];
  const unusable = new Map<string, string>();
  for (const server of session.servers) {
    const discovered = catalogs.find((catalog) => catalog.id === server.id);
    if (!discovered || discovered.error) continue;
    for (const catalog of discovered.tools) {
      const canonicalName = `${server.id}.${catalog.name}`;
      try {
        const rawInputSchema = asRecord(catalog.input_schema) ?? {
          type: "object",
          additionalProperties: false,
        };
        const input = providerSafeInputSchema(
          rawInputSchema,
          `${canonicalName} inputSchema`
        );
        const outputSchema = asRecord(catalog.output_schema);
        usable.push({
          serverId: server.id,
          serverName: server.name,
          catalog,
          canonicalName,
          piName: piMcpToolName(server.id, catalog.name),
          inputSchema: input.schema,
          validateInput: input.validate,
          ...(outputSchema
            ? {
                outputSchema,
                validateOutput: compileSchema(
                  outputSchema,
                  `${canonicalName} outputSchema`
                ),
              }
            : {}),
        });
      } catch (error) {
        unusable.set(
          canonicalName,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }
  return { usable, unusable };
}

export function createMcpToolSet(options: {
  session: McpSessionConfig;
  catalogs: readonly McpCatalogServer[];
  mcp: RecipeAgentMcp;
  env: NodeJS.ProcessEnv;
}): McpToolSet {
  // A host-provisioned daemon may serve more than one agent. Re-apply this
  // resolved agent's policy before any catalog entry becomes a Pi tool.
  const session: McpSessionConfig = {
    ...options.session,
    servers: options.session.servers.filter((server) =>
      Object.hasOwn(options.mcp.servers, server.id)
    ),
  };
  const catalogs = options.catalogs
    .filter((catalog) => Object.hasOwn(options.mcp.servers, catalog.id))
    .map((catalog) => ({
      ...catalog,
      tools: catalog.tools.filter((tool) =>
        mcpSelectionAllowsTool(options.mcp.servers[catalog.id], tool.name)
      ),
    }));
  const requiredFailures = catalogs.filter((catalog) => {
    const server = session.servers.find((entry) => entry.id === catalog.id);
    return server?.required === true && Boolean(catalog.error);
  });
  if (requiredFailures.length > 0) {
    throw new Error(
      `Required MCP catalog discovery failed: ${requiredFailures
        .map((catalog) => `${catalog.id}: ${catalog.error}`)
        .join("; ")}`
    );
  }
  const { usable, unusable } = compileUsableTools(session, catalogs);
  const activeCanonical = activeCanonicalNames(options.mcp, usable);
  const requestedEager = new Set(
    Object.entries(options.mcp.servers).flatMap(([serverId, policy]) =>
      (policy.eager ?? []).includes("*")
        ? usable
            .filter((tool) => tool.serverId === serverId)
            .map((tool) => tool.canonicalName)
        : (policy.eager ?? []).map((tool) => `${serverId}.${tool}`)
    )
  );
  for (const [serverId, policy] of Object.entries(options.mcp.servers)) {
    const selectors = policy.eager ?? [];
    if (!selectors.includes("*")) continue;
    const catalog = catalogs.find((entry) => entry.id === serverId);
    if (!catalog || catalog.error) {
      throw new Error(
        `Eager MCP wildcard for '${serverId}' requires a healthy catalog${
          catalog?.error ? `: ${catalog.error}` : "."
        }`
      );
    }
    const unusableActive = [...unusable.entries()].find(([name]) =>
      name.startsWith(`${serverId}.`)
    );
    if (unusableActive) {
      throw new Error(
        `Eager MCP wildcard for '${serverId}' includes unusable tool '${unusableActive[0]}': ${unusableActive[1]}`
      );
    }
  }
  const knownCanonical = new Set(
    catalogs.flatMap((server) =>
      server.tools.map((tool) => `${server.id}.${tool.name}`)
    )
  );
  for (const name of requestedEager) {
    if (unusable.has(name)) {
      throw new Error(
        `Eager MCP tool '${name}' is unusable: ${unusable.get(name)}`
      );
    }
    if (!knownCanonical.has(name) || !activeCanonical.has(name)) {
      throw new Error(
        `Eager MCP tool '${name}' is not authorized and available in the current catalog.`
      );
    }
  }

  const canonicalToPiName = new Map(
    usable.map((tool) => [tool.canonicalName, tool.piName])
  );
  const piNames = new Set<string>();
  for (const tool of usable) {
    if (
      piNames.has(tool.piName) ||
      tool.piName === RECIPE_TOOL_SEARCH_NAME ||
      tool.piName === LEGACY_MCP_TOOL_SEARCH_NAME
    ) {
      throw new Error(
        `MCP tool name collision for '${tool.canonicalName}' (${tool.piName}).`
      );
    }
    piNames.add(tool.piName);
  }

  const tools: ToolDefinition[] = usable.map((tool) => ({
    name: tool.piName,
    label: tool.catalog.name,
    description: tool.catalog.description ?? `MCP tool ${tool.canonicalName}`,
    parameters: Type.Unsafe(tool.inputSchema),
    executionMode:
      tool.catalog.annotations?.readOnlyHint === true &&
      tool.catalog.annotations?.idempotentHint === true
        ? "parallel"
        : "sequential",
    async execute(_toolCallId, params, signal) {
      const input = asRecord(params) ?? {};
      if (!tool.validateInput(input)) {
        throw new Error(
          `MCP tool '${tool.canonicalName}' received arguments that do not match inputSchema: ${schemaErrors(
            tool.validateInput
          )}`
        );
      }
      const raw = await callMcpDaemonTool(
        tool.serverId,
        tool.catalog.name,
        input,
        {
          env: options.env,
          signal,
          timeoutMs: positiveInteger(
            options.env.PI_RECIPES_MCP_CALL_TIMEOUT_MS,
            DEFAULT_CALL_TIMEOUT_MS
          ),
        }
      );
      return validateResult(tool, raw, options.env);
    },
  }));

  const initialActiveToolNames = usable
    .filter((tool) => activeCanonical.has(tool.canonicalName))
    .map((tool) => tool.piName);
  const inactive = usable.filter(
    (tool) => !activeCanonical.has(tool.canonicalName)
  );
  return {
    tools,
    toolNames: usable.map((tool) => tool.piName),
    initialActiveToolNames,
    deferredToolNames: inactive.map((tool) => tool.piName),
    diagnostics: [
      ...options.catalogs
        .filter((catalog) => catalog.error)
        .map((catalog) => `${catalog.id}: ${catalog.error}`),
      ...[...unusable.entries()].map(
        ([name, error]) => `${name}: ${error}`
      ),
    ],
    canonicalToPiName,
  };
}
