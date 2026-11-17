import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertRecipeModelTransport,
  createRecipeFallbackRouter,
  RecipeCredentialError,
  resolveRecipeAgentModels,
  routeRecipeFallbacks,
} from "../src/model-binding.js";
import { parseRecipeAgentAiConfig } from "../src/recipe/model.js";
import { resolveRecipe } from "../src/recipe/resolve.js";
import { createAgentSession } from "../src/session.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const luna = {
  provider: "openai",
  id: "gpt-6-luna",
  api: "openai-responses",
} as any;
const codexLuna = {
  provider: "openai-codex",
  id: "gpt-6-luna",
  api: "openai-codex-responses",
  headers: {},
} as any;
const sonnet = {
  provider: "anthropic",
  id: "claude-sonnet-5-5",
  api: "anthropic-messages",
} as any;

function registry(loggedIn: string[]) {
  const models: Record<string, any> = {
    "openai/gpt-6-luna": luna,
    "openai-codex/gpt-6-luna": codexLuna,
    "anthropic/claude-sonnet-5-5": sonnet,
  };
  return {
    find: (provider: string, id: string) => models[`${provider}/${id}`],
    getApiKeyAndHeaders: async (model: any) =>
      loggedIn.includes(model.provider)
        ? { ok: true, apiKey: `${model.provider}-token`, env: {} }
        : { ok: true },
  } as any;
}

describe("ai.fallbacks", () => {
  it("parses provider/model entries, in order", () => {
    expect(
      parseRecipeAgentAiConfig("test", {
        model: "openai/gpt-6-luna",
        fallbacks: ["anthropic/claude-sonnet-5-5", " openai/gpt-6-sol "],
      }),
    ).toMatchObject({
      name: "openai/gpt-6-luna",
      fallbacks: ["anthropic/claude-sonnet-5-5", "openai/gpt-6-sol"],
    });
  });

  it("refuses an entry that names no provider", () => {
    expect(() =>
      parseRecipeAgentAiConfig("test", {
        model: "openai/gpt-6-luna",
        fallbacks: ["claude-sonnet-5-5"],
      }),
    ).toThrow(/ai.fallbacks entry "claude-sonnet-5-5"/);
  });
});

describe("resolveRecipeAgentModels", () => {
  const specs = {
    modelSpec: "openai/gpt-6-luna",
    fallbacks: ["anthropic/claude-sonnet-5-5"],
  };

  it("keeps every model with a credential, the named one first, in one store", async () => {
    const { models, credentials } = await resolveRecipeAgentModels({
      ...specs,
      env: { OPENAI_API_KEY: "sk-test" },
      modelRegistry: registry(["anthropic"]),
    });
    expect(models.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "openai/gpt-6-luna",
      "anthropic/claude-sonnet-5-5",
    ]);
    expect(await credentials.read("openai")).toMatchObject({ key: "sk-test" });
    expect(await credentials.read("anthropic")).toMatchObject({
      key: "anthropic-token",
    });
  });

  it("starts on a fallback when the named model has no credential", async () => {
    const { models } = await resolveRecipeAgentModels({
      ...specs,
      env: {},
      modelRegistry: registry(["anthropic"]),
    });
    expect(models.map((m) => m.provider)).toEqual(["anthropic"]);
  });

  it("takes the subscription alias before a fallback", async () => {
    const { models } = await resolveRecipeAgentModels({
      ...specs,
      env: {},
      modelRegistry: registry(["openai-codex", "anthropic"]),
    });
    expect(models.map((m) => m.provider)).toEqual([
      "openai-codex",
      "anthropic",
    ]);
  });

  it("keeps one of two entries that resolve to the same model, so a retry can move past it", async () => {
    const { models } = await resolveRecipeAgentModels({
      modelSpec: "openai/gpt-6-luna",
      fallbacks: ["openai-codex/gpt-6-luna", "anthropic/claude-sonnet-5-5"],
      env: {},
      modelRegistry: registry(["openai-codex", "anthropic"]),
    });
    expect(models.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "openai-codex/gpt-6-luna",
      "anthropic/claude-sonnet-5-5",
    ]);
  });

  it("names the model the Recipe asked for when nothing has a credential", async () => {
    await expect(
      resolveRecipeAgentModels({
        ...specs,
        env: {},
        modelRegistry: registry([]),
      }),
    ).rejects.toThrow(/"openai"/);
  });

  it("never takes the alias when the host passes its own store", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai", async () => ({
      type: "api_key",
      key: "sk-host",
    }));
    const { models } = await resolveRecipeAgentModels({
      ...specs,
      env: {},
      credentials,
      modelRegistry: registry(["openai-codex"]),
    });
    expect(models.map((m) => m.provider)).toEqual(["openai"]);
  });

  it("ignores fallbacks when the host passes its own store", async () => {
    const credentials = new InMemoryCredentialStore();
    await expect(
      resolveRecipeAgentModels({
        ...specs,
        env: {},
        credentials,
        modelRegistry: registry(["anthropic"]),
      }),
    ).rejects.toBeInstanceOf(RecipeCredentialError);
  });

  it("lets a declared fallback through the transport check, and nothing else", () => {
    expect(() =>
      assertRecipeModelTransport("openai/gpt-6-luna", sonnet, specs.fallbacks),
    ).not.toThrow();
    expect(() =>
      assertRecipeModelTransport("openai/gpt-6-luna", sonnet),
    ).toThrow();
  });
});

