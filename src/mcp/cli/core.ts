import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stdin as input, stderr, stdout } from "node:process";
import { inspect, parseArgs } from "node:util";
import { isMainThread, Worker } from "node:worker_threads";
import type { Readable, Writable } from "node:stream";
import {
  createCallResult,
  createRuntime,
  describeConnectionIssue,
  type CallResult,
} from "mcporter";
import {
  currentMcpCommandContext,
  runWithMcpCommandContext,
  type McpRuntime,
} from "./command-context.js";
import {
  catalogOutputSchema,
  renderToolContract,
  renderToolSignature,
  type ContractTool,
} from "../../mcp-contract.js";
import {
  mcpCallHelpText,
  mcpCliHelpText,
  mcpListHelpText,
  mcpRunHelpText,
  mcpSearchHelpText,
} from "./help.js";
import {
  defaultMcporterConfigPath,
  defaultMcpSessionPath,
  filterMcpCatalog,
  mcpSessionAllowsTool,
  type McpSessionConfig,
  type McpSessionServer,
  type McpToolCatalogEntry,
} from "../../mcp.js";
import {
  createMcpCliSessionPolicy,
  validateDelegatedMcpCommand,
} from "./policy.js";
import type { McpCatalogServer } from "../daemon/protocol.js";

const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_LIST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RUN_TOOL_CALLS = 100;
const DEFAULT_MAX_CONCURRENT_TOOL_CALLS = 16;
const MAX_SEARCH_DESCRIPTION_CHARS = 600;
const CATALOG_LOCK_POLL_MS = 50;
const CATALOG_LOCK_INCOMPLETE_GRACE_MS = 1_000;
const MCP_SESSION_ENV = "PI_RECIPES_MCP_SESSION";
let mcporterCliPromise: Promise<typeof import("mcporter/cli")> | undefined;
const callCatalogCache = new WeakMap<
  McpRuntime,
  Map<string, Promise<McpToolCatalogEntry[]>>
>();

function loadMcporterCli(): Promise<typeof import("mcporter/cli")> {
  if (mcporterCliPromise) return mcporterCliPromise;
  const previousDisableAutorun = process.env.MCPORTER_DISABLE_AUTORUN;
  process.env.MCPORTER_DISABLE_AUTORUN = "1";
  mcporterCliPromise = import("mcporter/cli").finally(() => {
    if (previousDisableAutorun === undefined) {
      delete process.env.MCPORTER_DISABLE_AUTORUN;
    } else {
      process.env.MCPORTER_DISABLE_AUTORUN = previousDisableAutorun;
    }
  });
  return mcporterCliPromise;
}

async function acquireRuntime(): Promise<{
  runtime: Awaited<ReturnType<typeof createRuntime>>;
  owned: boolean;
}> {
  const shared = currentMcpCommandContext()?.runtime;
  return shared
    ? { runtime: shared, owned: false }
    : { runtime: await createRuntime(), owned: true };
}

async function closeOwnedRuntime(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  owned: boolean
): Promise<void> {
  if (owned) await runtime.close();
}

export interface ToolSearchMatch {
  ref: string;
  server: string;
  tool: string;
  description: string;
  required: string[];
  score: number;
  inspect: string;
  call: string;
  annotations?: Record<string, unknown>;
}

type ToolCallOutcome = "pending" | "succeeded" | "failed" | "outcome_unknown";

interface ToolCallRecord {
  ref: string;
  observed: boolean;
  outcome: ToolCallOutcome;
  error?: string;
  promise: Promise<unknown>;
}

type McpRunResultFormat =
  | "json"
  | "text"
  | "markdown"
  | "images"
  | "content"
  | "structuredContent"
  | "raw";

interface McpRunToolFunction {
  (args?: Record<string, unknown>): Promise<unknown>;
  text(args?: Record<string, unknown>): Promise<unknown>;
  markdown(args?: Record<string, unknown>): Promise<unknown>;
  images(args?: Record<string, unknown>): Promise<unknown>;
  content(args?: Record<string, unknown>): Promise<unknown>;
  structuredContent(args?: Record<string, unknown>): Promise<unknown>;
  raw(args?: Record<string, unknown>): Promise<unknown>;
}

export class McpRunUsageError extends Error {}

export class McpRunTimeoutError extends Error {
  readonly outcome = "unknown";
  constructor(message: string) {
    super(message);
    this.name = "McpRunTimeoutError";
  }
}

export interface McpRunRemoteErrorDetails extends Record<string, unknown> {
  code?: string;
  message: string;
  retryable?: boolean;
  action?: string;
  outcome?: string;
}

class McpRemoteToolResultError extends Error {
  constructor(readonly details: McpRunRemoteErrorDetails) {
    super(details.message);
    this.name = "McpRemoteToolResultError";
  }
}

export class McpRunToolError extends Error {
  readonly kind = "tool_execution";
  readonly details?: McpRunRemoteErrorDetails;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly action?: string;
  readonly outcome?: string;

  constructor(
    readonly server: string,
    readonly tool: string,
    message: string,
    options?: ErrorOptions & { details?: McpRunRemoteErrorDetails }
  ) {
    super(message, options);
    this.name = "McpRunToolError";
    this.details = options?.details;
    this.code = options?.details?.code;
    this.retryable = options?.details?.retryable;
    this.action = options?.details?.action;
    this.outcome = options?.details?.outcome;
  }
}

export {
  mcpCallHelpText,
  mcpListHelpText,
  mcpRunHelpText,
  mcpSearchHelpText,
} from "./help.js";

function isHelpArg(value: string | undefined): boolean {
  return value === "--help" || value === "-h" || value === "help";
}

function readStdin(): Promise<string> {
  const source = currentMcpCommandContext()?.stdin ?? input;
  source.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let data = "";
    source.on("data", (chunk) => {
      data += chunk;
    });
    source.on("error", reject);
    source.on("end", () => resolve(data));
  });
}

function checkedCallResult(
  callResult: ReturnType<typeof createCallResult>
): ReturnType<typeof createCallResult> {
  if (asRecord(callResult.raw).isError === true) {
    // Fail loudly in code mode so a bad call rejects instead of flowing an
    // error string into downstream logic.
    const parsed = callResult.json();
    const parsedRecord = asRecord(parsed);
    const parsedError = Object.prototype.hasOwnProperty.call(parsedRecord, "error")
      ? parsedRecord.error
      : parsedRecord;
    const errorObject = asRecord(parsedError);
    const message =
      typeof parsedError === "string"
        ? parsedError
        : typeof errorObject.message === "string"
          ? errorObject.message
          : callResult.text() ?? "MCP tool call failed.";
    throw new McpRemoteToolResultError({ ...errorObject, message });
  }
  return callResult;
}

function decodeCallResult(
  callResult: ReturnType<typeof createCallResult>,
  format: McpRunResultFormat,
  ref: string
): unknown {
  switch (format) {
    case "json": {
      const decoded = callResult.json();
      if (decoded === null && callResult.structuredContent() == null && callResult.text() != null) {
        throw new McpRunUsageError(
          `${ref} did not return JSON. Its documentation should name the response type; ` +
            `for plain text call tools[${JSON.stringify(ref.split(".")[0])}]` +
            `[${JSON.stringify(ref.slice(ref.indexOf(".") + 1))}].text(args).`
        );
      }
      return decoded;
    }
    case "text":
      return callResult.text();
    case "markdown":
      return callResult.markdown();
    case "images":
      return callResult.images();
    case "content":
      return callResult.content();
    case "structuredContent":
      return callResult.structuredContent();
    case "raw":
      return callResult.raw;
  }
}

function validateRunToolArgs(server: string, tool: string, args: Record<string, unknown>): void {
  const cliStyleKey = Object.keys(args).find((key) => key.includes(":=") || key.includes("="));
  if (!cliStyleKey) return;
  const suggestedKey = cliStyleKey.split(/:=|=/, 1)[0];
  throw new McpRunUsageError(
    `Invalid JavaScript argument key '${cliStyleKey}' for ${server}.${tool}. ` +
      `mcp run uses normal JavaScript objects: write { ${suggestedKey}: value }, ` +
      `not mcporter CLI key=value or key:=value syntax.`
  );
}

