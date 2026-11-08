import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

/** An installed package `name` whose entry point is `body`. */
function installed(name: string, body: string): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({
      name,
      version: "1.0.0",
      type: "module",
      main: "index.js",
    }),
    [`node_modules/${name}/index.js`]: body,
  };
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
  async search(request, context) {
    const body = await context.request("/search", { method: "POST", body: { q: request.query, depth: request.setting } });
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
  it("offers and calls an installed package beside a first-party provider", async () => {
    const recipeDir = recipe(
      {
        search: [
          { provider: "brave" },
          { provider: "acme", package: "@acme/recipe-search" },
        ],
      },
      installed("@acme/recipe-search", searchModule()),
      { "@acme/recipe-search": "1.0.0" },
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
      "Recipe search provider 'acme': @introspection-ai/recipe-search has no provider 'acme'; give the declaration a package",
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
      installed(name, productivityModule("acme-mail")),
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
    const recipeDir = recipe({}, installed("@acme/p", body));
    return loadProviderModules(
      SEARCH_PROVIDER_FAMILY,
      [{ provider, package: "@acme/p" }],
      { recipeDir },
    );
  };

  it("refuses a wrong kind, apiVersion or id", async () => {
    await expect(load(searchModule({ kind: "issues" }))).rejects.toThrow(
      "Recipe search provider 'acme': @acme/p exports kind 'issues', not 'search'",
    );
    await expect(load(searchModule({ apiVersion: 2 }))).rejects.toThrow(
      "implements search provider API 2",
    );
    await expect(load(searchModule({ id: "other" }))).rejects.toThrow(
      "Recipe search provider 'acme': @acme/p declares id 'other', not 'acme'",
    );
  });

  it("refuses a productivity package declaring another provider", async () => {
    const recipeDir = recipe(
      {},
      installed("@acme/p", productivityModule("other")),
    );
    await expect(
      loadProviderModules(
        PRODUCTIVITY_PROVIDER_FAMILY,
        [{ provider: "acme", package: "@acme/p" }],
        { recipeDir },
      ),
    ).rejects.toThrow("@acme/p declares id 'other', not 'acme'");
  });

  it("refuses a package that is not installed", async () => {
    await expect(
      loadProviderModules(
        SEARCH_PROVIDER_FAMILY,
        [{ provider: "acme", package: "@acme/missing" }],
        { recipeDir: recipe({}) },
      ),
    ).rejects.toThrow(
      "Recipe search provider 'acme' requires @acme/missing in the Recipe dependencies",
    );
  });

  it("refuses a duplicate id", async () => {
    const recipeDir = recipe({}, installed("@acme/p", searchModule()));
    await expect(
      loadProviderModules(
        SEARCH_PROVIDER_FAMILY,
        [
          { provider: "acme", package: "@acme/p" },
          { provider: "acme", package: "@acme/p" },
        ],
        { recipeDir },
      ),
    ).rejects.toThrow("pi.search declares provider 'acme' more than once");
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
          { provider: "acme", package: "" },
          { provider: "brave", package: "@acme/search" },
          { provider: "brave" },
          { provider: "other" },
          { provider: "exa", source: "x" },
        ],
      }),
    ).toEqual([
      "package.json#pi.search[0].package must be a non-empty package name",
      "package.json#pi.search[1].package '@acme/search' must be listed in package.json#dependencies",
      "package.json#pi.search contains duplicate provider 'brave'",
      "package.json#pi.search provider 'other' is not a first-party provider (tavily, parallel, exa, keenable, perplexity, brave); give it a package",
      "package.json#pi.search[4] contains unknown field(s): source; it takes provider, package",
    ]);
  });

  it("checks productivity sources the same way", () => {
    expect(
      messages({
        productivity: [
          { provider: "acme", package: "@acme/mail" },
          { provider: "other", module: "./mail.js" },
        ],
      }),
    ).toEqual([
      "package.json#pi.productivity declares more than one provider; a Recipe uses one productivity provider",
      "package.json#pi.productivity[0].package '@acme/mail' must be listed in package.json#dependencies",
      "package.json#pi.productivity[1] contains unknown field(s): module",
      "package.json#pi.productivity provider 'other' requires dependency '@introspection-ai/recipe-productivity-other'",
    ]);
  });
});
