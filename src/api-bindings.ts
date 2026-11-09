import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { interpolateEnv } from "./mcp/index.js";

/**
 * One entry of `.pi/api.local.json`: every request the Recipe's providers and
 * channel adapters send to `host` goes to `url` instead (docs/mcp-configuration.md,
 * "API bindings").
 */
export interface LocalApiBinding {
  /** A bare hostname a loaded provider or adapter declares, such as `graph.microsoft.com`. */
  host: string;
  /** Where the host's requests go: an absolute http(s) URL, optionally with a path prefix. `${VAR}` is interpolated. */
  url: string;
  /** Set on every request to the host, after its credentials are removed. `${VAR}` is interpolated. */
  headers?: Record<string, string>;
}

/**
 * The `.pi/api.local.json` shape, usable inline by hosts that synthesize
 * bindings instead of reading them from disk.
 */
export interface ApiLocalConfig {
  apis: LocalApiBinding[];
}

/** Names the binding file, ahead of `<cwd>/.pi/api.local.json` and `<recipeDir>/.pi/api.local.json`. */
export const API_LOCAL_CONFIG_ENV = "PI_RECIPES_API_LOCAL_CONFIG";

/**
 * Removed from every request to a bound host before the entry's headers are
 * set: credentials, the session carriers the platform's egress strips, and the
 * runtime proxy's routing headers. Kept by hand in step with the egress's
 * locator header list.
 */
const STRIPPED_HEADERS = [
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "x-typesense-api-key",
  "baggage",
  "x-introspection-egress-host",
  "x-introspection-relay-target",
] as const;

function defaultApiLocalConfigPath(dir: string): string {
  return join(dir, ".pi", "api.local.json");
}

/**
 * The binding file a session reads: the one `PI_RECIPES_API_LOCAL_CONFIG`
 * names, else `<cwd>/.pi/api.local.json`, else `<recipeDir>/.pi/api.local.json`,
 * else none.
 */
export function resolveApiLocalConfigPath(opts: {
  cwd: string;
  recipeDir: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = opts.env ?? process.env;
  const configured = env[API_LOCAL_CONFIG_ENV]?.trim();
  if (configured) return configured;
  const workspaceConfig = defaultApiLocalConfigPath(opts.cwd);
  if (existsSync(workspaceConfig)) return workspaceConfig;
  const recipeConfig = defaultApiLocalConfigPath(opts.recipeDir);
  return existsSync(recipeConfig) ? recipeConfig : undefined;
}

/**
 * A binding's host as it is matched: trimmed, lower case, without a trailing
 * dot. Throws for anything but a bare hostname (a scheme, port, path,
 * credentials or an IP literal with a port).
 */
export function normalizeApiHost(host: string): string {
  const value = host.trim().toLowerCase().replace(/\.$/, "");
  let parsed: URL | undefined;
  try {
    parsed = /^[a-z0-9.-]+$/.test(value)
      ? new URL(`https://${value}`)
      : undefined;
  } catch {
    parsed = undefined;
  }
  if (!parsed || parsed.hostname !== value || value.split(".").includes(""))
    throw new Error(
      `API binding host '${host}' is not a bare hostname (no scheme, port or path)`,
    );
  return value;
}

function bindingUrl(value: string, host: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `API binding for '${host}' has url '${value}', which is not an absolute URL`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(
      `API binding for '${host}' has url '${value}', which is not http(s)`,
    );
  if (url.search || url.hash || url.username || url.password)
    throw new Error(
      `API binding for '${host}' has url '${value}'; it takes no query, fragment or credentials`,
    );
  return url.toString();
}

function parseBinding(
  value: unknown,
  index: number,
  env: NodeJS.ProcessEnv,
): LocalApiBinding {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`API binding ${index} is not an object`);
  const entry = value as Record<string, unknown>;
  if (typeof entry.host !== "string")
    throw new Error(`API binding ${index} has no host`);
  const host = normalizeApiHost(entry.host);
  if (typeof entry.url !== "string")
    throw new Error(`API binding for '${host}' has no url`);
  const url = bindingUrl(interpolateEnv(entry.url, env), host);
  if (entry.headers === undefined) return { host, url };
  if (
    !entry.headers ||
    typeof entry.headers !== "object" ||
    Array.isArray(entry.headers)
  )
    throw new Error(`API binding for '${host}' has headers that are not a map`);
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(entry.headers)) {
    if (typeof header !== "string")
      throw new Error(
        `API binding for '${host}' has header '${name}' that is not a string`,
      );
    headers[name] = interpolateEnv(header, env);
  }
  return { host, url, headers };
}

