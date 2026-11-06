import {
  capText,
  dateOf,
  freshnessStart,
  hostOf,
  requestJson,
} from "../http.js";
import { mcpResultText } from "../mcp.js";
import {
  SEARCH_PROVIDER_API_VERSION,
  type SearchOption,
  type SearchProviderModule,
  type SearchProviderResult,
  type SearchRequest,
} from "../types.js";

interface ExaResponse {
  results?: Array<{
    url?: string;
    title?: string | null;
    publishedDate?: string;
    score?: number;
    highlights?: string[];
    text?: string;
  }>;
  costDollars?: { total?: number };
}

function exaResults(
  body: ExaResponse,
  request: SearchRequest,
): SearchProviderResult {
  const results = (body.results ?? []).flatMap((item) => {
    if (typeof item.url !== "string") return [];
    const text = item.highlights?.length
      ? item.highlights.join(" … ")
      : item.text;
    const published = dateOf(item.publishedDate);
    const site = hostOf(item.url);
    return [
      {
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        ...(text ? { snippet: capText(text, request.max_chars) } : {}),
        ...(published ? { published_at: published } : {}),
        ...(typeof item.score === "number" ? { score: item.score } : {}),
        ...(site ? { site } : {}),
      },
    ];
  });
  return {
    results,
    ...(typeof body.costDollars?.total === "number"
      ? { units: { name: "usd", count: body.costDollars.total } }
      : {}),
  };
}

/**
 * The results `web_search_exa` writes as text (exa-labs/exa-mcp-server
 * `src/tools/webSearch.ts`): blocks split by `---`, each with `Title:`,
 * `URL:`, `Published:` and `Highlights:` lines.
 */
function exaTextResults(text: string): ExaResponse {
  return {
    results: text.split(/\n\s*---\s*\n/).flatMap((block) => {
      const field = (name: string) =>
        new RegExp(`^${name}: (.*)$`, "m").exec(block)?.[1]?.trim();
      const url = field("URL");
      if (!url) return [];
      const highlights = /^Highlights:\n([\s\S]*)$/m.exec(block)?.[1]?.trim();
      const title = field("Title");
      const published = field("Published");
      return [
        {
          url,
          ...(title && title !== "N/A" ? { title } : {}),
          ...(published && published !== "N/A"
            ? { publishedDate: published }
            : {}),
          ...(highlights ? { highlights: highlights.split("\n") } : {}),
        },
      ];
    }),
  };
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Exa Search. REST `POST /search`, or Exa's hosted MCP server: its
 * `web_search_advanced_exa` tool takes every argument (the server offers it
 * when its URL lists it in `?tools=`), and its default `web_search_exa`
 * only a query and a count.
 */
export const exaSearchProvider: SearchProviderModule = {
  kind: "search",
  apiVersion: SEARCH_PROVIDER_API_VERSION,
  id: "exa",
  capabilities: {
    modes: {
      fast: { setting: "fast" },
      default: { setting: "auto" },
      deep: { setting: "deep" },
    },
    mode_parameter: "type",
    max_results: 100,
    host: "api.exa.ai",
    credential: { header: "x-api-key" },
    billing:
      "dollars per request by type and contents, reported in costDollars",
    options: {
      freshness: "approximate",
      include_sites: "native",
      exclude_sites: "native",
      context: "native",
    },
    notes: {
      freshness:
        "Exa filters on published date from the start of the window, so undated pages drop out.",
    },
  },
  mcp: {
    url: "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa,web_search_exa",
    credential: { header: "x-api-key" },
    tools: ["web_search_advanced_exa", "web_search_exa"],
    plan(request, hasTool, now) {
      if (hasTool("web_search_advanced_exa")) {
        return {
          tool: "web_search_advanced_exa",
          args: {
            query: request.query,
            type: request.setting,
            numResults: request.max_results,
            enableHighlights: true,
            highlightsMaxCharacters: request.max_chars,
            ...(request.freshness
              ? { startPublishedDate: freshnessStart(request.freshness, now) }
              : {}),
            ...(request.include_sites.length
              ? { includeDomains: request.include_sites }
              : {}),
            ...(request.exclude_sites.length
              ? { excludeDomains: request.exclude_sites }
              : {}),
          },
          unsupported: [],
        };
      }
      if (!hasTool("web_search_exa")) return undefined;
      // The default tool always searches `auto` with highlights of Exa's choosing.
      const unsupported: Array<SearchOption | "mode"> = [];
      if (request.setting !== "auto") unsupported.push("mode");
      if (request.freshness) unsupported.push("freshness");
      if (request.include_sites.length) unsupported.push("include_sites");
      if (request.exclude_sites.length) unsupported.push("exclude_sites");
      return {
        tool: "web_search_exa",
        args: { query: request.query, numResults: request.max_results },
        unsupported,
      };
    },
    parse(result, request, plan) {
      const text = mcpResultText(result);
      const json =
        plan.tool === "web_search_advanced_exa"
          ? (parsedJson(text) as ExaResponse | undefined)
          : undefined;
      return exaResults(
        Array.isArray(json?.results) ? json : exaTextResults(text),
        request,
      );
    },
  },
  async search(request, context) {
    const body = (await requestJson("exa", context, "/search", {
      method: "POST",
      body: {
        query: request.query,
        type: request.setting,
        numResults: request.max_results,
        // Highlights are query-relevant extracts at any length, so one
        // contents option serves both levels.
        contents: { highlights: { maxCharacters: request.max_chars } },
        ...(request.freshness
          ? {
              startPublishedDate: freshnessStart(
                request.freshness,
                context.now(),
              ),
            }
          : {}),
        ...(request.include_sites.length
          ? { includeDomains: request.include_sites }
          : {}),
        ...(request.exclude_sites.length
          ? { excludeDomains: request.exclude_sites }
          : {}),
      },
    })) as ExaResponse;
    return exaResults(body, request);
  },
};
