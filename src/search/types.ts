import type { McpCallToolResult } from "./mcp.js";

/**
 * The search provider contract this host implements. A provider module, and
 * the package that exports them, declare the version they were written
 * against, and the host refuses one that differs; bump it on any breaking
 * change to `SearchProviderModule` or the types it uses.
 */
export const SEARCH_PROVIDER_API_VERSION = 1 as const;

/**
 * The first-party providers, served by `@introspection-ai/recipe-search`.
 * Ids are open: a Recipe's own provider (`pi.search`) takes any other slug.
 */
export const SEARCH_PROVIDER_IDS = [
  "tavily",
  "parallel",
  "exa",
  "keenable",
  "perplexity",
  "brave",
] as const;
/** The id a call names: a first-party provider's or a Recipe's own. */
export type SearchProviderId = string;

/** One quality scale for every provider; each maps it to its own setting. */
export const SEARCH_MODES = ["fast", "default", "deep"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export const SEARCH_FRESHNESS = ["day", "week", "month", "year"] as const;
export type SearchFreshness = (typeof SEARCH_FRESHNESS)[number];

/**
 * `snippets`: a short excerpt per result. `context`: extracted, query-relevant
 * page text for grounding (Brave's LLM Context, others' text or highlights).
 */
export const SEARCH_CONTENT = ["snippets", "context"] as const;
export type SearchContent = (typeof SEARCH_CONTENT)[number];

export const SEARCH_MAX_RESULTS = 10;
export const SEARCH_DEFAULT_RESULTS = 5;
/** Characters kept per result for each content level. */
export const SEARCH_CONTENT_CHARS: Readonly<Record<SearchContent, number>> = {
  snippets: 300,
  context: 1500,
};

/** The arguments a call may set, beyond the query, provider and mode. */
export const SEARCH_OPTIONS = [
  "freshness",
  "include_sites",
  "exclude_sites",
  "context",
  "country",
] as const;
export type SearchOption = (typeof SEARCH_OPTIONS)[number];

/**
 * How a provider serves an argument: `native` maps it to the provider's own
 * parameter with the same meaning, `approximate` to something close (the
 * descriptor's note says what), `none` cannot serve it.
 */
export type SearchSupport = "native" | "approximate" | "none";

export interface SearchModeMapping {
  /** The provider's own value for this mode (Tavily `advanced`, Exa `auto`). */
  setting: string;
  /** Set when the provider has no setting that means this mode: what it does instead. */
  approximate?: string;
}

export interface SearchCapabilities {
  modes: Readonly<Record<SearchMode, SearchModeMapping>>;
  /** The provider parameter `modes` sets, for docs and traces. */
  mode_parameter: string;
  /** The most results one request returns. */
  max_results: number;
  options: Readonly<Record<SearchOption, SearchSupport>>;
  /** The ISO 3166-1 alpha-2 codes `country` accepts, where the provider names a closed set. */
  countries?: readonly string[];
  /**
   * Whether one request may carry both included and excluded sites. When it
   * may not (Perplexity answers 400, Parallel drops the exclusions), a call
   * with both sends only the included sites and notes the rest as ignored.
   */
  combine_sites: boolean;
  /**
   * The most sites a request may restrict to, where the provider takes fewer
   * than a call may list (Keenable takes one): the first are sent, and the
   * rest noted as ignored.
   */
  max_include_sites?: number;
  /** One sentence per approximated option, saying what it becomes. */
  notes?: Partial<Record<SearchOption, string>>;
  /** The longest query the provider accepts, in characters and in words, where it states one. */
  max_query_chars?: number;
  max_query_words?: number;
  /** The host the provider calls: the endpoint the runtime must bind. */
  host: string;
  /**
   * Every host the provider sends to, REST and MCP, so the egress can attach
   * a credential for each and a provider the platform does not know is
   * explicit about where a call goes.
   */
  hosts?: readonly string[];
  /** The header the provider's key travels in, and its prefix. */
  credential: { header: string; prefix?: string };
  /** How the provider bills a request, per setting where it differs. */
  billing: string;
}

/** One call, normalized: options the provider cannot serve already removed. */
export interface SearchRequest {
  query: string;
  mode: SearchMode;
  /** `capabilities.modes[mode].setting`. */
  setting: string;
  max_results: number;
  freshness?: SearchFreshness;
  include_sites: string[];
  exclude_sites: string[];
  content: SearchContent;
  /** Characters to keep per result. */
  max_chars: number;
  /** ISO 3166-1 alpha-2, upper case: results for this country. */
  country?: string;
  /**
   * Stable across the calls of one `createWebSearch`, the task it serves, for
   * providers that group or rate-limit by session. Never the task id.
   */
  session: string;
}

export interface SearchResultItem {
  url: string;
  title?: string;
  snippet?: string;
  published_at?: string;
  score?: number;
  site?: string;
}

export interface SearchNote {
  option: SearchOption | "max_results" | "mode";
  outcome: "ignored" | "approximated";
  detail: string;
}

export interface SearchUnits {
  name: string;
  count: number;
}

/** What a provider returns for one request. */
export interface SearchProviderResult {
  results: SearchResultItem[];
  /** Billing units the provider reported (credits, dollars), if any. */
  units?: SearchUnits;
}

export type SearchFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** What the host hands a provider for each request. */
export interface SearchCallContext {
  /**
   * Sends one JSON request to `path` on the provider's host, with the
   * credential its egress lane needs, and throws `SearchProviderError` for a
   * failure (429 with its retry delay, 401, 402, 5xx…). Resolves to the
   * parsed body.
   */
  request(
    path: string,
    init: {
      method: "GET" | "POST";
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<unknown>;
  now: () => Date;
  signal?: AbortSignal;
}

export const SEARCH_ERROR_CODES = [
  "not_bound",
  "not_configured",
  "out_of_credit",
  "invalid_request",
  "query_too_long",
  "max_uses_exceeded",
  "too_many_requests",
  "unavailable",
  "provider_error",
] as const;
export type SearchErrorCode = (typeof SEARCH_ERROR_CODES)[number];

export interface SearchErrorInfo {
  code: SearchErrorCode;
  message: string;
  status?: number;
  retry_after_seconds?: number;
  /** For `query_too_long` and `max_uses_exceeded`: the limit the call passed. */
  limit?: number;
}

/** Thrown by a provider (or the host) to report a typed failure. */
export class SearchProviderError extends Error {
  readonly search: SearchErrorInfo;
  constructor(info: SearchErrorInfo) {
    super(info.message);
    this.name = "SearchProviderError";
    this.search = info;
  }
}

/** How one request maps onto a provider's MCP tool. */
export interface SearchMcpPlan {
  tool: string;
  args: Record<string, unknown>;
  /** What the tool cannot express; with REST bound too, the call goes to REST instead. */
  unsupported: Array<SearchOption | "mode">;
  /**
   * The provider setting the tool runs, when it is not the mode's: its fixed
   * setting, or null when the server picks one it does not report.
   */
  setting?: string | null;
}

/** A provider's hosted MCP server, which `web_search` prefers to its REST API. */
export interface SearchMcpAdapter {
  /** The provider's hosted server, for docs and bindings; the bound URL may differ. */
  url: string;
  /** The header its key travels in, injected by the egress like a REST key. */
  credential: { header: string; prefix?: string };
  /** The tools it may call, in order of preference. */
  tools: readonly string[];
  /** The call for this request, given the tools the bound server offers; undefined when it offers none of them. */
  plan(
    request: SearchRequest,
    hasTool: (tool: string) => boolean,
    now: Date,
  ): SearchMcpPlan | undefined;
  /** An error it throws that is not a `SearchProviderError` is reported as `provider_error`. */
  parse(
    result: McpCallToolResult,
    request: SearchRequest,
    plan: SearchMcpPlan,
  ): SearchProviderResult;
}

/** A search provider: a descriptor, its REST call and, optionally, its MCP server. */
export interface SearchProviderModule {
  kind: "search";
  apiVersion: typeof SEARCH_PROVIDER_API_VERSION;
  id: SearchProviderId;
  capabilities: SearchCapabilities;
  mcp?: SearchMcpAdapter;
  search(
    request: SearchRequest,
    context: SearchCallContext,
  ): Promise<SearchProviderResult>;
}

export type SearchProviders = Readonly<
  Record<SearchProviderId, SearchProviderModule>
>;

/**
 * What a search provider package exports as its default
 * (`@introspection-ai/recipe-search`): its providers by id. It needs no
 * run-time import of `@introspection-ai/recipes`, only these types.
 */
export interface RecipeSearchModule {
  kind: "search";
  apiVersion: typeof SEARCH_PROVIDER_API_VERSION;
  providers: SearchProviders;
}

/** The arguments of one call, from the model or from Recipe code. */
export interface WebSearchArgs {
  query: string;
  provider?: SearchProviderId;
  mode?: SearchMode;
  max_results?: number;
  freshness?: SearchFreshness;
  /** `"arxiv.org"` restricts to a site; `"-pinterest.com"` excludes one. */
  sites?: string[];
  /** ISO 3166-1 alpha-2 (`"US"`, `"DE"`): results for that country. */
  country?: string;
  content?: SearchContent;
}

/** One call's structured result, for the host and its trace; the model reads text. */
export interface WebSearchResult {
  results: SearchResultItem[];
  provider: SearchProviderId;
  mode: SearchMode;
  /**
   * The provider's own setting that ran: the mode's, unless an MCP tool ran
   * its own; null when the server does not report which.
   */
  setting: string | null;
  /** Whether the provider's MCP server or its REST API served the call. */
  transport: "mcp" | "rest";
  content: SearchContent;
  notes: SearchNote[];
  usage: { requests: number; units?: SearchUnits };
}
