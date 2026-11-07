import { setTimeout } from "node:timers/promises";

import type { Tracer } from "@opentelemetry/api";

import type {
  ProductivityErrorCode,
  ProductivityErrorInfo,
  ProductivityFetch,
  ProductivityProviderError,
} from "@introspection-ai/recipes/productivity";

import { defaultTracer, tracedFetch } from "./telemetry.js";

/** Microsoft Graph v1.0. Beta is never used. */
export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

/** Sent where Graph expects a token; the egress replaces it with the person's token. */
export const EGRESS_INJECTED_TOKEN = "introspection-egress";

/** How many times a throttled or unavailable read is retried. */
const MAX_RETRIES = 3;
/** The longest `Retry-After` waited in-process; longer waits come back as `rate_limited`. */
const MAX_WAIT_MS = 30_000;
/** The largest JSON response read into memory. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** Graph's diagnostic, cut to this length before it reaches a result. */
const MAX_MESSAGE = 200;

type Env = Readonly<Record<string, string | undefined>>;

function configured(value: string | undefined): value is string {
  return Boolean(value && value !== "undefined" && value !== "null");
}

/**
 * Whether the sandbox reaches Graph through the standard env proxy, which
 * injects the person's token, rather than the provider listener named by
 * INTROSPECTION_EGRESS_URL. The same rule as the Slack channel package.
 */
function egressProxyNative(env: Env): boolean {
  if (env.INTROSPECTION_EGRESS_PROXY_NATIVE?.trim() === "1") return true;
  return (
    !configured(env.INTROSPECTION_EGRESS_URL?.trim()) &&
    configured(env.INTROSPECTION_TASK_ID?.trim())
  );
}

/** A failed Graph call in the host's shared error shape. */
export class GraphError extends Error implements ProductivityProviderError {
  readonly productivity: ProductivityErrorInfo;

  constructor(
    info: ProductivityErrorInfo,
    readonly graphCode?: string,
  ) {
    super(info.message);
    this.name = "GraphError";
    this.productivity = info;
  }
}

function graphError(
  code: ProductivityErrorCode,
  message: string,
  extra: Partial<ProductivityErrorInfo> = {},
  graphCode?: string,
): GraphError {
  return new GraphError({ code, message, ...extra }, graphCode);
}

/** Seconds from a `Retry-After` header: delta-seconds or an HTTP date. */
export function retryAfterSeconds(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.max(0, Math.ceil((date - now) / 1000))
    : undefined;
}

export interface GraphRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Below the base URL, already escaped, such as `/me/messages`. */
  path: string;
  /**
   * The path's template in Graph's OpenAPI description, such as
   * `/me/messages/{message-id}`, which names the request's span.
   */
  template: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  /** JSON-encoded unless it is bytes. */
  body?: unknown;
  /**
   * The delegated scope the call needs, named in a `missing_scope` error.
   * Graph's 403 does not say which scope was missing.
   */
  scope: string;
  /**
   * Whether the request only reads, so a 429, 503 or 504 may be retried. A
   * write is never retried: Graph writes are not idempotent, and a 503 may
   * follow a write that took effect.
   */
  read: boolean;
}

export interface GraphClientOptions {
  env?: Env;
  /** A host's request hook; it attaches the credential instead of the egress. */
  fetch?: ProductivityFetch;
  /** Default `GRAPH_BASE_URL`; tests point it at a fake server. */
  baseUrl?: string;
  /** Default `timers/promises` `setTimeout`; tests record the waits. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Default: the globally registered tracer; tests record the spans. */
  tracer?: Tracer;
}

type FetchResponse = Awaited<ReturnType<ProductivityFetch>>;

/**
 * A small Microsoft Graph v1.0 client over `fetch`.
 *
 * It holds no credential. It sends a placeholder bearer, which the egress (or
 * a host's request hook) replaces with the person's token, exactly as the
 * Slack channel package does. Reads follow `@odata.nextLink` and are retried
 * on `429`, `503` and `504` after `Retry-After`; writes are sent once.
 */
export class GraphClient {
  readonly baseUrl: string;
  private readonly env: Env;
  private readonly hooked: boolean;
  private readonly fetchImpl: ProductivityFetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly tracer: Tracer;

