import { capText, dateOf, hostOf, requestJson } from "../http.js";
import { mcpResultText } from "../mcp.js";
import {
  SEARCH_PROVIDER_API_VERSION,
  type SearchProviderModule,
  type SearchProviderResult,
  type SearchRequest,
} from "../types.js";

interface TavilyResponse {
  results?: Array<{
    url?: string;
    title?: string;
    content?: string;
    score?: number;
    published_date?: string;
  }>;
  usage?: { credits?: number };
}

function tavilyResults(
  body: TavilyResponse,
  request: SearchRequest,
): SearchProviderResult {
  const results = (body.results ?? []).flatMap((item) => {
    if (typeof item.url !== "string") return [];
    const published = dateOf(item.published_date);
    const site = hostOf(item.url);
    return [
      {
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        ...(item.content
          ? { snippet: capText(item.content, request.max_chars) }
          : {}),
        ...(published ? { published_at: published } : {}),
        ...(typeof item.score === "number" ? { score: item.score } : {}),
        ...(site ? { site } : {}),
      },
    ];
  });
  return {
    results,
    ...(typeof body.usage?.credits === "number"
      ? { units: { name: "credits", count: body.usage.credits } }
      : {}),
  };
}

/**
 * The results Tavily's MCP server writes as text (`format-results.ts` in
 * tavily-ai/tavily-mcp): `Title:`, `URL:`, `Content:` lines per result. The
 * text carries no date, score or credits.
 */
function tavilyTextResults(text: string): TavilyResponse {
  const results: NonNullable<TavilyResponse["results"]> = [];
  for (const line of text.split("\n")) {
    const match = /^(Title|URL|Content): (.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    let current = results.at(-1);
    if (!current || key === "Title" || (key === "URL" && current.url)) {
      current = {};
      results.push(current);
    }
    if (key === "Title") current.title = value;
    else if (key === "URL") current.url = value;
    else current.content = value;
  }
  return { results };
}

/**
 * Tavily Search. REST `POST /search`, or the `tavily_search` tool of
 * Tavily's hosted MCP server; the mode sets `search_depth` on either.
 */
export const tavilySearchProvider: SearchProviderModule = {
  kind: "search",
  apiVersion: SEARCH_PROVIDER_API_VERSION,
  id: "tavily",
  capabilities: {
    modes: {
      fast: { setting: "fast" },
      default: { setting: "basic" },
      deep: { setting: "advanced" },
    },
    mode_parameter: "search_depth",
    max_results: 20,
    host: "api.tavily.com",
    credential: { header: "Authorization", prefix: "Bearer " },
    billing:
      "credits: basic and fast 1, advanced 2 (reported with include_usage)",
    options: {
      freshness: "native",
      include_sites: "native",
      exclude_sites: "native",
      context: "approximate",
    },
    notes: {
      context:
        "Tavily returns up to 3 relevant chunks per result (chunks_per_source) only in deep mode; other modes return one snippet.",
    },
  },
  mcp: {
    url: "https://mcp.tavily.com/mcp/",
    credential: { header: "Authorization", prefix: "Bearer " },
    tools: ["tavily_search"],
    plan(request, hasTool) {
      if (!hasTool("tavily_search")) return undefined;
      return {
        tool: "tavily_search",
        args: {
          query: request.query,
          search_depth: request.setting,
          max_results: request.max_results,
          ...(request.freshness ? { time_range: request.freshness } : {}),
          ...(request.include_sites.length
            ? { include_domains: request.include_sites }
            : {}),
          ...(request.exclude_sites.length
            ? { exclude_domains: request.exclude_sites }
            : {}),
        },
        // The tool takes no chunks_per_source, so context needs REST.
        unsupported:
          request.content === "context" && request.setting === "advanced"
            ? ["context"]
            : [],
      };
    },
    parse(result, request) {
      const structured = result.structuredContent as TavilyResponse | undefined;
      return tavilyResults(
        Array.isArray(structured?.results)
          ? structured
          : tavilyTextResults(mcpResultText(result)),
        request,
      );
    },
  },
  async search(request, context) {
    const body = (await requestJson("tavily", context, "/search", {
      method: "POST",
      body: {
        query: request.query,
        search_depth: request.setting,
        max_results: request.max_results,
        include_usage: true,
        ...(request.content === "context" && request.setting === "advanced"
          ? { chunks_per_source: 3 }
          : {}),
        ...(request.freshness ? { time_range: request.freshness } : {}),
        ...(request.include_sites.length
          ? { include_domains: request.include_sites }
          : {}),
        ...(request.exclude_sites.length
          ? { exclude_domains: request.exclude_sites }
          : {}),
      },
    })) as TavilyResponse;
    return tavilyResults(body, request);
  },
};
