import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createGoogleProductivitySession } from "../packages/productivity/google/src/index.js";
import {
  createMicrosoftSession,
  MICROSOFT_PRODUCTIVITY_CAPABILITIES,
} from "../packages/productivity/microsoft/src/index.js";
import {
  SLACK_CHANNEL_CAPABILITIES,
  SlackBotSession,
} from "../packages/channels/slack/src/index.js";
import searchProviders from "../packages/search/src/index.js";
import {
  API_LOCAL_CONFIG_ENV,
  bindRecipeApis,
  ensureApiBindingFetch,
  installApiBindings,
  isApiBindingFetchInstalled,
  isApiBound,
  normalizeApiHost,
  readApiBindings,
  resolveApiLocalConfigPath,
  type LocalApiBinding,
} from "../src/api-bindings.js";
import { loadRecipeConnectors } from "../src/connector-tools.js";
import { createRecipesExtension } from "../src/pi-extension.js";
import { createProductivityHttp } from "../src/productivity/index.js";
import { readPiPackageManifest } from "../src/recipe/package.js";
import { resolveRecipe } from "../src/recipe/resolve.js";
import {
  boundSearchProviders,
  registerWebSearchTool,
} from "../src/search/index.js";
import { createInProcessRunController } from "../src/run-controller.js";
import {
  createAgentSession,
  createAgentSessionInternal,
} from "../src/session.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";
import {
  installSlackRecipeConnector,
  SLACK_RECIPE_CHANNEL_PACKAGE,
} from "./helpers/recipe-connectors.js";

const MANAGED_FETCH_INSTALLER_SYMBOL = Symbol.for(
  "introspection.installManagedFetch",
);
const originalFetch = globalThis.fetch;
const releases: Array<() => void> = [];
const cleanups: Array<() => void> = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeBindingFile(dir: string, config: unknown): string {
  mkdirSync(join(dir, ".pi"), { recursive: true });
  const path = join(dir, ".pi", "api.local.json");
  writeFileSync(
    path,
    typeof config === "string" ? config : JSON.stringify(config),
  );
  return path;
}

function install(owner: string, bindings: LocalApiBinding[]): () => void {
  const release = installApiBindings(owner, bindings);
  releases.push(release);
  return release;
}

afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const cleanup of cleanups.splice(0)) cleanup();
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, MANAGED_FETCH_INSTALLER_SYMBOL);
});

interface Recorded {
  method: string;
  path: string;
  search: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

type Reply = {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
};

/** A local server standing in for a vendor, recording what reaches it. */
const recorded: Recorded[] = [];
let reply: (request: Recorded) => Reply = () => ({ json: {} });
let fakeBase = "";
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const url = new URL(req.url!, "http://fake");
    const request: Recorded = {
      method: req.method!,
      path: decodeURIComponent(url.pathname),
      search: url.search,
      headers: req.headers,
      body: Buffer.concat(chunks),
    };
    recorded.push(request);
    const answer = reply(request);
    res.writeHead(answer.status ?? 200, {
      "Content-Type": "application/json",
      ...answer.headers,
    });
    res.end(JSON.stringify(answer.json ?? {}));
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fakeBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  recorded.length = 0;
  reply = () => ({ json: {} });
});

/** The vendor URL a fake answers with, built from the forwarding headers as the bound host's own. */
function forwardedLink(request: Recorded, path: string): string {
  const prefix = String(request.headers["x-forwarded-prefix"] ?? "");
  const own = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return `${String(request.headers["x-forwarded-proto"])}://${String(request.headers["x-forwarded-host"])}${own}`;
}

