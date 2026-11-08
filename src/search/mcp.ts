import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { SpanKind, SpanStatusCode, type Tracer } from "@opentelemetry/api";

import { isPiMcpServerTool, mcpToolName } from "../mcp/pi-client.js";
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

/** What Pi says of a registered tool (`pi.getAllTools()`), enough to tell its MCP server. */
export type PiToolInfo = Pick<ToolInfo, "name" | "namespace">;

/**
 * The MCP client over Pi's built-in one: each server a Recipe binds on Pi's
 * client (`mcp.mode: codemode`, or any mode with `behind`) is connected in
 * the Pi process, and its tools are reachable as `mcpToolName(server, tool)`
 * through `ctx.executeTool`. `toolInfos` (the extension's `pi.getAllTools`)
 * confirms that a tool so named is the server's by Pi's namespace; without
 * it, the name alone decides. Pi returns the whole `CallToolResult` as the
 * nested call's `structuredContent`; a call Pi refuses (unknown tool,
 * blocked) has none.
 */
export function piSearchMcpClient(
  ctx: PiToolContext,
  toolInfos?: () => readonly PiToolInfo[],
): SearchMcpClient {
  return {
    hasTool(server, tool) {
      const name = mcpToolName(server, tool);
      if (!ctx.tools.some((candidate) => candidate.name === name)) return false;
      const info = toolInfos?.().find((candidate) => candidate.name === name);
      return info ? isPiMcpServerTool(info, server) : true;
    },
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
function mcpResultText(result: McpCallToolResult): string {
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
