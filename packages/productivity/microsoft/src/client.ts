import type {
  ProductivityErrorCode,
  ProductivityErrorInfo,
  ProductivityHttp,
  ProductivityHttpResponse,
  ProductivityProviderError,
} from "@introspection-ai/recipes/productivity";

/** Microsoft Graph v1.0. Beta is never used. */
export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

/** The largest JSON response read into memory. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** Graph's diagnostic, cut to this length before it reaches a result. */
const MAX_MESSAGE = 200;

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
   * Whether the request only reads, so the host may retry it when throttled.
   * A write is never retried: Graph writes are not idempotent, and a 503 may
   * follow a write that took effect.
   */
  read: boolean;
}

export interface GraphClientOptions {
  /** Default `GRAPH_BASE_URL`; tests point it at a fake server. */
  baseUrl?: string;
}

type FetchResponse = ProductivityHttpResponse;

/**
 * A small Microsoft Graph v1.0 client over the host's `http`, which attaches
 * the placeholder credential, records each request and retries a throttled
 * read. Reads follow `@odata.nextLink`; writes are sent once.
 */
export class GraphClient {
  readonly baseUrl: string;

  constructor(
    private readonly http: ProductivityHttp,
    options: GraphClientOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? GRAPH_BASE_URL).replace(/\/+$/, "");
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
    let response: FetchResponse;
    try {
      response = await this.http({
        method: request.method,
        url,
        headers: {
          Accept: "application/json",
          ...(body !== undefined && !isBytes
            ? { "Content-Type": "application/json" }
            : {}),
          ...request.headers,
        },
        ...(body !== undefined ? { body } : {}),
        redirect: "manual",
        ...(signal ? { signal } : {}),
        template: request.template,
        read: request.read,
      });
    } catch (error) {
      if (signal?.aborted || !(error instanceof TypeError)) throw error;
      throw graphError(
        "provider_error",
        "Microsoft Graph could not be reached",
      );
    }
    if (response.ok || (response.status >= 300 && response.status < 400))
      return response;
    throw await this.error(response, request);
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
      response = await this.http({
        method: "GET",
        url: new URL(location, this.baseUrl).toString(),
        anonymous: true,
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
    const response = await this.http({
      method: "PUT",
      url: uploadUrl,
      headers: {
        "Content-Length": String(chunk.byteLength),
        "Content-Range": `bytes ${range.start}-${range.end}/${range.total}`,
      },
      body: chunk,
      anonymous: true,
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
    const retryAfter = response.retryAfterSeconds;
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
