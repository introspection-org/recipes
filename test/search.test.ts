import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  boundSearchProviders,
  BUILTIN_SEARCH_PROVIDERS,
  createWebSearch,
  piSearchMcpClient,
  registerWebSearchTool,
  SEARCH_PROVIDER_API_VERSION,
  SEARCH_SKILL,
  webSearchParameters,
  type McpCallToolResult,
  type SearchProviderId,
  type SearchProviderModule,
  type SearchRequest,
  type WebSearchOptions,
  type WebSearchResult,
} from "../src/search/index.js";
import { mcpToolName } from "../src/mcp/pi-client.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

interface Recorded {
  method: string;
  path: string;
  url: URL;
  headers: IncomingMessage["headers"];
  body: any;
}

interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** A local HTTP server standing in for a provider's API. */
async function fakeApi(
  reply: (request: Recorded) => FakeReply,
): Promise<{ baseUrl: string; requests: Recorded[]; server: Server }> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const recorded: Recorded = {
        method: req.method ?? "GET",
        path: url.pathname,
        url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(recorded);
      const answer = reply(recorded);
      res.writeHead(answer.status ?? 200, {
        "content-type": "application/json",
        ...answer.headers,
      });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests, server };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

const PROXY_NATIVE = { INTROSPECTION_EGRESS_PROXY_NATIVE: "1" };
const LEGACY = {
  INTROSPECTION_EGRESS_URL: "http://egress.invalid:8081",
  INTROSPECTION_TOKEN: "locator-jwt",
};
const NOW = () => new Date("2026-11-06T12:00:00Z");

const braveContext = {
  grounding: {
    generic: [
      {
        url: "https://arxiv.org/abs/2601.00001",
        title: "Agents that search",
        snippets: ["First chunk about agents.", "Second chunk."],
      },
    ],
    map: [],
  },
  sources: {
    "https://arxiv.org/abs/2601.00001": {
      title: "Agents that search",
      hostname: "arxiv.org",
      age: ["Friday, October 2, 2026", "2026-10-02", "35 days ago"],
    },
  },
};

const braveWeb = {
  web: {
    results: [
      {
        url: "https://www.example.com/post",
        title: "Example <strong>post</strong>",
        description: `An <strong>example</strong> ${"x ".repeat(400)}`,
        page_age: "2026-11-01T08:00:00",
        meta_url: { hostname: "www.example.com" },
      },
    ],
  },
};

const tavilyBody = {
  query: "q",
  results: [
    {
      url: "https://news.example.org/a",
      title: "A",
      content: "Tavily content A",
      score: 0.91,
      published_date: "Mon, 02 Nov 2026 10:00:00 GMT",
    },
  ],
  usage: { credits: 2 },
};

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  ended: boolean;
}

function fakeTracer() {
  const spans: RecordedSpan[] = [];
  const span = (name: string, attributes: Record<string, unknown> = {}) => {
    const recorded: RecordedSpan = {
      name,
      attributes: { ...attributes },
      ended: false,
    };
    spans.push(recorded);
    return {
      setAttribute(key: string, value: unknown) {
        recorded.attributes[key] = value;
      },
      setAttributes(more: Record<string, unknown>) {
        Object.assign(recorded.attributes, more);
      },
      setStatus(status: { code: number; message?: string }) {
        recorded.status = status;
      },
      end() {
        recorded.ended = true;
      },
    };
  };
  const tracer = {
    startActiveSpan: (name: string, fn: (span: unknown) => unknown) =>
      fn(span(name)),
    startSpan: (
      name: string,
      options?: { attributes?: Record<string, unknown> },
    ) => span(name, options?.attributes),
  };
  return { spans, tracer: tracer as unknown as WebSearchOptions["tracer"] };
}

function setup(
  bound: SearchProviderId[],
  options: Partial<WebSearchOptions> = {},
  ctx: unknown = {},
) {
  const pi = createMockExtensionAPI();
  const { spans, tracer } = fakeTracer();
  registerWebSearchTool(pi, {
    bound,
    env: PROXY_NATIVE,
    now: NOW,
    tracer,
    ...options,
  });
  const tool = pi.tools.get("web_search")!;
  const call = async (params: Record<string, unknown>) =>
    (await tool.execute(
      "call-1",
      params as never,
      undefined,
      undefined,
      ctx as never,
    )) as {
      content: Array<{ text: string }>;
      details: WebSearchResult & { error?: { code: string } };
      isError?: boolean;
    };
  return { tool, call, spans };
}

