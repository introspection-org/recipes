import { setTimeout as sleepFor } from "node:timers/promises";

import {
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Tracer,
} from "@opentelemetry/api";

import { isApiBound } from "../api-bindings.js";
import { egressCredentialLane, parseRetryAfter } from "../egress.js";
import type {
  ProductivityFetch,
  ProductivityHttp,
  ProductivityHttpRequest,
  ProductivityHttpResponse,
} from "./types.js";

type FetchResponse = Awaited<ReturnType<ProductivityFetch>>;

/** Sent where a provider expects a token; the egress replaces it with the person's. */
export const PRODUCTIVITY_EGRESS_TOKEN = "introspection-egress";

/** The attribute a JSON response body is recorded under, as the tool result itself is. */
export const RESPONSE_BODY_ATTRIBUTE = "gen_ai.tool.call.result";

/** The API's own id for the method called, such as `gmail.users.messages.get`. */
export const OPERATION_ID_ATTRIBUTE = "introspection.api.operation_id";

/** The largest response body recorded on a span; a larger one records its size only. */
export const MAX_RECORDED_BODY_BYTES = 256 * 1024;

/** Retries of a throttled read, after the first attempt. */
const MAX_RETRIES = 3;

/** The longest wait slept through; a longer one comes back to the provider. */
const MAX_WAIT_MS = 30_000;

/** Statuses a read is retried on, beyond what the provider adds with `throttled`. */
const RETRIED_STATUSES = new Set([429, 500, 502, 503, 504]);

type Env = Readonly<Record<string, string | undefined>>;

export interface ProductivityHttpOptions {
  /** Names the spans' instrumentation scope: `@introspection-ai/recipe-productivity-<provider>`. */
  provider: string;
  env?: Env;
  /** A host's request hook, which attaches the person's credential itself. */
  fetch?: ProductivityFetch;
  /** Injected so tests do not wait out a backoff. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Default: the globally registered tracer. */
  tracer?: Tracer;
}

/**
 * The `Authorization` a request leaving the sandbox carries: the placeholder
 * the egress (or a host's hook) replaces, or the session locator the provider
 * listener exchanges for the token.
 */
function productivityAuthorization(
  env: Env,
  hostAttachesCredential: boolean,
): string {
  const lane = egressCredentialLane(env);
  if (hostAttachesCredential || lane?.kind === "proxy_native")
    return `Bearer ${PRODUCTIVITY_EGRESS_TOKEN}`;
  if (!lane)
    throw new Error(
      "Productivity tools need the Introspection cloud egress, or a host that attaches the person's credential. Use introspection dev to test them.",
    );
  return `Bearer ${lane.locator}`;
}

/** Seconds from a `Retry-After` header: delta-seconds or an HTTP date. */
export function retryAfterSeconds(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  const seconds = parseRetryAfter(value, now);
  return seconds === undefined ? undefined : Math.max(0, seconds);
}

/** The span name and start attributes for one request, after the HTTP client conventions. */
function httpRequestSpan(
  request: Pick<
    ProductivityHttpRequest,
    "method" | "url" | "template" | "operation"
  >,
): { name: string; attributes: Attributes } {
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
  if (request.operation) attributes[OPERATION_ID_ATTRIBUTE] = request.operation;
  return {
    name: request.template
      ? `${request.method} ${request.template}`
      : request.method,
    attributes,
  };
}

/** Keys whose value is a link that carries its own credential. */
const CREDENTIAL_KEYS =
  /^(uploadUrl|@microsoft\.graph\.downloadUrl|downloadUrl)$/i;

/** Query parameters that make a URL a credential. */
const CREDENTIAL_QUERY =
  /[?&](tempauth|sig|signature|token|access_token|x-amz-signature|x-goog-signature|x-goog-credential)=/i;

const REDACTED = "[redacted]";

