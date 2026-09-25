import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BROWSER_COMMANDS,
  createBrowserExtension,
  hostAllowed,
  registerBrowserTool,
  resolveBrowserConfig,
  type BrowserAgentModule,
} from "../src/browser/index.js";
import { loadRecipeConnectors } from "../src/connector-tools.js";
import { readPiPackageManifest, validatePiPackageManifest } from "../src/recipe/package.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const ENV = {
  INTROSPECTION_TASK_BROWSER_CDP_URL: "http://127.0.0.1:9222",
  INTROSPECTION_TASK_BROWSER_ALLOWED_DOMAINS: "app.example.com, *.shop.test",
};

/**
 * Stands in for the runtime-supplied `@introspection-sdk/browser-agent`, whose
 * own suite drives real Chromium. This records what the tool asks of it.
 */
function agentModule() {
  const calls: Record<string, unknown>[] = [];
  const connects: Array<{ endpoint: string; options: unknown }> = [];
  const jev: unknown[] = [];
  let toolOptions: Parameters<BrowserAgentModule["createBrowserTool"]>[0] | undefined;
  const module: BrowserAgentModule = {
    BrowserSession: {
      async connect(endpoint, options) {
        connects.push({ endpoint, options });
        return { endpoint };
      },
    },
    createBrowserTool(options) {
      toolOptions = options;
      return {
        commands: options.commands ?? [],
        async call(input) {
          calls.push(input);
          if (input.command === "navigate") await options.validateTarget?.(input.url as string);
          if (input.command === "screenshot") return { mime_type: "image/jpeg", data: "AAAA", width: 800, height: 600 };
          if (input.command === "observe") return { url: "https://app.example.com", elements: [], screenshot: "BBBB" };
          if (input.command === "run") return { status: "done", drivers: options.drivers?.(input) };
          return { ok: true, echo: input };
        },
      };
    },
    JevDriver: class {
      constructor(opts: unknown) {
        jev.push(opts);
      }
    } as unknown as BrowserAgentModule["JevDriver"],
  };
  return { module, calls, connects, jev, toolOptions: () => toolOptions };
}

const tool = (pi: ReturnType<typeof createMockExtensionAPI>) => pi.tools.get("browser")!;
const exec = (pi: ReturnType<typeof createMockExtensionAPI>, input: Record<string, unknown>) =>
  tool(pi).execute("call-1", input as never, undefined as never, undefined as never, undefined as never);

describe("resolveBrowserConfig", () => {
  it("reads the INTROSPECTION_TASK_BROWSER_* contract", () => {
    expect(resolveBrowserConfig({})).toBeNull();
    expect(resolveBrowserConfig({ INTROSPECTION_TASK_BROWSER_CDP_URL: "  " })).toBeNull();
    expect(resolveBrowserConfig({ ...ENV, INTROSPECTION_TASK_BROWSER_JEV_URL: "http://api.typesafe.ai" })).toEqual({
      cdpUrl: "http://127.0.0.1:9222",
      allowedDomains: ["app.example.com", "*.shop.test"],
      jevUrl: "http://api.typesafe.ai",
    });
  });

  it("matches hosts and wildcards", () => {
    expect(hostAllowed("https://x.test", [])).toBe(true);
    expect(hostAllowed("https://eu.shop.test/a", ["*.shop.test"])).toBe(true);
    expect(hostAllowed("https://shop.test/", ["*.shop.test"])).toBe(true);
    expect(hostAllowed("https://evilshop.test/", ["*.shop.test"])).toBe(false);
    expect(hostAllowed("nope", ["a.test"])).toBe(false);
  });
});