describe("the API binding file", () => {
  it("is looked up inline, then from the env, then the workspace, then the Recipe", () => {
    const cwd = tempDir("api-bindings-cwd-");
    const recipeDir = tempDir("api-bindings-recipe-");
    const named = join(tempDir("api-bindings-env-"), "bindings.json");
    writeFileSync(
      named,
      JSON.stringify({ apis: [{ host: "env.example", url: "http://env:1" }] }),
    );
    writeBindingFile(cwd, {
      apis: [{ host: "cwd.example", url: "http://cwd:1" }],
    });
    const recipeFile = writeBindingFile(recipeDir, {
      apis: [{ host: "recipe.example", url: "http://recipe:1" }],
    });
    const env = { [API_LOCAL_CONFIG_ENV]: named };
    const hosts = (opts: Parameters<typeof readApiBindings>[0]) =>
      readApiBindings(opts).map((binding) => binding.host);

    expect(
      hosts({
        cwd,
        recipeDir,
        env,
        inline: { apis: [{ host: "inline.example", url: "http://inline:1" }] },
      }),
    ).toEqual(["inline.example"]);
    expect(resolveApiLocalConfigPath({ cwd, recipeDir, env })).toBe(named);
    expect(hosts({ cwd, recipeDir, env })).toEqual(["env.example"]);
    expect(hosts({ cwd, recipeDir, env: {} })).toEqual(["cwd.example"]);
    rmSync(join(cwd, ".pi"), { recursive: true });
    expect(resolveApiLocalConfigPath({ cwd, recipeDir, env: {} })).toBe(
      recipeFile,
    );
    expect(hosts({ cwd, recipeDir, env: {} })).toEqual(["recipe.example"]);
    rmSync(join(recipeDir, ".pi"), { recursive: true });
    expect(resolveApiLocalConfigPath({ cwd, recipeDir, env: {} })).toBe(
      undefined,
    );
    expect(hosts({ cwd, recipeDir, env: {} })).toEqual([]);
  });

  it("interpolates ${VAR} in url and headers and normalizes the host", () => {
    const cwd = tempDir("api-bindings-interpolate-");
    writeBindingFile(cwd, {
      apis: [
        {
          host: " Graph.Microsoft.com. ",
          url: "${FAKES_URL}/microsoft",
          headers: { Authorization: "Bearer ${STAGING_TOKEN}" },
        },
      ],
    });
    expect(
      readApiBindings({
        cwd,
        recipeDir: cwd,
        env: { FAKES_URL: "http://fakes:7353", STAGING_TOKEN: "t0k" },
      }),
    ).toEqual([
      {
        host: "graph.microsoft.com",
        url: "http://fakes:7353/microsoft",
        headers: { Authorization: "Bearer t0k" },
      },
    ]);
  });

  it("binds nothing from an empty file", () => {
    const cwd = tempDir("api-bindings-empty-");
    writeBindingFile(cwd, "  \n");
    expect(readApiBindings({ cwd, recipeDir: cwd, env: {} })).toEqual([]);
  });

  it("fails loudly on a malformed file, a duplicate host, a bad url or a host that is not bare", () => {
    const cwd = tempDir("api-bindings-invalid-");
    const read = (config: unknown) => {
      writeBindingFile(cwd, config);
      return () => readApiBindings({ cwd, recipeDir: cwd, env: {} });
    };
    expect(read("{ not json")).toThrow(/is not valid JSON/);
    expect(read({ apis: {} })).toThrow(/apis is not an array/);
    expect(
      read({
        apis: [
          { host: "slack.com", url: "http://a:1" },
          { host: "SLACK.com", url: "http://b:1" },
        ],
      }),
    ).toThrow(/binds 'slack.com' more than once/);
    expect(read({ apis: [{ host: "slack.com", url: "/relative" }] })).toThrow(
      /not an absolute URL/,
    );
    expect(
      read({ apis: [{ host: "slack.com", url: "ftp://fakes/slack" }] }),
    ).toThrow(/not http\(s\)/);
    expect(
      read({ apis: [{ host: "slack.com", url: "http://fakes/?a=1" }] }),
    ).toThrow(/no query/);
    expect(
      read({
        apis: [{ host: "slack.com", url: "http://a:1", headers: { x: 1 } }],
      }),
    ).toThrow(/header 'x' that is not a string/);
    for (const host of [
      "https://slack.com",
      "slack.com:443",
      "slack.com/api",
      "user@slack.com",
      "",
    ])
      expect(read({ apis: [{ host, url: "http://a:1" }] })).toThrow(
        /is not a bare hostname/,
      );
    expect(() =>
      readApiBindings({
        cwd,
        recipeDir: cwd,
        env: { [API_LOCAL_CONFIG_ENV]: join(cwd, "missing.json") },
      }),
    ).toThrow(/cannot be read/);
    expect(normalizeApiHost("Files.Slack.com")).toBe("files.slack.com");
  });

  it("fails a host no loaded provider declares, and installs nothing", () => {
    const cwd = tempDir("api-bindings-undeclared-");
    writeBindingFile(cwd, {
      apis: [
        { host: "slack.com", url: "http://fakes:7353/slack" },
        { host: "graph.microsoft.com", url: "http://fakes:7353/microsoft" },
      ],
    });
    expect(() =>
      bindRecipeApis({
        owner: "test",
        cwd,
        recipeDir: cwd,
        env: {},
        declaredHosts: ["slack.com", "files.slack.com"],
      }),
    ).toThrow(/no loaded provider or channel declares: graph\.microsoft\.com/);
    expect(isApiBound("https://slack.com/api")).toBe(false);
  });
});

