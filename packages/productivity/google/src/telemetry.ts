import {
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from "@opentelemetry/api";

import type { ProductivityToolCallOutcome } from "@introspection-ai/recipes/productivity";

import type { GoogleFetch, GoogleHttpResponse } from "./http.js";

const TRACER_NAME = "@introspection-ai/recipe-productivity-google";

/**
 * The attribute a response body is recorded under: the one the `execute_tool`
 * span carries a tool result in, which the Introspection processor seals on
 * whatever span holds it.
 */
export const RESPONSE_BODY_ATTRIBUTE = "gen_ai.tool.call.result";

/** The Google API method a request calls, by its discovery id, such as `gmail.users.messages.get`. */
export const OPERATION_ID_ATTRIBUTE = "introspection.api.operation_id";

/** The largest response body recorded on a span; a larger one records its size only. */
export const MAX_RECORDED_BODY_BYTES = 256 * 1024;

/** The tracer the host registered globally; a no-op tracer when it registered none. */
export function defaultTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/** What a span names about one HTTP request. */
export interface HttpSpanRequest {
  method: string;
  /** The full URL; only its host and port are recorded, never its path or query. */
  url: string;
  /** The path template from the API's discovery document, such as `/gmail/v1/users/{userId}/messages/{id}`. */
  template?: string;
  /** The discovery method id, such as `gmail.users.messages.get`. */
  operation?: string;
}

function serverAttributes(url: string): Attributes {
  try {
    const parsed = new URL(url);
    const port =
      parsed.port ||
      (parsed.protocol === "https:"
        ? "443"
        : parsed.protocol === "http:"
          ? "80"
          : "");
    return {
      "server.address": parsed.hostname,
      ...(port ? { "server.port": Number(port) } : {}),
    };
  } catch {
    return {};
  }
}

/** The span name and start attributes for one request, after the HTTP client semantic conventions. */
export function httpRequestSpan(request: HttpSpanRequest): {
  name: string;
  attributes: Attributes;
} {
  return {
    name: request.template
      ? `${request.method} ${request.template}`
      : request.method,
    attributes: {
      "http.request.method": request.method,
      ...serverAttributes(request.url),
      ...(request.template ? { "url.template": request.template } : {}),
      ...(request.operation
        ? { [OPERATION_ID_ATTRIBUTE]: request.operation }
        : {}),
    },
  };
}

/** A body's size and, up to the cap, the body itself. */
function bodyAttributes(body: string): Attributes {
  const size = Buffer.byteLength(body);
  return size <= MAX_RECORDED_BODY_BYTES
    ? { "http.response.body.size": size, [RESPONSE_BODY_ATTRIBUTE]: body }
    : { "http.response.body.size": size };
}

/** The attributes a response adds: its status and, for JSON, its body. */
export function httpResponseAttributes(
  status: number,
  body?: string,
): Attributes {
  return {
    "http.response.status_code": status,
    ...(status >= 400 ? { "error.type": String(status) } : {}),
    ...(body !== undefined ? bodyAttributes(body) : {}),
  };
}

function isJson(response: GoogleHttpResponse): boolean {
  const type = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  return type.includes("application/json") || type.includes("+json");
}

/** A response whose body was read once, served again to its reader byte for byte. */
function buffered(
  response: GoogleHttpResponse,
  bytes: Uint8Array,
  text: string,
): GoogleHttpResponse {
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

function failed(span: Span, error: unknown): void {
  span.setAttribute(
    "error.type",
    error instanceof Error && error.name ? error.name : "_OTHER",
  );
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/**
 * Send one request inside a client span, a child of the active context (the
 * tool call's `execute_tool` span). Records the method, host, path template,
 * operation and status, and a JSON response's body; never a header, the path
 * or the query, which can carry credentials.
 */
export async function tracedFetch(
  tracer: Tracer,
  fetchImpl: GoogleFetch,
  url: string,
  init: Parameters<GoogleFetch>[1],
  request: Omit<HttpSpanRequest, "method" | "url"> = {},
): Promise<GoogleHttpResponse> {
  const { name, attributes } = httpRequestSpan({
    method: init.method ?? "GET",
    url,
    ...(request.template ? { template: request.template } : {}),
    ...(request.operation ? { operation: request.operation } : {}),
  });
  const span = tracer.startSpan(name, { kind: SpanKind.CLIENT, attributes });
  try {
    const response = await fetchImpl(url, init);
    if (!isJson(response)) {
      span.setAttributes(httpResponseAttributes(response.status));
      if (response.status >= 400)
        span.setStatus({ code: SpanStatusCode.ERROR });
      return response;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    span.setAttributes(httpResponseAttributes(response.status, text));
    if (response.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
    return buffered(response, bytes, text);
  } catch (error) {
    failed(span, error);
    throw error;
  } finally {
    span.end();
  }
}

/** One call to a Recipe MCP server's tool through the session's tools. */
export interface ToolCallSpanRequest {
  /** The MCP server's id in the Recipe. */
  server: string;
  tool: string;
}

/**
 * The span name and start attributes for one MCP tool call through Pi. It
 * carries no `mcp.method.name` or `gen_ai.operation.name`: the request on the
 * wire is the runtime's own `tools/call` span, a child of this one.
 */
export function toolCallSpan(request: ToolCallSpanRequest): {
  name: string;
  attributes: Attributes;
} {
  return {
    name: `${request.server}/${request.tool}`,
    attributes: {
      "mcp.server.id": request.server,
      "mcp.tool.name": request.tool,
    },
  };
}

/** The attributes an MCP result adds: an `isError` result, and the result itself. */
export function mcpResultAttributes(result: unknown): Attributes {
  if (result === undefined) return {};
  const failedTool =
    typeof result === "object" &&
    result !== null &&
    (result as { isError?: unknown }).isError === true;
  return {
    ...(failedTool ? { "error.type": "tool_error" } : {}),
    ...bodyAttributes(JSON.stringify(result)),
  };
}

/**
 * Run one MCP tool call through the session's tools inside an internal span,
 * active while Pi's client sends the request. Neither Pi nor the session
 * instrumentation records a nested call's result, so the `CallToolResult` is
 * recorded here like a REST answer's body; a call Pi failed records
 * `error.type` `call_failed` only.
 */
export async function tracedToolCall(
  tracer: Tracer,
  request: ToolCallSpanRequest,
  run: () => Promise<ProductivityToolCallOutcome>,
): Promise<ProductivityToolCallOutcome> {
  const { name, attributes } = toolCallSpan(request);
  return tracer.startActiveSpan(
    name,
    { kind: SpanKind.INTERNAL, attributes },
    async (span) => {
      try {
        const outcome = await run();
        if (outcome.structuredContent !== undefined) {
          const recorded = mcpResultAttributes(outcome.structuredContent);
          span.setAttributes(recorded);
          if (recorded["error.type"])
            span.setStatus({ code: SpanStatusCode.ERROR });
        } else if (outcome.isError) {
          span.setAttribute("error.type", "call_failed");
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        return outcome;
      } catch (error) {
        failed(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
