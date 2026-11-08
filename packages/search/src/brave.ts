import type {
  SearchProviderModule,
  SearchRequest,
  SearchResultItem,
} from "@introspection-ai/recipes/search";

import { searchResult } from "./text.js";

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

/** A Goggles rule for a site: `site=` takes a domain alone, so a path leads the rule. */
function siteRule(site: string, options: string): string {
  const slash = site.indexOf("/");
  const domain = slash < 0 ? site : site.slice(0, slash);
  const path = slash < 0 ? "" : site.slice(slash);
  return `${path}$${options}site=${domain}`;
}

/** Inline Goggles: an allowlist discards everything but the named sites. */
function goggles(request: SearchRequest): string | undefined {
  const rules = [
    ...(request.include_sites.length > 0 ? ["$discard"] : []),
    ...request.include_sites.map((site) => siteRule(site, "")),
    ...request.exclude_sites.map((site) => siteRule(site, "discard,")),
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
  apiVersion: 1,
  id: "brave",
  capabilities: {
    modes: {
      fast: { setting: "search", approximate: "Brave has one quality level" },
      default: { setting: "search" },
      deep: { setting: "search", approximate: "Brave has one quality level" },
    },
    mode_parameter: "none (content selects web or llm/context)",
    max_results: 20,
    max_query_chars: 400,
    max_query_words: 50,
    host: "api.search.brave.com",
    credential: { header: "X-Subscription-Token" },
    billing: "1 request on the Search plan, either endpoint",
    combine_sites: true,
    options: {
      freshness: "native",
      include_sites: "native",
      exclude_sites: "native",
      context: "native",
      country: "native",
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
    if (request.country) params.set("country", request.country);
    const rules = goggles(request);
    if (rules) params.set("goggles", rules);
    const path = web ? "/res/v1/web/search" : "/res/v1/llm/context";
    const body = await context.request(`${path}?${params.toString()}`, {
      method: "GET",
    });
    const items: SearchResultItem[] = web
      ? ((body as BraveWeb).web?.results ?? []).flatMap((item) =>
          searchResult(
            {
              url: item.url,
              title: item.title ? stripTags(item.title) : undefined,
              text: stripTags(
                [item.description, ...(item.extra_snippets ?? [])]
                  .filter(Boolean)
                  .join(" … "),
              ),
              published: item.page_age,
              site: item.meta_url?.hostname?.replace(/^www\./, ""),
            },
            request.max_chars,
          ),
        )
      : ((body as BraveContext).grounding?.generic ?? []).flatMap((item) => {
          const source =
            typeof item.url === "string"
              ? (body as BraveContext).sources?.[item.url]
              : undefined;
          return searchResult(
            {
              url: item.url,
              title: item.title || source?.title,
              text: (item.snippets ?? []).join(" … "),
              published: source?.age?.[1],
              site: source?.hostname,
            },
            request.max_chars,
          );
        });
    return { results: items.slice(0, request.max_results) };
  },
};
