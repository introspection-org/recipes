import type {
  SearchProviderModule,
  SearchProviderResult,
  SearchRequest,
} from "@introspection-ai/recipes/search";

import { mcpResultText, parsedJson, searchResult } from "./text.js";

/** Tavily's `country` values, from its Search API reference; it rejects any other name. */
const TAVILY_COUNTRIES: Readonly<Record<string, string>> = {
  AD: "andorra",
  AE: "united arab emirates",
  AF: "afghanistan",
  AL: "albania",
  AM: "armenia",
  AO: "angola",
  AR: "argentina",
  AT: "austria",
  AU: "australia",
  AZ: "azerbaijan",
  BA: "bosnia and herzegovina",
  BB: "barbados",
  BD: "bangladesh",
  BE: "belgium",
  BF: "burkina faso",
  BG: "bulgaria",
  BH: "bahrain",
  BI: "burundi",
  BJ: "benin",
  BN: "brunei",
  BO: "bolivia",
  BR: "brazil",
  BS: "bahamas",
  BT: "bhutan",
  BW: "botswana",
  BY: "belarus",
  BZ: "belize",
  CA: "canada",
  CF: "central african republic",
  CG: "congo",
  CH: "switzerland",
  CL: "chile",
  CM: "cameroon",
  CN: "china",
  CO: "colombia",
  CR: "costa rica",
  CU: "cuba",
  CV: "cape verde",
  CY: "cyprus",
  CZ: "czech republic",
  DE: "germany",
  DJ: "djibouti",
  DK: "denmark",
  DO: "dominican republic",
  DZ: "algeria",
  EC: "ecuador",
  EE: "estonia",
  EG: "egypt",
  ER: "eritrea",
  ES: "spain",
  ET: "ethiopia",
  FI: "finland",
  FJ: "fiji",
  FR: "france",
  GA: "gabon",
  GB: "united kingdom",
  GE: "georgia",
  GH: "ghana",
  GM: "gambia",
  GN: "guinea",
  GQ: "equatorial guinea",
  GR: "greece",
  GT: "guatemala",
  HN: "honduras",
  HR: "croatia",
  HT: "haiti",
  HU: "hungary",
  ID: "indonesia",
  IE: "ireland",
  IL: "israel",
  IN: "india",
  IQ: "iraq",
  IR: "iran",
  IS: "iceland",
  IT: "italy",
  JM: "jamaica",
  JO: "jordan",
  JP: "japan",
  KE: "kenya",
  KG: "kyrgyzstan",
  KH: "cambodia",
  KM: "comoros",
  KP: "north korea",
  KR: "south korea",
  KW: "kuwait",
  KZ: "kazakhstan",
  LB: "lebanon",
  LI: "liechtenstein",
  LK: "sri lanka",
  LR: "liberia",
  LS: "lesotho",
  LT: "lithuania",
  LU: "luxembourg",
  LV: "latvia",
  LY: "libya",
  MA: "morocco",
  MC: "monaco",
  MD: "moldova",
  ME: "montenegro",
  MG: "madagascar",
  MK: "north macedonia",
  ML: "mali",
  MM: "myanmar",
  MN: "mongolia",
  MR: "mauritania",
  MT: "malta",
  MU: "mauritius",
  MV: "maldives",
  MW: "malawi",
  MX: "mexico",
  MY: "malaysia",
  MZ: "mozambique",
  NA: "namibia",
  NE: "niger",
  NG: "nigeria",
  NI: "nicaragua",
  NL: "netherlands",
  NO: "norway",
  NP: "nepal",
  NZ: "new zealand",
  OM: "oman",
  PA: "panama",
  PE: "peru",
  PG: "papua new guinea",
  PH: "philippines",
  PK: "pakistan",
  PL: "poland",
  PT: "portugal",
  PY: "paraguay",
  QA: "qatar",
  RO: "romania",
  RS: "serbia",
  RU: "russia",
  RW: "rwanda",
  SA: "saudi arabia",
  SD: "sudan",
  SE: "sweden",
  SG: "singapore",
  SI: "slovenia",
  SK: "slovakia",
  SN: "senegal",
  SO: "somalia",
  SS: "south sudan",
  SV: "el salvador",
  SY: "syria",
  TD: "chad",
  TG: "togo",
  TH: "thailand",
  TJ: "tajikistan",
  TM: "turkmenistan",
  TN: "tunisia",
  TR: "turkey",
  TT: "trinidad and tobago",
  TW: "taiwan",
  TZ: "tanzania",
  UA: "ukraine",
  UG: "uganda",
  US: "united states",
  UY: "uruguay",
  UZ: "uzbekistan",
  VE: "venezuela",
  VN: "vietnam",
  YE: "yemen",
  ZA: "south africa",
  ZM: "zambia",
  ZW: "zimbabwe",
};

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
  const results = (body.results ?? []).flatMap((item) =>
    searchResult(
      {
        url: item.url,
        title: item.title,
        text: item.content,
        published: item.published_date,
        score: item.score,
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

/**
 * The results older Tavily MCP servers write as text (`format-results.ts` in
 * tavily-ai/tavily-mcp): `Title:`, `ID:`, `URL:`, `Content:` lines per result,
 * where content keeps its own newlines. The text carries no date, score or
 * credits. Current servers answer `structuredContent` and the same JSON as text.
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
 * Tavily's hosted MCP server, which answers the API's results with scores,
 * and dates when asked (`include_published_date`), but no credits; the mode
 * sets `search_depth` on either.
 */
export const tavilySearchProvider: SearchProviderModule = {
  kind: "search",
  apiVersion: 1,
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
    countries: Object.keys(TAVILY_COUNTRIES),
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
          include_published_date: true,
          ...(request.freshness ? { time_range: request.freshness } : {}),
          ...(request.include_sites.length
            ? { include_domains: request.include_sites }
            : {}),
          ...(request.exclude_sites.length
            ? { exclude_domains: request.exclude_sites }
            : {}),
          ...(request.country
            ? { country: TAVILY_COUNTRIES[request.country] }
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
      if (Array.isArray(structured?.results))
        return tavilyResults(structured, request);
      const text = mcpResultText(result);
      const json = parsedJson(text) as TavilyResponse | undefined;
      return tavilyResults(
        Array.isArray(json?.results) ? json : tavilyTextResults(text),
        request,
      );
    },
  },
  async search(request, context) {
    const body = (await context.request("/search", {
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
        ...(request.country
          ? { country: TAVILY_COUNTRIES[request.country] }
          : {}),
      },
    })) as TavilyResponse;
    return tavilyResults(body, request);
  },
};