function parseApiLocalConfig(
  value: unknown,
  source: string,
  env: NodeJS.ProcessEnv,
): LocalApiBinding[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${source} is not a JSON object`);
  const apis = "apis" in value ? value.apis : undefined;
  if (apis === undefined) return [];
  if (!Array.isArray(apis)) throw new Error(`${source}: apis is not an array`);
  const bindings = apis.map((entry, index) => parseBinding(entry, index, env));
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (seen.has(binding.host))
      throw new Error(`${source} binds '${binding.host}' more than once`);
    seen.add(binding.host);
  }
  return bindings;
}

/**
 * The session's API bindings, hosts normalized and `${VAR}` in `url` and
 * `headers` interpolated from `env`: the inline `apiBindings` when given, else
 * the file `resolveApiLocalConfigPath` finds, else none. An empty file binds
 * nothing. A file that is missing (when the env names it) or malformed, a host
 * bound twice, a host that is not a bare hostname and a `url` that is not
 * absolute http(s) all throw, so the session fails rather than reaching the
 * live host.
 */
export function readApiBindings(opts: {
  cwd: string;
  recipeDir: string;
  env?: NodeJS.ProcessEnv;
  inline?: ApiLocalConfig;
}): LocalApiBinding[] {
  const env = opts.env ?? process.env;
  if (opts.inline) return parseApiLocalConfig(opts.inline, "apiBindings", env);
  const path = resolveApiLocalConfigPath({ ...opts, env });
  if (!path) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `API binding file ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!text.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `API binding file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseApiLocalConfig(parsed, `API binding file ${path}`, env);
}

/**
 * Fails when a binding names a host no loaded provider or adapter declares:
 * the file can rebind a declared host, never add one.
 */
function assertApiBindingsDeclared(
  bindings: readonly LocalApiBinding[],
  declaredHosts: readonly string[],
): void {
  const declared = new Set(declaredHosts.map((host) => host.toLowerCase()));
  const undeclared = bindings
    .map((binding) => binding.host)
    .filter((host) => !declared.has(host));
  if (undeclared.length > 0)
    throw new Error(
      `API bindings name host(s) no loaded provider or channel declares: ${undeclared.join(", ")}${declared.size ? ` (declared: ${[...declared].sort().join(", ")})` : ""}`,
    );
}

interface LiveBinding {
  binding: LocalApiBinding;
  owners: Set<symbol>;
}

const live = new Map<string, LiveBinding>();
let installedFetch: typeof fetch | undefined;
let wrappedFetch: typeof fetch | undefined;

function sameBinding(left: LocalApiBinding, right: LocalApiBinding): boolean {
  const leftHeaders = Object.entries(left.headers ?? {});
  const rightHeaders = right.headers ?? {};
  return (
    left.url === right.url &&
    leftHeaders.length === Object.keys(rightHeaders).length &&
    leftHeaders.every(([name, value]) => rightHeaders[name] === value)
  );
}

function hostOf(url: string | URL): string | undefined {
  try {
    return (typeof url === "string" ? new URL(url) : url).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    return undefined;
  }
}

/**
 * Whether a request to `url` goes where a live API binding sends it rather
 * than to the vendor: such a request needs no egress credential lane.
 */
export function isApiBound(url: string | URL): boolean {
  const host = hostOf(url);
  return host !== undefined && live.has(host);
}

/** Where a request to a bound URL goes, with its forwarding headers. */
function rewrite(
  url: URL,
  binding: LocalApiBinding,
): { target: string; prefix: string } {
  const base = new URL(binding.url);
  const prefix = base.pathname.replace(/\/+$/, "");
  return {
    target: `${base.origin}${prefix}${url.pathname}${url.search}`,
    prefix,
  };
}

function boundHeaders(
  headers: Headers,
  binding: LocalApiBinding,
  prefix: string,
): Headers {
  for (const name of STRIPPED_HEADERS) headers.delete(name);
  headers.set("x-forwarded-host", binding.host);
  headers.set("x-forwarded-proto", "https");
  if (prefix) headers.set("x-forwarded-prefix", prefix);
  else headers.delete("x-forwarded-prefix");
  for (const [name, value] of Object.entries(binding.headers ?? {}))
    headers.set(name, value);
  return headers;
}

function isRequest(input: unknown): input is Request {
  return (
    typeof input === "object" &&
    input !== null &&
    !(input instanceof URL) &&
    typeof (input as Request).url === "string" &&
    typeof (input as Request).method === "string"
  );
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** The redirects one bound request follows, as fetch itself allows. */
const MAX_REDIRECTS = 20;

function bindingFetch(inner: typeof fetch): typeof fetch {
  /** Send `url` through the binding lookup: a bound host to its target, any other to the wrapped fetch. */
  function send(url: URL, init: RequestInit, hops: number): Promise<Response> {
    const host = hostOf(url);
    const entry = host === undefined ? undefined : live.get(host);
    return entry
      ? sendBound(url, entry.binding, init, hops)
      : inner(url.href, init);
  }

  /**
   * Send a request for a bound host to its target. Redirects the caller wants
   * followed are followed here rather than inside the wrapped fetch, so a
   * `Location` naming the vendor host goes through the binding again instead
   * of reaching the vendor.
   */
  async function sendBound(
    url: URL,
    binding: LocalApiBinding,
    init: RequestInit,
    hops: number,
  ): Promise<Response> {
    const { target, prefix } = rewrite(url, binding);
    const follow = (init.redirect ?? "follow") === "follow";
    const response = await inner(target, {
      ...init,
      headers: boundHeaders(new Headers(init.headers), binding, prefix),
      ...(follow ? { redirect: "manual" } : {}),
    });
    const location = response.headers.get("location");
    if (!follow || !REDIRECT_STATUSES.has(response.status) || !location)
      return response;
    if (hops >= MAX_REDIRECTS)
      throw new TypeError("fetch failed: too many redirects");
    // The target answers as the vendor (x-forwarded-*), so its Location is
    // read against the URL the provider sent to.
    const next = new URL(location, url);
    const method = (init.method ?? "GET").toUpperCase();
    const toGet =
      response.status === 303
        ? method !== "HEAD"
        : (response.status === 301 || response.status === 302) &&
          method === "POST";
    if (!toGet && init.body instanceof ReadableStream)
      throw new TypeError(
        "fetch failed: cannot follow a redirect with a streamed body",
      );
    const headers = new Headers(init.headers);
    // Another host gets none of what the binding strips, bound or not.
    if (next.host !== url.host) {
      for (const name of STRIPPED_HEADERS) headers.delete(name);
      for (const name of Object.keys(binding.headers ?? {}))
        headers.delete(name);
    }
    if (toGet) {
      headers.delete("content-type");
      headers.delete("content-length");
    }
    await response.body?.cancel();
    return send(
      next,
      { ...init, headers, ...(toGet ? { method: "GET", body: null } : {}) },
      hops + 1,
    );
  }

  const wrapped = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    if (live.size === 0) return inner(input, init);
    const raw = isRequest(input)
      ? input.url
      : input instanceof URL
        ? input.href
        : String(input);
    const host = hostOf(raw);
    const entry = host === undefined ? undefined : live.get(host);
    if (!entry) return inner(input, init);
    if (!isRequest(input))
      return sendBound(new URL(raw), entry.binding, init ?? {}, 0);
    const request = init ? new Request(input, init) : input;
    // Buffered, so a 307 or 308 can send the body again.
    const body = request.body ? await request.arrayBuffer() : null;
    return sendBound(
      new URL(request.url),
      entry.binding,
      {
        method: request.method,
        headers: request.headers,
        body,
        redirect: request.redirect,
        signal: request.signal,
        credentials: request.credentials,
        cache: request.cache,
        integrity: request.integrity,
        keepalive: request.keepalive,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
      },
      0,
    );
  }) as typeof fetch;
  return wrapped;
}

/** Whether `globalThis.fetch` is the API binding wrapper. */
export function isApiBindingFetchInstalled(): boolean {
  return installedFetch !== undefined && globalThis.fetch === installedFetch;
}

/**
 * Put the binding wrapper in front of the current `globalThis.fetch` while any
 * binding is live. A no-op when the wrapper already is the global fetch, so
 * calling it again never grows the chain.
 */
export function ensureApiBindingFetch(): void {
  if (live.size === 0 || isApiBindingFetchInstalled()) return;
  wrappedFetch = globalThis.fetch;
  installedFetch = bindingFetch(wrappedFetch);
  globalThis.fetch = installedFetch;
}

/**
 * Bind hosts for one owner (a session) in front of `globalThis.fetch`, until
 * the returned release. Owners share the process's fetch: two live owners may
 * bind a host only to the same URL and headers, and a host stays bound until
 * its last owner releases. After the last release the global fetch is handed
 * back, unless something replaced the wrapper since.
 */
export function installApiBindings(
  owner: string,
  bindings: readonly LocalApiBinding[],
): () => void {
  if (bindings.length === 0) return () => {};
  for (const binding of bindings) {
    const current = live.get(binding.host);
    if (current && !sameBinding(current.binding, binding))
      throw new Error(
        `${owner} binds API host '${binding.host}' to ${binding.url}, but a live session binds it to ${current.binding.url}`,
      );
  }
  const token = Symbol(owner);
  for (const binding of bindings) {
    const current = live.get(binding.host);
    if (current) current.owners.add(token);
    else live.set(binding.host, { binding, owners: new Set([token]) });
  }
  ensureApiBindingFetch();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const binding of bindings) {
      const current = live.get(binding.host);
      if (!current) continue;
      current.owners.delete(token);
      if (current.owners.size === 0) live.delete(binding.host);
    }
    if (live.size > 0) return;
    if (isApiBindingFetchInstalled() && wrappedFetch)
      globalThis.fetch = wrappedFetch;
    installedFetch = undefined;
    wrappedFetch = undefined;
  };
}

/** What a session bound: the hosts its providers declare, and where the file sends each bound one. */
export interface RecipeSessionApiBindings {
  /** Every host the loaded productivity, issues, channel and (with `pi.search`) search providers declare, sorted. */
  declaredHosts: readonly string[];
  /** The bindings in force for this session; headers are left out, as they may carry a token. */
  bound: readonly Pick<LocalApiBinding, "host" | "url">[];
}

/**
 * Resolve, check and install a session's API bindings: what both session
 * paths do once their providers are loaded and before any of their
 * extensions runs.
 */
export function bindRecipeApis(opts: {
  owner: string;
  cwd: string;
  recipeDir: string;
  declaredHosts: readonly string[];
  env?: NodeJS.ProcessEnv;
  inline?: ApiLocalConfig;
}): {
  apiBindings: RecipeSessionApiBindings;
  bindings: LocalApiBinding[];
  release: () => void;
} {
  const bindings = readApiBindings(opts);
  assertApiBindingsDeclared(bindings, opts.declaredHosts);
  const release = installApiBindings(opts.owner, bindings);
  return {
    apiBindings: {
      declaredHosts: [
        ...new Set(opts.declaredHosts.map((host) => host.toLowerCase())),
      ].sort(),
      bound: bindings.map(({ host, url }) => ({ host, url })),
    },
    bindings,
    release,
  };
}