describe("the binding fetch", () => {
  type Seen = { url: string; request: Request };
  function stubFetch(): Seen[] {
    const seen: Seen[] = [];
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const request = new Request(input, init);
      seen.push({ url: request.url, request });
      return new Response("ok");
    }) as typeof fetch;
    return seen;
  }

  const CARRIERS = {
    Authorization: "Bearer introspection-egress",
    "Proxy-Authorization": "Basic x",
    "x-api-key": "k",
    "api-key": "k",
    "x-goog-api-key": "k",
    "x-typesense-api-key": "k",
    baggage: "introspection.session=1",
    "x-introspection-egress-host": "graph.microsoft.com",
    "x-introspection-relay-target": "t",
  };

  it("sends a bound host's string, URL and Request to the bound url with forwarding headers, stripped of credentials", async () => {
    const seen = stubFetch();
    install("test", [
      {
        host: "graph.microsoft.com",
        url: "http://localhost:7353/fakes/microsoft",
        headers: { "x-fake": "1" },
      },
    ]);

    await fetch("https://graph.microsoft.com/v1.0/me?$top=1", {
      headers: { ...CARRIERS, Accept: "application/json" },
    });
    await fetch(new URL("https://graph.microsoft.com/v1.0/me/messages"));
    await fetch(
      new Request("https://graph.microsoft.com/v1.0/me/sendMail", {
        method: "POST",
        headers: CARRIERS,
        body: "hello",
      }),
    );

    expect(seen.map((entry) => entry.url)).toEqual([
      "http://localhost:7353/fakes/microsoft/v1.0/me?$top=1",
      "http://localhost:7353/fakes/microsoft/v1.0/me/messages",
      "http://localhost:7353/fakes/microsoft/v1.0/me/sendMail",
    ]);
    for (const { request } of seen) {
      expect(request.headers.get("x-forwarded-host")).toBe(
        "graph.microsoft.com",
      );
      expect(request.headers.get("x-forwarded-proto")).toBe("https");
      expect(request.headers.get("x-forwarded-prefix")).toBe(
        "/fakes/microsoft",
      );
      expect(request.headers.get("x-fake")).toBe("1");
      for (const name of Object.keys(CARRIERS))
        expect(request.headers.has(name)).toBe(false);
    }
    expect(seen[0]!.request.headers.get("accept")).toBe("application/json");
    expect(seen[2]!.request.method).toBe("POST");
    expect(await seen[2]!.request.text()).toBe("hello");
  });

  it("sets the entry's headers after stripping, and no prefix for a root url", async () => {
    const seen = stubFetch();
    install("test", [
      {
        host: "www.googleapis.com",
        url: "http://localhost:7353/",
        headers: { Authorization: "Bearer dev-token" },
      },
    ]);
    await fetch("https://www.googleapis.com/drive/v3/files", {
      headers: { Authorization: "Bearer introspection-egress" },
    });
    expect(seen[0]!.url).toBe("http://localhost:7353/drive/v3/files");
    expect(seen[0]!.request.headers.get("authorization")).toBe(
      "Bearer dev-token",
    );
    expect(seen[0]!.request.headers.has("x-forwarded-prefix")).toBe(false);
  });

  it("leaves a host the file does not name unchanged", async () => {
    const seen = stubFetch();
    install("test", [{ host: "slack.com", url: "http://localhost:7353" }]);
    await fetch("https://api.example.com/v1?q=1", {
      headers: { Authorization: "Bearer real" },
    });
    expect(seen[0]!.url).toBe("https://api.example.com/v1?q=1");
    expect(seen[0]!.request.headers.get("authorization")).toBe("Bearer real");
    expect(isApiBound("https://api.example.com")).toBe(false);
    expect(isApiBound("https://slack.com/api/chat.postMessage")).toBe(true);
  });

  it("is shared by owners binding a host alike, refuses a different binding, and hands the fetch back on the last release", () => {
    stubFetch();
    const base = globalThis.fetch;
    const binding = { host: "slack.com", url: "http://localhost:7353/slack" };
    const first = install("first", [binding]);
    const wrapper = globalThis.fetch;
    expect(wrapper).not.toBe(base);
    const second = install("second", [{ ...binding }]);
    expect(() =>
      installApiBindings("third", [
        { host: "slack.com", url: "http://localhost:9999" },
      ]),
    ).toThrow(/a live session binds it to http:\/\/localhost:7353\/slack/);
    ensureApiBindingFetch();
    expect(globalThis.fetch).toBe(wrapper);

    first();
    expect(isApiBound("https://slack.com")).toBe(true);
    expect(globalThis.fetch).toBe(wrapper);
    second();
    expect(isApiBound("https://slack.com")).toBe(false);
    expect(globalThis.fetch).toBe(base);
    expect(isApiBindingFetchInstalled()).toBe(false);
  });
});

