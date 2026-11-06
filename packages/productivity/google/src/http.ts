import { setTimeout as sleepFor } from "node:timers/promises";

import { GoogleProductivityError } from "./errors.js";

export type GoogleEnvironment = Record<string, string | undefined>;

export interface GoogleHttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null | undefined };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface GoogleRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  redirect?: "error";
  signal?: AbortSignal;
}

export type GoogleFetch = (
  url: string,
  init: GoogleRequestInit,
) => Promise<GoogleHttpResponse>;

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface GoogleTransportOptions {
  env?: GoogleEnvironment;
  fetchImpl?: GoogleFetch;
  /** Injected so tests do not wait out a backoff. */
  sleep?: Sleep;
  /** Attempts for a read that meets a rate limit, the first included. */
  maxRateLimitAttempts?: number;
  /** A rate-limit wait longer than this is reported, not slept through. */
  maxRetryWaitMs?: number;
  /** Override Google's base URLs, for an emulator or a fake. */
  endpoints?: Partial<GoogleEndpoints>;
}

export interface GoogleRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | string[] | undefined>;
  json?: unknown;
  body?: string | Uint8Array;
  contentType?: string;
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

/** Sent where Google expects a token; the egress replaces it with the person's. */
const EGRESS_INJECTED_TOKEN = "introspection-egress";

const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);
const SCOPE_REASONS = new Set([
  "insufficientPermissions",
  "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
]);

function configured(value: string | undefined): value is string {
  return Boolean(value && value !== "undefined" && value !== "null");
}

/**
 * Whether the sandbox reaches Google through the standard env proxy, which
 * attaches the person's token, rather than the provider listener named by
 * INTROSPECTION_EGRESS_URL. The same rule as the Slack package's client.
 */
function egressProxyNative(env: GoogleEnvironment): boolean {
  if (env.INTROSPECTION_EGRESS_PROXY_NATIVE?.trim() === "1") return true;
  return (
    !configured(env.INTROSPECTION_EGRESS_URL?.trim()) &&
    configured(env.INTROSPECTION_TASK_ID?.trim())
  );
}

export function retryAfterMs(value: string | null | undefined): number {
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

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
export function mapGoogleError(
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
      "export_too_large",
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

function rateLimited(status: number, reasons: string[]): boolean {
  return (
    status === 429 ||
    (status === 403 && reasons.some((r) => RATE_LIMIT_REASONS.has(r)))
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

/**
 * One person's Google connection, as seen from the sandbox: every request
 * carries a placeholder bearer, and the host's egress attaches the person's
 * token on the way out. The package never holds a credential.
 */
export class GoogleTransport {
  readonly env: GoogleEnvironment;
  readonly fetchImpl: GoogleFetch;
  readonly endpoints: GoogleEndpoints;
  private readonly sleep: Sleep;
  private readonly maxRateLimitAttempts: number;
  private readonly maxRetryWaitMs: number;

  constructor(options: GoogleTransportOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as GoogleFetch);
    this.sleep =
      options.sleep ??
      (async (ms, signal) => {
        await sleepFor(ms, undefined, { signal });
      });
    this.maxRateLimitAttempts = options.maxRateLimitAttempts ?? 4;
    this.maxRetryWaitMs = options.maxRetryWaitMs ?? 30_000;
    this.endpoints = { ...GOOGLE_ENDPOINTS, ...options.endpoints };
  }

  /**
   * The `Authorization` value for a request leaving the sandbox: the
   * placeholder the egress replaces, or the session locator the provider
   * listener exchanges for the person's token.
   */
  authorization(): string {
    if (egressProxyNative(this.env)) return `Bearer ${EGRESS_INJECTED_TOKEN}`;
    const locator = this.env.INTROSPECTION_TOKEN?.trim();
    const egressUrl = this.env.INTROSPECTION_EGRESS_URL?.trim();
    if (!locator || !egressUrl) {
      throw new Error(
        "Google productivity tools require the Introspection cloud egress environment. Use introspection dev to test productivity recipes.",
      );
    }
    return `Bearer ${locator}`;
  }

  /**
   * Send one request, keeping the provider URL intact so the egress can route
   * on its authority and select the connector credential.
   */
  raw(
    url: string,
    init: Omit<GoogleRequestInit, "headers"> & {
      headers?: Record<string, string>;
    },
  ): Promise<GoogleHttpResponse> {
    return this.fetchImpl(url, {
      ...init,
      redirect: "error",
      headers: { ...init.headers, Authorization: this.authorization() },
    });
  }

  /**
   * Send a request, retrying a read on a rate limit (with backoff) and once
   * on a 5xx; a write is sent once. A failure is a `GoogleProductivityError`.
   */
  async send(url: string, request: GoogleRequest): Promise<GoogleHttpResponse> {
    const target = withQuery(url, request.query);
    const label = `${request.method ?? "GET"} ${new URL(url).pathname}`;
    const headers: Record<string, string> = {};
    let body = request.body;
    if (request.json !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      body = JSON.stringify(request.json);
    } else if (request.contentType) {
      headers["Content-Type"] = request.contentType;
    }
    let serverRetried = false;
    for (let attempt = 1; ; attempt += 1) {
      const response = await this.raw(target, {
        method: request.method ?? "GET",
        headers,
        body,
        signal: request.signal,
      });
      if (response.ok) return response;
      const errorBody = parseErrorBody(await response.text());
      const reasons = errorReasons(errorBody);
      const wait = retryAfterMs(response.headers.get("Retry-After"));
      if (rateLimited(response.status, reasons)) {
        const delay = Math.max(wait, 500 * 2 ** (attempt - 1));
        if (
          request.write ||
          attempt >= this.maxRateLimitAttempts ||
          delay > this.maxRetryWaitMs
        ) {
          throw mapGoogleError(response.status, errorBody, {
            scope: request.scope,
            retryAfter: Math.max(wait, delay),
            label,
          });
        }
        await this.sleep(delay, request.signal);
        continue;
      }
      if (response.status >= 500 && !request.write && !serverRetried) {
        serverRetried = true;
        await this.sleep(Math.max(wait, 500), request.signal);
        continue;
      }
      throw mapGoogleError(response.status, errorBody, {
        scope: request.scope,
        label,
      });
    }
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
    "too_large",
    `The content is larger than the ${Math.round(limitBytes / (1024 * 1024))} MB limit, so it was not fetched.`,
    { limitBytes },
  );
}

/** Each page's items and the token for the next, as every Google list returns. */
export interface GooglePage<T> {
  items: T[];
  nextPageToken?: string;
}

/**
 * Follow `nextPageToken` until `limit` items are collected or the pages run
 * out, asking each page for no more than the room left so a page is never cut
 * and the returned token resumes exactly after the last item returned.
 */
export async function collectPages<T>(
  fetchPage: (
    pageToken: string | undefined,
    pageSize: number,
  ) => Promise<GooglePage<T>>,
  limit: number,
  pageToken?: string,
): Promise<GooglePage<T>> {
  const items: T[] = [];
  let token = pageToken;
  for (;;) {
    const page = await fetchPage(token, limit - items.length);
    items.push(...page.items.slice(0, limit - items.length));
    if (!page.nextPageToken) return { items };
    if (items.length >= limit) {
      return { items, nextPageToken: page.nextPageToken };
    }
    token = page.nextPageToken;
  }
}