  constructor(options: GraphClientOptions = {}) {
    this.env = options.env ?? process.env;
    this.hooked = options.fetch !== undefined;
    this.fetchImpl =
      options.fetch ?? (globalThis.fetch as unknown as ProductivityFetch);
    this.baseUrl = (options.baseUrl ?? GRAPH_BASE_URL).replace(/\/+$/, "");
    this.sleep =
      options.sleep ?? ((ms, signal) => setTimeout(ms, undefined, { signal }));
    this.tracer = options.tracer ?? defaultTracer();
  }

  private fetch(
    url: string,
    init: Parameters<ProductivityFetch>[1],
    template?: string,
  ): Promise<FetchResponse> {
    return tracedFetch(this.tracer, this.fetchImpl, url, init, template);
  }

  /** The `Authorization` header for a Graph request. */
  authorization(): string {
    if (this.hooked || egressProxyNative(this.env))
      return `Bearer ${EGRESS_INJECTED_TOKEN}`;
    const locator = this.env.INTROSPECTION_TOKEN?.trim();
    const egressUrl = this.env.INTROSPECTION_EGRESS_URL?.trim();
    if (!configured(locator) || !configured(egressUrl)) {
      throw graphError(
        "provider_error",
        "Microsoft productivity tools need the Introspection cloud egress, or a host that attaches the person's credential. Use introspection dev to test them.",
      );
    }
    // Keep the provider URL intact: the runtime's proxy dispatcher dials
    // INTROSPECTION_EGRESS_URL and keeps graph.microsoft.com as the authority,
    // so the egress can route the request and select the connector credential.
    return `Bearer ${locator}`;
  }

  url(path: string, query?: Record<string, string | undefined>): string {
    const url = `${this.baseUrl}${path}`;
    const params = Object.entries(query ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    );
    if (params.length === 0) return url;
    // OData wants %20 for spaces, not URLSearchParams' `+`.
    return `${url}?${params
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&")}`;
  }

  /** Send a request and return the response, retrying a read when Graph asks. */
  async send(
    request: GraphRequest,
    signal?: AbortSignal,
    url = this.url(request.path, request.query),
  ): Promise<FetchResponse> {
    const isBytes = request.body instanceof Uint8Array;
    const body =
      request.body === undefined
        ? undefined
        : isBytes
          ? (request.body as Uint8Array)
          : JSON.stringify(request.body);
    for (let attempt = 0; ; attempt += 1) {
      let response: FetchResponse;
      try {
        response = await this.fetch(
          url,
          {
            method: request.method,
            headers: {
              Accept: "application/json",
              ...(body !== undefined && !isBytes
                ? { "Content-Type": "application/json" }
                : {}),
              ...request.headers,
              Authorization: this.authorization(),
            },
            ...(body !== undefined ? { body } : {}),
            redirect: "manual",
            ...(signal ? { signal } : {}),
          },
          request.template,
        );
      } catch (error) {
        if (signal?.aborted || error instanceof GraphError) throw error;
        throw graphError(
          "provider_error",
          "Microsoft Graph could not be reached",
        );
      }
      if (response.ok || (response.status >= 300 && response.status < 400))
        return response;
      const retryable =
        request.read &&
        (response.status === 429 ||
          response.status === 503 ||
          response.status === 504);
      const wait = retryAfterSeconds(response.headers.get("Retry-After"));
      const waitMs = wait !== undefined ? wait * 1000 : 2 ** attempt * 1000;
      if (!retryable || attempt >= MAX_RETRIES || waitMs > MAX_WAIT_MS)
        throw await this.error(response, request);
      await this.sleep(waitMs, signal);
    }
  }

  /** Send a request and decode its JSON body; `undefined` for an empty one (202, 204). */
  async json<T>(request: GraphRequest, signal?: AbortSignal): Promise<T> {
    return this.decode<T>(await this.send(request, signal));
  }