describe("redirects from a bound host", () => {
  /** The live vendor: a second server that a bound request must never reach. */
  const vendorRequests: string[] = [];
  const vendor = createServer((req, res) => {
    vendorRequests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ from: "vendor" }));
  });
  let vendorBase = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      vendor.listen(0, "127.0.0.1", resolve),
    );
    // `localhost` stands in for the vendor host the binding names.
    vendorBase = `http://localhost:${(vendor.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => vendor.close(() => resolve())));
  afterEach(() => {
    vendorRequests.length = 0;
  });

  /** The fake redirects `/start` to the vendor's own `/next`, as built from x-forwarded-*. */
  function redirecting(status: number) {
    reply = (request) =>
      request.path === "/fake/start"
        ? {
            status,
            headers: { Location: `${vendorBase}/next?page=2` },
          }
        : { json: { from: "fake", method: request.method } };
  }

  it("follows a Location naming the vendor host back through the binding", async () => {
    install("test", [
      {
        host: "localhost",
        url: `${fakeBase}/fake`,
        headers: { "x-fake": "1" },
      },
    ]);
    redirecting(302);

    const response = await fetch(`${vendorBase}/start`, {
      headers: { Authorization: "Bearer introspection-egress" },
    });

    expect(await response.json()).toEqual({ from: "fake", method: "GET" });
    expect(vendorRequests).toEqual([]);
    expect(
      recorded.map((request) => `${request.path}${request.search}`),
    ).toEqual(["/fake/start", "/fake/next?page=2"]);
    expect(recorded[1]!.headers["x-forwarded-host"]).toBe("localhost");
    expect(recorded[1]!.headers["x-fake"]).toBe("1");
    expect(recorded[1]!.headers.authorization).toBeUndefined();
  });

  it("turns a POST into a GET on 302 and 303, and keeps it with its body on 307", async () => {
    install("test", [{ host: "localhost", url: `${fakeBase}/fake` }]);
    for (const [status, method, body] of [
      [302, "GET", ""],
      [303, "GET", ""],
      [307, "POST", "payload"],
    ] as const) {
      recorded.length = 0;
      redirecting(status);
      await fetch(
        new Request(`${vendorBase}/start`, { method: "POST", body: "payload" }),
      );
      expect(recorded[1]!.method).toBe(method);
      expect(recorded[1]!.body.toString("utf8")).toBe(body);
    }
    expect(vendorRequests).toEqual([]);
  });

  it("sends a redirect to an unbound host none of the stripped credentials", async () => {
    install("test", [
      {
        host: "localhost",
        url: `${fakeBase}/fake`,
        headers: { "x-fake": "1" },
      },
    ]);
    // The fake's own address is not bound: the redirect goes there directly.
    reply = (request) =>
      request.path === "/fake/start"
        ? { status: 302, headers: { Location: `${fakeBase}/elsewhere` } }
        : { json: { from: "fake" } };

    await fetch(`${vendorBase}/start`, {
      headers: {
        Authorization: "Bearer introspection-egress",
        "x-api-key": "k",
        baggage: "introspection.session=1",
        "x-introspection-egress-host": "localhost",
        Accept: "application/json",
      },
    });

    expect(recorded.map((request) => request.path)).toEqual([
      "/fake/start",
      "/elsewhere",
    ]);
    const headers = recorded[1]!.headers;
    for (const name of [
      "authorization",
      "x-api-key",
      "baggage",
      "x-introspection-egress-host",
      "x-fake",
      "x-forwarded-host",
    ])
      expect(headers[name]).toBeUndefined();
    expect(headers.accept).toBe("application/json");
    expect(vendorRequests).toEqual([]);
  });

  it("keeps a caller's manual redirect and stops after 20 hops", async () => {
    install("test", [{ host: "localhost", url: `${fakeBase}/fake` }]);
    redirecting(302);
    const manual = await fetch(`${vendorBase}/start`, { redirect: "manual" });
    expect(manual.status).toBe(302);
    expect(manual.headers.get("location")).toBe(`${vendorBase}/next?page=2`);
    expect(recorded).toHaveLength(1);

    reply = () => ({
      status: 302,
      headers: { Location: `${vendorBase}/loop` },
    });
    await expect(fetch(`${vendorBase}/loop`)).rejects.toThrow(
      /too many redirects/,
    );
    expect(vendorRequests).toEqual([]);
  });
});

describe("declared hosts", () => {
  it("come from the loaded channels, productivity, issues and search providers, selected or not", async () => {
    const recipeDir = tempDir("api-bindings-declared-");
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "declared",
        version: "0.1.0",
        type: "module",
        dependencies: { [SLACK_RECIPE_CHANNEL_PACKAGE]: "0.1.0" },
        pi: {
          channels: [{ provider: "slack" }],
          productivity: [{ provider: "microsoft" }],
          issues: [{ provider: "linear" }],
          search: [{ provider: "brave" }],
        },
      }),
    );
    installSlackRecipeConnector(recipeDir);

    const loaded = await loadRecipeConnectors(
      readPiPackageManifest(recipeDir),
      [],
      { recipeDir, env: {} },
    );

    expect(loaded.loadout.toolNames).toEqual([]);
    expect(loaded.hosts).toEqual(
      expect.arrayContaining([
        "slack.com",
        "files.slack.com",
        "graph.microsoft.com",
        "mcp.linear.app",
        "api.search.brave.com",
      ]),
    );
  });

  it("leave search out when the Recipe declares no pi.search", async () => {
    const recipeDir = tempDir("api-bindings-no-search-");
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({ name: "plain", version: "0.1.0", pi: {} }),
    );
    const loaded = await loadRecipeConnectors(
      readPiPackageManifest(recipeDir),
      [],
      { recipeDir },
    );
    expect(loaded.hosts).toEqual([]);
  });
});

describe("a bound host needs no egress lane", () => {
  it("productivity sends without Authorization and without a lane", async () => {
    install("test", [{ host: "api.acme.example", url: `${fakeBase}/acme` }]);
    const http = createProductivityHttp({ provider: "acme", env: {} });
    const response = await http({
      method: "GET",
      url: "https://api.acme.example/v1/items",
      read: true,
    });
    expect(response.status).toBe(200);
    expect(recorded[0]!.path).toBe("/acme/v1/items");
    expect(recorded[0]!.headers.authorization).toBeUndefined();

    await expect(
      http({ method: "GET", url: "https://unbound.example/v1", read: true }),
    ).rejects.toThrow(/need the Introspection cloud egress/);
  });

  it("search offers a REST provider and calls it with no credential header", async () => {
    const brave = searchProviders.providers.brave!;
    install("test", [
      { host: brave.capabilities.host, url: `${fakeBase}/brave` },
    ]);
    reply = () => ({
      json: {
        web: {
          results: [
            {
              url: "https://news.example.org/a",
              title: "A",
              description: "Brave result A",
            },
          ],
        },
      },
    });
    const { bound } = boundSearchProviders({}, searchProviders.providers);
    expect(bound).toEqual(["brave"]);

    const pi = createMockExtensionAPI();
    registerWebSearchTool(pi, {
      bound,
      providers: searchProviders.providers,
      env: {},
    });
    const result = (await pi.tools
      .get("web_search")!
      .execute(
        "call-1",
        { query: "agents" } as never,
        undefined,
        undefined,
        {} as never,
      )) as {
      isError?: boolean;
      details: { results: Array<{ url: string }> };
    };
    expect(result.isError).toBeFalsy();
    expect(result.details.results[0]!.url).toBe("https://news.example.org/a");
    expect(recorded[0]!.path).toBe("/brave/res/v1/web/search");
    expect(recorded[0]!.headers["x-subscription-token"]).toBeUndefined();
    expect(recorded[0]!.headers["x-forwarded-host"]).toBe(
      brave.capabilities.host,
    );
  });

  it("search offers a provider with an MCP server by its API-bound REST host alone", () => {
    const tavily = searchProviders.providers.tavily!;
    expect(tavily.mcp).toBeDefined();
    expect(boundSearchProviders({}, searchProviders.providers).bound).toEqual(
      [],
    );
    install("test", [
      { host: tavily.capabilities.host, url: `${fakeBase}/tavily` },
    ]);
    expect(boundSearchProviders({}, searchProviders.providers)).toEqual({
      bound: ["tavily"],
      mcpServers: {},
    });
  });

  it("Slack sends without Authorization through the fetch installed after it was built", async () => {
    reply = () => ({ json: { ok: true, messages: [] } });
    const session = new SlackBotSession({ env: {}, isApiBound });
    install("test", [{ host: "slack.com", url: `${fakeBase}/slack` }]);

    await session.call("conversations.history", { channel: "C1" });

    expect(recorded[0]!.path).toBe("/slack/api/conversations.history");
    expect(recorded[0]!.headers.authorization).toBeUndefined();
    expect(SLACK_CHANNEL_CAPABILITIES.hosts).toEqual([
      "slack.com",
      "files.slack.com",
    ]);
  });
});

describe("providers against a fake through the file", () => {
  it("Microsoft keeps its real base URL and follows next links the fake builds from x-forwarded-*", async () => {
    const cwd = tempDir("api-bindings-microsoft-");
    writeBindingFile(cwd, {
      apis: [
        { host: "graph.microsoft.com", url: `${fakeBase}/fakes/microsoft` },
      ],
    });
    releases.push(
      bindRecipeApis({
        owner: "test",
        cwd,
        recipeDir: cwd,
        env: {},
        declaredHosts: MICROSOFT_PRODUCTIVITY_CAPABILITIES.hosts ?? [],
      }).release,
    );
    reply = (request) => {
      const page = new URLSearchParams(request.search).get("page");
      return {
        json: {
          value: page === "2" ? [{ id: "m3" }] : [{ id: "m1" }, { id: "m2" }],
          "@odata.nextLink": `${forwardedLink(request, request.path)}?page=${page === "2" ? 3 : 2}`,
        },
      };
    };
    const session = createMicrosoftSession({
      http: createProductivityHttp({ provider: "microsoft", env: {} }),
    });

    const result = await session.mail!.search!({ limit: 3 }, {});

    expect(result.messages.map((message) => message.id)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    expect(result.cursor).toBe(
      "https://graph.microsoft.com/v1.0/me/messages?page=3",
    );
    expect(recorded.map((request) => request.path)).toEqual([
      "/fakes/microsoft/v1.0/me/messages",
      "/fakes/microsoft/v1.0/me/messages",
    ]);
    expect(recorded[0]!.headers["x-forwarded-prefix"]).toBe("/fakes/microsoft");
    expect(recorded[0]!.headers.authorization).toBeUndefined();
  });

  it("Google Drive's resumable upload follows the Location the fake builds from x-forwarded-*", async () => {
    install("test", [
      { host: "www.googleapis.com", url: `${fakeBase}/fakes/google` },
    ]);
    reply = (request) =>
      request.method === "POST"
        ? {
            headers: {
              Location: `${forwardedLink(request, request.path)}?upload_id=u1`,
            },
          }
        : {
            json: {
              id: "f1",
              name: "big.bin",
              mimeType: "application/octet-stream",
            },
          };
    const session = await createGoogleProductivitySession({
      config: { provider: "google", tools: {} },
      env: {},
      cwd: tempDir("api-bindings-google-"),
      http: createProductivityHttp({ provider: "google", env: {} }),
    });

    const file = await session.drive.upload({
      name: "big.bin",
      bytes: new Uint8Array(5 * 1024 * 1024 + 1),
    });

    expect(file.id).toBe("f1");
    expect(
      recorded.map(
        (request) => `${request.method} ${request.path}${request.search}`,
      ),
    ).toEqual([
      expect.stringMatching(
        /^POST \/fakes\/google\/upload\/drive\/v3\/files\?uploadType=resumable/,
      ),
      "PUT /fakes/google/upload/drive/v3/files?upload_id=u1",
    ]);
    expect(recorded[1]!.body.byteLength).toBe(5 * 1024 * 1024 + 1);
  });
});

describe("Recipe sessions", () => {
  /** A channel package whose adapter records what its session saw while the extension loaded. */
  function writeCustomChannelRecipe(root: string): string {
    const recipeDir = join(root, "recipe");
    const channelDir = join(
      recipeDir,
      "node_modules",
      "@introspection-ai",
      "recipe-channel-custom",
    );
    mkdirSync(join(recipeDir, "defs"), { recursive: true });
    mkdirSync(channelDir, { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "custom-channel-recipe",
        version: "0.1.0",
        dependencies: { "@introspection-ai/recipe-channel-custom": "0.1.0" },
        pi: { agents: ["defs/*.yaml"], channels: [{ provider: "custom" }] },
      }),
    );
    writeFileSync(
      join(recipeDir, "defs", "main.yaml"),
      [
        "name: main",
        "model:",
        "  name: openai/gpt-4.1",
        "tools: [channels]",
      ].join("\n"),
    );
    writeFileSync(
      join(channelDir, "package.json"),
      JSON.stringify({
        name: "@introspection-ai/recipe-channel-custom",
        version: "0.1.0",
        type: "module",
        exports: { import: "./index.js" },
      }),
    );
    writeFileSync(
      join(channelDir, "index.js"),
      `const capabilities = { react: false, edit: false, retract: false, read: false, attach: false, fetchFile: false, documents: false, resolveAuthors: false, permalinks: false, hosts: ["api.custom.example"] };