describe("routeRecipeFallbacks", () => {
  const models = [luna, sonnet];
  const route = (request: Record<string, unknown>) =>
    routeRecipeFallbacks(models, {
      model: luna,
      thinkingLevel: "medium",
      messages: [],
      ...request,
    } as any).model;

  it("starts on the first model", () => {
    expect(route({ reason: "user" })).toBe(luna);
  });

  it("moves to the next model on a retry, and no further than the last", () => {
    expect(route({ reason: "retry", failed: { model: luna } })).toBe(sonnet);
    expect(route({ reason: "retry", failed: { model: sonnet } })).toBe(sonnet);
  });

  it("stays on the model that last answered", () => {
    expect(route({ reason: "continuation", previous: { model: sonnet } })).toBe(
      sonnet,
    );
    expect(route({ reason: "user", previous: { model: sonnet } })).toBe(sonnet);
  });
});

describe("createRecipeFallbackRouter", () => {
  const retry = (model: any) =>
    ({ reason: "retry", failed: { model }, thinkingLevel: "low" }) as any;

  it("retries a failing model the given number of times before moving on", () => {
    const route = createRecipeFallbackRouter([luna, sonnet], {
      afterRetries: 2,
    });
    expect(route(retry(luna)).model).toBe(luna);
    expect(route(retry(luna)).model).toBe(luna);
    expect(route(retry(luna)).model).toBe(sonnet);
    expect(route(retry(sonnet)).model).toBe(sonnet);
  });

  it("starts the count again once a request succeeds", () => {
    const route = createRecipeFallbackRouter([luna, sonnet], {
      afterRetries: 1,
    });
    expect(route(retry(luna)).model).toBe(luna);
    route({ reason: "user", previous: { model: luna } } as any);
    expect(route(retry(luna)).model).toBe(luna);
    expect(route(retry(luna)).model).toBe(sonnet);
  });
});

