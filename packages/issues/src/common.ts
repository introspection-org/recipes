import type {
  IssuesErrorCode,
  IssuesErrorInfo,
  IssuesMcpCaller,
  IssuesMcpCallToolResult,
  IssuesMcpToolMapping,
  IssueStatusCategory,
} from "@introspection-ai/recipes/issues";

const STATUS_CATEGORIES: readonly string[] = [
  "open",
  "in_progress",
  "done",
  "cancelled",
];

/** A typed failure the host reports as is. */
export class IssuesError extends Error {
  readonly issues: IssuesErrorInfo;
  constructor(code: IssuesErrorCode, message: string) {
    super(message);
    this.name = "IssuesError";
    this.issues = { code, message };
  }
}

export function isStatusCategory(value: string): value is IssueStatusCategory {
  return STATUS_CATEGORIES.includes(value);
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The first non-empty string among `values`. */
export function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const found = text(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * A tool result's JSON: its `structuredContent`, else its text blocks parsed
 * as JSON. Text that is not JSON fails as `provider_error`.
 */
function resultJson(result: IssuesMcpCallToolResult, tool: string): unknown {
  if (
    result.structuredContent !== undefined &&
    result.structuredContent !== null
  )
    return result.structuredContent;
  const body = (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!body) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new IssuesError(
      "provider_error",
      `${tool} answered with text this provider cannot read as JSON`,
    );
  }
}

/** The list a result holds: the value itself, or the first of `keys` that is an array. */
export function listOf(value: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const object = record(value);
  for (const key of keys) {
    if (Array.isArray(object[key])) return object[key] as unknown[];
  }
  return [];
}

/**
 * The first of `candidates` the bound server offers, so one adapter serves
 * both a server's current and older tool names.
 */
function pickTool(
  mcp: IssuesMcpCaller | undefined,
  provider: string,
  candidates: readonly string[],
): string {
  if (!mcp)
    throw new IssuesError(
      "not_connected",
      `${provider}'s MCP server is not bound; ask a member to connect it with introspection_open`,
    );
  const tool = candidates.find((candidate) => mcp.hasTool(candidate));
  if (!tool)
    throw new IssuesError(
      "not_supported",
      `${provider}'s MCP server offers none of ${candidates.join(", ")}`,
    );
  return tool;
}

/** Call the first offered tool of `candidates` and return its JSON. */
export async function callJson(
  mcp: IssuesMcpCaller | undefined,
  provider: string,
  candidates: readonly string[],
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const tool = pickTool(mcp, provider, candidates);
  return resultJson(await mcp!.callTool(tool, args, signal), tool);
}

/** The tool names a map lists for one use. */
export function toolsFor(
  map: readonly IssuesMcpToolMapping[],
  use: IssuesMcpToolMapping["serves"][number],
): string[] {
  return map
    .filter((entry) => entry.serves.includes(use))
    .map((entry) => entry.tool);
}

/** A status category guessed from a status name, for a provider that reports only the name. */
export function categoryFromName(name: string): IssueStatusCategory {
  const lower = name.toLowerCase();
  if (/cancel|won'?t|reject|declin|duplicate/.test(lower)) return "cancelled";
  if (/done|complete|closed|resolved|shipped|merged/.test(lower)) return "done";
  if (/progress|review|started|doing|active|testing/.test(lower))
    return "in_progress";
  return "open";
}

/** How many pages one command follows before it stops, so a runaway list cannot hold a call open. */
export const MAX_PAGES = 20;

/** The cursor a list page names for the next one, or undefined when it says it is the last. */
export function nextCursor(answer: unknown): string | undefined {
  const page = record(answer);
  const info = record(page.pageInfo);
  const more = page.hasNextPage ?? info.hasNextPage;
  const cursor = firstText(page.cursor, page.nextCursor, info.endCursor);
  return more === true ? cursor : undefined;
}
