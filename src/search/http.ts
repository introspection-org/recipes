import {
  SearchProviderError,
  type SearchCallContext,
  type SearchErrorCode,
} from "./types.js";

/** Sends one request for a provider and maps a failure to a typed error. */
export async function requestJson(
  provider: string,
  context: SearchCallContext,
  path: string,
  init: {
    method: "GET" | "POST";
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<unknown> {
  let response: Awaited<ReturnType<SearchCallContext["fetch"]>>;
  try {
    response = await context.fetch(`${context.baseUrl}${path}`, {
      method: init.method,
      headers: {
        Accept: "application/json",
        ...(init.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...init.headers,
        ...context.credentialHeaders,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });
  } catch (error) {
    if (context.signal?.aborted) throw error;
    throw new SearchProviderError({
      code: "unavailable",
      message: `${provider} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new SearchProviderError({
      code: codeFor(response.status),
      message: `${provider} answered ${response.status}${detail ? `: ${detail}` : ""}`,
      status: response.status,
      ...(Number.isFinite(retryAfter) && retryAfter > 0
        ? { retry_after_seconds: retryAfter }
        : {}),
    });
  }
  return response.json();
}

function codeFor(status: number): SearchErrorCode {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "not_configured";
  if (status === 400 || status === 422) return "invalid_request";
  if (status >= 500) return "unavailable";
  return "provider_error";
}

/** A text cut to `limit` characters, on a word boundary where one is near. */
export function capText(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${space > limit * 0.6 ? cut.slice(0, space) : cut}…`;
}

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** `YYYY-MM-DD` of an ISO-ish date string, or undefined. */
export function dateOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
  if (match) return match[0];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? undefined
    : parsed.toISOString().slice(0, 10);
}

const FRESHNESS_DAYS = { day: 1, week: 7, month: 31, year: 365 } as const;

/** The first day a freshness window admits, as `YYYY-MM-DD`. */
export function freshnessStart(
  freshness: keyof typeof FRESHNESS_DAYS,
  now: Date,
): string {
  return new Date(now.getTime() - FRESHNESS_DAYS[freshness] * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
