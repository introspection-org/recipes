import type {
  SearchProviderModule,
  SearchProviderResult,
  SearchRequest,
} from "@introspection-ai/recipes/search";

import { mcpResultText, parsedJson, searchResult } from "./text.js";

/** Relative offsets Keenable's `published_after` takes back from the request time. */
const FRESHNESS = { day: "1d", week: "7d", month: "1mo", year: "1y" } as const;

/** The shortest `snippet_max_length` Keenable accepts. */
const MIN_SNIPPET = 180;

interface KeenableResponse {
  results?: Array<{
    url?: string;
    title?: string;
    description?: string;
    snippet?: string;
    published_at?: string;
    acquired_at?: string;
  }>;
  usage?: { sku?: string; amount?: number; credits?: number; paid?: boolean };
}

function keenableResults(
  body: KeenableResponse,
  request: SearchRequest,
): SearchProviderResult {
  const results = (body.results ?? []).flatMap((item) =>
    searchResult(
      {
        url: item.url,
        title: item.title,
        text: item.snippet || item.description,
        published: item.published_at,
      },
      request.max_chars,
    ),
  );
  return {
    results,
    ...(typeof body.usage?.credits === "number"
      ? { units: { name: "credits", count: body.usage.credits } }
      : {}),
  };
}

/** The arguments REST `POST /v1/search` and the MCP tool `search_web_pages` share. */
function keenableArgs(request: SearchRequest): Record<string, unknown> {
  return {
    query: request.query,
    mode: request.setting,
    max_results: request.max_results,
    snippet_max_length: Math.max(request.max_chars, MIN_SNIPPET),
    ...(request.freshness
      ? { published_after: FRESHNESS[request.freshness] }
      : {}),
    ...(request.include_sites[0] ? { site: request.include_sites[0] } : {}),
  };
}

/**
 * Keenable. REST `POST /v1/search`, or the `search_web_pages` tool of
 * Keenable's hosted MCP server, which takes the same arguments and, asked
 * for `output_format: "json"`, answers the same JSON as text. The MCP
 * answer reports its credits only in `_meta`, which Pi's client drops.
 */
export const keenableSearchProvider: SearchProviderModule = {
  kind: "search",
  apiVersion: 1,
  id: "keenable",
  capabilities: {
    modes: {
      fast: { setting: "realtime" },
      default: { setting: "pro" },
      deep: {
        setting: "pro",
        approximate: "Keenable's most thorough mode is pro, its default",
      },
    },
    mode_parameter: "mode",
    max_results: 50,
    host: "api.keenable.ai",
    credential: { header: "X-API-Key" },
    billing: "credits: 1 per realtime or pro search, reported in usage on REST",
    combine_sites: false,
    max_include_sites: 1,
    options: {
      freshness: "approximate",
      include_sites: "native",
      exclude_sites: "none",
      context: "native",
      country: "none",
    },
    notes: {
      freshness:
        "Keenable filters on publish time from the start of the window, so pages with no known publish date may drop out.",
    },
  },
  mcp: {
    url: "https://api.keenable.ai/mcp",
    credential: { header: "X-API-Key" },
    tools: ["search_web_pages"],
    plan(request, hasTool) {
      if (!hasTool("search_web_pages")) return undefined;
      return {
        tool: "search_web_pages",
        args: { ...keenableArgs(request), output_format: "json" },
        unsupported: [],
      };
    },
    parse(result, request) {
      const text = mcpResultText(result);
      const body = parsedJson(text) as KeenableResponse | undefined;
      // The host reports any other error as `provider_error`.
      if (!Array.isArray(body?.results))
        throw new Error(
          `keenable/search_web_pages did not answer JSON: ${text.slice(0, 200)}`,
        );
      return keenableResults(body, request);
    },
  },
  async search(request, context) {
    const body = (await context.request("/v1/search", {
      method: "POST",
      body: keenableArgs(request),
    })) as KeenableResponse;
    return keenableResults(body, request);
  },
};
