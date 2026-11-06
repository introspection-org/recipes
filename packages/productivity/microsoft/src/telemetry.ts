import {
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from "@opentelemetry/api";

import type { ProductivityFetch } from "@introspection-ai/recipes/productivity";

type FetchResponse = Awaited<ReturnType<ProductivityFetch>>;

/** The instrumentation scope of the Graph request spans. */
const TRACER_NAME = "@introspection-ai/recipe-productivity-microsoft";

/**
 * The attribute a response body is recorded under: the one the `execute_tool`
 * span carries a tool result in, which the Introspection processor seals on
 * whatever span holds it.
 */
export const RESPONSE_BODY_ATTRIBUTE = "gen_ai.tool.call.result";

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
  /** The OpenAPI path template, such as `/me/messages/{message-id}`. */
  template?: string;
}

/** The span name and start attributes for one request, after the HTTP client semantic conventions. */
export function httpRequestSpan(request: HttpSpanRequest): {
  name: string;
  attributes: Attributes;
} {
  const attributes: Attributes = { "http.request.method": request.method };
  try {
    const url = new URL(request.url);
    attributes["server.address"] = url.hostname;
    const port =
      url.port ||
      (url.protocol === "https:"
        ? "443"
        : url.protocol === "http:"
          ? "80"
          : "");
    if (port) attributes["server.port"] = Number(port);
  } catch {
    // The fetch reports a malformed URL.
  }
  if (request.template) attributes["url.template"] = request.template;
  return {
    name: request.template
      ? `${request.method} ${request.template}`
      : request.method,
    attributes,
  };
}

/** The attributes a response adds: its status and, for JSON, its body. */
export function httpResponseAttributes(
  status: number,
  body?: string,
): Attributes {
  const attributes: Attributes = { "http.response.status_code": status };
  if (status >= 400) attributes["error.type"] = String(status);
  if (body !== undefined) {
    const size = Buffer.byteLength(body);
    attributes["http.response.body.size"] = size;
    if (size <= MAX_RECORDED_BODY_BYTES)
      attributes[RESPONSE_BODY_ATTRIBUTE] = body;
  }
  return attributes;
}

function isJson(response: FetchResponse): boolean {
  const type = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  return type.includes("application/json") || type.includes("+json");
}

/** A response whose body was read once, served again to its reader byte for byte. */
function buffered(
  response: FetchResponse,
  bytes: Uint8Array,
  text: string,
): FetchResponse {
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

/**
 * Send one request inside a client span, a child of the active context (the
 * tool call's `execute_tool` span). Records the method, host, path template
 * and status, and a JSON response's body; never a header, the path or the
 * query, which can carry credentials.
 */
export async function tracedFetch(
  tracer: Tracer,
  fetchImpl: ProductivityFetch,
  url: string,
  init: Parameters<ProductivityFetch>[1],
  template?: string,
): Promise<FetchResponse> {
  const { name, attributes } = httpRequestSpan({
    method: init.method ?? "GET",
    url,
    ...(template ? { template } : {}),
  });
  const span: Span = tracer.startSpan(name, {
    kind: SpanKind.CLIENT,
    attributes,
  });
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
    span.setAttribute(
      "error.type",
      error instanceof Error && error.name ? error.name : "_OTHER",
    );
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}