/** A JSON body with every pre-authenticated link replaced, or undefined when it is not JSON. */
function redactedBody(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const redact = (value: unknown, key?: string): unknown => {
    if (typeof value === "string")
      return (key !== undefined && CREDENTIAL_KEYS.test(key)) ||
        CREDENTIAL_QUERY.test(value)
        ? REDACTED
        : value;
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, redact(v, k)]),
      );
    return value;
  };
  return JSON.stringify(redact(parsed));
}

/** The attributes a response adds: its status and, when recorded, its redacted JSON body up to the cap. */
function httpResponseAttributes(
  status: number,
  body?: string,
  record = false,
): Attributes {
  const attributes: Attributes = { "http.response.status_code": status };
  if (status >= 400) attributes["error.type"] = String(status);
  if (body !== undefined) {
    const size = Buffer.byteLength(body);
    attributes["http.response.body.size"] = size;
    const recorded =
      record && size <= MAX_RECORDED_BODY_BYTES
        ? redactedBody(body)
        : undefined;
    if (recorded !== undefined) attributes[RESPONSE_BODY_ATTRIBUTE] = recorded;
  }
  return attributes;
}

function isJson(response: FetchResponse): boolean {
  const type = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  return type.includes("application/json") || type.includes("+json");
}

/** A response whose body was read once, served again byte for byte. */
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
 * The HTTP a provider sends through: the placeholder credential, one client
 * span per attempt (a child of the tool call's span, recording a JSON body
 * but never a header, path or query), and a read retried while the provider
 * is throttled, after `Retry-After` or a backoff of 1, 2 and 4 seconds. A
 * write is sent once. A failed answer comes back as it is, its body readable,
 * for the provider to map.
 */
export function createProductivityHttp(
  options: ProductivityHttpOptions,
): ProductivityHttp {
  const env = options.env ?? process.env;
  const fetchImpl: ProductivityFetch =
    options.fetch ??
    ((url, init) =>
      globalThis.fetch(
        url,
        init as RequestInit,
      ) as ReturnType<ProductivityFetch>);
  const sleep =
    options.sleep ??
    (async (ms: number, signal?: AbortSignal) => {
      await sleepFor(ms, undefined, { signal });
    });
  const tracer =
    options.tracer ??
    trace.getTracer(
      `@introspection-ai/recipe-productivity-${options.provider}`,
    );

  async function attempt(
    request: ProductivityHttpRequest,
  ): Promise<FetchResponse> {
    // A host an API binding sends elsewhere needs no credential lane: the
    // request never reaches the egress, and the binding removes credentials.
    const headers =
      request.anonymous || isApiBound(request.url)
        ? { ...request.headers }
        : {
            ...request.headers,
            Authorization: productivityAuthorization(
              env,
              options.fetch !== undefined,
            ),
          };
    const { name, attributes } = httpRequestSpan(request);
    const span = tracer.startSpan(name, { kind: SpanKind.CLIENT, attributes });
    try {
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        redirect: request.redirect ?? "error",
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (response.status >= 400)
        span.setStatus({ code: SpanStatusCode.ERROR });
      if (!isJson(response) && response.ok) {
        span.setAttributes(httpResponseAttributes(response.status));
        return response;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const text = new TextDecoder().decode(bytes);
      span.setAttributes(
        httpResponseAttributes(
          response.status,
          isJson(response) ? text : undefined,
          request.record ?? request.read === true,
        ),
      );
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

  return async (request) => {
    for (let retries = 0; ; retries += 1) {
      const response = await attempt(request);
      const retryAfter = retryAfterSeconds(response.headers.get("Retry-After"));
      const answered: ProductivityHttpResponse = {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        text: () => response.text(),
        json: () => response.json(),
        arrayBuffer: () => response.arrayBuffer(),
        ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
      };
      if (response.ok || !request.read || retries >= MAX_RETRIES)
        return answered;
      const throttled =
        RETRIED_STATUSES.has(response.status) ||
        (request.throttled?.(response.status, await response.text()) ?? false);
      const waitMs =
        retryAfter !== undefined ? retryAfter * 1000 : 1000 * 2 ** retries;
      if (!throttled || waitMs > MAX_WAIT_MS) return answered;
      await sleep(waitMs, request.signal);
    }
  };
}
