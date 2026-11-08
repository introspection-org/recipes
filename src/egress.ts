type Env = Readonly<Record<string, string | undefined>>;

function configured(value: string | undefined): value is string {
  return Boolean(value && value !== "undefined" && value !== "null");
}

/**
 * How a provider request leaving the sandbox gets its credential, which the
 * Recipe never holds. `proxy_native`: the env proxy injects the endpoint's
 * configured header. `locator`: the legacy provider lane at
 * `INTROSPECTION_EGRESS_URL` swaps the session locator for the credential.
 * Undefined: there is no credential path, and the caller must not reach the
 * provider unauthenticated. The same rule as the Slack channel package.
 */
export function egressCredentialLane(
  env: Env,
): { kind: "proxy_native" } | { kind: "locator"; locator: string } | undefined {
  const egressUrl = env.INTROSPECTION_EGRESS_URL?.trim();
  if (
    env.INTROSPECTION_EGRESS_PROXY_NATIVE?.trim() === "1" ||
    (!configured(egressUrl) && configured(env.INTROSPECTION_TASK_ID?.trim()))
  )
    return { kind: "proxy_native" };
  const locator = env.INTROSPECTION_TOKEN?.trim();
  return configured(locator) && configured(egressUrl)
    ? { kind: "locator", locator }
    : undefined;
}

/**
 * A `Retry-After` header as seconds from `now`: delay-seconds as given, an
 * HTTP date rounded up. Zero or negative when the wait is over; undefined
 * when absent or unreadable.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number,
): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return seconds;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.ceil((at - now) / 1000);
}
