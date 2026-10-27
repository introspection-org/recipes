import { createHash } from "node:crypto";

import type { JsonValue } from "vitest-evals";

type JsonObject = { [key: string]: JsonValue };

/** One tool call of a run, paired from Pi's `tool_execution_start` and `tool_execution_end`. */
export type ToolCall = {
  name: string;
  args: JsonObject;
  isError: boolean;
  /** The result's content as the agent got it. */
  content: JsonValue;
  /** The `structuredContent` the Recipes MCP wrapper keeps in the result's details, when an object. */
  structured?: JsonObject;
};

/**
 * One MCP server's call under the server's own tool name, with the text it answered and the
 * `structuredContent` of a tool that states an `outputSchema`: what mcp-fakes' `answered()` reads.
 */
export type ServerCall = {
  name: string;
  args: JsonObject;
  isError: boolean;
  response: string;
  structured?: JsonObject;
};

/**
 * The tool calls of a run's `piEvents` artifact, in the order they started. A call that never
 * ended, such as one cut off by a failed turn, is left out.
 */
export function piToolCalls(piEvents: unknown): ToolCall[] {
  const events = Array.isArray(piEvents)
    ? piEvents.flatMap((event: unknown) => {
        const value = object(event);
        return value ? [value] : [];
      })
    : [];
  // Subagent runs number their calls on their own, so a call is keyed by its run as well.
  const key = (event: Record<string, unknown>) =>
    `${String(object(event.run)?.id ?? "")}\0${String(event.toolCallId)}`;
  const ends = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (event.type === "tool_execution_end") ends.set(key(event), event);
  }
  return events.flatMap((start): ToolCall[] => {
    if (start.type !== "tool_execution_start") return [];
    const end = ends.get(key(start));
    if (!end) return [];
    const result = object(end.result);
    const structured = object(object(result?.details)?.structuredContent) as
      | JsonObject
      | undefined;
    return [{
      name: typeof start.toolName === "string" ? start.toolName : "",
      args: (object(start.args) ?? {}) as JsonObject,
      isError: end.isError === true,
      content: (result?.content ?? null) as JsonValue,
      ...(structured && { structured }),
    }];
  });
}

/**
 * One MCP server's calls among a run's tool calls. Pi names an MCP tool `mcp_<server>_<tool>`,
 * with characters outside `[A-Za-z0-9_-]` replaced, and may cut it short and append `_<10 hex>`,
 * a hash of the name. Given the server's `tools`, each call is named by the tool whose Pi name
 * it carries, and a call to no listed tool is left out; without them, the hash is stripped,
 * which recovers only a short name Pi did not have to replace characters of.
 */
export function serverCalls(
  calls: ToolCall[],
  server: string,
  tools?: readonly string[],
): ServerCall[] {
  const prefix = `mcp_${server}_`;
  const named =
    tools && new Map(tools.flatMap((tool) => piToolNames(server, tool).map((name) => [name, tool])));
  return calls.flatMap((call) => {
    const name = named
      ? named.get(call.name)
      : call.name.startsWith(prefix)
        ? call.name.slice(prefix.length).replace(/_[0-9a-f]{10}$/, "")
        : undefined;
    if (name === undefined) return [];
    const { args, isError, structured } = call;
    return [{
      name,
      args,
      isError,
      response: text(call.content),
      ...(structured && { structured }),
    }];
  });
}

// The names Pi gives a server's tool: hashed, and the readable form without the hash.
function piToolNames(server: string, tool: string): string[] {
  const digest = createHash("sha256").update(`${server}.${tool}`).digest("hex").slice(0, 10);
  const part = (value: string) =>
    value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "") || "tool";
  const readable = `mcp_${part(server)}_${part(tool)}`;
  return [`${readable.slice(0, 64 - digest.length - 1).replace(/_+$/, "")}_${digest}`, readable];
}

// The text of a result's text parts, joined.
function text(content: JsonValue): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => object(part))
    .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