export default {
  kind: "channel",
  apiVersion: 1,
  provider: "custom",
  capabilities,
  createSession({ isApiBound }) {
    globalThis.__customChannel = { fetch: globalThis.fetch, bound: isApiBound?.("https://api.custom.example/v1") };
    return {
      // A rebuilt descriptor, with a new hosts array.
      adapter: { provider: "custom", capabilities: { ...capabilities, hosts: [...capabilities.hosts] }, async reply() { return {}; } },
      target: () => ({ provider: "custom", conversation: "c1" }),
    };
  },
};
`,
    );
    return recipeDir;
  }

  function extensionContext(cwd: string) {
    return {
      cwd,
      hasUI: true,
      ui: { notify: vi.fn() },
      modelRegistry: {
        find: vi.fn((provider: string, id: string) => ({ provider, id })),
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "k" })),
      },
    } as any;
  }

  it("Pi: binds before the extensions load, outside the managed fetch, without growing it per request", async () => {
    const root = tempDir("api-bindings-pi-");
    const recipeDir = writeCustomChannelRecipe(root);
    writeBindingFile(recipeDir, {
      apis: [{ host: "api.custom.example", url: "http://127.0.0.1:9/fake" }],
    });
    const baseCalls: string[] = [];
    const managedCalls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      baseCalls.push(String(input));
      return new Response("ok");
    }) as typeof fetch;
    // The Runtime's installer: re-wraps whatever global fetch it did not install.
    let managedFetch: typeof fetch | undefined;
    let wraps = 0;
    Reflect.set(globalThis, MANAGED_FETCH_INSTALLER_SYMBOL, () => {
      if (globalThis.fetch === managedFetch) return;
      const inner = globalThis.fetch;
      wraps += 1;
      managedFetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        managedCalls.push(String(input));
        return inner(input, init);
      }) as typeof fetch;
      globalThis.fetch = managedFetch;
    });

    const pi = createMockExtensionAPI();
    pi.flagValues.set("recipe", recipeDir);
    pi.flagValues.set("agent", "main");
    createRecipesExtension({ env: {} })(pi);
    const ctx = extensionContext(root);
    await pi.emitExtensionEvent(
      { type: "session_start", reason: "startup" } as any,
      ctx,
    );

    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("cannot start"),
      expect.anything(),
    );
    expect(pi.tools.has("channels")).toBe(true);
    const seen = Reflect.get(globalThis, "__customChannel") as {
      fetch: typeof fetch;
      bound: boolean;
    };
    expect(seen.bound).toBe(true);
    expect(isApiBindingFetchInstalled()).toBe(true);
    expect(seen.fetch).toBe(globalThis.fetch);
    expect(wraps).toBe(1);

    const composed = globalThis.fetch;
    for (let turn = 0; turn < 3; turn += 1)
      await pi.emitExtensionEvent(
        { type: "before_provider_request", payload: {} } as any,
        ctx,
      );
    expect(wraps).toBe(1);
    expect(globalThis.fetch).toBe(composed);

    await fetch("https://api.custom.example/v1/messages?x=1");
    expect(managedCalls).toEqual(["http://127.0.0.1:9/fake/v1/messages?x=1"]);
    expect(baseCalls).toEqual(["http://127.0.0.1:9/fake/v1/messages?x=1"]);

    await pi.emitExtensionEvent({ type: "session_shutdown" } as any, ctx);
    expect(isApiBound("https://api.custom.example")).toBe(false);
    expect(globalThis.fetch).toBe(managedFetch);
    Reflect.deleteProperty(globalThis, "__customChannel");
  });

  it("Pi: fails the session when the file binds an undeclared host", async () => {
    const root = tempDir("api-bindings-pi-undeclared-");
    const recipeDir = writeCustomChannelRecipe(root);
    writeBindingFile(root, {
      apis: [{ host: "graph.microsoft.com", url: "http://127.0.0.1:9/fake" }],
    });
    const pi = createMockExtensionAPI();
    pi.flagValues.set("recipe", recipeDir);
    pi.flagValues.set("agent", "main");
    createRecipesExtension({ env: {} })(pi);
    const ctx = extensionContext(root);
    await pi.emitExtensionEvent(
      { type: "session_start", reason: "startup" } as any,
      ctx,
    );

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(
        /Recipe session cannot start[\s\S]*graph\.microsoft\.com/,
      ),
      "warning",
    );
    expect(Reflect.get(globalThis, "__customChannel")).toBeUndefined();
    await pi.emitExtensionEvent({ type: "session_shutdown" } as any, ctx);
  });

  async function credentials(): Promise<InMemoryCredentialStore> {
    const store = new InMemoryCredentialStore();
    await store.modify("anthropic", async () => ({
      type: "api_key",
      key: "test-key",
    }));
    return store;
  }

  function slackFixture() {
    const created = writeFixtureRecipe({
      dependencies: { [SLACK_RECIPE_CHANNEL_PACKAGE]: "0.1.0" },
      tools: ["channels"],
      manifestPi: { channels: [{ provider: "slack" }] },
    });
    cleanups.push(created.cleanup);
    installSlackRecipeConnector(created.recipeDir);
    return created;
  }

  it("SDK: reports the declared and bound hosts and releases the binding at dispose", async () => {
    const { recipeDir, workspaceDir } = slackFixture();
    writeBindingFile(workspaceDir, {
      apis: [{ host: "slack.com", url: "http://localhost:7353/slack" }],
    });
    const handle = await createAgentSession({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      credentials: await credentials(),
      env: cleanEnv(),
    });
    try {
      expect(handle.apiBindings).toEqual({
        declaredHosts: ["files.slack.com", "slack.com"],
        bound: [{ host: "slack.com", url: "http://localhost:7353/slack" }],
      });
      expect(isApiBound("https://slack.com/api/chat.postMessage")).toBe(true);
    } finally {
      await handle.dispose();
    }
    expect(isApiBound("https://slack.com/api/chat.postMessage")).toBe(false);
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("SDK: inline apiBindings win, and an undeclared host fails construction", async () => {
    const { recipeDir, workspaceDir } = slackFixture();
    writeBindingFile(workspaceDir, {
      apis: [{ host: "slack.com", url: "http://localhost:7353/slack" }],
    });
    await expect(
      createAgentSession({
        recipe: resolveRecipe({ recipeDir }),
        cwd: workspaceDir,
        credentials: await credentials(),
        env: cleanEnv(),
        apiBindings: {
          apis: [{ host: "graph.microsoft.com", url: "http://localhost:1" }],
        },
      }),
    ).rejects.toThrow(/graph\.microsoft\.com/);
    expect(isApiBound("https://slack.com")).toBe(false);
    expect(isApiBound("https://graph.microsoft.com")).toBe(false);
  });

  it("SDK: a delegated child binds what its root resolved, not the file", async () => {
    const created = writeFixtureRecipe({
      dependencies: { [SLACK_RECIPE_CHANNEL_PACKAGE]: "0.1.0" },
      tools: ["channels"],
      subagents: ["helper"],
      manifestPi: { channels: [{ provider: "slack" }] },
    });
    cleanups.push(created.cleanup);
    installSlackRecipeConnector(created.recipeDir);
    const { recipeDir, workspaceDir } = created;
    writeBindingFile(workspaceDir, {
      apis: [{ host: "slack.com", url: "http://localhost:7353/from-file" }],
    });
    const inline = {
      apis: [{ host: "slack.com", url: "http://localhost:7353/inline" }],
    };
    const recipe = resolveRecipe({ recipeDir });
    const root = await createAgentSession({
      recipe,
      cwd: workspaceDir,
      credentials: await credentials(),
      env: cleanEnv(),
      apiBindings: inline,
    });
    try {
      let childBound: unknown;
      const controller = createInProcessRunController({
        recipe,
        cwd: workspaceDir,
        env: cleanEnv(),
        apiBindings: { apis: [...root.apiBindings.bound] },
        sessionFactory: async (options) => {
          const child = await createAgentSessionInternal({
            ...options,
            credentials: await credentials(),
          });
          childBound = child.apiBindings.bound;
          await child.dispose();
          throw new Error("constructed");
        },
      });
      const run = await controller.start({ name: "helper", prompt: "go" });
      const settled = await controller.wait(run.agent_run_id);
      expect(settled.error).toContain("constructed");
      expect(childBound).toEqual(inline.apis);
      expect(isApiBound("https://slack.com")).toBe(true);
    } finally {
      await root.dispose();
    }
  });
});
