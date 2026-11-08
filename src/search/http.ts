import { parseRetryAfter } from "../egress.js";
import {
  SearchProviderError,
  type SearchCallContext,
  type SearchErrorCode,
  type SearchFetch,
} from "./types.js";

/** Where one provider's requests go, and with which credential. */
export interface SearchHttpTarget {
  fetch: SearchFetch;
  /** The provider's base URL; tests and hosts may replace it. */
  baseUrl: string;
  /** Headers carrying the credential, from the host's egress (never a key). */
  credentialHeaders: Record<string, string>;
  now: () => Date;
  signal?: AbortSignal;
}

/** Sends one request for a provider and maps a failure to a typed error. */
export async function requestJson(
  provider: string,
  context: SearchHttpTarget,
  path: string,
  init: Parameters<SearchCallContext["request"]>[1],
): Promise<unknown> {
  let response: Awaited<ReturnType<SearchFetch>>;
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
    const retryAfter = retryAfterSeconds(
      response.headers.get("retry-after"),
      context.now(),
    );
    throw new SearchProviderError({
      code: codeFor(response.status),
      message: `${provider} answered ${response.status}${response.status === 402 ? ": the provider account is out of credit" : ""}${detail ? `: ${detail}` : ""}`,
      status: response.status,
      ...(retryAfter ? { retry_after_seconds: retryAfter } : {}),
    });
  }
  return response.json();
}

function codeFor(status: number): SearchErrorCode {
  if (status === 429) return "too_many_requests";
  if (status === 401 || status === 403) return "not_configured";
  if (status === 402) return "out_of_credit";
  if (status === 400 || status === 422) return "invalid_request";
  if (status >= 500) return "unavailable";
  return "provider_error";
}

/** `Retry-After` as whole seconds from now, when there is a wait left. */
function retryAfterSeconds(
  value: string | null,
  now: Date,
): number | undefined {
  const seconds = parseRetryAfter(value, now.getTime());
  return seconds !== undefined && seconds > 0 ? Math.ceil(seconds) : undefined;
}

const REGIONS = new Intl.DisplayNames(["en"], { type: "region" });

/** Region codes ICU names that are not countries: the EU, the eurozone, the UN, outlying Oceania. */
const NOT_COUNTRIES = new Set(["EU", "EZ", "UN", "QO"]);

/** An assigned ISO 3166-1 alpha-2 code: one with an English name of its own. */
export function isCountryCode(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code) || NOT_COUNTRIES.has(code)) return false;
  try {
    const name = REGIONS.of(code);
    // ICU names an unassigned code "Unknown Region" rather than echoing it.
    return Boolean(name) && name !== code && name !== "Unknown Region";
  } catch {
    return false;
  }
}
