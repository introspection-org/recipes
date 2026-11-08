import type {
  Pages,
  ProductivityHttp,
  ProductivityHttpResponse,
} from "@introspection-ai/recipes/productivity";

import { GoogleProductivityError } from "./errors.js";

export interface GoogleRequest {
  /** The method's id in the API's discovery document, such as `gmail.users.messages.get`. */
  operation: string;
  /**
   * The method's path template from the host's root, after the discovery
   * document's `flatPath`, such as `/gmail/v1/users/{userId}/messages/{id}`.
   */
  template: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | string[] | undefined>;
  json?: unknown;
  body?: string | Uint8Array;
  contentType?: string;
  headers?: Record<string, string>;
  /**
   * A write is never retried: Gmail and Calendar writes are not idempotent,
   * so a request that may have reached Google is not sent twice.
   */
  write?: boolean;
  /** Named in a `missing_scope` result. */
  scope: string;
  signal?: AbortSignal;
}

/** Where each REST API lives; the egress admits exactly these on Google's hosts. */
export interface GoogleEndpoints {
  gmail: string;
  calendar: string;
  drive: string;
  driveUpload: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  gmail: "https://gmail.googleapis.com/gmail/v1",
  calendar: "https://www.googleapis.com/calendar/v3",
  drive: "https://www.googleapis.com/drive/v3",
  driveUpload: "https://www.googleapis.com/upload/drive/v3",
};

const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);
const SCOPE_REASONS = new Set([
  "insufficientPermissions",
  "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
]);

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string }>;
    details?: Array<{ reason?: string }>;
  };
}

function errorReasons(body: GoogleErrorBody): string[] {
  const error = body.error;
  if (!error) return [];
  return [
    ...(error.errors ?? []).map((entry) => entry.reason),
    ...(error.details ?? []).map((entry) => entry.reason),
  ].filter((reason): reason is string => typeof reason === "string");
}

function parseErrorBody(text: string): GoogleErrorBody {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as GoogleErrorBody)
      : {};
  } catch {
    return {};
  }
}

/** The 10 MB Drive applies to `files.export`; documented on the method itself. */
export const DRIVE_EXPORT_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * Map a failed Google answer to a command result
 * (docs/productivity/google.md, Errors). Rate limits are mapped here too; the
 * transport decides before calling this whether to retry them.
 */
function mapGoogleError(
  status: number,
  body: GoogleErrorBody,
  options: { scope: string; retryAfter?: number; label: string },
): GoogleProductivityError {
  const reasons = errorReasons(body);
  const reason = reasons[0];
  const message = body.error?.message ?? `HTTP ${status}`;
  if (status === 401) {
    return new GoogleProductivityError(
      "not_connected",
      "The Google connection is missing or expired: the person reconnects their Google account.",
      { status, reason },
    );
  }
  if (status === 429 || reasons.some((r) => RATE_LIMIT_REASONS.has(r))) {
    return new GoogleProductivityError(
      "rate_limited",
      `Google rate-limited ${options.label}; try again later.`,
      { status, reason, retryAfterMs: options.retryAfter ?? 0 },
    );
  }
  if (status === 403 && reasons.some((r) => SCOPE_REASONS.has(r))) {
    return new GoogleProductivityError(
      "missing_scope",
      `The Google connection lacks the scope ${options.scope}: add it to the connector and reconnect.`,
      { status, reason, scope: options.scope },
    );
  }
  if (status === 403 && reasons.includes("exportSizeLimitExceeded")) {
    return new GoogleProductivityError(
      "invalid_request",
      `The file is larger than Google's export limit of ${DRIVE_EXPORT_LIMIT_BYTES / (1024 * 1024)} MB, so it cannot be exported.`,
      { status, reason, limitBytes: DRIVE_EXPORT_LIMIT_BYTES },
    );
  }
  if (status === 404) {
    return new GoogleProductivityError(
      "not_found",
      `${options.label}: not found.`,
      { status, reason },
    );
  }
  if (status === 400) {
    return new GoogleProductivityError(
      "invalid_request",
      `${options.label}: ${message}`,
      { status, reason },
    );
  }
  return new GoogleProductivityError(
    "provider_error",
    `${options.label} failed: HTTP ${status}${reason ? ` ${reason}` : ""}: ${message}`,
    { status, reason },
  );
}

function rateLimitBody(status: number, body: string): boolean {
  return (
    status === 403 &&
    errorReasons(parseErrorBody(body)).some((r) => RATE_LIMIT_REASONS.has(r))
  );
}

function withQuery(url: string, query: GoogleRequest["query"]): string {
  if (!query) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) parsed.searchParams.append(key, item);
    } else {
      parsed.searchParams.set(key, String(value));
    }
  }
  return parsed.toString();
}

/** Google's REST APIs over the host's `http`, which sends, traces and retries. */
export class GoogleTransport {
  readonly endpoints: GoogleEndpoints;

  constructor(
    private readonly http: ProductivityHttp,
    /** The host's pager, for every list that follows `nextPageToken`. */
    readonly pages: Pages,
    endpoints: Partial<GoogleEndpoints> = {},
  ) {
    this.endpoints = { ...GOOGLE_ENDPOINTS, ...endpoints };
  }

  /** Send a request; a failure is a `GoogleProductivityError`. */
  async send(
    url: string,
    request: GoogleRequest,
  ): Promise<ProductivityHttpResponse> {
    const headers: Record<string, string> = { ...request.headers };
    let body = request.body;
    if (request.json !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      body = JSON.stringify(request.json);
    } else if (request.contentType) {
      headers["Content-Type"] = request.contentType;
    }
    const method = request.method ?? "GET";
    const response = await this.http({
      method,
      url: withQuery(url, request.query),
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      template: request.template,
      operation: request.operation,
      read: !request.write,
      throttled: rateLimitBody,
    });
    if (response.ok) return response;
    throw mapGoogleError(
      response.status,
      parseErrorBody(await response.text()),
      {
        scope: request.scope,
        label: `${method} ${new URL(url).pathname}`,
        ...(response.retryAfterSeconds !== undefined
          ? { retryAfter: response.retryAfterSeconds * 1000 }
          : {}),
      },
    );
  }

  async json<T>(url: string, request: GoogleRequest): Promise<T> {
    const response = await this.send(url, request);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * The response body as bytes, refusing (not truncating) one larger than
   * `limitBytes`.
   */
  async bytes(
    url: string,
    request: GoogleRequest & { limitBytes: number },
  ): Promise<Uint8Array> {
    const response = await this.send(url, request);
    const declared = Number(response.headers.get("Content-Length") ?? NaN);
    if (Number.isFinite(declared) && declared > request.limitBytes) {
      throw tooLarge(request.limitBytes);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > request.limitBytes)
      throw tooLarge(request.limitBytes);
    return data;
  }
}

function tooLarge(limitBytes: number): GoogleProductivityError {
  return new GoogleProductivityError(
    "invalid_request",
    `The content is larger than the ${Math.round(limitBytes / (1024 * 1024))} MB limit, so it was not fetched.`,
    { limitBytes },
  );
}

/** Each page's items and the token for the next, as every Google list returns. */
export interface GooglePage<T> {
  items: T[];
  nextPageToken?: string;
}
