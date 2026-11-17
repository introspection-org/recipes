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
});