describe("browser tool", () => {
  it("registers one tool whose schema covers the allowed commands only", () => {
    const pi = createMockExtensionAPI();
    registerBrowserTool(pi, { env: ENV, commands: ["observe", "act"] });
    const params = tool(pi).parameters as { anyOf: Array<{ properties: { command: { const: string } } }> };
    expect(params.anyOf.map((v) => v.properties.command.const)).toEqual(["observe", "act"]);
    expect(tool(pi).description).toContain("untrusted data");
  });

  it("offers run only when the platform provides a Jev route", () => {
    const without = createMockExtensionAPI();
    registerBrowserTool(without, { env: ENV });
    const commands = (p: typeof without) =>
      (tool(p).parameters as { anyOf: Array<{ properties: { command: { const: string } } }> }).anyOf.map(
        (v) => v.properties.command.const,
      );
    expect(commands(without)).not.toContain("run");
    expect(() => registerBrowserTool(createMockExtensionAPI(), { env: ENV, commands: ["run"] })).toThrow(/Unsupported browser command: run/);

    const withJev = createMockExtensionAPI();
    registerBrowserTool(withJev, { env: { ...ENV, INTROSPECTION_TASK_BROWSER_JEV_URL: "http://api.typesafe.ai" } });
    expect(commands(withJev)).toEqual([...BROWSER_COMMANDS]);
  });

  it("rejects unknown commands and registers nothing for an empty allowlist", () => {
    expect(() => registerBrowserTool(createMockExtensionAPI(), { env: ENV, commands: ["teleport"] })).toThrow(/Unknown browser command/);
    const pi = createMockExtensionAPI();
    registerBrowserTool(pi, { env: ENV, commands: [] });
    expect(pi.tools.has("browser")).toBe(false);
  });

  it("connects lazily, once, and dispatches every call through the agent package", async () => {
    const agent = agentModule();
    const pi = createMockExtensionAPI();
    registerBrowserTool(pi, { env: ENV, loadAgent: async () => agent.module });
    expect(agent.connects).toHaveLength(0);

    const acted = (await exec(pi, { command: "act", element: "el_a_1", action: "click" })) as {
      details: { ok: boolean };
    };
    expect(acted.details.ok).toBe(true);
    await exec(pi, { command: "tabs" });
    expect(agent.connects).toEqual([
      { endpoint: "http://127.0.0.1:9222", options: { allowedDomains: ["app.example.com", "*.shop.test"] } },
    ]);
    await exec(pi, { command: "press", keys: ["ArrowLeft", "Space"] });
    await exec(pi, { command: "act", action: "click", x: 10, y: 20 });
    expect(agent.calls.map((c) => c.command)).toEqual(["act", "tabs", "press", "act"]);
  });

  it("returns screenshots as image content", async () => {
    const agent = agentModule();
    const pi = createMockExtensionAPI();
    registerBrowserTool(pi, { env: ENV, loadAgent: async () => agent.module });
    const shot = (await exec(pi, { command: "screenshot" })) as { content: Array<{ type: string; data?: string }> };
    expect(shot.content).toEqual([
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      { type: "text", text: "800x600 pixels" },
    ]);
    const observed = (await exec(pi, { command: "observe" })) as { content: Array<{ type: string }>; details: object };
    expect(observed.content.map((c) => c.type)).toEqual(["image", "text"]);
    expect(observed.details).not.toHaveProperty("screenshot");
  });

  it("validates arguments against the command schema", async () => {
    const pi = createMockExtensionAPI();
    registerBrowserTool(pi, { env: ENV, loadAgent: async () => agentModule().module });
    await expect(exec(pi, { command: "act", element: "el_a_1" })).rejects.toThrow(/follow the command schema/);
    await expect(exec(pi, { command: "observe", bogus: 1 })).rejects.toThrow(/follow the command schema/);
    await expect(exec(pi, { command: "press", keys: [] })).rejects.toThrow(/follow the command schema/);
  });

  it("applies the Recipe's allowed domains on navigate", async () => {
    const agent = agentModule();
    const pi = createMockExtensionAPI();
    registerBrowserTool(pi, { env: ENV, allowedDomains: ["app.example.com"], loadAgent: async () => agent.module });
    await exec(pi, { command: "navigate", url: "https://app.example.com/a" });
    await expect(exec(pi, { command: "navigate", url: "https://other.test/" })).rejects.toThrow(/outside this Recipe's allowed domains/);
  });

  it("builds a Jev driver per run with the caller's inputs, through the platform route", async () => {
    const agent = agentModule();
    const pi = createMockExtensionAPI();
    registerBrowserTool(pi, {
      env: { ...ENV, INTROSPECTION_TASK_BROWSER_JEV_URL: "http://api.typesafe.ai", INTROSPECTION_TOKEN: "locator" },
      loadAgent: async () => agent.module,
    });
    await exec(pi, { command: "run", goal: "Design stays in Lisbon", inputs: { Destination: "Lisbon" } });
    expect(agent.jev).toEqual([{ baseUrl: "http://api.typesafe.ai", apiKey: "locator", slots: { Destination: "Lisbon" } }]);
  });

  it("fails calls, not the session, when the task has no browser, and retries loading", async () => {
    const pi = createMockExtensionAPI();
    registerBrowserTool(pi, { env: {} });
    await expect(exec(pi, { command: "tabs" })).rejects.toThrow(/This task has no browser/);

    let attempts = 0;
    const agent = agentModule();
    const flaky = createMockExtensionAPI();
    registerBrowserTool(flaky, {
      env: ENV,
      loadAgent: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("not yet");
        return agent.module;
      },
    });
    await expect(exec(flaky, { command: "tabs" })).rejects.toThrow("not yet");
    await exec(flaky, { command: "tabs" });
    expect(attempts).toBe(2);
  });

  it("explains a missing agent package", async () => {
    const pi = createMockExtensionAPI();
    registerBrowserTool(pi, { env: ENV });
    await expect(exec(pi, { command: "tabs" })).rejects.toThrow(/@introspection-sdk\/browser-agent/);
  });

  it("installs only when the agent selected the tool", () => {
    const skipped = createMockExtensionAPI();
    createBrowserExtension({ tools: [], env: ENV })(skipped);
    expect(skipped.tools.has("browser")).toBe(false);
    const installed = createMockExtensionAPI();
    createBrowserExtension({ tools: ["browser"], env: ENV })(installed);
    expect(installed.tools.has("browser")).toBe(true);
  });
});

