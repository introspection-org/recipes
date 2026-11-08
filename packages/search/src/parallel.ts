import type {
  SearchOption,
  SearchProviderModule,
  SearchProviderResult,
  SearchRequest,
} from "@introspection-ai/recipes/search";

import {
  freshnessStart,
  mcpResultText,
  parsedJson,
  searchResult,
} from "./text.js";

interface ParallelResponse {
  results?: Array<{
    url?: string;
    title?: string | null;
    publish_date?: string | null;
    excerpts?: string[];
  }>;
  usage?: Array<{ name?: string; count?: number }> | null;
}

/** Words kept in the keyword query, which Parallel wants 3-6 words long. */
const KEYWORD_WORDS = 6;

/** Keyword queries one MCP call sends, one per included domain. */
const MAX_SITE_QUERIES = 5;

/**
 * Whether a URL is on a site, as Parallel's source policy reads one: a plain
 * domain matches itself and its subdomains, a path matches at segment
 * boundaries.
 */
function onSite(url: string, site: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const slash = site.indexOf("/");
  const domain = slash < 0 ? site : site.slice(0, slash);
  const path = slash < 0 ? "" : site.slice(slash).replace(/\/$/, "");
  const host = parsed.hostname.toLowerCase();
  if (host !== domain && !host.endsWith(`.${domain}`)) return false;
  return (
    !path || parsed.pathname === path || parsed.pathname.startsWith(`${path}/`)
  );
}

function parallelResults(
  body: ParallelResponse,
  request: SearchRequest,
): SearchProviderResult {
  const results = (body.results ?? []).flatMap((item) =>
    searchResult(
      {
        url: item.url,
        title: item.title,
        text: (item.excerpts ?? []).join(" … "),
        published: item.publish_date,
      },
      request.max_chars,
    ),
  );
  // The usage SKUs differ by request; the search SKU is the billed request.
  const usage =
    body.usage?.find((item) => item.name === "sku_search") ?? body.usage?.[0];
  return {
    results,
    ...(usage?.name && typeof usage.count === "number"
      ? { units: { name: usage.name, count: usage.count } }
      : {}),
  };
}

/**
 * Parallel Search. REST `POST /v1/search`, or the `web_search` tool of
 * Parallel's hosted MCP server (`search.parallel.ai/mcp`, which also serves
 * anonymous calls at free-tier limits). Either way the query is the
 * natural-language `objective` and, shortened, a keyword query in
 * `search_queries`. REST takes the mode, sites, date and location; the MCP
 * tool takes none of them, so it receives included domains as `site:`
 * queries and its results are filtered here to the sites the call names.
 */
export const parallelSearchProvider: SearchProviderModule = {
  kind: "search",
  apiVersion: 1,
  id: "parallel",
  capabilities: {
    modes: {
      fast: { setting: "fast" },
      default: { setting: "advanced" },
      deep: {
        setting: "advanced",
        approximate:
          "Parallel's Search API has nothing deeper than advanced, its default",
      },
    },
    mode_parameter: "mode",
    // The API states no maximum; web_search never asks for more than 10.
    max_results: 10,
    host: "api.parallel.ai",
    credential: { header: "x-api-key" },
    billing: "per request; the response's usage lists SKUs and counts",
    combine_sites: false,
    options: {
      freshness: "approximate",
      include_sites: "native",
      exclude_sites: "native",
      context: "native",
      country: "native",
    },
    notes: {
      freshness:
        "Parallel filters on published date from the start of the window (after_date).",
    },
  },
  mcp: {
    url: "https://search.parallel.ai/mcp",
    credential: { header: "Authorization", prefix: "Bearer " },
    tools: ["web_search"],
    plan(request, hasTool) {
      if (!hasTool("web_search")) return undefined;
      const keywords = request.query
        .trim()
        .split(/\s+/)
        .slice(0, KEYWORD_WORDS)
        .join(" ");
      const domains = [
        ...new Set(request.include_sites.map((site) => site.split("/")[0]!)),
      ];
      const unsupported: Array<SearchOption | "mode"> = [];
      // The tool takes no mode, and its answer does not say which ran.
      if (request.setting !== "advanced") unsupported.push("mode");
      if (request.freshness) unsupported.push("freshness");
      if (request.country) unsupported.push("country");
      return {
        tool: "web_search",
        args: {
          objective: request.query,
          session_id: request.session,
          search_queries: domains.length
            ? domains
                .slice(0, MAX_SITE_QUERIES)
                .map((domain) => `${keywords} site:${domain}`)
            : [keywords],
        },
        unsupported,
        setting: null,
      };
    },
    parse(result, request) {
      const structured = result.structuredContent as
        ParallelResponse | undefined;
      const body = Array.isArray(structured?.results)
        ? structured
        : (parsedJson(mcpResultText(result)) as ParallelResponse | undefined);
      const parsed = parallelResults(body ?? {}, request);
      return {
        results: parsed.results.filter(
          (item) =>
            (request.include_sites.length === 0 ||
              request.include_sites.some((site) => onSite(item.url, site))) &&
            !request.exclude_sites.some((site) => onSite(item.url, site)),
        ),
      };
    },
  },
  async search(request, context) {
    const sourcePolicy = {
      ...(request.include_sites.length
        ? { include_domains: request.include_sites }
        : {}),
      ...(request.exclude_sites.length
        ? { exclude_domains: request.exclude_sites }
        : {}),
      ...(request.freshness
        ? { after_date: freshnessStart(request.freshness, context.now()) }
        : {}),
    };
    const body = (await context.request("/v1/search", {
      method: "POST",
      body: {
        objective: request.query,
        search_queries: [request.query],
        mode: request.setting,
        session_id: request.session,
        advanced_settings: {
          max_results: request.max_results,
          excerpt_settings: { max_chars_per_result: request.max_chars },
          ...(Object.keys(sourcePolicy).length
            ? { source_policy: sourcePolicy }
            : {}),
          ...(request.country
            ? { location: request.country.toLowerCase() }
            : {}),
        },
      },
    })) as ParallelResponse;
    return parallelResults(body, request);
  },
};