class ToolCallQueue {
  private active = 0;
  private readonly waiting: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
  }> = [];
  private cancelled: unknown;

  constructor(private readonly limit: number) {}

  acquire(): Promise<() => void> {
    if (this.cancelled !== undefined) return Promise.reject(this.cancelled);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseHandle());
    }
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  cancel(error: unknown): void {
    if (this.cancelled !== undefined) return;
    this.cancelled = error;
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next && this.cancelled === undefined) {
        next.resolve(this.releaseHandle());
        return;
      }
      this.active -= 1;
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function toolProperties(tool: McpToolCatalogEntry): Array<{ name: string; description: string }> {
  const schema = asRecord(tool.input_schema);
  const properties = asRecord(schema.properties);
  return Object.entries(properties).map(([name, value]) => {
    const property = asRecord(value);
    const description =
      typeof property.description === "string"
        ? property.description
        : typeof property.title === "string"
          ? property.title
          : "";
    return { name, description };
  });
}

function toolRequired(tool: McpToolCatalogEntry): string[] {
  const schema = asRecord(tool.input_schema);
  return Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
}

function includesTerm(value: string, term: string): boolean {
  return value.toLowerCase().includes(term.toLowerCase());
}

function scoreTool(opts: {
  query: string;
  queryTerms: string[];
  regex?: RegExp;
  serverId: string;
  serverName: string;
  tool: McpToolCatalogEntry;
}): number {
  const ref = `${opts.serverId}.${opts.tool.name}`;
  const description = opts.tool.description ?? "";
  const properties = toolProperties(opts.tool);
  const propertyNames = properties.map((property) => property.name).join(" ");
  const propertyDescriptions = properties.map((property) => property.description).join(" ");
  const searchable = [
    ref,
    opts.serverId,
    opts.serverName,
    opts.tool.name,
    description,
    propertyNames,
    propertyDescriptions,
  ].join("\n");
  if (opts.regex) return opts.regex.test(searchable) ? 100 : 0;

  const query = opts.query.toLowerCase();
  const toolName = opts.tool.name.toLowerCase();
  const refName = ref.toLowerCase();
  let score = 0;
  if (refName === query) score += 500;
  if (toolName === query) score += 300;
  if (refName.includes(query)) score += 120;
  if (toolName.includes(query)) score += 100;
  if (description.toLowerCase().includes(query)) score += 60;

  const toolNameTokens = new Set(words(opts.tool.name));
  const serverTokens = new Set(words(`${opts.serverId} ${opts.serverName}`));
  const descriptionText = description.toLowerCase();
  const propertyNameTokens = new Set(words(propertyNames));
  const propertyDescriptionText = propertyDescriptions.toLowerCase();

  for (const term of opts.queryTerms) {
    if (toolNameTokens.has(term)) score += 40;
    else if (includesTerm(opts.tool.name, term)) score += 20;

    if (descriptionText.includes(term)) score += 16;
    if (propertyNameTokens.has(term)) score += 12;
    else if (includesTerm(propertyNames, term)) score += 6;

    if (propertyDescriptionText.includes(term)) score += 6;
    if (serverTokens.has(term)) score += 4;
  }
  return score;
}

function exampleValue(name: string): string {
  if (/^(q|query|search)$/i.test(name)) return `="example query"`;
  if (/limit|count|max/i.test(name)) return "=10";
  if (/^(id|.*Id)$/i.test(name)) return '="<id>"';
  return '="<value>"';
}

function callExample(serverId: string, tool: McpToolCatalogEntry): string {
  const required = toolRequired(tool);
  const args = required.slice(0, 4).map((name) => `${name}${exampleValue(name)}`);
  return ["mcp call", `${serverId}.${tool.name}`, ...args].join(" ");
}

export function searchMcpTools(
  session: McpSessionConfig,
  query: string,
  opts: { limit?: number; regex?: boolean } = {}
): ToolSearchMatch[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const regex = opts.regex ? new RegExp(trimmed, "i") : undefined;
  const queryTerms = words(trimmed);
  const matches: ToolSearchMatch[] = [];
  for (const server of session.servers) {
    for (const tool of server.catalog ?? []) {
      const score = scoreTool({
        query: trimmed,
        queryTerms,
        regex,
        serverId: server.id,
        serverName: server.name ?? "",
        tool,
      });
      if (score <= 0) continue;
      const ref = `${server.id}.${tool.name}`;
      matches.push({
        ref,
        server: server.id,
        tool: tool.name,
        description:
          (tool.description ?? "").length > MAX_SEARCH_DESCRIPTION_CHARS
            ? `${(tool.description ?? "").slice(0, MAX_SEARCH_DESCRIPTION_CHARS - 14).trimEnd()}… [truncated]`
            : (tool.description ?? ""),
        required: toolRequired(tool),
        score,
        inspect: `mcp list ${ref} --schema`,
        call: callExample(server.id, tool),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      });
    }
  }
  return matches
    .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref))
    .slice(0, opts.limit ?? 8);
}

async function readSession(): Promise<McpSessionConfig> {
  const path = sessionPolicyPath();
  const data = await readFile(path, "utf8");
  const parsed = JSON.parse(data) as McpSessionConfig;
  if (parsed.version !== 1 || !Array.isArray(parsed.servers)) {
    throw new Error(`Invalid MCP session policy at ${path}`);
  }
  return parsed;
}

function sessionPolicyPath(): string {
  const workspacePath = defaultMcpSessionPath(sessionRoot());
  return existsSync(workspacePath)
    ? workspacePath
    : process.env[MCP_SESSION_ENV] || workspacePath;
}

function sessionMcporterConfigPath(): string {
  const workspacePath = defaultMcporterConfigPath(sessionRoot());
  return existsSync(workspacePath)
    ? workspacePath
    : process.env.MCPORTER_CONFIG || workspacePath;
}

function sessionRoot(): string {
  return process.env.PI_RECIPES_MCP_SESSION_ROOT || process.cwd();
}

function pinSessionMcporterConfig(): void {
  process.env.MCPORTER_CONFIG = sessionMcporterConfigPath();
}

async function sessionCliPolicy() {
  return createMcpCliSessionPolicy(await readSession());
}

function catalogFingerprint(server: McpSessionServer): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: server.id,
        baseUrl: server.base_url,
        packageTools: server.package_tools,
        agentTools: server.agent_tools,
      })
    )
    .digest("hex")
    .slice(0, 20);
}

function catalogCachePath(server: McpSessionServer): string {
  return join(
    sessionRoot(),
    ".pi",
    "mcp-catalogs",
    `${server.id}-${catalogFingerprint(server)}.json`
  );
}

async function readCachedCatalog(
  server: McpSessionServer
): Promise<McpToolCatalogEntry[] | null> {
  if (server.catalog) return server.catalog;
  try {
    const parsed = JSON.parse(
      await readFile(catalogCachePath(server), "utf8")
    ) as { tools?: McpToolCatalogEntry[] };
    return Array.isArray(parsed.tools) ? parsed.tools : null;
  } catch {
    return null;
  }
}

async function writeCachedCatalog(
  server: McpSessionServer,
  tools: McpToolCatalogEntry[]
): Promise<void> {
  const directory = join(sessionRoot(), ".pi", "mcp-catalogs");
  await mkdir(directory, { recursive: true });
  const path = catalogCachePath(server);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ tools })}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function catalogLockIsStale(
  path: string,
  timeoutMs: number
): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(path, "utf8")) as {
      pid?: unknown;
      createdAt?: unknown;
    };
    if (
      typeof owner.pid === "number" &&
      Number.isInteger(owner.pid) &&
      owner.pid > 0 &&
      typeof owner.createdAt === "number" &&
      Number.isFinite(owner.createdAt)
    ) {
      return (
        !processExists(owner.pid) ||
        Date.now() - owner.createdAt > timeoutMs + CATALOG_LOCK_INCOMPLETE_GRACE_MS
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
  }
  try {
    const metadata = await stat(path);
    return Date.now() - metadata.mtimeMs > CATALOG_LOCK_INCOMPLETE_GRACE_MS;
  } catch {
    return false;
  }
}