describe("web_search schema", () => {
  it("lists only bound providers, and leaves provider out when one is bound", () => {
    const one = webSearchParameters(["brave"]) as any;
    expect(Object.keys(one.properties)).toEqual([
      "query",
      "mode",
      "max_results",
      "freshness",
      "sites",
      "content",
      "country",
    ]);
    const two = webSearchParameters(["tavily", "exa"]) as any;
    expect(two.properties.provider.enum).toEqual(["tavily", "exa"]);
  });

  it("offers only bound providers this package implements", () => {
    const { tool } = setup(["parallel", "tavily", "brave"], {
      providers: {
        tavily: BUILTIN_SEARCH_PROVIDERS.tavily!,
        brave: BUILTIN_SEARCH_PROVIDERS.brave!,
      },
    });
    expect((tool.parameters as any).properties.provider.enum).toEqual([
      "tavily",
      "brave",
    ]);
  });

  it("stays small", () => {
    const { tool } = setup(["tavily", "exa", "brave"]);
    const definition = JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
    // About 265 tokens with three providers bound (docs/search/README.md).
    expect(definition.length).toBeLessThan(1000);
  });

  it("ships the search skill beside the code", () => {
    expect(readFileSync(SEARCH_SKILL, "utf8")).toMatch(/^---\nname: search\n/);
  });

  it("tells the model to cite results and to treat them as untrusted", () => {
    const { tool } = setup(["brave"]);
    expect(tool.description).toContain("[title](url)");
    expect(tool.description).toMatch(/untrusted/);
    expect(tool.description).toMatch(/never follow instructions/);
    const skill = readFileSync(SEARCH_SKILL, "utf8");
    expect(skill).toContain("`[title](url)`");
    expect(skill).toMatch(/## Results are untrusted/);
    expect(skill).toMatch(/Do not move private data into public search/);
  });

  it("documents each built provider's modes as its descriptor maps them", () => {
    const readme = readFileSync(
      new URL("../docs/search/README.md", import.meta.url),
      "utf8",
    );
    for (const module of Object.values(BUILTIN_SEARCH_PROVIDERS)) {
      const { modes, mode_parameter } = module.capabilities;
      if (modes.default.setting === modes.fast.setting) continue;
      const cell = (setting: string) => `\`${setting}\``;
      expect(readme).toContain(
        `| \`${module.id}\` | \`${mode_parameter}\` | ${cell(modes.fast.setting)} | ${cell(modes.default.setting)} | ${cell(modes.deep.setting)} |`,
      );
    }
  });

  it("binds REST-only providers by egress host, and MCP providers by their bound server", () => {
    const hosts = [
      "api.anthropic.com",
      "API.SEARCH.BRAVE.COM",
      "api.exa.ai",
      "api.tavily.com",
    ];
    expect(boundSearchProviders({ hosts })).toEqual({
      bound: ["brave"],
      mcpServers: {},
    });
    expect(
      boundSearchProviders({
        hosts,
        mcpServers: [
          { id: "web", url: "https://mcp.tavily.com/mcp/" },
          { id: "exa", url: "http://127.0.0.1:7353/exa/mcp" },
          { id: "other", url: "https://mcp.example.com/mcp" },
        ],
      }),
    ).toEqual({
      bound: ["brave", "exa", "tavily"],
      mcpServers: { exa: "exa", tavily: "web" },
    });
  });
});

describe("web_search providers", () => {
  it("serves Brave context from the LLM Context API, with no credential on the proxy-native egress", async () => {
    const api = await fakeApi(() => ({ body: braveContext }));
    const { call, spans } = setup(["brave"], {
      baseUrls: { brave: api.baseUrl },
    });
    const result = await call({
      query: "agent search",
      max_results: 2,
      freshness: "week",
      sites: ["arxiv.org", "-pinterest.com"],
      content: "context",
    });
    expect(result.isError).toBeUndefined();
    const [request] = api.requests;
    expect(request!.method).toBe("GET");
    expect(request!.path).toBe("/res/v1/llm/context");
    expect(Object.fromEntries(request!.url.searchParams)).toEqual({
      q: "agent search",
      count: "2",
      maximum_number_of_urls: "2",
      freshness: "pw",
      goggles: "$discard\n$site=arxiv.org\n$discard,site=pinterest.com",
    });
    expect(request!.headers["x-subscription-token"]).toBeUndefined();
    expect(result.content[0]!.text).toBe(
      [
        "[1] Agents that search — arxiv.org · 2026-10-02",
        "https://arxiv.org/abs/2601.00001",
        "First chunk about agents. … Second chunk.",
      ].join("\n"),
    );
    expect(result.details).toMatchObject({
      provider: "brave",
      mode: "default",
      setting: "search",
      content: "context",
      notes: [],
      usage: { requests: 1 },
    });
    expect(spans).toEqual([
      expect.objectContaining({
        name: "web_search",
        ended: true,
        attributes: expect.objectContaining({
          "search.provider": "brave",
          "search.mode": "default",
          "search.content": "context",
          "introspection.usage.service": "brave/search",
          "introspection.usage.unit": "request",
          "introspection.usage.quantity": 1,
          "introspection.usage.variant": "search",
          "introspection.usage.key_owner": "customer",
        }),
      }),
    ]);
  });

  it("puts a site's path ahead of Brave's site= option, which takes a domain alone", async () => {
    const api = await fakeApi(() => ({ body: braveContext }));
    const { call } = setup(["brave"], { baseUrls: { brave: api.baseUrl } });
    await call({
      query: "agent search",
      sites: ["github.com/openai", "-example.com/spam/"],
      content: "context",
    });
    expect(api.requests[0]!.url.searchParams.get("goggles")).toBe(
      "$discard\n/openai$site=github.com\n/spam$discard,site=example.com",
    );
  });

  it("lowercases a site's domain but keeps its path as given", async () => {
    const brave = await fakeApi(() => ({ body: braveWeb }));
    const exa = await fakeApi(() => ({ body: { results: [] } }));
    const { call } = setup(["brave", "exa"], {
      baseUrls: { brave: brave.baseUrl, exa: exa.baseUrl },
    });
    await call({
      query: "q",
      provider: "brave",
      sites: ["-Example.ORG/Spam/API/"],
    });
    await call({
      query: "q",
      provider: "exa",
      sites: ["-Example.ORG/Spam/API"],
    });
    expect(brave.requests[0]!.url.searchParams.get("goggles")).toBe(
      "/Spam/API$discard,site=example.org",
    );
    expect(exa.requests[0]!.body.excludeDomains).toEqual([
      "example.org/Spam/API",
    ]);
  });

  it("serves Brave snippets from the Web Search API, and notes a mode it cannot honour", async () => {
    const api = await fakeApi(() => ({ body: braveWeb }));
    const { call } = setup(["brave"], { baseUrls: { brave: api.baseUrl } });
    const result = await call({ query: "x", mode: "deep" });
    expect(api.requests[0]!.path).toBe("/res/v1/web/search");
    const lines = result.content[0]!.text.split("\n");
    expect(lines[0]).toBe("[1] Example post — example.com · 2026-11-01");
    expect(lines[2]!.startsWith("An example x x")).toBe(true);
    expect(lines[2]!.length).toBeLessThanOrEqual(301);
    expect(lines.at(-1)).toBe(
      "(approximated: mode — Brave has one quality level)",
    );
  });

  it("puts the session locator in the provider's own header on the legacy lane", async () => {
    const brave = await fakeApi(() => ({ body: braveWeb }));
    const tavily = await fakeApi(() => ({ body: tavilyBody }));
    const { call } = setup(["brave", "tavily"], {
      env: LEGACY,
      baseUrls: { brave: brave.baseUrl, tavily: tavily.baseUrl },
    });
    await call({ query: "x", provider: "brave" });
    await call({ query: "x", provider: "tavily" });
    expect(brave.requests[0]!.headers["x-subscription-token"]).toBe(
      "locator-jwt",
    );
    expect(tavily.requests[0]!.headers.authorization).toBe(
      "Bearer locator-jwt",
    );
  });

  it("fails as not_configured with no egress, without calling the provider", async () => {
    const api = await fakeApi(() => ({ body: braveWeb }));
    const result = await setup(["brave"], {
      env: {},
      baseUrls: { brave: api.baseUrl },
    }).call({ query: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(
      /^web_search failed \(not_configured\)/,
    );
    expect(api.requests).toHaveLength(0);
  });

  it("maps Tavily's modes to search_depth, with context only in deep", async () => {
    const api = await fakeApi(() => ({ body: tavilyBody }));
    const { call, spans } = setup(["tavily"], {
      baseUrls: { tavily: api.baseUrl },
    });
    const result = await call({
      query: "agents",
      mode: "deep",
      freshness: "month",
      sites: ["example.org"],
      content: "context",
    });
    expect(api.requests[0]!.path).toBe("/search");
    expect(api.requests[0]!.body).toEqual({
      query: "agents",
      search_depth: "advanced",
      max_results: 5,
      include_usage: true,
      chunks_per_source: 3,
      time_range: "month",
      include_domains: ["example.org"],
    });
    expect(result.content[0]!.text).toBe(
      [
        "[1] A — news.example.org · 2026-11-02",
        "https://news.example.org/a",
        "Tavily content A",
        "",
        "(approximated: context — Tavily returns up to 3 relevant chunks per result (chunks_per_source) only in deep mode; other modes return one snippet.)",
      ].join("\n"),
    );
    expect(spans[0]!.attributes).toMatchObject({
      "search.provider": "tavily",
      "search.mode": "deep",
      "search.setting": "advanced",
      "search.units.name": "credits",
      "search.units.count": 2,
      "introspection.usage.service": "tavily/search",
      "introspection.usage.unit": "credit",
      "introspection.usage.quantity": 2,
      "introspection.usage.variant": "advanced",
      "introspection.usage.results": 1,
      "introspection.usage.key_owner": "customer",
    });
    expect(spans[0]!.attributes).not.toHaveProperty(
      "introspection.usage.cost_usd",
    );

    await call({ query: "agents" });
    expect(api.requests[1]!.body).toEqual({
      query: "agents",
      search_depth: "basic",
      max_results: 5,
      include_usage: true,
    });
  });

  it("maps Exa's modes to type and freshness to a published-date start", async () => {
    const api = await fakeApi(() => ({
      body: {
        results: [
          {
            url: "https://exa.example/p",
            title: "P",
            publishedDate: "2026-11-01T00:00:00.000Z",
            score: 0.4,
            highlights: ["one", "two"],
          },
        ],
        costDollars: { total: 0.005 },
      },
    }));
    const { call, spans } = setup(["exa"], { baseUrls: { exa: api.baseUrl } });
    const result = await call({
      query: "q",
      freshness: "week",
      max_results: 3,
    });
    expect(api.requests[0]!.body).toEqual({
      query: "q",
      type: "auto",
      numResults: 3,
      contents: { highlights: { maxCharacters: 300 } },
      startPublishedDate: "2026-10-30",
    });
    expect(result.content[0]!.text).toContain("one … two");
    expect(result.content[0]!.text).toMatch(
      /\(approximated: freshness — Exa filters on published date/,
    );
    expect(result.details.usage.units).toEqual({ name: "usd", count: 0.005 });
    expect(spans[0]!.attributes).toMatchObject({
      "introspection.usage.service": "exa/search",
      "introspection.usage.unit": "request",
      "introspection.usage.quantity": 1,
      "introspection.usage.variant": "auto",
      "introspection.usage.cost_usd": 0.005,
      "introspection.usage.key_owner": "customer",
    });
    await call({ query: "q", mode: "fast", content: "context" });
    expect(api.requests[1]!.body).toMatchObject({
      type: "fast",
      contents: { highlights: { maxCharacters: 1500 } },
    });
  });

  it("passes country to each provider in its own form", async () => {
    const tavily = await fakeApi(() => ({ body: { results: [] } }));
    const exa = await fakeApi(() => ({ body: { results: [] } }));
    const brave = await fakeApi(() => ({ body: braveWeb }));
    const { call } = setup(["tavily", "exa", "brave"], {
      baseUrls: {
        tavily: tavily.baseUrl,
        exa: exa.baseUrl,
        brave: brave.baseUrl,
      },
    });
    for (const provider of ["tavily", "exa", "brave"])
      expect(
        (await call({ query: "q", provider, country: "GB" })).details.notes,
      ).toEqual([]);
    expect(tavily.requests[0]!.body).toMatchObject({
      country: "united kingdom",
    });
    expect(exa.requests[0]!.body).toMatchObject({ userLocation: "GB" });
    expect(brave.requests[0]!.url.searchParams.get("country")).toBe("GB");
  });

  it("refuses a country that is not an ISO 3166-1 alpha-2 code", async () => {
    const { call } = setup(["brave"]);
    for (const country of ["ZZ", "XX", "EU", "gb", "GBR"]) {
      const result = await call({ query: "q", country });
      expect(result.details.error).toMatchObject({ code: "invalid_request" });
    }
  });
});

describe("web_search routing", () => {
  const plain: SearchProviderModule = {
    kind: "search",
    apiVersion: SEARCH_PROVIDER_API_VERSION,
    id: "keenable",
    capabilities: {
      modes: {
        fast: { setting: "pro" },
        default: { setting: "pro" },
        deep: { setting: "pro" },
      },
      mode_parameter: "mode",
      max_results: 3,
      combine_sites: false,
      host: "api.keenable.ai",
      credential: { header: "X-API-Key" },
      billing: "per request",
      options: {
        freshness: "none",
        include_sites: "native",
        exclude_sites: "none",
        context: "none",
        country: "none",
      },
    },
    async search(request) {
      return {
        results: Array.from({ length: request.max_results }, (_, index) => ({
          url: `https://plain.invalid/${index}`,
          title: `R${index}`,
          site: "plain.invalid",
        })),
      };
    },
  };
  const providers = { ...BUILTIN_SEARCH_PROVIDERS, keenable: plain };

  it("tells the model what it ignored or capped", async () => {
    const result = await setup(["keenable"], { providers }).call({
      query: "x",
      freshness: "day",
      max_results: 8,
      sites: ["-pinterest.com"],
      content: "context",
      country: "DE",
    });
    expect(result.details.results).toHaveLength(3);
    expect(result.content[0]!.text.split("\n").slice(-5)).toEqual([
      "(ignored: freshness — not supported by keenable)",
      "(ignored: exclude sites — not supported by keenable)",
      "(ignored: context — not supported by keenable)",
      "(ignored: country — not supported by keenable)",
      "(approximated: max results — keenable returns at most 3)",
    ]);
  });

  it("sends only the included sites to a provider that cannot combine them, and says so", async () => {
    const requests: SearchRequest[] = [];
    const exclusive: SearchProviderModule = {
      ...plain,
      id: "perplexity",
      capabilities: {
        ...plain.capabilities,
        combine_sites: false,
        options: {
          ...plain.capabilities.options,
          include_sites: "native",
          exclude_sites: "native",
        },
      },
      async search(request, context) {
        requests.push(request);
        return plain.search(request, context);
      },
    };
    const result = await setup(["perplexity"], {
      providers: { ...BUILTIN_SEARCH_PROVIDERS, perplexity: exclusive },
    }).call({ query: "x", sites: ["arxiv.org", "-spam.com"] });
    expect(requests[0]).toMatchObject({
      include_sites: ["arxiv.org"],
      exclude_sites: [],
    });
    expect(result.details.notes).toContainEqual({
      option: "exclude_sites",
      outcome: "ignored",
      detail:
        "perplexity cannot combine included and excluded sites, so only the included ones apply",
    });
    const excludeOnly = await setup(["perplexity"], {
      providers: { ...BUILTIN_SEARCH_PROVIDERS, perplexity: exclusive },
    }).call({ query: "x", sites: ["-spam.com"], max_results: 3 });
    expect(requests[1]).toMatchObject({ exclude_sites: ["spam.com"] });
    expect(excludeOnly.details.notes).toEqual([]);
  });

  it("declares which built providers combine included and excluded sites", () => {
    expect(
      Object.fromEntries(
        Object.values(BUILTIN_SEARCH_PROVIDERS).map((module) => [
          module.id,
          module.capabilities.combine_sites,
        ]),
      ),
    ).toEqual({
      brave: true,
      exa: true,
      keenable: false,
      parallel: false,
      perplexity: false,
      tavily: true,
    });
  });

  it("refuses an unnamed provider when several are bound, and an unbound one", async () => {
    const { call, spans } = setup(["keenable", "brave"], { providers });
    const unnamed = await call({ query: "x" });
    expect(unnamed.isError).toBe(true);
    expect(unnamed.content[0]!.text).toBe(
      "web_search failed (not_bound): Several search providers are bound; name one: keenable, brave.",
    );
    const unbound = await call({ query: "x", provider: "exa" });
    expect(unbound.content[0]!.text).toMatch(/not_bound.*exa is not bound/);
    expect(spans[1]!.status?.message).toMatch(/exa is not bound/);
    expect(
      (await call({ query: "x", provider: "keenable", sites: ["not a site"] }))
        .isError,
    ).toBe(true);
  });

  it("serves Recipe code with the same arguments", async () => {
    const tavily = await fakeApi(() => ({ body: tavilyBody }));
    const search = createWebSearch({
      bound: ["tavily"],
      env: PROXY_NATIVE,
      baseUrls: { tavily: tavily.baseUrl },
      tracer: fakeTracer().tracer,
    });
    const result = await search({
      query: "x",
      provider: "tavily",
      mode: "fast",
    });
    expect(result).toMatchObject({
      provider: "tavily",
      mode: "fast",
      setting: "fast",
    });
    await expect(search({ query: "" })).rejects.toThrow(
      /Invalid web_search arguments/,
    );
  });

  it("reports a rate limit with its retry delay", async () => {
    const tavily = await fakeApi(() => ({
      status: 429,
      headers: { "retry-after": "30" },
      body: { detail: "slow down" },
    }));
    const result = await setup(["tavily"], {
      baseUrls: { tavily: tavily.baseUrl },
    }).call({ query: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      'web_search failed (too_many_requests): tavily answered 429: {"detail":"slow down"} Retry after 30s.',
    );
    expect(result.details.error).toMatchObject({
      code: "too_many_requests",
      status: 429,
      retry_after_seconds: 30,
    });
  });

  it("reads a Retry-After date as seconds from now", async () => {
    const brave = await fakeApi(() => ({
      status: 429,
      headers: {
        "retry-after": new Date(NOW().getTime() + 90_000).toUTCString(),
      },
      body: {},
    }));
    const result = await setup(["brave"], {
      baseUrls: { brave: brave.baseUrl },
    }).call({ query: "x" });
    expect(result.details.error).toMatchObject({
      code: "too_many_requests",
      retry_after_seconds: 90,
    });
  });

  it("refuses a query longer than the provider accepts, before calling it", async () => {
    const brave = await fakeApi(() => ({ body: braveWeb }));
    const { call } = setup(["brave"], { baseUrls: { brave: brave.baseUrl } });
    const long = await call({ query: "x".repeat(401) });
    expect(long.isError).toBe(true);
    expect(long.details.error).toMatchObject({
      code: "query_too_long",
      limit: 400,
    });
    const wordy = await call({ query: Array(51).fill("w").join(" ") });
    expect(wordy.details.error).toMatchObject({
      code: "query_too_long",
      limit: 50,
    });
    expect(brave.requests).toHaveLength(0);
  });

  it("refuses calls past the Recipe's budget with the limit it set", async () => {
    const brave = await fakeApi(() => ({ body: braveWeb }));
    const { call, spans } = setup(["brave"], {
      baseUrls: { brave: brave.baseUrl },
      maxUses: 2,
    });
    expect((await call({ query: "a" })).isError).toBeUndefined();
    expect((await call({ query: "b" })).isError).toBeUndefined();
    const third = await call({ query: "c" });
    expect(third.isError).toBe(true);
    expect(third.details.error).toMatchObject({
      code: "max_uses_exceeded",
      limit: 2,
    });
    expect(third.content[0]!.text).toMatch(
      /^web_search failed \(max_uses_exceeded\): This task may search at most 2 times/,
    );
    expect(brave.requests).toHaveLength(2);
    expect(spans[2]!.attributes["error.type"]).toBe("max_uses_exceeded");
  });

  it("refuses a budget that is not a whole number", () => {
    expect(() => setup(["brave"], { maxUses: -1 })).toThrow(/maxUses/);
  });
});

/** A Pi tool context whose MCP tools answer from handlers, as Pi's built-in client returns them. */
function fakePiMcp(
  tools: Record<string, (args: Record<string, unknown>) => McpCallToolResult>,
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ctx = {
    tools: Object.keys(tools).map((name) => ({ name })),
    async executeTool(name: string, args: unknown) {
      calls.push({ name, args: args as Record<string, unknown> });
      const handler = tools[name];
      if (!handler)
        return {
          isError: true,
          result: {
            content: [{ type: "text", text: `Tool ${name} not found` }],
          },
        };
      const result = handler(args as Record<string, unknown>);
      return {
        isError: Boolean(result.isError),
        result: {
          content: result.content ?? [],
          structuredContent: result,
        },
      };
    },
  };
  return { ctx, calls };
}

const text = (value: string): McpCallToolResult => ({
  content: [{ type: "text", text: value }],
});

/** What tavily-mcp's `tavily_search` writes (src/format-results.ts). */
const TAVILY_MCP_TEXT = [
  "Request ID: r-1",
  "Detailed Results:",
  "",
  "Title: A",
  "ID: a",
  "URL: https://news.example.org/a",
  "Content: Tavily content A",
  "",
  "Title: B",
  "URL: https://b.example.com/b",
  "Content: Tavily content B",
].join("\n");

/** What exa-search-server 3.5.0's `web_search_advanced_exa` answers as text, live. */
const EXA_ADVANCED_JSON = {
  requestId: "ff89f170df30f8b0482c4ad19e688a12",
  resolvedSearchType: "",
  results: [
    {
      id: "https://exa.example/p",
      url: "https://exa.example/p",
      publishedDate: "2026-11-01T00:00:00.000Z",
      image: "https://exa.example/og.png",
      title: "P",
      highlights: ["one", "two"],
    },
  ],
  searchTime: 2360.7,
  costDollars: { total: 0.007, search: { neural: 0.007 } },
};

/** What tavily-mcp 4.1.5's `tavily_search` answers, live: structuredContent and the same JSON as text. */
const TAVILY_MCP_JSON = {
  query: "agents",
  follow_up_questions: null,
  answer: null,
  images: [],
  results: [
    {
      url: "https://news.example.org/a",
      title: "A",
      content: "## Recall\n\nTavily content A",
      score: 0.90692574,
      raw_content: null,
      published_date: "Sun, 26 Apr 2026 00:00:00 GMT",
      id: "3c9aac-00",
    },
  ],
  response_time: 1.21,
  request_id: "fa45ee95-8134-43ff-b99a-edcd5e53d0c7",
  auth_mode: "keyed",
};

/** What exa-mcp-server's `web_search_exa` writes (src/tools/webSearch.ts). */
const EXA_MCP_TEXT = [
  "Title: P",
  "URL: https://exa.example/p",
  "Published: 2026-11-01T00:00:00.000Z",
  "Author: N/A",
  "Highlights:\none\ntwo",
].join("\n");

describe("web_search over a provider's MCP server", () => {
  const TAVILY = mcpToolName("tavily", "tavily_search");
  const EXA_ADVANCED = mcpToolName("exa", "web_search_advanced_exa");
  const EXA_DEFAULT = mcpToolName("exa", "web_search_exa");

  it("calls Tavily's MCP tool through Pi's executeTool, with an MCP span", async () => {
    const rest = await fakeApi(() => ({ body: tavilyBody }));
    const { ctx, calls } = fakePiMcp({ [TAVILY]: () => text(TAVILY_MCP_TEXT) });
    const { tool, call, spans } = setup(
      ["tavily"],
      { mcpServers: { tavily: "tavily" }, baseUrls: { tavily: rest.baseUrl } },
      ctx,
    );
    expect((tool as any).reachesTools()).toEqual([TAVILY]);
    const result = await call({
      query: "agents",
      mode: "deep",
      freshness: "week",
      sites: ["example.org", "-spam.com"],
      country: "US",
    });
    expect(calls).toEqual([
      {
        name: TAVILY,
        args: {
          query: "agents",
          search_depth: "advanced",
          max_results: 5,
          include_published_date: true,
          time_range: "week",
          include_domains: ["example.org"],
          exclude_domains: ["spam.com"],
          country: "united states",
        },
      },
    ]);
    expect(rest.requests).toHaveLength(0);
    expect(result.content[0]!.text).toBe(
      [
        "[1] A — news.example.org",
        "https://news.example.org/a",
        "Tavily content A",
        "",
        "[2] B — b.example.com",
        "https://b.example.com/b",
        "Tavily content B",
      ].join("\n"),
    );
    expect(result.details).toMatchObject({
      provider: "tavily",
      transport: "mcp",
    });
    expect(spans.map((span) => span.name)).toEqual([
      "web_search",
      "tools/call tavily_search",
    ]);
    expect(spans[0]!.attributes["search.transport"]).toBe("mcp");
    expect(spans[1]!.attributes).toMatchObject({
      "mcp.method.name": "tools/call",
      "gen_ai.tool.name": "tavily_search",
      "search.mcp.server": "tavily",
    });
  });

  it("keeps a Tavily MCP result's content across its own newlines", async () => {
    const multiline = [
      "Detailed Results:",
      "",
      "Title: A",
      "URL: https://news.example.org/a",
      "Content: first line",
      "second line",
      "",
      "third line",
      "",
      "Title: B",
      "URL: https://b.example.com/b",
      "Content: only line",
      "",
      "Images:",
      "",
      "[1] URL: https://img.example/x.png",
    ].join("\n");
    const { ctx } = fakePiMcp({ [TAVILY]: () => text(multiline) });
    const { call } = setup(
      ["tavily"],
      { mcpServers: { tavily: "tavily" } },
      ctx,
    );
    const result = await call({ query: "agents" });
    const snippets = (result.details as any).results.map((r: any) => r.snippet);
    expect(snippets).toEqual([
      "first line second line third line",
      "only line",
    ]);
  });

  it("falls back to REST for what the MCP tool cannot express, or notes it when REST is not bound", async () => {
    const rest = await fakeApi(() => ({ body: tavilyBody }));
    const { ctx, calls } = fakePiMcp({ [TAVILY]: () => text(TAVILY_MCP_TEXT) });
    const args = { query: "agents", mode: "deep", content: "context" };
    const both = await setup(
      ["tavily"],
      { mcpServers: { tavily: "tavily" }, baseUrls: { tavily: rest.baseUrl } },
      ctx,
    ).call(args);
    expect(both.details.transport).toBe("rest");
    expect(rest.requests[0]!.body.chunks_per_source).toBe(3);
    expect(calls).toHaveLength(0);

    const mcpOnly = await setup(
      [],
      { mcpServers: { tavily: "tavily" } },
      ctx,
    ).call(args);
    expect(mcpOnly.details.transport).toBe("mcp");
    expect(mcpOnly.content[0]!.text.split("\n").at(-1)).toBe(
      "(ignored: context — tavily's MCP tool tavily_search cannot express it)",
    );
  });

  it("prefers Exa's advanced MCP tool and reads its JSON", async () => {
    const { ctx, calls } = fakePiMcp({
      [EXA_ADVANCED]: () => text(JSON.stringify(EXA_ADVANCED_JSON)),
      [EXA_DEFAULT]: () => text(EXA_MCP_TEXT),
    });
    const { call } = setup([], { mcpServers: { exa: "exa" } }, ctx);
    const result = await call({
      query: "q",
      freshness: "week",
      sites: ["exa.example"],
      country: "FR",
    });
    expect(calls[0]).toEqual({
      name: EXA_ADVANCED,
      args: {
        query: "q",
        type: "auto",
        numResults: 5,
        enableHighlights: true,
        highlightsMaxCharacters: 300,
        startPublishedDate: "2026-10-30",
        includeDomains: ["exa.example"],
        userLocation: "FR",
      },
    });
    expect(result.content[0]!.text.split("\n")[0]).toBe(
      "[1] P — exa.example · 2026-11-01",
    );
    expect(result.details.usage.units).toEqual({ name: "usd", count: 0.007 });
  });

  it("uses Exa's default MCP tool for a plain query, and REST when it cannot filter", async () => {
    const rest = await fakeApi(() => ({ body: { results: [] } }));
    const { ctx, calls } = fakePiMcp({
      [EXA_DEFAULT]: () => text(EXA_MCP_TEXT),
    });
    const { call } = setup(
      ["exa"],
      { mcpServers: { exa: "exa" }, baseUrls: { exa: rest.baseUrl } },
      ctx,
    );
    const plain = await call({ query: "q" });
    expect(calls[0]).toEqual({
      name: EXA_DEFAULT,
      args: { query: "q", numResults: 5 },
    });
    expect(plain.content[0]!.text).toBe(
      [
        "[1] P — exa.example · 2026-11-01",
        "https://exa.example/p",
        "one … two",
      ].join("\n"),
    );
    const filtered = await call({ query: "q", freshness: "day" });
    expect(filtered.details.transport).toBe("rest");
    expect(rest.requests).toHaveLength(1);
    const located = await call({ query: "q", country: "JP" });
    expect(located.details.transport).toBe("rest");
    expect(rest.requests[1]!.body).toMatchObject({ userLocation: "JP" });
  });

  it("reads Tavily's structuredContent with scores and dates, or the same JSON as text", async () => {
    const structured = fakePiMcp({
      [TAVILY]: () => ({
        ...text(JSON.stringify(TAVILY_MCP_JSON)),
        structuredContent: TAVILY_MCP_JSON,
      }),
    });
    const textOnly = fakePiMcp({
      [TAVILY]: () => text(JSON.stringify(TAVILY_MCP_JSON)),
    });
    for (const { ctx } of [structured, textOnly]) {
      const result = await setup(
        [],
        { mcpServers: { tavily: "tavily" } },
        ctx,
      ).call({ query: "agents" });
      expect(result.details.results).toEqual([
        {
          url: "https://news.example.org/a",
          title: "A",
          snippet: "## Recall Tavily content A",
          published_at: "2026-04-26",
          score: 0.90692574,
          site: "news.example.org",
        },
      ]);
      expect(result.details.usage).toEqual({ requests: 1 });
    }
  });

  it("runs Exa's deep mode on REST, since the advanced MCP tool's type has no deep", async () => {
    const rest = await fakeApi(() => ({ body: { results: [] } }));
    const { ctx, calls } = fakePiMcp({
      [EXA_ADVANCED]: () => text(JSON.stringify(EXA_ADVANCED_JSON)),
    });
    const both = await setup(
      ["exa"],
      { mcpServers: { exa: "exa" }, baseUrls: { exa: rest.baseUrl } },
      ctx,
    ).call({ query: "q", mode: "deep" });
    expect(both.details.transport).toBe("rest");
    expect(rest.requests[0]!.body).toMatchObject({ type: "deep" });
    expect(calls).toHaveLength(0);

    const mcpOnly = await setup([], { mcpServers: { exa: "exa" } }, ctx).call({
      query: "q",
      mode: "deep",
    });
    expect(calls[0]!.args).toMatchObject({ type: "auto" });
    expect(mcpOnly.details).toMatchObject({ mode: "deep", setting: "auto" });
    expect(mcpOnly.details.notes).toEqual([
      {
        option: "mode",
        outcome: "approximated",
        detail:
          "exa's MCP tool web_search_advanced_exa cannot run this mode, so it ran auto",
      },
    ]);
  });

  it("records the setting Exa's default MCP tool ran, not the mode's", async () => {
    const { ctx } = fakePiMcp({ [EXA_DEFAULT]: () => text(EXA_MCP_TEXT) });
    const { call, spans } = setup([], { mcpServers: { exa: "exa" } }, ctx);
    const result = await call({ query: "q", mode: "deep" });
    expect(result.details).toMatchObject({ mode: "deep", setting: "auto" });
    expect(spans[0]!.attributes).toMatchObject({
      "search.mode": "deep",
      "search.setting": "auto",
      "introspection.usage.variant": "auto",
    });
    expect(result.details.notes).toContainEqual({
      option: "mode",
      outcome: "approximated",
      detail:
        "exa's MCP tool web_search_exa cannot run this mode, so it ran auto",
    });
  });

  it("takes an MCP tool as its server's only when Pi's namespace says so", () => {
    const { ctx } = fakePiMcp({ [TAVILY]: () => text(TAVILY_MCP_TEXT) });
    const namespaced = (name: string, aliases: string[]) => () => [
      { name: TAVILY, namespace: { name, aliases } as never },
    ];
    expect(piSearchMcpClient(ctx).hasTool("tavily", "tavily_search")).toBe(
      true,
    );
    expect(
      piSearchMcpClient(ctx, namespaced("mcp__tavily", ["tavily"])).hasTool(
        "tavily",
        "tavily_search",
      ),
    ).toBe(true);
    // Another server's tool that Pi happened to give the same name.
    expect(
      piSearchMcpClient(ctx, namespaced("mcp__tavily", ["other"])).hasTool(
        "tavily",
        "tavily_search",
      ),
    ).toBe(false);
    expect(piSearchMcpClient(ctx).hasTool("exa", "web_search_exa")).toBe(false);
  });

  it("reports a tool error, a call Pi refused, and an MCP-only provider with no client", async () => {
    const failing = fakePiMcp({
      [TAVILY]: () => ({ ...text("quota exceeded"), isError: true }),
    });
    const failed = await setup(
      [],
      { mcpServers: { tavily: "tavily" } },
      failing.ctx,
    ).call({ query: "x" });
    expect(failed.content[0]!.text).toBe(
      "web_search failed (provider_error): tavily/tavily_search failed: quota exceeded",
    );

    const refused = {
      tools: [{ name: TAVILY }],
      executeTool: async () => ({
        isError: true,
        result: { content: [{ type: "text", text: "blocked by policy" }] },
      }),
    };
    const blocked = await setup(
      [],
      { mcpServers: { tavily: "tavily" } },
      refused,
    ).call({ query: "x" });
    expect(blocked.content[0]!.text).toBe(
      "web_search failed (unavailable): MCP tool tavily/tavily_search could not be called: blocked by policy",
    );

    const search = createWebSearch({
      bound: [],
      mcpServers: { tavily: "tavily" },
      tracer: fakeTracer().tracer,
    });
    await expect(search({ query: "x" })).rejects.toThrow(
      /bound only as an MCP server, and this call has no MCP client/,
    );
    const served = await search(
      { query: "x" },
      {
        mcp: piSearchMcpClient(
          fakePiMcp({ [TAVILY]: () => text(TAVILY_MCP_TEXT) }).ctx,
        ),
      },
    );
    expect(served.transport).toBe("mcp");
  });
});

/** What api.keenable.ai answers, live: REST adds `usage`; MCP's JSON text lacks it. */
const keenableBody = {
  query: "q",
  mode: "realtime",
  results: [
    {
      title: "Support RabitQ in pgvector",
      url: "https://github.com/pgvector/pgvector/issues/1003",
      description: "",
      snippet: "We have implemented RaBitQ quantization for HNSW.",
      published_at: "2026-07-28T08:58:47Z",
      acquired_at: "2026-09-19T17:03:41Z",
    },
    {
      title: "Undated",
      url: "https://example.com/undated",
      description: "Only a description",
      snippet: "",
      acquired_at: "2026-10-14T12:46:02Z",
    },
  ],
};

/** What perplexity_search writes (perplexityai/modelcontextprotocol `formatSearchResults`). */
const PERPLEXITY_MCP_TEXT = [
  "Found 2 search results:",
  "",
  "1. **Agents that search**",
  "   URL: https://arxiv.org/abs/2601.00001",
  "   First line of the snippet.",
  "Second line, unindented.",
  "   Date: 2026-10-02",
  "   Last updated: 2026-10-05",
  "",
  "2. **Undated page**",
  "   URL: https://example.com/p",
  "   Just a snippet.",
  "",
].join("\n");

describe("web_search over Keenable, Perplexity and Parallel", () => {
  const KEENABLE = mcpToolName("keenable", "search_web_pages");
  const PERPLEXITY = mcpToolName("perplexity", "perplexity_search");

  it("maps Keenable's modes, one site and freshness onto REST, and records its credits", async () => {
    const api = await fakeApi(() => ({
      body: {
        ...keenableBody,
        usage: { sku: "search.realtime", amount: 1, credits: 1, paid: false },
      },
    }));
    const { call, spans } = setup(["keenable"], {
      baseUrls: { keenable: api.baseUrl },
    });
    const result = await call({
      query: "pgvector",
      mode: "fast",
      freshness: "month",
      sites: ["github.com", "arxiv.org", "-pinterest.com"],
      country: "US",
    });
    expect(api.requests[0]!.path).toBe("/v1/search");
    expect(api.requests[0]!.body).toEqual({
      query: "pgvector",
      mode: "realtime",
      max_results: 5,
      snippet_max_length: 300,
      published_after: "1mo",
      site: "github.com",
    });
    expect(api.requests[0]!.headers["x-api-key"]).toBeUndefined();
    expect(result.content[0]!.text).toBe(
      [
        "[1] Support RabitQ in pgvector — github.com · 2026-07-28",
        "https://github.com/pgvector/pgvector/issues/1003",
        "We have implemented RaBitQ quantization for HNSW.",
        "",
        "[2] Undated — example.com",
        "https://example.com/undated",
        "Only a description",
        "",
        "(approximated: freshness — Keenable filters on publish time from the start of the window, so pages with no known publish date may drop out.)",
        "(ignored: exclude sites — not supported by keenable)",
        "(ignored: country — not supported by keenable)",
        "(ignored: include sites — keenable restricts to at most 1 site, so arxiv.org did not apply)",
      ].join("\n"),
    );
    expect(spans[0]!.attributes).toMatchObject({
      "search.setting": "realtime",
      "search.units.name": "credits",
      "introspection.usage.service": "keenable/search",
      "introspection.usage.unit": "credit",
      "introspection.usage.quantity": 1,
      "introspection.usage.variant": "realtime",
    });

    await call({ query: "q", mode: "deep", content: "context" });
    expect(api.requests[1]!.body).toEqual({
      query: "q",
      mode: "pro",
      max_results: 5,
      snippet_max_length: 1500,
    });
  });

  it("calls Keenable's MCP tool for JSON and reads it, and fails on text it cannot read", async () => {
    const { ctx, calls } = fakePiMcp({
      [KEENABLE]: () => text(JSON.stringify(keenableBody)),
    });
    const { call } = setup([], { mcpServers: { keenable: "keenable" } }, ctx);
    const result = await call({
      query: "q",
      freshness: "day",
      sites: ["github.com"],
    });
    expect(calls[0]).toEqual({
      name: KEENABLE,
      args: {
        query: "q",
        mode: "pro",
        max_results: 5,
        snippet_max_length: 300,
        published_after: "1d",
        site: "github.com",
        output_format: "json",
      },
    });
    expect(result.details).toMatchObject({
      transport: "mcp",
      usage: { requests: 1 },
    });
    expect(result.details.results[0]).toMatchObject({
      published_at: "2026-07-28",
      site: "github.com",
    });

    const readable = fakePiMcp({ [KEENABLE]: () => text("1. Some page") });
    const failed = await setup(
      [],
      { mcpServers: { keenable: "keenable" } },
      readable.ctx,
    ).call({ query: "q" });
    expect(failed.details.error).toMatchObject({ code: "provider_error" });
  });

  it("calls Perplexity's MCP tool and reads its formatted text", async () => {
    const { ctx, calls } = fakePiMcp({
      [PERPLEXITY]: () => ({
        ...text(PERPLEXITY_MCP_TEXT),
        structuredContent: { results: PERPLEXITY_MCP_TEXT },
      }),
    });
    const { call } = setup(
      [],
      { mcpServers: { perplexity: "perplexity" } },
      ctx,
    );
    const result = await call({
      query: "agents",
      mode: "fast",
      freshness: "week",
      sites: ["arxiv.org", "-spam.com"],
      country: "DE",
      content: "context",
    });
    expect(calls[0]).toEqual({
      name: PERPLEXITY,
      args: {
        query: "agents",
        max_results: 5,
        max_tokens_per_page: 1024,
        search_type: "fast",
        country: "DE",
        search_recency_filter: "week",
        search_domain_filter: ["arxiv.org"],
      },
    });
    expect(result.content[0]!.text).toBe(
      [
        "[1] Agents that search — arxiv.org · 2026-10-02",
        "https://arxiv.org/abs/2601.00001",
        "First line of the snippet. Second line, unindented.",
        "",
        "[2] Undated page — example.com",
        "https://example.com/p",
        "Just a snippet.",
        "",
        "(ignored: exclude sites — perplexity cannot combine included and excluded sites, so only the included ones apply)",
      ].join("\n"),
    );
    // The text from structuredContent alone, as a client that drops content would see it.
    const structuredOnly = fakePiMcp({
      [PERPLEXITY]: () => ({
        content: [],
        structuredContent: { results: PERPLEXITY_MCP_TEXT },
      }),
    });
    const fromStructured = await setup(
      [],
      { mcpServers: { perplexity: "perplexity" } },
      structuredOnly.ctx,
    ).call({ query: "agents", sites: ["-spam.com"], mode: "deep" });
    expect(structuredOnly.calls[0]!.args).toMatchObject({
      search_type: "web",
      max_tokens_per_page: 256,
      search_domain_filter: ["-spam.com"],
    });
    expect(fromStructured.details.results).toHaveLength(2);
    expect(fromStructured.details.notes).toEqual([
      {
        option: "mode",
        outcome: "approximated",
        detail:
          "Perplexity's Search API has nothing deeper than web, its default",
      },
    ]);
  });

  it("serves Perplexity over REST with the bearer on the legacy lane", async () => {
    const api = await fakeApi(() => ({
      body: {
        results: [
          {
            title: "T",
            url: "https://example.com/t",
            snippet: "S",
            date: "2026-10-01",
            last_updated: "2026-10-03",
          },
        ],
      },
    }));
    const { call } = setup(["perplexity"], {
      env: LEGACY,
      baseUrls: { perplexity: api.baseUrl },
    });
    const result = await call({ query: "q" });
    expect(api.requests[0]!.path).toBe("/search");
    expect(api.requests[0]!.headers.authorization).toBe("Bearer locator-jwt");
    expect(api.requests[0]!.body).toEqual({
      query: "q",
      max_results: 5,
      max_tokens_per_page: 256,
      search_type: "web",
    });
    expect(result.content[0]!.text.split("\n")[0]).toBe(
      "[1] T — example.com · 2026-10-01",
    );
  });

  it("sends Parallel the query as objective and keyword query, with its settings", async () => {
    const api = await fakeApi(() => ({
      body: {
        search_id: "search_1",
        results: [
          {
            url: "https://www.example.com",
            title: "Sample webpage title",
            publish_date: "2024-01-15",
            excerpts: ["Sample excerpt 1", "Sample excerpt 2"],
          },
        ],
        usage: [{ name: "sku_search", count: 1 }],
        session_id: "session_1",
      },
    }));
    const { call, spans } = setup(["parallel"], {
      env: LEGACY,
      baseUrls: { parallel: api.baseUrl },
      sessionId: "task-session",
    });
    const result = await call({
      query: "agents that search",
      mode: "deep",
      freshness: "week",
      sites: ["arxiv.org", "-spam.com"],
      country: "GB",
      content: "context",
    });
    expect(api.requests[0]!.path).toBe("/v1/search");
    expect(api.requests[0]!.headers["x-api-key"]).toBe("locator-jwt");
    expect(api.requests[0]!.body).toEqual({
      objective: "agents that search",
      search_queries: ["agents that search"],
      mode: "advanced",
      session_id: "task-session",
      advanced_settings: {
        max_results: 5,
        excerpt_settings: { max_chars_per_result: 1500 },
        source_policy: {
          include_domains: ["arxiv.org"],
          after_date: "2026-10-30",
        },
        location: "gb",
      },
    });
    expect(result.content[0]!.text).toBe(
      [
        "[1] Sample webpage title — example.com · 2024-01-15",
        "https://www.example.com",
        "Sample excerpt 1 … Sample excerpt 2",
        "",
        "(approximated: mode — Parallel's Search API has nothing deeper than advanced, its default)",
        "(approximated: freshness — Parallel filters on published date from the start of the window (after_date).)",
        "(ignored: exclude sites — parallel cannot combine included and excluded sites, so only the included ones apply)",
      ].join("\n"),
    );
    expect(result.details.usage.units).toEqual({
      name: "sku_search",
      count: 1,
    });
    expect(spans[0]!.attributes).toMatchObject({
      "introspection.usage.service": "parallel/search",
      "introspection.usage.unit": "request",
      "introspection.usage.variant": "advanced",
    });

    await call({ query: "q", mode: "fast", sites: ["-spam.com"] });
    expect(api.requests[1]!.body).toEqual({
      objective: "q",
      search_queries: ["q"],
      mode: "fast",
      session_id: "task-session",
      advanced_settings: {
        max_results: 5,
        excerpt_settings: { max_chars_per_result: 300 },
        source_policy: { exclude_domains: ["spam.com"] },
      },
    });
  });

  it("calls Parallel's MCP tool with site: queries, filters to the sites named, and leaves to REST what it cannot express", async () => {
    const live = {
      search_id: "search_9af9b97d1b9aa47fece60f7a41155ba6",
      results: [
        {
          url: "https://workos.com/blog/mcp-enterprise-managed-authorization",
          title: "Inside the ID-JAG",
          publish_date: "2026-09-08",
          excerpts: [`In this article\n\n${"word ".repeat(500)}`],
        },
        {
          url: "https://docs.workos.com/sso",
          title: "SSO",
          publish_date: null,
          excerpts: ["Docs excerpt"],
        },
        {
          url: "https://supabase.com/docs/guides/platform/sso",
          title: "Elsewhere",
          publish_date: null,
          excerpts: ["Not on the site"],
        },
      ],
      warnings: null,
      metadata: null,
      session_id: "session_9af9b97d1b9aa47fece60f7a41155ba6",
    };
    const PARALLEL = mcpToolName("parallel", "web_search");
    const rest = await fakeApi(() => ({ body: { results: [] } }));
    const { ctx, calls } = fakePiMcp({
      [PARALLEL]: () => ({
        ...text(JSON.stringify(live)),
        structuredContent: live,
      }),
    });
    const { call } = setup(
      ["parallel"],
      {
        mcpServers: { parallel: "parallel" },
        baseUrls: { parallel: rest.baseUrl },
        sessionId: "task-session",
      },
      ctx,
    );
    const result = await call({
      query:
        "how does enterprise managed authorization for MCP work in practice",
      sites: ["workos.com", "-docs.workos.com"],
    });
    expect(calls[0]).toEqual({
      name: PARALLEL,
      args: {
        objective:
          "how does enterprise managed authorization for MCP work in practice",
        session_id: "task-session",
        search_queries: [
          "how does enterprise managed authorization for site:workos.com",
        ],
      },
    });
    expect(result.details.transport).toBe("mcp");
    expect(result.details.results.map((item) => item.url)).toEqual([
      "https://workos.com/blog/mcp-enterprise-managed-authorization",
      "https://docs.workos.com/sso",
    ]);
    expect(result.details.results[0]!.published_at).toBe("2026-09-08");
    expect(result.details.results[0]!.snippet!.length).toBeLessThanOrEqual(301);

    const excluded = await call({ query: "q", sites: ["-docs.workos.com"] });
    expect(excluded.details.results.map((item) => item.site)).toEqual([
      "workos.com",
      "supabase.com",
    ]);

    for (const args of [
      { query: "q", mode: "fast" },
      { query: "q", freshness: "week" },
      { query: "q", country: "US" },
    ])
      expect((await call(args)).details.transport).toBe("rest");
    expect(rest.requests).toHaveLength(3);

    const parallelOnly = setup(
      [],
      { mcpServers: { parallel: "parallel" } },
      ctx,
    );
    const mcpOnly = await parallelOnly.call({
      query: "q",
      mode: "fast",
      freshness: "day",
    });
    expect(mcpOnly.details.notes.map((note) => note.option)).toEqual([
      "freshness",
      "mode",
      "freshness",
    ]);
    expect(mcpOnly.details.notes[1]!.detail).toBe(
      "parallel's MCP tool web_search cannot run this mode, so it ran the server's default",
    );
    // The tool reports no setting, so none is recorded or priced.
    expect(mcpOnly.details).toMatchObject({ mode: "fast", setting: null });
    const span = parallelOnly.spans[0]!.attributes;
    expect(span["search.mode"]).toBe("fast");
    expect(span).not.toHaveProperty("search.setting");
    expect(span).not.toHaveProperty("introspection.usage.variant");
  });

  it("reports an account out of credit, and keeps one session id per task", async () => {
    const api = await fakeApi(() => ({
      status: 402,
      body: {
        type: "error",
        error: { ref_id: "r", message: "Insufficient credit in account" },
      },
    }));
    const { call } = setup(["parallel", "keenable"], {
      baseUrls: { parallel: api.baseUrl, keenable: api.baseUrl },
    });
    const parallel = await call({ query: "q", provider: "parallel" });
    expect(parallel.details.error).toMatchObject({
      code: "out_of_credit",
      status: 402,
    });
    expect(parallel.content[0]!.text).toMatch(
      /^web_search failed \(out_of_credit\): parallel answered 402: the provider account is out of credit: /,
    );
    expect(
      (await call({ query: "q", provider: "keenable" })).details.error,
    ).toMatchObject({ code: "out_of_credit" });
    await call({ query: "r", provider: "parallel" });
    const sessions = api.requests
      .filter(
        (request) => request.path === "/v1/search" && request.body.session_id,
      )
      .map((request) => request.body.session_id);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessions[1]).toBe(sessions[0]);
  });

  it("binds Keenable, Perplexity and Parallel by their MCP servers, and REST by host", () => {
    expect(
      boundSearchProviders({
        hosts: ["api.parallel.ai", "api.keenable.ai"],
        mcpServers: [
          { id: "k", url: "https://api.keenable.ai/mcp" },
          { id: "p", url: "https://api.perplexity.ai/mcp" },
          { id: "par", url: "https://search.parallel.ai/mcp" },
        ],
      }),
    ).toEqual({
      bound: ["keenable", "parallel"],
      mcpServers: { keenable: "k", parallel: "par", perplexity: "p" },
    });
  });
});
