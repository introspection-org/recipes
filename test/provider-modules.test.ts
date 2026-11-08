import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import googleProductivityModule from "../packages/productivity/google/src/index.js";
import microsoftProductivityModule from "../packages/productivity/microsoft/src/index.js";

import {
  loadRecipeProductivity,
  PRODUCTIVITY_PROVIDER_FAMILY,
} from "../src/productivity/index.js";
import { productivityCapabilitiesProblem } from "../src/productivity/tools.js";
import {
  readPiPackageManifest,
  validatePiPackageManifest,
} from "../src/recipe/package.js";
import { loadProviderModules } from "../src/recipe/providers.js";
import {
  createWebSearch,
  loadSearchProviders,
  SEARCH_PROVIDER_FAMILY,
  SEARCH_PROVIDER_IDS,
  type SearchFetch,
} from "../src/search/index.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function recipe(
  pi: Record<string, unknown>,
  files: Record<string, string> = {},
  dependencies: Record<string, string> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "provider-recipe-"));
  write(
    join(dir, "package.json"),
    JSON.stringify({
      name: "r",
      version: "0.1.0",
      type: "module",
      dependencies,
      pi: { agents: [], ...pi },
    }),
  );
  for (const [path, body] of Object.entries(files))
    write(join(dir, path), body);
  return dir;
}

function searchModule(
  fields: { kind?: string; apiVersion?: number; id?: string } = {},
): string {
  return `const capabilities = {
  modes: { fast: { setting: "fast" }, default: { setting: "std" }, deep: { setting: "deep" } },
  mode_parameter: "depth",
  max_results: 10,
  options: { freshness: "none", include_sites: "none", exclude_sites: "none", context: "none", country: "none" },
  combine_sites: true,
  host: "api.acme.test",
  hosts: ["api.acme.test"],
  credential: { header: "x-api-key" },
  billing: "1 request",
};
export default {
  kind: ${JSON.stringify(fields.kind ?? "search")},
  apiVersion: ${fields.apiVersion ?? 1},
  id: ${JSON.stringify(fields.id ?? "acme")},
  capabilities,
  async search(request: { query: string; setting: string }, context: { request(path: string, init: unknown): Promise<unknown> }) {
    const body = (await context.request("/search", { method: "POST", body: { q: request.query, depth: request.setting } })) as { hits: Array<{ url: string; title: string }> };
    return { results: body.hits.map((hit) => ({ url: hit.url, title: hit.title })) };
  },
};
`;
}

const FAKE_CAPABILITIES = {
  mail: {
    labels: "labels",
    folders: "labels",
    commands: { search: { effect: "read", backend: "rest" } },
  },
  hosts: ["mail.acme.test"],
};

function productivityModule(provider: string): string {
  return `export default { kind: "productivity", apiVersion: 1, provider: ${JSON.stringify(provider)},
  capabilities: ${JSON.stringify(FAKE_CAPABILITIES)},
  createSession: () => ({ provider: ${JSON.stringify(provider)}, mail: {}, calendar: {}, drive: {} }) };\n`;
}