async function acquireCatalogLock(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`
    );
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
  await handle.close();
  return true;
}

function catalogEntry(tool: ContractTool): McpToolCatalogEntry {
  const annotations = asRecord(tool).annotations;
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.inputSchema && typeof tool.inputSchema === "object"
      ? { input_schema: tool.inputSchema as Record<string, unknown> }
      : {}),
    ...(tool.outputSchema && typeof tool.outputSchema === "object"
      ? { output_schema: tool.outputSchema as Record<string, unknown> }
      : {}),
    ...(annotations && typeof annotations === "object"
      ? { annotations: annotations as Record<string, unknown> }
      : {}),
  };
}

async function discoverServerCatalog(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  server: McpSessionServer,
  timeoutMs: number
): Promise<McpToolCatalogEntry[]> {
  const cached = await readCachedCatalog(server);
  if (cached) return cached;
  const lock = `${catalogCachePath(server)}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  let ownsLock = false;
  const deadline = Date.now() + timeoutMs;
  while (!ownsLock && Date.now() < deadline) {
    ownsLock = await acquireCatalogLock(lock);
    if (ownsLock) break;
    const populated = await readCachedCatalog(server);
    if (populated) return populated;
    if (await catalogLockIsStale(lock, timeoutMs)) {
      await rm(lock, { force: true });
      continue;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await delay(Math.min(CATALOG_LOCK_POLL_MS, remainingMs));
    }
  }
  if (!ownsLock) {
    const populated = await readCachedCatalog(server);
    if (populated) return populated;
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for MCP catalog discovery for '${server.id}'`
    );
  }
  try {
    // The previous owner may have populated the cache immediately before its
    // process exited and this caller reclaimed the lock.
    const populated = await readCachedCatalog(server);
    if (populated) return populated;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `timed out after ${timeoutMs}ms before MCP catalog discovery for '${server.id}' started`
      );
    }
    const discovered = (await withListTimeout(
      runtime.listTools(server.id, {
        includeSchema: true,
        autoAuthorize: false,
        allowCachedAuth: true,
        disableOAuth: true,
      }),
      remainingMs
    )) as ContractTool[];
    const tools = filterMcpCatalog(server, discovered.map(catalogEntry));
    await writeCachedCatalog(server, tools);
    return tools;
  } finally {
    if (ownsLock) await rm(lock, { recursive: true, force: true });
  }
}

export async function discoverMcpCatalogs(
  runtime: McpRuntime,
  timeoutMs: number
): Promise<McpCatalogServer[]> {
  const session = await readSession();
  return await Promise.all(
    session.servers.map(async (server) => {
      try {
        return {
          id: server.id,
          name: server.name,
          tools: await discoverServerCatalog(runtime, server, timeoutMs),
        };
      } catch (error) {
        return {
          id: server.id,
          name: server.name,
          tools: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );
}

const SEARCH_OPTIONS = {
  limit: { type: "string" },
  regex: { type: "boolean" },
} as const;

function optionName(value: string): string {
  const equals = value.indexOf("=");
  return equals === -1 ? value : value.slice(0, equals);
}

export function parseSearchArgs(
  args: string[]
):
  | { query: string; limit: number; regex: boolean; error?: undefined }
  | { error: string } {
  if (args.some((arg) => optionName(arg) === "--json")) {
    return { error: "mcp search metadata is compact text; JSON is reserved for tool results." };
  }
  let parsed: ReturnType<typeof parseArgs<{ options: typeof SEARCH_OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args, options: SEARCH_OPTIONS, allowPositionals: true });
  } catch (error) {
    // An agent reads these and decides what to try next, so the wording stays
    // ours rather than Node's.
    if ((error as NodeJS.ErrnoException).code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      // parseArgs rejects an option-shaped value (`--limit -1`) before it is
      // read, so the value has to be recovered to name it back.
      const index = args.findIndex((arg) => optionName(arg) === "--limit");
      const flag = args[index] ?? "";
      const raw = flag.includes("=")
        ? flag.slice(flag.indexOf("=") + 1)
        : (args[index + 1] ?? "");
      return { error: `--limit expects a positive integer, got '${raw}'.` };
    }
    const unknown = args.find(
      (arg) => arg.startsWith("-") && !(optionName(arg).slice(2) in SEARCH_OPTIONS)
    );
    return { error: `Unknown mcp search option '${unknown}'.` };
  }
  const { values, positionals } = parsed;
  let limit = 8;
  if (values.limit !== undefined) {
    const value = Number(values.limit);
    if (!Number.isInteger(value) || value <= 0) {
      return { error: `--limit expects a positive integer, got '${values.limit}'.` };
    }
    limit = value;
  }
  return { query: positionals.join(" "), limit, regex: values.regex === true };
}

async function searchCatalog(args: string[]): Promise<number> {
  const parsed = parseSearchArgs(args);
  if (parsed.error !== undefined) {
    stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const { query, limit, regex } = parsed;
  if (!query.trim()) {
    stderr.write("Usage: mcp search \"what you need\" [--limit N] [--regex]\n");
    return 2;
  }
  let matches: ToolSearchMatch[];
  const { runtime, owned } = await acquireRuntime();
  try {
    const session = await readSession();
    const results = await Promise.all(
      session.servers.map(async (server) => {
        try {
          return {
            catalog: await discoverServerCatalog(
              runtime,
              server,
              DEFAULT_LIST_TIMEOUT_MS
            ),
          } as const;
        } catch (error) {
          return { error } as const;
        }
      })
    );
    const failed = results.filter((result) => "error" in result).length;
    if (failed > 0) {
      stderr.write(
        `mcp search: ${failed} of ${results.length} server(s) unavailable; searched the remaining catalogs.\n`
      );
    }
    matches = searchMcpTools(
      {
        ...session,
        servers: session.servers.map((server, index) => ({
          ...server,
          catalog:
            "catalog" in results[index]! ? results[index]!.catalog : [],
        })),
      },
      query,
      { limit, regex }
    );
  } catch (err) {
    if (regex && err instanceof SyntaxError) {
      stderr.write(`Invalid --regex pattern: ${query}\n`);
      return 2;
    }
    throw err;
  } finally {
    await closeOwnedRuntime(runtime, owned);
  }
  if (matches.length === 0) {
    stdout.write(`No matching tools found for "${query}".\n`);
    stdout.write("Try broader or alternate terms.\n");
    stdout.write(
      "Use `mcp list <server>` only to identify exact tool names, then inspect one candidate with `mcp list <server.tool> --schema`.\n"
    );
    return 0;
  }
  for (const match of matches) {
    stdout.write(`${match.ref}${match.description ? ` — ${match.description}` : ""}\n`);
    if (match.required.length > 0) stdout.write(`  required: ${match.required.join(", ")}\n`);
  }
  return 0;
}

function exactToolTarget(value: string | undefined): { server: string; tool: string } | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot < 1 || dot === value.length - 1) return null;
  return { server: value.slice(0, dot), tool: value.slice(dot + 1) };
}

function catalogTool(
  session: McpSessionConfig,
  server: string,
  tool: string
): McpToolCatalogEntry | undefined {
  return session.servers
    ?.find((entry) => entry.id === server)
    ?.catalog?.find((entry) => entry.name === tool);
}

function toolCount(count: number): string {
  return `${count} tool${count === 1 ? "" : "s"}`;
}

export function parseListTimeoutMs(args: readonly string[]): number | string {
  const configured = process.env.MCPORTER_LIST_TIMEOUT;
  let raw = configured && /^[1-9]\d*$/.test(configured) ? configured : String(DEFAULT_LIST_TIMEOUT_MS);
  // Non-strict: every other option on this line belongs to mcporter.
  const { values } = parseArgs({
    args: [...args.slice(1)],
    options: { timeout: { type: "string" } },
    strict: false,
    allowPositionals: true,
  });
  if (values.timeout !== undefined) {
    // A trailing `--timeout` parses as a boolean rather than throwing.
    if (typeof values.timeout !== "string" || values.timeout === "") {
      return "mcp list: --timeout requires a value.";
    }
    raw = values.timeout;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    return "mcp list: --timeout must be a positive integer (milliseconds).";
  }
  const timeout = Number(raw);
  return Number.isSafeInteger(timeout)
    ? timeout
    : "mcp list: --timeout must be a positive integer (milliseconds).";
}

export function withListTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function aggregateListExitCode(
  hadFailure: boolean,
  args: readonly string[]
): number {
  return hadFailure && (args.includes("--quiet") || args.includes("--exit-code"))
    ? 1
    : 0;
}

function writeCompactListError(error: unknown): void {
  const filter = createDelegatedErrorFilter((text) => stderr.write(text));
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  filter.push(`mcp list: ${message.endsWith("\n") ? message : `${message}\n`}`);
  filter.flush();
}

const LIST_OPTIONS = {
  "all-parameters": { type: "boolean" },
  "exit-code": { type: "boolean" },
  "no-oauth": { type: "boolean" },
  quiet: { type: "boolean" },
  schema: { type: "boolean" },
  status: { type: "boolean" },
  timeout: { type: "string" },
  verbose: { type: "boolean" },
} as const;

export function compactListArgumentError(args: readonly string[]): string | undefined {
  try {
    const { positionals } = parseArgs({
      args: [...args.slice(1)],
      options: LIST_OPTIONS,
      allowPositionals: true,
    });
    // One target at most: a server, or a server.tool.
    if (positionals.length > 1) {
      return `Unexpected mcp list argument '${positionals[1]}'.`;
    }
    return undefined;
  } catch {
    const unknown = args
      .slice(1)
      .find((arg) => arg.startsWith("-") && !(optionName(arg).slice(2) in LIST_OPTIONS));
    // No unknown option means a trailing `--timeout`, which parseListTimeoutMs
    // reports with the message that names the value it wanted.
    return unknown ? `Unknown mcp list option '${unknown}'.` : undefined;
  }
}

async function compactList(args: string[]): Promise<number> {
  if (args.includes("--json")) {
    stderr.write("mcp list metadata is compact text; JSON is reserved for tool results.\n");
    return 2;
  }
  const argumentError = compactListArgumentError(args);
  if (argumentError) {
    stderr.write(`${argumentError}\n`);
    return 2;
  }
  const target = args[1] && !args[1].startsWith("-") ? args[1] : undefined;
  const schema = args.includes("--schema");
  const status = args.includes("--status");
  const verbose = args.includes("--verbose");
  const allParameters = args.includes("--all-parameters");
  const quiet = args.includes("--quiet");
  const timeout = parseListTimeoutMs(args);
  if (typeof timeout === "string") {
    stderr.write(`${timeout}\n`);
    return 2;
  }
  if (schema && !target) {
    stderr.write("mcp list --schema requires one exact tool: mcp list <server>.<tool> --schema\n");
    return 2;
  }
  const session = await readSession();
  if (!target) {
    const { runtime, owned } = await acquireRuntime();
    try {
      const results = await Promise.all(
        session.servers.map(async (server) => {
          try {
            const tools = await discoverServerCatalog(runtime, server, timeout);
            return { server, tools } as const;
          } catch (error) {
            return { server, error } as const;
          }
        })
      );
      let hadFailure = false;
      for (const result of results) {
        if ("error" in result) {
          hadFailure = true;
          if (!quiet) stdout.write(`${result.server.id} — unavailable\n`);
        } else if (!quiet) {
          stdout.write(
            `${result.server.id} — ${toolCount(result.tools.length)}\n`
          );
        }
      }
      return aggregateListExitCode(hadFailure, args);
    } finally {
      await closeOwnedRuntime(runtime, owned);
    }
  }
  const exact = exactToolTarget(target);
  const server = exact?.server ?? target;
  if (schema && !exact) {
    stderr.write("mcp list --schema requires one exact tool: mcp list <server>.<tool> --schema\n");
    return 2;
  }
  const { runtime, owned } = await acquireRuntime();
  try {
    const sessionServer = session.servers.find((entry) => entry.id === server);
    if (!sessionServer) {
      stderr.write(`MCP server '${server}' is not available in this session.\n`);
      return 1;
    }
    const catalog = await discoverServerCatalog(runtime, sessionServer, timeout);
    const tools = catalog.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
      outputSchema: tool.output_schema,
      annotations: tool.annotations,
    })) as ContractTool[];
    if (quiet) return 0;
    if (status) {
      stdout.write(`${server} ok — ${toolCount(tools.length)}\n`);
      return 0;
    }
    const selected = exact ? tools.filter((tool) => tool.name === exact.tool) : tools;
    if (exact && selected.length === 0) {
      stderr.write(`Tool '${exact.tool}' is not available on server '${server}'.\n`);
      return 1;
    }
    if (schema && exact) {
      const tool = selected[0];
      if (!tool) return 1;
      const outputSchema =
        tool.outputSchema ?? catalogOutputSchema(catalogTool(
          { ...session, servers: session.servers.map((entry) =>
            entry.id === server ? { ...entry, catalog } : entry
          ) },
          server,
          exact.tool
        ));
      stdout.write(
        renderToolContract(
          server,
          { ...tool, outputSchema },
          { verboseDescriptions: verbose }
        )
      );
      return 0;
    }
    for (const tool of selected) {
      stdout.write(`${renderToolSignature(server, tool, { allParameters })}\n`);
      if (verbose && tool.description?.trim()) {
        stdout.write(`  ${tool.description.trim().replace(/\s+/g, " ")}\n`);
      }
    }
    return 0;
  } catch (error) {
    if (!quiet) writeCompactListError(error);
    return 1;
  } finally {
    await closeOwnedRuntime(runtime, owned);
  }
}

// Property names scripts and runtimes probe on plain objects; returning
// undefined keeps `await tools`, JSON.stringify, and inspection from throwing.
const PROXY_PROBE_PROPS = new Set(["then", "toJSON", "constructor", "inspect"]);

function normalizeName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function closestName(input: string, candidates: Iterable<string>): string | undefined {
  const normalizedInput = normalizeName(input);
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const score = levenshtein(normalizedInput, normalizeName(candidate));
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best === undefined) return undefined;
  const baseline = Math.max(normalizedInput.length, normalizeName(best).length, 1);
  return bestScore <= Math.max(2, Math.floor(baseline / 3)) ? best : undefined;
}

export function describeUnknownRunServer(server: string, servers: string[]): string {
  const suggestion = closestName(server, servers);
  const parts = [`Unknown MCP server '${server}'.`];
  if (suggestion) parts.push(`Did you mean 'tools.${suggestion}'?`);
  parts.push(
    servers.length > 0
      ? `Available servers: ${servers.join(", ")}.`
      : "No MCP servers are configured."
  );
  return parts.join(" ");
}

const RUN_TOOL_REJECTED_PATTERNS = [
  /\btool\s+[\w.-]+\s+not found\b/i,
  /\bunknown tool\b/i,
];
const RUN_TOOL_BLOCKED_PATTERN = /is not accessible on server '[^']+' \(blocked by configuration\)/;
const RUN_AUTH_REQUIRED_PATTERN =
  /\b(?:authentication required|unauthenticated|HTTP 401|missing (?:access )?token|invalid (?:access )?token|failed to resolve header ['"]Authorization)/i;

export function describeUnavailableRunTool(
  server: string,
  tool: string,
  knownTools: string[]
): string {
  const suggestion = closestName(tool, knownTools);
  const parts = [`Tool '${tool}' is not available on server '${server}'.`];
  if (suggestion) parts.push(`Did you mean '${suggestion}'?`);
  parts.push(`Run \`mcp list ${server}\` to see available tools.`);
  return parts.join(" ");
}