describe("a session with fallbacks", () => {
  it("answers from the fallback when the named model returns 429, through each model's configured transport", async () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    writeFileSync(
      join(fixture.recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "ai:",
        "  model: faux/faux-1",
        "  fallbacks: [faux-b/faux-b-1]",
        "tools: [read]",
        "system_instructions:",
        "  mode: append",
        "  content: Fallback agent",
        "",
      ].join("\n"),
    );
    const primary = fauxProvider();
    const fallback = fauxProvider({
      provider: "faux-b",
      models: [{ id: "faux-b-1" }],
    });
    const streamed: Array<[string, string | undefined, string | undefined]> =
      [];
    primary.setResponses([
      (_context, _options, _state, model) => {
        streamed.push([
          model.provider,
          model.baseUrl,
          model.headers?.["x-proxy"],
        ]);
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "429 Too Many Requests",
        });
      },
    ]);
    fallback.setResponses([
      (_context, _options, _state, model) => {
        streamed.push([
          model.provider,
          model.baseUrl,
          model.headers?.["x-proxy"],
        ]);
        return fauxAssistantMessage("from the fallback");
      },
    ]);
    const throughProxy = (model: any, name: string) => ({
      ...model,
      baseUrl: `https://${name}.proxy.test/v1`,
      headers: { ...(model.headers ?? {}), "x-proxy": name },
    });
    const credentials = new InMemoryCredentialStore();
    for (const provider of ["faux", "faux-b"])
      await credentials.modify(provider, async () => ({
        type: "api_key",
        key: "test-key",
      }));

    const handle = await createAgentSession({
      recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
      cwd: fixture.workspaceDir,
      env: cleanEnv(),
      credentials,
      modelOverride: throughProxy(primary.getModel(), "primary"),
      modelFallbacks: [throughProxy(fallback.getModel(), "fallback")],
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
      }),
      extensionFactories: [
        (pi) => pi.registerProvider(primary.provider),
        (pi) => pi.registerProvider(fallback.provider),
      ],
      mcpBindings: { servers: [] },
    });
    cleanups.push(() => handle.dispose());

    await handle.session.prompt("hello");

    const last = handle.session.messages.at(-1) as any;
    expect(last.role).toBe("assistant");
    expect(last.provider).toBe("faux-b");
    expect(last.content).toEqual([{ type: "text", text: "from the fallback" }]);
    expect(primary.state.callCount).toBe(1);
    expect(streamed).toEqual([
      ["faux", "https://primary.proxy.test/v1", "primary"],
      ["faux-b", "https://fallback.proxy.test/v1", "fallback"],
    ]);
  });

  it("sends a Gemini fallback tool schemas without additionalProperties", async () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    writeFileSync(
      join(fixture.recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "ai:",
        "  model: faux/faux-1",
        "  fallbacks: [faux-g/gemini-faux]",
        "tools: [read, strict_lookup]",
        "system_instructions:",
        "  mode: append",
        "  content: Fallback agent",
        "",
      ].join("\n"),
    );
    const schemas = (messages: readonly any[]) =>
      JSON.stringify(
        messages.flatMap((message) =>
          message.role === "system"
            ? (message.toolsAdded ?? []).map((tool: any) => tool.parameters)
            : [],
        ),
      );
    const sent: Record<string, string> = {};
    const primary = fauxProvider();
    const gemini = fauxProvider({
      provider: "faux-g",
      models: [{ id: "gemini-faux" }],
    });
    primary.setResponses([
      (context) => {
        sent.primary = schemas(context.messages);
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "503 Service Unavailable",
        });
      },
    ]);
    gemini.setResponses([
      (context) => {
        sent.gemini = schemas(context.messages);
        return fauxAssistantMessage("from Gemini");
      },
    ]);
    const credentials = new InMemoryCredentialStore();
    for (const provider of ["faux", "faux-g"])
      await credentials.modify(provider, async () => ({
        type: "api_key",
        key: "test-key",
      }));
    const strictTool = {
      name: "strict_lookup",
      label: "Strict lookup",
      description: "Looks a key up.",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
      execute: async () => ({
        content: [{ type: "text", text: "found" }],
        details: {},
      }),
    } as any;

    const handle = await createAgentSession({
      recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
      cwd: fixture.workspaceDir,
      env: cleanEnv(),
      credentials,
      modelOverride: primary.getModel(),
      modelFallbacks: [gemini.getModel()],
      customTools: [strictTool],
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
      }),
      extensionFactories: [
        (pi) => pi.registerProvider(primary.provider),
        (pi) => pi.registerProvider(gemini.provider),
      ],
      mcpBindings: { servers: [] },
    });
    cleanups.push(() => handle.dispose());

    await handle.session.prompt("hello");

    expect(sent.primary).toContain("additionalProperties");
    expect(sent.gemini).toBeDefined();
    expect(sent.gemini).not.toContain("additionalProperties");
  });
});
