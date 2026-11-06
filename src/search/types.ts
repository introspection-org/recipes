import type { McpCallToolResult } from "./mcp.js";

/** Compatibility of a search provider module with this host. */
export const SEARCH_PROVIDER_API_VERSION = 1;

/** The providers `web_search` knows, by the id a call names. */
export const SEARCH_PROVIDER_IDS = [
  "tavily",
  "parallel",
  "exa",
  "keenable",
  "perplexity",
  "brave",
] as const;
export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];

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
  /** One sentence per approximated option, saying what it becomes. */
  notes?: Partial<Record<SearchOption, string>>;
  /** The host the provider calls: the endpoint the runtime must bind. */
  host: string;
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
  fetch: SearchFetch;
  /** The provider's base URL; tests and hosts may replace it. */
  baseUrl: string;
  /** Headers carrying the credential, from the host's egress (never a key). */
  credentialHeaders: Record<string, string>;
  now: () => Date;
  signal?: AbortSignal;
}

export const SEARCH_ERROR_CODES = [
  "not_bound",
  "not_configured",
  "invalid_request",
  "rate_limited",
  "unavailable",
  "provider_error",
] as const;
export type SearchErrorCode = (typeof SEARCH_ERROR_CODES)[number];

export interface SearchErrorInfo {
  code: SearchErrorCode;
  message: string;
  status?: number;
  retry_after_seconds?: number;
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
  parse(
    result: McpCallToolResult,
    request: SearchRequest,
    plan: SearchMcpPlan,
  ): SearchProviderResult;
}

/** A search provider: a descriptor, its REST call and, optionally, its MCP server. */
export interface SearchProviderModule {
  kind: "search";
  apiVersion: number;
  id: SearchProviderId;
  capabilities: SearchCapabilities;
  mcp?: SearchMcpAdapter;
  search(
    request: SearchRequest,
    context: SearchCallContext,
  ): Promise<SearchProviderResult>;
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
  content?: SearchContent;
}

/** One call's structured result, for the host and its trace; the model reads text. */
export interface WebSearchResult {
  results: SearchResultItem[];
  provider: SearchProviderId;
  mode: SearchMode;
  /** The provider's own setting the mode mapped to. */
  setting: string;
  /** Whether the provider's MCP server or its REST API served the call. */
  transport: "mcp" | "rest";
  content: SearchContent;
  notes: SearchNote[];
  usage: { requests: number; units?: SearchUnits };
}