describe("pi.search", () => {
  it("offers and calls a Recipe-local module beside a first-party provider", async () => {
    const recipeDir = recipe(
      {
        search: [
          { provider: "brave" },
          { provider: "acme", module: "./providers/acme-search.ts" },
        ],
      },
      { "providers/acme-search.ts": searchModule() },
    );
    const manifest = readPiPackageManifest(recipeDir);
    expect(validatePiPackageManifest(manifest).findings).toEqual([]);
    const providers = await loadSearchProviders({
      recipeDir,
      declarations: manifest.search!,
    });
    expect(Object.keys(providers)).toEqual(["brave", "acme"]);
    expect(providers.brave!.capabilities.host).toBe("api.search.brave.com");

    const requests: Array<{ url: string; body?: string }> = [];
    const fetch: SearchFetch = async (url, init) => {
      requests.push({ url, ...(init?.body ? { body: init.body } : {}) });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          hits: [{ url: "https://acme.test/a", title: "A" }],
        }),
        text: async () => "",
      };
    };
    const search = createWebSearch({
      bound: ["acme"],
      providers,
      fetch,
      credentialHeaders: () => ({}),
    });
    const result = await search({ query: "widgets", mode: "deep" });
    expect(result.provider).toBe("acme");
    expect(result.results).toEqual([
      { url: "https://acme.test/a", title: "A" },
    ]);
    expect(requests).toEqual([
      {
        url: "https://api.acme.test/search",
        body: JSON.stringify({ q: "widgets", depth: "deep" }),
      },
    ]);
  });

  it("keeps today's providers when the Recipe declares no pi.search", async () => {
    const recipeDir = recipe({});
    const manifest = readPiPackageManifest(recipeDir);
    expect(manifest.search).toBeUndefined();
    const providers = await loadSearchProviders({
      recipeDir,
      ...(manifest.search ? { declarations: manifest.search } : {}),
    });
    expect(Object.keys(providers).sort()).toEqual(
      [...SEARCH_PROVIDER_IDS].sort(),
    );
  });

  it("refuses an id the first-party bundle does not serve", async () => {
    const recipeDir = recipe({ search: [{ provider: "acme" }] });
    await expect(
      loadSearchProviders({
        recipeDir,
        declarations: readPiPackageManifest(recipeDir).search!,
      }),
    ).rejects.toThrow(
      "Recipe search provider 'acme': @introspection-ai/recipe-search has no provider 'acme'; give the declaration a package or module",
    );
  });

  it("declares every host each first-party provider calls", async () => {
    const providers = await loadSearchProviders({ recipeDir: recipe({}) });
    for (const provider of Object.values(providers)) {
      const { host, hosts } = provider.capabilities;
      expect(hosts).toContain(host);
      if (provider.mcp)
        expect(hosts).toContain(new URL(provider.mcp.url).hostname);
    }
  });
});

describe("pi.productivity sources", () => {
  it("loads a provider from a package the Recipe depends on", async () => {
    const name = "@acme/recipe-productivity-mail";
    const recipeDir = recipe(
      { productivity: [{ provider: "acme-mail", package: name }] },
      {
        "node_modules/@acme/recipe-productivity-mail/package.json":
          JSON.stringify({
            name,
            version: "1.0.0",
            type: "module",
            main: "index.js",
          }),
        "node_modules/@acme/recipe-productivity-mail/index.js":
          productivityModule("acme-mail"),
      },
      { [name]: "1.0.0" },
    );
    const manifest = readPiPackageManifest(recipeDir);
    expect(manifest.productivity).toEqual([
      { provider: "acme-mail", package: name },
    ]);
    expect(validatePiPackageManifest(manifest).findings).toEqual([]);
    const loaded = await loadRecipeProductivity(
      manifest.productivity!,
      ["mail"],
      { recipeDir },
    );
    expect(loaded.toolNames).toEqual(["mail"]);
    const pi = createMockExtensionAPI();
    await loaded.extension!.factory(pi as never);
    expect([...pi.tools.keys()]).toEqual(["mail"]);
  });

  it("loads a provider from a module in the Recipe", async () => {
    const recipeDir = recipe(
      { productivity: [{ provider: "acme", module: "providers/mail.js" }] },
      { "providers/mail.js": productivityModule("acme") },
    );
    const loaded = await loadRecipeProductivity(
      readPiPackageManifest(recipeDir).productivity!,
      ["mail"],
      { recipeDir },
    );
    expect(loaded.toolNames).toEqual(["mail"]);
  });

  it("declares the hosts of the first-party providers", () => {
    for (const module of [
      googleProductivityModule,
      microsoftProductivityModule,
    ]) {
      expect(module.capabilities.hosts?.length).toBeGreaterThan(0);
      expect(productivityCapabilitiesProblem(module.capabilities)).toBe(
        undefined,
      );
    }
  });
});

