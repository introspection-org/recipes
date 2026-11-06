import {
  capText,
  dateOf,
  freshnessStart,
  hostOf,
  requestJson,
} from "../http.js";
import {
  SEARCH_PROVIDER_API_VERSION,
  type SearchProviderModule,
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

/** Exa Search (`POST /search`); the mode sets `type`. */
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
  },
};
