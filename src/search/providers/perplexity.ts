import { capText, dateOf, hostOf, requestJson } from "../http.js";
import { mcpResultText } from "../mcp.js";
import {
  SEARCH_PROVIDER_API_VERSION,
  type SearchContent,
  type SearchProviderModule,
  type SearchProviderResult,
  type SearchRequest,
} from "../types.js";

/** Tokens extracted per page; the MCP tool takes 256 to 2048. */
const TOKENS_PER_PAGE: Readonly<Record<SearchContent, number>> = {
  snippets: 256,
  context: 1024,
};

interface PerplexityResponse {
  results?: Array<{
    url?: string;
    title?: string;
    snippet?: string;
    date?: string | null;
    last_updated?: string | null;
  }>;
}

function perplexityResults(
  body: PerplexityResponse,
  request: SearchRequest,
): SearchProviderResult {
  return {
    results: (body.results ?? []).flatMap((item) => {
      if (typeof item.url !== "string") return [];
      const published = dateOf(item.date);
      const site = hostOf(item.url);
      return [
        {
          url: item.url,
          ...(item.title ? { title: item.title } : {}),
          ...(item.snippet
            ? { snippet: capText(item.snippet, request.max_chars) }
            : {}),
          ...(published ? { published_at: published } : {}),
          ...(site ? { site } : {}),
        },
      ];
    }),
  };
}

/** The arguments REST `POST /search` and the MCP tool `perplexity_search` share. */
function perplexityArgs(request: SearchRequest): Record<string, unknown> {
  const domains = [
    ...request.include_sites,
    ...request.exclude_sites.map((site) => `-${site}`),
  ];
  return {
    query: request.query,
    max_results: request.max_results,
    max_tokens_per_page: TOKENS_PER_PAGE[request.content],
    search_type: request.setting,
    ...(request.country ? { country: request.country } : {}),
    ...(request.freshness ? { search_recency_filter: request.freshness } : {}),
    ...(domains.length ? { search_domain_filter: domains } : {}),
  };
}

const RESULT_HEAD = /^\d+\. \*\*(.*)\*\*$/;
const RESULT_URL = /^ {3}URL: (\S+)$/;

/**
 * The results `perplexity_search` writes as text
 * (perplexityai/modelcontextprotocol `formatSearchResults`): a numbered
 * `**title**` line, then indented `URL:`, snippet, `Date:` and
 * `Last updated:` lines. A snippet keeps its own newlines unindented.
 */
function perplexityTextResults(text: string): PerplexityResponse {
  const lines = text.split("\n");
  const results: NonNullable<PerplexityResponse["results"]> = [];
  let snippet: string[] = [];
  const endResult = () => {
    const current = results.at(-1);
    if (current && snippet.length) current.snippet = snippet.join("\n").trim();
    snippet = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const head = RESULT_HEAD.exec(line);
    const url = head ? RESULT_URL.exec(lines[index + 1] ?? "") : null;
    if (head && url) {
      endResult();
      results.push({ title: head[1]!, url: url[1]! });
      index += 1;
      continue;
    }
    const current = results.at(-1);
    if (!current) continue;
    const date = /^ {3}Date: (.*)$/.exec(line);
    if (date) current.date = date[1]!.trim();
    else if (/^ {3}Last updated: /.test(line)) continue;
    else snippet.push(line);
  }
  endResult();
  return { results };
}

/**
 * Perplexity's Search API. REST `POST /search`, or the `perplexity_search`
 * tool of Perplexity's hosted MCP server, which takes the same arguments
 * and answers formatted text; the mode sets `search_type` on either.
 */
export const perplexitySearchProvider: SearchProviderModule = {
  kind: "search",
  apiVersion: SEARCH_PROVIDER_API_VERSION,
  id: "perplexity",
  capabilities: {
    modes: {
      fast: { setting: "fast" },
      default: { setting: "web" },
      deep: {
        setting: "web",
        approximate:
          "Perplexity's Search API has nothing deeper than web, its default",
      },
    },
    mode_parameter: "search_type",
    max_results: 20,
    host: "api.perplexity.ai",
    credential: { header: "Authorization", prefix: "Bearer " },
    billing: "per request",
    combine_sites: false,
    options: {
      freshness: "native",
      include_sites: "native",
      exclude_sites: "native",
      context: "native",
      country: "native",
    },
  },
  mcp: {
    url: "https://api.perplexity.ai/mcp",
    credential: { header: "Authorization", prefix: "Bearer " },
    tools: ["perplexity_search"],
    plan(request, hasTool) {
      if (!hasTool("perplexity_search")) return undefined;
      return {
        tool: "perplexity_search",
        args: perplexityArgs(request),
        unsupported: [],
      };
    },
    parse(result, request) {
      const structured = result.structuredContent as
        { results?: unknown } | undefined;
      const text =
        mcpResultText(result) ||
        (typeof structured?.results === "string" ? structured.results : "");
      return perplexityResults(perplexityTextResults(text), request);
    },
  },
  async search(request, context) {
    const body = (await requestJson("perplexity", context, "/search", {
      method: "POST",
      body: perplexityArgs(request),
    })) as PerplexityResponse;
    return perplexityResults(body, request);
  },
};