describe("loadProviderModules", () => {
  const load = (body: string, provider = "acme") => {
    const recipeDir = recipe({}, { "providers/acme.ts": body });
    return loadProviderModules(
      SEARCH_PROVIDER_FAMILY,
      [{ provider, module: "./providers/acme.ts" }],
      { recipeDir },
    );
  };

  it("refuses a wrong kind, apiVersion or id", async () => {
    await expect(load(searchModule({ kind: "issues" }))).rejects.toThrow(
      "Recipe search provider 'acme': ./providers/acme.ts exports kind 'issues', not 'search'",
    );
    await expect(load(searchModule({ apiVersion: 2 }))).rejects.toThrow(
      "Recipe search provider 'acme': ./providers/acme.ts implements search provider API 2, but this host implements search provider API 1",
    );
    await expect(load(searchModule({ id: "other" }))).rejects.toThrow(
      "Recipe search provider 'acme': ./providers/acme.ts declares id 'other', not 'acme'",
    );
  });

  it("refuses a productivity module declaring another provider", async () => {
    const recipeDir = recipe({}, { "p.js": productivityModule("other") });
    await expect(
      loadProviderModules(
        PRODUCTIVITY_PROVIDER_FAMILY,
        [{ provider: "acme", module: "p.js" }],
        { recipeDir },
      ),
    ).rejects.toThrow("p.js declares id 'other', not 'acme'");
  });

  it("refuses a module outside the Recipe, by path or by symlink", async () => {
    const outside = mkdtempSync(join(tmpdir(), "provider-outside-"));
    write(join(outside, "acme.ts"), searchModule());
    const recipeDir = recipe({});
    symlinkSync(join(outside, "acme.ts"), join(recipeDir, "linked.ts"));
    await expect(
      loadProviderModules(
        SEARCH_PROVIDER_FAMILY,
        [{ provider: "acme", module: "../outside/acme.ts" }],
        { recipeDir },
      ),
    ).rejects.toThrow("module '../outside/acme.ts' is outside the Recipe");
    await expect(
      loadProviderModules(
        SEARCH_PROVIDER_FAMILY,
        [{ provider: "acme", module: "linked.ts" }],
        { recipeDir },
      ),
    ).rejects.toThrow("module 'linked.ts' resolves outside the Recipe");
  });

  it("refuses a duplicate id and a declaration naming two sources", async () => {
    const recipeDir = recipe({}, { "a.ts": searchModule() });
    await expect(
      loadProviderModules(
        SEARCH_PROVIDER_FAMILY,
        [
          { provider: "acme", module: "a.ts" },
          { provider: "acme", module: "a.ts" },
        ],
        { recipeDir },
      ),
    ).rejects.toThrow("pi.search declares provider 'acme' more than once");
    await expect(
      loadProviderModules(
        SEARCH_PROVIDER_FAMILY,
        [{ provider: "acme", module: "a.ts", package: "acme" }],
        { recipeDir },
      ),
    ).rejects.toThrow("names both a package and a module");
  });
});

describe("provider declaration findings", () => {
  const messages = (pi: Record<string, unknown>, files = {}) =>
    validatePiPackageManifest(
      readPiPackageManifest(recipe(pi, files)),
    ).findings.map((finding) => finding.message);

  it("reports a bad source, a duplicate id and an unknown first-party id", () => {
    expect(
      messages({
        search: [
          { provider: "acme", module: "../acme.ts" },
          { provider: "brave", package: "@acme/search", module: "a.ts" },
          { provider: "brave" },
          { provider: "other" },
          { provider: "exa", source: "x" },
        ],
      }),
    ).toEqual([
      "package.json#pi.search[0].module '../acme.ts' is outside the Recipe; name a file under the Recipe root",
      "package.json#pi.search[1] names both a package and a module; name one",
      "package.json#pi.search[1].package '@acme/search' must be listed in package.json#dependencies",
      "package.json#pi.search[1]: module 'a.ts' does not exist",
      "package.json#pi.search contains duplicate provider 'brave'",
      "package.json#pi.search provider 'other' is not a first-party provider (tavily, parallel, exa, keenable, perplexity, brave); give it a package or module",
      "package.json#pi.search[4] contains unknown field(s): source",
    ]);
  });

  it("checks productivity sources the same way", () => {
    expect(
      messages({
        productivity: [
          { provider: "acme", package: "@acme/mail", module: "/abs.js" },
        ],
      }),
    ).toEqual([
      "package.json#pi.productivity[0] names both a package and a module; name one",
      "package.json#pi.productivity[0].package '@acme/mail' must be listed in package.json#dependencies",
      "package.json#pi.productivity[0].module '/abs.js' is outside the Recipe; name a file under the Recipe root",
    ]);
  });
});