describe("pi.browser declaration", () => {
  function recipe(browser: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "recipe-browser-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "browser-test", version: "0.1.0", pi: { agents: ["agents/*.yaml"], browser } }),
    );
    return dir;
  }

  it("parses commands, allowed domains and profile", async () => {
    const manifest = readPiPackageManifest(
      recipe({ commands: ["observe", "act"], allowedDomains: ["app.example.com"], profile: "required" }),
    );
    expect(manifest.browser).toEqual({ commands: ["observe", "act"], allowedDomains: ["app.example.com"], profile: "required" });
    expect((readPiPackageManifest(recipe({}))).browser).toEqual({});
    expect((readPiPackageManifest(recipe(undefined))).browser).toBeUndefined();
  });

  it("reports malformed declarations", async () => {
    for (const [browser, message] of [
      [[], "must be an object"],
      [{ commands: ["teleport"] }, "unknown command(s): teleport"],
      [{ commands: ["act", "act"] }, "unique non-empty strings"],
      [{ allowedDomains: [""] }, "allowedDomains must be"],
      [{ profile: "sometimes" }, "profile must be one of"],
      [{ backend: "sidecar" }, "unknown field(s): backend"],
    ] as const) {
      const report = validatePiPackageManifest(readPiPackageManifest(recipe(browser)));
      const found = report.findings.filter((f) => f.code === "pi.browser_invalid").map((f) => f.message);
      expect(found.some((m) => m.includes(message)), `${JSON.stringify(browser)} -> ${found}`).toBe(true);
    }
  });

  it("loads the browser as a connector when an agent selects it", async () => {
    const manifest = readPiPackageManifest(recipe({ commands: ["observe"] }));
    const loaded = await loadRecipeConnectors(manifest, ["browser"], { recipeDir: manifest.path, env: ENV });
    expect(loaded.loadout).toEqual({ toolNames: ["browser"], initialActiveToolNames: ["browser"], deferredToolNames: [] });
    expect(loaded.extensions.map((e) => e.owner)).toEqual(["<browser>"]);
    const pi = createMockExtensionAPI();
    await loaded.extensions[0]!.factory(pi);
    expect(pi.tools.has("browser")).toBe(true);

    expect((await loadRecipeConnectors(manifest, ["read"], { recipeDir: manifest.path, env: ENV })).extensions).toEqual([]);
    const disabled = readPiPackageManifest(recipe({ commands: [] }));
    expect((await loadRecipeConnectors(disabled, ["browser"], { recipeDir: disabled.path })).extensions).toEqual([]);
  });
});
