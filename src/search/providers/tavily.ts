import { capText, countryName, dateOf, hostOf, requestJson } from "../http.js";
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
 * tavily-ai/tavily-mcp): `Title:`, `ID:`, `URL:`, `Content:` lines per result,
 * where content keeps its own newlines. The text carries no date, score or
 * credits.
 */
function tavilyTextResults(text: string): TavilyResponse {
  const results: NonNullable<TavilyResponse["results"]> = [];
  let content: string[] | undefined;
  const endContent = () => {
    const current = results.at(-1);
    if (current && content) current.content = content.join("\n").trimEnd();
    content = undefined;
  };
  for (const line of text.split("\n")) {
    const match = /^(Title|ID|URL|Content|Raw Content|Favicon): (.*)$/.exec(
      line,
    );
    if (!match) {
      if (line === "Images:") endContent();
      else content?.push(line);
      continue;
    }
    endContent();
    const [, key, value] = match;
    let current = results.at(-1);
    if (
      key === "Title" ||
      ((key === "URL" || key === "ID") && (!current || current.url))
    ) {
      current = {};
      results.push(current);
    }
    if (!current) continue;
    if (key === "Title") current.title = value;
    else if (key === "URL") current.url = value;
    else if (key === "Content") content = [value];
  }
  endContent();
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
    max_query_chars: 400,
    host: "api.tavily.com",
    credential: { header: "Authorization", prefix: "Bearer " },
    billing:
      "credits: basic and fast 1, advanced 2 (reported with include_usage)",
    combine_sites: true,
    options: {
      freshness: "native",
      include_sites: "native",
      exclude_sites: "native",
      context: "approximate",
      country: "native",
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
          ...(request.country ? { country: countryName(request.country) } : {}),
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
        ...(request.country ? { country: countryName(request.country) } : {}),
      },
    })) as TavilyResponse;
    return tavilyResults(body, request);
  },
};
