import { createHash } from "node:crypto";

import { SpanKind, SpanStatusCode, type Tracer } from "@opentelemetry/api";

import { SearchProviderError } from "./types.js";

/** An MCP `CallToolResult`, without `_meta`: what a search provider's MCP tool answers. */
export interface McpCallToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * The MCP calls `web_search` makes: whether a bound server offers a tool,
 * and one call to it. Pi's built-in MCP client backs it in a session
 * ({@link piSearchMcpClient}); any other client, or a test, can too.
 */
export interface SearchMcpClient {
  hasTool(server: string, tool: string): boolean;
  callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallToolResult>;
}

// Pi's limit for a tool name, which its MCP tool names are shortened to.
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * The Pi tool name of an MCP tool: `mcp__<server>__<tool>`, every character
 * outside `[A-Za-z0-9_]` replaced by `_`, and a hash suffix past 64
 * characters. The same rule as `mcpToolName` in PR #375
 * (`src/mcp/pi-client.ts`), which this replaces once that lands.
 */
export function mcpToolName(serverId: string, toolName: string): string {
  const name = `mcp__${serverId}__${toolName}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
  const hash = createHash("sha256")
    .update(`${serverId}\0${toolName}`)
    .digest("hex")
    .slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/** The part of Pi's tool context `web_search` uses (`ExtensionToolContext`). */
export interface PiToolContext {
  readonly tools: readonly { name: string }[];
  executeTool(
    name: string,
    args: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<{
    isError: boolean;
    result: {
      content: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
    };
  }>;
}

/**
 * The MCP client over Pi's built-in one: each server a Recipe binds under
 * `mcp.mode: codemode` (PR #375) is connected in the Pi process, and its
 * tools are reachable as `mcp__<server>__<tool>` through `ctx.executeTool`.
 * Pi returns the whole `CallToolResult` as the nested call's
 * `structuredContent`; a call Pi refuses (unknown tool, blocked) has none.
 */
export function piSearchMcpClient(ctx: PiToolContext): SearchMcpClient {
  return {
    hasTool: (server, tool) =>
      ctx.tools.some(
        (candidate) => candidate.name === mcpToolName(server, tool),
      ),
    async callTool(server, tool, args, signal) {
      const outcome = await ctx.executeTool(
        mcpToolName(server, tool),
        args,
        signal ? { signal } : {},
      );
      const result = outcome.result.structuredContent as
        McpCallToolResult | undefined;
      if (result && typeof result === "object" && "content" in result)
        return result;
      const text = outcome.result.content
        .map((block) => block.text ?? "")
        .join(" ")
        .trim();
      throw new SearchProviderError({
        code: "unavailable",
        message: `MCP tool ${server}/${tool} could not be called${text ? `: ${text.slice(0, 200)}` : ""}`,
      });
    },
  };
}

/** The text of a result's text blocks, joined. */
export function mcpResultText(result: McpCallToolResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * One MCP tool call inside a client span, a child of the `web_search` span,
 * after the MCP semantic conventions (as the Google productivity provider
 * records its own). An `isError` result maps to `provider_error`.
 */
export async function tracedMcpCall(
  tracer: Tracer,
  client: SearchMcpClient,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpCallToolResult> {
  const span = tracer.startSpan(`tools/call ${tool}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      "mcp.method.name": "tools/call",
      "gen_ai.tool.name": tool,
      "search.mcp.server": server,
    },
  });
  try {
    const result = await client.callTool(server, tool, args, signal);
    if (result.isError) {
      span.setAttribute("error.type", "tool_error");
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw new SearchProviderError({
        code: "provider_error",
        message: `${server}/${tool} failed: ${mcpResultText(result).slice(0, 300) || "the tool reported an error"}`,
      });
    }
    return result;
  } catch (error) {
    if (!(
      error instanceof SearchProviderError &&
      error.search.code === "provider_error"
    )) {
      span.setAttribute(
        "error.type",
        error instanceof SearchProviderError ? error.search.code : "_OTHER",
      );
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    throw error;
  } finally {
    span.end();
  }
}