  /**
   * Every page of a collection, following `@odata.nextLink`, until `limit`
   * items. Returns every item of the pages read, which may be more than
   * `limit` (the host keeps the rest for its next page), and the next link
   * when more remain.
   */
  async page<T>(
    request: GraphRequest,
    limit: number,
    signal?: AbortSignal,
    cursor?: string,
  ): Promise<{ items: T[]; next?: string }> {
    const items: T[] = [];
    let url = cursor ? this.ownLink(cursor) : undefined;
    for (;;) {
      const response = await this.send(request, signal, url);
      const page = await this.decode<{
        value?: T[];
        "@odata.nextLink"?: string;
      }>(response);
      items.push(...(page?.value ?? []));
      const next = page?.["@odata.nextLink"];
      if (!next) return { items };
      if (items.length >= limit) return { items, next: this.ownLink(next) };
      url = this.ownLink(next);
    }
  }

  /** Fetch bytes, following a redirect to a pre-authenticated URL without the bearer. */
  async bytes(
    request: GraphRequest,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType?: string }> {
    let response = await this.send(request, signal);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      if (!location)
        throw graphError(
          "provider_error",
          "Graph redirected without a location",
        );
      // The redirect carries its own credential; the bearer never follows it.
      response = await this.fetch(new URL(location, this.baseUrl).toString(), {
        method: "GET",
        redirect: "error",
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw await this.error(response, request);
    }
    const contentType = response.headers.get("Content-Type") ?? undefined;
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      ...(contentType ? { contentType } : {}),
    };
  }

  /** PUT bytes to an upload session URL: pre-authenticated, so no bearer; never retried. */
  async uploadRange(
    uploadUrl: string,
    chunk: Uint8Array,
    range: { start: number; end: number; total: number },
    signal?: AbortSignal,
  ): Promise<FetchResponse> {
    const response = await this.fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.byteLength),
        "Content-Range": `bytes ${range.start}-${range.end}/${range.total}`,
      },
      body: chunk,
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok)
      throw await this.error(response, {
        method: "PUT",
        path: "",
        template: "",
        scope: "Files.ReadWrite",
        read: false,
      });
    return response;
  }

  async decode<T>(response: FetchResponse): Promise<T> {
    const text = await response.text();
    if (text.length > MAX_JSON_BYTES)
      throw graphError(
        "provider_error",
        "The Graph response is larger than this client reads",
      );
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw graphError("provider_error", "The Graph response was not JSON");
    }
  }

  /** A next link must stay on this client's base URL, so a cursor never moves the bearer elsewhere. */
  private ownLink(link: string): string {
    if (!link.startsWith(`${this.baseUrl}/`))
      throw graphError(
        "invalid_request",
        "The cursor does not belong to Microsoft Graph",
      );
    return link;
  }

  private async error(
    response: FetchResponse,
    request: GraphRequest,
  ): Promise<GraphError> {
    let code: string | undefined;
    let message: string | undefined;
    try {
      const envelope = JSON.parse(await response.text()) as {
        error?: { code?: string; message?: string };
      };
      code = envelope.error?.code;
      message = envelope.error?.message;
    } catch {
      // Not JSON: keep the status alone.
    }
    const detail = message
      ? `: ${message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message}`
      : "";
    const status = response.status;
    const retryAfter = retryAfterSeconds(response.headers.get("Retry-After"));
    if (status === 401)
      return graphError(
        "not_connected",
        "The Microsoft 365 connection is missing or expired",
        { status },
        code,
      );
    if (status === 403)
      return graphError(
        "missing_scope",
        `Microsoft Graph refused the request${detail}`,
        { status, scope: request.scope },
        code,
      );
    if (status === 404 || status === 410)
      return graphError("not_found", `Not found${detail}`, { status }, code);
    if (status === 429)
      return graphError(
        "rate_limited",
        "Microsoft Graph is throttling requests",
        {
          status,
          ...(retryAfter !== undefined
            ? { retry_after_seconds: retryAfter }
            : {}),
        },
        code,
      );
    if (status >= 400 && status < 500)
      return graphError(
        "invalid_request",
        `Microsoft Graph rejected the request${detail}`,
        { status },
        code,
      );
    return graphError(
      "provider_error",
      `Microsoft Graph failed (HTTP ${status})${detail}`,
      {
        status,
        ...(retryAfter !== undefined
          ? { retry_after_seconds: retryAfter }
          : {}),
      },
      code,
    );
  }
}

export function invalidRequest(message: string): GraphError {
  return graphError("invalid_request", message);
}