function improveRunToolError(
  error: unknown,
  server: string,
  tool: string,
  knownTools: string[]
): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (RUN_AUTH_REQUIRED_PATTERN.test(message)) {
    return new McpRemoteToolResultError({
      code: "authentication_required",
      message:
        `Authentication is required for MCP server '${server}'. ` +
        "Ask the user to authenticate this MCP connection outside the agent session, then retry.",
      retryable: false,
      action: "ask_user_to_authenticate",
    });
  }
  if (RUN_TOOL_BLOCKED_PATTERN.test(message)) {
    return new Error(
      `Tool '${tool}' is not enabled for server '${server}' in this session. ` +
        `Run \`mcp list ${server}\` to inspect the allowlist; if absent, the recipe configuration must grant it.`,
      { cause: error }
    );
  }
  if (!RUN_TOOL_REJECTED_PATTERNS.some((pattern) => pattern.test(message))) return error;
  return new Error(describeUnavailableRunTool(server, tool, knownTools), { cause: error });
}

async function createTools(opts: {
  callTimeoutMs: number;
  maxCalls: number;
  maxConcurrentCalls: number;
  deadlineMs: number;
}) {
  const { runtime, owned } = await acquireRuntime();
  const session = await readSession();
  const knownTools = new Map<string, string[]>();
  await Promise.all(
    session.servers.map(async (server) => {
      knownTools.set(
        server.id,
        (await readCachedCatalog(server))?.map((tool) => tool.name) ?? []
      );
    })
  );
  // The static session policy is the authority. The mcporter config is a
  // transport projection, not another capability source, so extra config
  // entries must never appear on the run proxy.
  const configuredServers = new Set(runtime.listServers());
  const servers = session.servers.filter((server) =>
    configuredServers.has(server.id)
  );
  const calls: ToolCallRecord[] = [];
  let callCount = 0;
  const queue = new ToolCallQueue(opts.maxConcurrentCalls);
  const toolsByServer: Record<
    string,
    Record<string, McpRunToolFunction>
  > = Object.create(null);
  for (const serverPolicy of servers) {
    const server = serverPolicy.id;
    toolsByServer[server] = new Proxy(Object.create(null), {
      get(_target, property) {
        if (typeof property !== "string" || PROXY_PROBE_PROPS.has(property)) return undefined;
        const startCall = (
          args: Record<string, unknown>,
          format: McpRunResultFormat
        ): Promise<unknown> => {
          validateRunToolArgs(server, property, args);
          const allowedToolNames = knownTools.get(server) ?? [];
          if (!mcpSessionAllowsTool(serverPolicy, property)) {
            throw new McpRunToolError(
              server,
              property,
              describeUnavailableRunTool(server, property, allowedToolNames)
            );
          }
          if (callCount >= opts.maxCalls) {
            throw new McpRunUsageError(
              `mcp run tool-call limit exceeded (${opts.maxCalls}). Split the workflow or raise PI_RECIPES_MCP_RUN_MAX_CALLS.`
            );
          }
          callCount += 1;
          const rawCall = (async () => {
            let release: (() => void) | undefined;
            try {
              release = await queue.acquire();
              const remainingMs = opts.deadlineMs - Date.now();
              if (remainingMs <= 0) {
                throw new McpRunTimeoutError(
                  `mcp run deadline reached before ${server}.${property} started.`
                );
              }
              const result = checkedCallResult(
                createCallResult(
                  await runtime.callTool(server, property, {
                    args,
                    // A queued call must never outlive the workflow that owns
                    // it. mcporter forwards this timeout to the MCP SDK and
                    // resets the transport when it fires.
                    timeoutMs: Math.min(opts.callTimeoutMs, remainingMs),
                    disableOAuth: true,
                  })
                )
              );
              return decodeCallResult(result, format, `${server}.${property}`);
            } catch (error) {
              const improved = improveRunToolError(
                error,
                server,
                property,
                allowedToolNames ?? []
              );
              if (improved instanceof McpRunUsageError) throw improved;
              const message = improved instanceof Error ? improved.message : String(improved);
              const remoteDetails =
                improved instanceof McpRemoteToolResultError
                  ? improved.details
                  : error instanceof McpRemoteToolResultError
                    ? error.details
                    : undefined;
              const timeoutDetails =
                !remoteDetails &&
                (improved instanceof McpRunTimeoutError ||
                  /\b(?:timed?\s*out|timeout)\b/i.test(message))
                  ? {
                      code: "timeout",
                      message:
                        improved instanceof McpRunTimeoutError
                          ? message
                          : `MCP tool call ${server}.${property} timed out.`,
                      retryable: true,
                      action: "inspect_state",
                      outcome:
                        improved instanceof McpRunTimeoutError ? "not_started" : "unknown",
                    }
                  : undefined;
              throw new McpRunToolError(
                server,
                property,
                remoteDetails?.message ?? timeoutDetails?.message ?? message,
                { cause: improved, details: remoteDetails ?? timeoutDetails }
              );
            } finally {
              release?.();
            }
          })();
          const record: ToolCallRecord = {
            ref: `${server}.${property}`,
            observed: false,
            outcome: "pending",
            promise: rawCall,
          };
          calls.push(record);
          rawCall.then(
            () => {
              record.outcome = "succeeded";
            },
            (error: unknown) => {
              record.outcome = "failed";
              record.error = error instanceof Error ? error.message : String(error);
            }
          );
          // JSON.stringify(promise) is "{}" — the classic missing-await
          // symptom. Make it print a diagnosis instead.
          return new Proxy(rawCall, {
            get(target, key) {
              if (key === "toJSON") {
                return () => `[pending tool call ${server}.${property} — did you forget await?]`;
              }
              if (key === "then" || key === "catch" || key === "finally") {
                record.observed = true;
              }
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        };

        const tool = ((args: Record<string, unknown> = {}) =>
          startCall(args, "json")) as McpRunToolFunction;
        tool.text = (args: Record<string, unknown> = {}) => startCall(args, "text");
        tool.markdown = (args: Record<string, unknown> = {}) => startCall(args, "markdown");
        tool.images = (args: Record<string, unknown> = {}) => startCall(args, "images");
        tool.content = (args: Record<string, unknown> = {}) => startCall(args, "content");
        tool.structuredContent = (args: Record<string, unknown> = {}) =>
          startCall(args, "structuredContent");
        tool.raw = (args: Record<string, unknown> = {}) => startCall(args, "raw");
        return tool;
      },
    }) as Record<string, McpRunToolFunction>;
  }
  // Fail with a clear message when a script names a server that does not
  // exist, instead of "Cannot read properties of undefined".
  const tools = new Proxy(toolsByServer, {
    get(target, property) {
      if (typeof property !== "string" || PROXY_PROBE_PROPS.has(property)) return undefined;
      if (property in target) return target[property];
      throw new Error(
        describeUnknownRunServer(
          property,
          servers.map((server) => server.id)
        )
      );
    },
  });
  return {
    runtime,
    owned,
    tools,
    calls,
    cancelQueued: (error: unknown) => queue.cancel(error),
  };
}

// vars.TYPO silently becomes undefined, which strips the argument it feeds
// and can turn a targeted query into a match-everything one. Throw instead.
function createVars(vars: Record<string, string>): Record<string, string> {
  return new Proxy({ ...vars }, {
    get(target, property) {
      if (typeof property !== "string" || PROXY_PROBE_PROPS.has(property)) return undefined;
      if (property in target) return target[property as keyof typeof target];
      const defined = Object.keys(target);
      throw new Error(
        `vars.${property} is not defined. Pass it with --var ${property}=value` +
          (defined.length > 0 ? ` (defined vars: ${defined.join(", ")}).` : " (no vars were passed).") +
          ` Use \`"${property}" in vars\` to test for optional vars.`
      );
    },
  });
}

function createRunProcess(): NodeJS.Process {
  return new Proxy(globalThis.process, {
    get(target, property) {
      if (property === "argv") {
        throw new McpRunUsageError(
          "process.argv is unavailable in mcp run. Pass dynamic values with --var KEY=value and read them as vars.KEY."
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function concurrentOutcomeError(
  error: McpRunToolError,
  calls: ToolCallRecord[]
): McpRunToolError {
  if (calls.length < 2) return error;
  const outcomes = calls.map((call) => ({
    ref: call.ref,
    outcome: call.outcome,
    ...(call.error ? { error: call.error } : {}),
  }));
  const summary = outcomes.map((call) => `${call.ref}=${call.outcome}`).join(", ");
  const message = `${error.message} Workflow call outcomes: ${summary}. Inspect state before retrying side-effecting calls.`;
  return new McpRunToolError(error.server, error.tool, message, {
    cause: error,
    details: { ...error.details, message, calls: outcomes },
  });
}

function positiveInteger(
  value: number | string | undefined,
  label: string,
  fallback: number
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new McpRunUsageError(`${label} expects a positive integer, got '${value ?? ""}'.`);
  }
  return parsed;
}

export async function runMcpJavaScript(
  code: string,
  opts: {
    timeoutMs?: number;
    callTimeoutMs?: number;
    maxCalls?: number;
    maxConcurrentCalls?: number;
    vars?: Record<string, string>;
  } = {}
): Promise<void> {
  const timeoutMs = positiveInteger(
    opts.timeoutMs ?? process.env.PI_RECIPES_MCP_RUN_TIMEOUT_MS,
    "PI_RECIPES_MCP_RUN_TIMEOUT_MS",
    DEFAULT_RUN_TIMEOUT_MS
  );
  const callTimeoutMs = positiveInteger(
    opts.callTimeoutMs ?? process.env.PI_RECIPES_MCP_RUN_CALL_TIMEOUT_MS,
    "PI_RECIPES_MCP_RUN_CALL_TIMEOUT_MS",
    Math.min(DEFAULT_TOOL_CALL_TIMEOUT_MS, timeoutMs)
  );
  const maxCalls = positiveInteger(
    opts.maxCalls ?? process.env.PI_RECIPES_MCP_RUN_MAX_CALLS,
    "PI_RECIPES_MCP_RUN_MAX_CALLS",
    DEFAULT_MAX_RUN_TOOL_CALLS
  );
  const maxConcurrentCalls = positiveInteger(
    opts.maxConcurrentCalls ?? process.env.PI_RECIPES_MCP_RUN_MAX_CONCURRENCY,
    "PI_RECIPES_MCP_RUN_MAX_CONCURRENCY",
    DEFAULT_MAX_CONCURRENT_TOOL_CALLS
  );
  const deadlineMs = Date.now() + timeoutMs;
  const { runtime, owned, tools, calls, cancelQueued } = await createTools({
    callTimeoutMs,
    maxCalls,
    maxConcurrentCalls,
    deadlineMs,
  });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (tools: unknown, vars: Record<string, string>, process: NodeJS.Process) => Promise<unknown>;
  const run = new AsyncFunction("tools", "vars", "process", code);
  let timeout: NodeJS.Timeout | undefined;
  let primaryError: unknown;
  try {
    let scriptError: unknown;
    try {
      await Promise.race([
        run(tools, createVars(opts.vars ?? {}), createRunProcess()),
        new Promise((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new McpRunTimeoutError(
                `mcp run timed out after ${timeoutMs}ms. Remote side effects may already have occurred; inspect state before retrying.`
              )
            );
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      scriptError = error;
    }

    // A workflow deadline is also the cancellation boundary. mcporter 0.12.3
    // does not expose an AbortSignal, but it does forward each effective
    // timeout to the MCP SDK. Cancel calls that have not started, then close
    // the runtime in finally to tear down active transports.
    if (scriptError instanceof McpRunTimeoutError) {
      cancelQueued(scriptError);
      for (const call of calls) {
        if (call.outcome === "pending") call.outcome = "outcome_unknown";
      }
      throw scriptError;
    }

    // Accessing .then/.catch is not proof that a detached chain was awaited.
    // Anything still pending when the script returns is unsafe even if a
    // handler was attached, because closing the runtime can cut it off.
    const unsafeAtExit = calls.filter(
      (call) => !call.observed || call.outcome === "pending"
    );
    if (unsafeAtExit.length > 0) {
      const remainingSettleMs = Math.max(0, Math.min(15_000, deadlineMs - Date.now()));
      if (remainingSettleMs > 0) {
        let settleTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            Promise.allSettled(unsafeAtExit.map((call) => call.promise)),
            new Promise((resolve) => {
              settleTimer = setTimeout(resolve, remainingSettleMs);
            }),
          ]);
        } finally {
          if (settleTimer) clearTimeout(settleTimer);
        }
      }
      for (const call of unsafeAtExit) {
        if (call.outcome === "pending") call.outcome = "outcome_unknown";
      }
      // Promise.all rejects as soon as one member fails, while its already-
      // observed siblings keep running. We wait those siblings above before
      // closing the transport. Once they have settled, do not misreport them
      // as detached calls; surface the original tool error instead.
      const remainingUnsafe = unsafeAtExit.filter(
        (call) => !call.observed || call.outcome === "outcome_unknown"
      );
      if (
        scriptError instanceof McpRunToolError &&
        remainingUnsafe.length === 0
      ) {
        throw concurrentOutcomeError(scriptError, calls);
      }
      const summary = unsafeAtExit
        .map(
          (call) =>
            `${call.ref}=${call.outcome}` +
            (call.error ? ` (${call.error})` : "")
        )
        .join(", ");
      throw new McpRunUsageError(
        `mcp run: ${unsafeAtExit.length} tool call(s) were not awaited: ${summary}. ` +
          "Await or return every tool-call chain before the script exits; " +
          "attaching .then/.catch without awaiting the chain is not enough. " +
          "Remote side effects may already have occurred." +
          (scriptError
            ? ` The script also failed: ${scriptError instanceof Error ? scriptError.message : String(scriptError)}.`
            : "")
      );
    }
    if (scriptError) throw scriptError;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    try {
      await closeOwnedRuntime(runtime, owned);
    } catch (closeError) {
      // Transport cleanup must not replace the typed tool/script error that
      // tells the agent what actually failed. A close-only failure still
      // surfaces normally.
      if (primaryError === undefined) throw closeError;
    }
  }
}

// The soft timeout in runMcpJavaScript is a Promise.race, which a script that
// never yields (a synchronous busy-loop) starves forever. Worker threads run
// their own event loop, so a watchdog there can still fire and kill the
// process with a diagnostic once the deadline plus a grace period passes.
const RUN_WATCHDOG_GRACE_MS = 2_000;

function startRunWatchdog(timeoutMs: number): () => void {
  const worker = new Worker(
    `const { workerData } = require("node:worker_threads");
     const { writeSync } = require("node:fs");
     setTimeout(() => {
       writeSync(
         2,
         "mcp run: killed after " + workerData.limitMs + "ms. The script never yielded " +
           "(synchronous busy-loop?) or ignored the timeout. Use await inside loops and " +
           "set PI_RECIPES_MCP_RUN_TIMEOUT_MS to adjust the limit. Remote side effects " +
           "may already have occurred; inspect state before retrying.\\n"
       );
       process.kill(process.pid, "SIGKILL");
     }, workerData.limitMs);`,
    { eval: true, workerData: { limitMs: timeoutMs + RUN_WATCHDOG_GRACE_MS } }
  );
  worker.unref();
  return () => void worker.terminate();
}

async function runCode(args: string[]): Promise<number> {
  const vars: Record<string, string> = {};
  const positional: string[] = [];
  let jsonErrors = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json-errors") {
      jsonErrors = true;
      continue;
    }
    const inline = arg.startsWith("--var=") ? arg.slice("--var=".length) : undefined;
    const value = inline ?? (arg === "--var" ? args[++index] : undefined);
    if (arg === "--var" || inline !== undefined) {
      const eq = value?.indexOf("=") ?? -1;
      if (value === undefined || eq < 1) {
        stderr.write("--var expects KEY=value.\n");
        return 2;
      }
      vars[value.slice(0, eq)] = value.slice(eq + 1);
      continue;
    }
    positional.push(arg);
  }
  const file = positional[0];
  if (positional.length > 1) {
    stderr.write("mcp run accepts at most one file path.\n");
    return 2;
  }
  const code = file ? await readFile(file, "utf8") : await readStdin();
  if (!code.trim()) {
    stderr.write(
      "mcp run: empty script. Pass a file path or pipe JavaScript on stdin (see `mcp run --help`).\n"
    );
    return 2;
  }
  let timeoutMs: number;
  try {
    timeoutMs = positiveInteger(
      process.env.PI_RECIPES_MCP_RUN_TIMEOUT_MS,
      "PI_RECIPES_MCP_RUN_TIMEOUT_MS",
      DEFAULT_RUN_TIMEOUT_MS
    );
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  // Daemon-backed runs execute inside a disposable worker. The daemon owns
  // that worker's hard deadline, so a synchronous loop cannot kill the shared
  // MCP host process.
  const stopWatchdog = isMainThread ? startRunWatchdog(timeoutMs) : () => {};
  try {
    await runMcpJavaScript(code, { vars, timeoutMs });
  } catch (error) {
    // Keep the error class visible for non-generic failures (SyntaxError,
    // TypeError, ...) so script bugs read differently from tool failures.
    const message =
      error instanceof Error
        ? error.name === "Error"
          ? error.message
          : `${error.name}: ${error.message}`
        : String(error);
    const prefixed = message.startsWith("mcp run") ? message : `mcp run: ${message}`;
    const code = error instanceof McpRunUsageError ? 2 : 1;
    if (jsonErrors) {
      const remoteDetails = error instanceof McpRunToolError ? error.details : undefined;
      stderr.write(
        `${JSON.stringify({
          error: {
            ...remoteDetails,
            code:
              remoteDetails?.code ??
              (error instanceof McpRunUsageError
                ? "invalid_usage"
                : error instanceof McpRunToolError
                  ? "tool_execution"
                  : error instanceof McpRunTimeoutError
                    ? "timeout"
                    : "script_failure"),
            message: remoteDetails?.message ?? prefixed,
            retryable: remoteDetails?.retryable ?? false,
            action:
              remoteDetails?.action ??
              (error instanceof McpRunUsageError
                ? "correct_script"
                : error instanceof McpRunTimeoutError
                  ? "inspect_state"
                  : "inspect_error"),
            ...(error instanceof McpRunTimeoutError
              ? { outcome: error.outcome }
              : {}),
            ...(error instanceof McpRunToolError
              ? { server: error.server, tool: error.tool }
              : {}),
          },
        })}\n`
      );
    } else {
      stderr.write(`${prefixed}\n`);
    }
    return code;
  } finally {
    stopWatchdog();
  }
  return 0;
}

export function createDelegatedErrorFilter(write: (text: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = "";
  let sawOAuthMetadataError = false;
  const emit = (line: string) => {
    // Keep mcporter's message, but omit implementation stack frames that do
    // not help an agent recover.
    if (/^\s+at\s\S/.test(line)) return;
    if (/trying to load OAuth metadata/.test(line)) sawOAuthMetadataError = true;
    const safe = line
      .replace(
        /Tool '([^']+)' is not accessible on server '([^']+)' \(blocked by configuration\)/g,
        "Tool '$1' is not enabled on server '$2' in this recipe session"
      )
      .replace(
        /Failed to resolve header 'Authorization' for server '([^']+)': Environment variable\(s\) [A-Z0-9_, ]+ must be set for MCP header substitution\./g,
        "Authentication is required for MCP server '$1'. Ask the user to authenticate this MCP connection outside the agent session, then retry."
      )
      .replace(
        /Next: run ['`]mcporter auth [^'`]+['`] to finish authentication\.?/gi,
        "Authentication is required. Ask the user to authenticate this MCP connection outside the agent session, then retry."
      );
    write(safe);
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        emit(buffer.slice(0, index + 1));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer) emit(buffer);
      buffer = "";
      if (sawOAuthMetadataError) {
        write(
          "Hint: this server is called with a configured bearer token; the token may be invalid or expired.\n"
        );
        sawOAuthMetadataError = false;
      }
    },
  };
}

export function duplicateCallArgumentKeys(args: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const token of args.slice(1)) {
    const rawKey = token.match(/^([A-Za-z_][A-Za-z0-9_.-]*)=/)?.[1];
    if (!rawKey) continue;
    const key = rawKey.replace(
      /-([a-zA-Z0-9])/g,
      (_match, char: string) => char.toUpperCase()
    );
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

export function callJsonArgumentError(args: readonly string[]): string | null {
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      const value = args[index + 1];
      if (value === undefined || (value.startsWith("--") && value !== "-")) {
        return `mcp call: ${arg} expects a JSON object or - for stdin. Example: mcp call server.tool --json '{"tags":["a","b"]}'`;
      }
      index += 1;
      continue;
    }
    if (arg === "--json=") {
      return `mcp call: ${arg.slice(0, -1)} expects a JSON object or - for stdin.`;
    }
  }
  return null;
}

export function malformedCallExpression(args: string[]): string | null {
  const ref = args.find((arg) => !arg.startsWith("-"));
  if (!ref || !/[()]/.test(ref)) return null;
  return (
    `mcp call: function-call expressions are unavailable. ` +
    `Use mcp call <server>.<tool> key=value or --json for structured arguments.`
  );
}

async function callWithMcporter(args: string[]): Promise<number> {
  const shared = currentMcpCommandContext()?.runtime;
  if (shared) return callWithSharedRuntime(shared, args);
  const previousDisableAutorun = process.env.MCPORTER_DISABLE_AUTORUN;
  const previousExitCode = process.exitCode;
  process.env.MCPORTER_DISABLE_AUTORUN = "1";
  process.exitCode = undefined;

  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let owned = false;
  try {
    ({ runtime, owned } = await acquireRuntime());
    const { handleCall } = await loadMcporterCli();
    await handleCall(runtime, args);
    return process.exitCode ?? 0;
  } finally {
    process.exitCode = previousExitCode;
    if (previousDisableAutorun === undefined) {
      delete process.env.MCPORTER_DISABLE_AUTORUN;
    } else {
      process.env.MCPORTER_DISABLE_AUTORUN = previousDisableAutorun;
    }
    if (runtime && owned) await runtime.close().catch(() => {});
  }
}

async function callWithSharedRuntime(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  args: string[]
): Promise<number> {
  const selector = args[0];
  const separator = selector?.indexOf(".") ?? -1;
  if (!selector || separator <= 0 || separator === selector.length - 1) {
    stderr.write("mcp call requires <server>.<tool>.\n");
    return 2;
  }
  const server = selector.slice(0, separator);
  const tool = selector.slice(separator + 1);
  const normalizedArgs = [...args];
  for (let index = 1; index < normalizedArgs.length; index += 1) {
    let token = normalizedArgs[index]!;
    const equals = token.indexOf("=");
    if (equals > 0 && !token.startsWith("--")) {
      const rawValue = token.slice(equals + 1);
      try {
        const decoded = JSON.parse(rawValue);
        if (typeof decoded === "string") {
          token = `${token.slice(0, equals + 1)}${decoded}`;
          normalizedArgs[index] = token;
        }
      } catch {
        // Ordinary key=value text is not JSON and needs no normalization.
      }
    }
    for (const flag of ["--json", "--timeout", "--output"]) {
      if (token.startsWith(`${flag}=`)) {
        normalizedArgs.splice(index, 1, flag, token.slice(flag.length + 1));
        break;
      }
    }
    if (normalizedArgs[index] === "--json" && normalizedArgs[index + 1] === "-") {
      normalizedArgs[index + 1] = await readStdin();
    }
  }

  try {
    const { parseCallArguments, resolveCallTimeout } = await loadMcporterCli();
    const parsed = parseCallArguments(normalizedArgs);
    const timeoutMs = resolveCallTimeout(parsed.timeoutMs);
    const values = await restoreSchemaStringArguments(
      runtime,
      server,
      tool,
      parsed.args,
      parsed.schemaStringCoercionCandidates,
      timeoutMs
    );
    const call = runtime.callTool(server, tool, {
      args: values,
      timeoutMs,
      disableOAuth: true,
    });
    const signal = currentMcpCommandContext()?.signal;
    let cancelled: (() => void) | undefined;
    const raw = signal
      ? await Promise.race([
          call,
          new Promise<never>((_resolve, reject) => {
            cancelled = () => reject(new Error("MCP command cancelled."));
            if (signal.aborted) cancelled();
            else signal.addEventListener("abort", cancelled, { once: true });
          }),
        ]).finally(() => {
          if (cancelled) signal.removeEventListener("abort", cancelled);
        })
      : await call;
    const result = createCallResult(raw);
    const rendered = selectCallOutput(result, raw, parsed.output);
    const serialized = serializeCallOutput(rendered, parsed.output);
    const configuredLimit = process.env.PI_RECIPES_MCP_MAX_OUTPUT_BYTES;
    if (configuredLimit !== undefined) {
      const limit = Number(configuredLimit);
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        stderr.write("PI_RECIPES_MCP_MAX_OUTPUT_BYTES must be a positive integer.\n");
        return 2;
      }
      const size = Buffer.byteLength(serialized, "utf8");
      if (size > limit) {
        stderr.write(
          `MCP result is ${size} bytes, exceeding PI_RECIPES_MCP_MAX_OUTPUT_BYTES=${limit}. ` +
            "Use tool pagination or a narrower field projection.\n"
        );
        return 1;
      }
    }
    stdout.write(`${serialized}\n`);
    return asRecord(raw).isError === true ? 1 : 0;
  } catch (error) {
    stderr.write(`${describeSharedCallError(error, server, tool)}\n`);
    return 1;
  }
}

type CallOutputKind = "json" | "markdown" | "text" | "raw";
type CallOutputFormat = CallOutputKind | "auto";

interface SelectedCallOutput {
  kind: CallOutputKind;
  value: unknown;
}

function selectCallOutput(
  result: CallResult,
  raw: unknown,
  format: CallOutputFormat
): SelectedCallOutput {
  const preferred: Record<CallOutputFormat, CallOutputKind[]> = {
    auto: ["json", "markdown", "text", "raw"],
    text: ["text", "markdown", "json", "raw"],
    markdown: ["markdown", "text", "json", "raw"],
    json: ["json", "raw"],
    raw: ["raw"],
  };
  for (const kind of preferred[format]) {
    if (kind === "json") {
      const value = result.json();
      if (value !== null) return { kind, value };
    } else if (kind === "markdown") {
      const value = result.markdown();
      if (typeof value === "string") return { kind, value };
    } else if (kind === "text") {
      const value = result.text();
      if (typeof value === "string") return { kind, value };
    } else {
      return { kind, value: raw };
    }
  }
  return { kind: "raw", value: raw };
}

function jsonString(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function serializeCallOutput(
  selected: SelectedCallOutput,
  requested: CallOutputFormat
): string {
  if (selected.kind === "markdown" || selected.kind === "text") {
    return String(selected.value);
  }
  if (selected.kind === "json") {
    return jsonString(selected.value) ?? String(selected.value);
  }
  if (requested === "json") {
    return jsonString(selected.value) ?? JSON.stringify(String(selected.value));
  }
  if (typeof selected.value === "string") return selected.value;
  if (selected.value === null) return "null";
  if (selected.value === undefined) return "undefined";
  if (
    typeof selected.value === "bigint" ||
    typeof selected.value === "symbol" ||
    typeof selected.value === "function"
  ) {
    return selected.value.toString();
  }
  return inspect(selected.value, {
    depth: 8,
    maxStringLength: null,
    breakLength: 80,
  });
}

function describeSharedCallError(
  error: unknown,
  server: string,
  tool: string
): string {
  const issue = describeConnectionIssue(error);
  if (issue.kind === "auth") {
    return (
      `Authentication is required for MCP server '${server}'. ` +
      "Ask the user to authenticate this MCP connection outside the agent session, then retry."
    );
  }
  if (issue.kind === "offline") {
    return `MCP server '${server}' appears offline: ${issue.rawMessage}`;
  }
  if (issue.kind === "http") {
    return (
      `MCP call ${server}.${tool} failed with HTTP ${issue.statusCode ?? "error"}: ` +
      issue.rawMessage
    );
  }
  if (issue.kind === "stdio-exit") {
    const exit =
      typeof issue.stdioExitCode === "number"
        ? `code ${issue.stdioExitCode}`
        : "an unknown status";
    const signal = issue.stdioSignal ? ` (signal ${issue.stdioSignal})` : "";
    return `MCP server '${server}' exited with ${exit}${signal}.`;
  }
  return issue.rawMessage || (error instanceof Error ? error.message : String(error));
}

function schemaAllowsString(value: unknown): boolean {
  const schema = asRecord(value);
  if (!schema) return false;
  if (schema.type === "string") return true;
  if (Array.isArray(schema.type) && schema.type.includes("string")) return true;
  return ["anyOf", "oneOf", "allOf"].some((key) => {
    const branches = schema[key];
    return Array.isArray(branches) && branches.some(schemaAllowsString);
  });
}

async function loadCallInputSchema(
  runtime: McpRuntime,
  server: string,
  tool: string,
  timeoutMs: number
): Promise<Record<string, unknown> | undefined> {
  let cache = callCatalogCache.get(runtime);
  if (!cache) {
    cache = new Map();
    callCatalogCache.set(runtime, cache);
  }
  let pending = cache.get(server);
  if (!pending) {
    pending = (async () => {
      const sessionServer = (await readSession()).servers.find(
        (entry) => entry.id === server
      );
      if (!sessionServer) return [];
      return discoverServerCatalog(
        runtime,
        sessionServer,
        DEFAULT_LIST_TIMEOUT_MS
      );
    })();
    cache.set(server, pending);
    void pending.catch(() => {
      if (cache?.get(server) === pending) cache.delete(server);
    });
  }
  const catalog = await withListTimeout(pending, timeoutMs).catch(
    () => undefined
  );
  return catalog?.find((entry) => entry.name === tool)?.input_schema;
}

async function restoreSchemaStringArguments(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  server: string,
  tool: string,
  values: Record<string, unknown>,
  candidates: Record<string, string> | undefined,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  if (!candidates || Object.keys(candidates).length === 0) return values;
  const inputSchema = await loadCallInputSchema(
    runtime,
    server,
    tool,
    timeoutMs
  );
  const properties = asRecord(inputSchema?.properties);
  if (!properties) return values;

  let corrected: Record<string, unknown> | undefined;
  for (const [key, rawValue] of Object.entries(candidates)) {
    if (typeof values[key] !== "number" || !schemaAllowsString(properties[key])) {
      continue;
    }
    corrected ??= { ...values };
    corrected[key] = rawValue;
  }
  return corrected ?? values;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (
    args.length === 0 ||
    args[0] === "--help" ||
    args[0] === "-h" ||
    (args[0] === "help" && args.length === 1)
  ) {
    stdout.write(`${mcpCliHelpText()}\n`);
    return 0;
  }
  if (args[0] === "search" && isHelpArg(args[1])) {
    stdout.write(`${mcpSearchHelpText()}\n`);
    return 0;
  }
  if (args[0] === "list" && args.slice(1).some(isHelpArg)) {
    stdout.write(`${mcpListHelpText()}\n`);
    return 0;
  }
  if (args[0] === "call" && args.slice(1).some(isHelpArg)) {
    stdout.write(`${mcpCallHelpText()}\n`);
    return 0;
  }
  if (args[0] === "run" && isHelpArg(args[1])) {
    stdout.write(`${mcpRunHelpText()}\n`);
    return 0;
  }
  pinSessionMcporterConfig();
  if (args[0] === "run") return runCode(args.slice(1));
  if (args[0] === "search") return searchCatalog(args.slice(1));
  if (args[0] === "call") {
    const malformed = malformedCallExpression(args.slice(1));
    if (malformed) {
      stderr.write(`${malformed}\n`);
      return 2;
    }
    const jsonArgumentError = callJsonArgumentError(args.slice(1));
    if (jsonArgumentError) {
      stderr.write(`${jsonArgumentError}\n`);
      return 2;
    }
  }
  let validated;
  try {
    validated = validateDelegatedMcpCommand(args, await sessionCliPolicy());
  } catch (error) {
    stderr.write(`mcp: failed to load the session MCP policy: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (validated.error) {
    stderr.write(`mcp: ${validated.error}\n`);
    return 2;
  }
  if (!validated.command) {
    stderr.write("mcp: invalid session command policy result.\n");
    return 1;
  }
  if (args[0] === "call") {
    const duplicates = duplicateCallArgumentKeys(
      validated.command.args.slice(1)
    );
    if (duplicates.length > 0) {
      stderr.write(
        `mcp call: argument${duplicates.length === 1 ? "" : "s"} ${duplicates
          .map((key) => `'${key}'`)
          .join(", ")} ${duplicates.length === 1 ? "was" : "were"} passed more than once. ` +
          "Pass each argument exactly once.\n"
      );
      return 2;
    }
  }
  const delegatedArgs = validated.command.args;
  if (delegatedArgs[0] === "list") return compactList(delegatedArgs);
  if (delegatedArgs[0] === "call") {
    return callWithMcporter(delegatedArgs.slice(1));
  }
  stderr.write(`mcp: command '${delegatedArgs[0]}' is unavailable in recipe sessions.\n`);
  return 2;
}

export async function executeMcpCommand(opts: {
  args: string[];
  runtime: McpRuntime;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  signal: AbortSignal;
}): Promise<number> {
  const context = {
    runtime: opts.runtime,
    stdin: opts.stdin,
    stdout: opts.stdout,
    stderr: opts.stderr,
    signal: opts.signal,
  };
  return runWithMcpCommandContext(context, () => main(opts.args));
}
