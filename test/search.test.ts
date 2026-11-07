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
    ]);
    const two = webSearchParameters(["tavily", "exa"]) as any;
    expect(two.properties.provider.enum).toEqual(["tavily", "exa"]);
  });

  it("offers only bound providers this package implements", () => {
    const { tool } = setup(["parallel", "tavily", "brave"]);
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
    // About 210 tokens with three providers bound (docs/search/README.md).
    expect(definition.length).toBeLessThan(800);
  });

  it("ships the search skill beside the code", () => {
    expect(readFileSync(SEARCH_SKILL, "utf8")).toMatch(/^---\nname: search\n/);
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
      host: "api.keenable.ai",
      credential: { header: "X-API-Key" },
      billing: "per request",
      options: {
        freshness: "none",
        include_sites: "native",
        exclude_sites: "none",
        context: "none",
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
    });
    expect(result.details.results).toHaveLength(3);
    expect(result.content[0]!.text.split("\n").slice(-4)).toEqual([
      "(ignored: freshness — not supported by keenable)",
      "(ignored: exclude sites — not supported by keenable)",
      "(ignored: context — not supported by keenable)",
      "(approximated: max results — keenable returns at most 3)",
    ]);
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
      'web_search failed (rate_limited): tavily answered 429: {"detail":"slow down"} Retry after 30s.',
    );
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
    });
    expect(calls).toEqual([
      {
        name: TAVILY,
        args: {
          query: "agents",
          search_depth: "advanced",
          max_results: 5,
          time_range: "week",
          include_domains: ["example.org"],
          exclude_domains: ["spam.com"],
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
      [EXA_ADVANCED]: () =>
        text(
          JSON.stringify({
            results: [
              {
                url: "https://exa.example/p",
                title: "P",
                publishedDate: "2026-11-01T00:00:00.000Z",
                highlights: ["one", "two"],
              },
            ],
            costDollars: { total: 0.007 },
          }),
        ),
      [EXA_DEFAULT]: () => text(EXA_MCP_TEXT),
    });
    const { call } = setup([], { mcpServers: { exa: "exa" } }, ctx);
    const result = await call({
      query: "q",
      freshness: "week",
      sites: ["exa.example"],
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
