import { capText, dateOf, hostOf, requestJson } from "../http.js";
import {
  SEARCH_PROVIDER_API_VERSION,
  type SearchProviderModule,
  type SearchRequest,
  type SearchResultItem,
} from "../types.js";

const FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" } as const;

interface BraveContext {
  grounding?: {
    generic?: Array<{ url?: string; title?: string; snippets?: string[] }>;
  };
  sources?: Record<
    string,
    { title?: string; hostname?: string; age?: string[] }
  >;
}

interface BraveWeb {
  web?: {
    results?: Array<{
      url?: string;
      title?: string;
      description?: string;
      page_age?: string;
      extra_snippets?: string[];
      meta_url?: { hostname?: string };
    }>;
  };
}

/** Inline Goggles: an allowlist discards everything but the named sites. */
function goggles(request: SearchRequest): string | undefined {
  const rules = [
    ...(request.include_sites.length > 0 ? ["$discard"] : []),
    ...request.include_sites.map((site) => `$site=${site}`),
    ...request.exclude_sites.map((site) => `$discard,site=${site}`),
  ];
  return rules.length > 0 ? rules.join("\n") : undefined;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}

/**
 * Brave Search. Brave has one quality level, so every mode maps to it. The
 * content level picks the endpoint: `snippets` the Web Search API
 * (`GET /res/v1/web/search`), `context` the LLM Context API
 * (`GET /res/v1/llm/context`), which returns relevance-ranked text extracted
 * from each page for grounding.
 */
export const braveSearchProvider: SearchProviderModule = {
  kind: "search",
  apiVersion: SEARCH_PROVIDER_API_VERSION,
  id: "brave",
  capabilities: {
    modes: {
      fast: { setting: "search", approximate: "Brave has one quality level" },
      default: { setting: "search" },
      deep: { setting: "search", approximate: "Brave has one quality level" },
    },
    mode_parameter: "none (content selects web or llm/context)",
    max_results: 20,
    host: "api.search.brave.com",
    credential: { header: "X-Subscription-Token" },
    billing: "1 request on the Search plan, either endpoint",
    options: {
      freshness: "native",
      include_sites: "native",
      exclude_sites: "native",
      context: "native",
    },
  },
  async search(request, context) {
    const params = new URLSearchParams({
      q: request.query,
      count: String(request.max_results),
    });
    const web = request.content === "snippets";
    if (!web) params.set("maximum_number_of_urls", String(request.max_results));
    if (request.freshness)
      params.set("freshness", FRESHNESS[request.freshness]);
    const rules = goggles(request);
    if (rules) params.set("goggles", rules);
    const path = web ? "/res/v1/web/search" : "/res/v1/llm/context";
    const body = await requestJson(
      "brave",
      context,
      `${path}?${params.toString()}`,
      {
        method: "GET",
      },
    );
    const items: SearchResultItem[] = web
      ? ((body as BraveWeb).web?.results ?? []).flatMap((item) => {
          if (typeof item.url !== "string") return [];
          const snippet = stripTags(
            [item.description, ...(item.extra_snippets ?? [])]
              .filter(Boolean)
              .join(" … "),
          );
          const published = dateOf(item.page_age);
          const site = item.meta_url?.hostname ?? hostOf(item.url);
          return [
            {
              url: item.url,
              ...(item.title ? { title: stripTags(item.title) } : {}),
              ...(snippet
                ? { snippet: capText(snippet, request.max_chars) }
                : {}),
              ...(published ? { published_at: published } : {}),
              ...(site ? { site: site.replace(/^www\./, "") } : {}),
            },
          ];
        })
      : ((body as BraveContext).grounding?.generic ?? []).flatMap((item) => {
          if (typeof item.url !== "string") return [];
          const source = (body as BraveContext).sources?.[item.url];
          const snippet = (item.snippets ?? []).join(" … ");
          const published = dateOf(source?.age?.[1]);
          const site = source?.hostname ?? hostOf(item.url);
          const title = item.title || source?.title;
          return [
            {
              url: item.url,
              ...(title ? { title } : {}),
              ...(snippet
                ? { snippet: capText(snippet, request.max_chars) }
                : {}),
              ...(published ? { published_at: published } : {}),
              ...(site ? { site } : {}),
            },
          ];
        });
    return { results: items.slice(0, request.max_results) };
  },
};
