import { describe, expect, it } from "vitest";
import {
  RecipeModelTransportError,
  assertRecipeModelTransport,
  resolveRecipeAgentModel,
  resolveRecipeCredentials,
} from "../src/model-binding.js";

describe("resolveRecipeCredentials", () => {
  it("applies nullable Pi 0.84 auth headers without leaking nulls to models", async () => {
    const model = {
      provider: "test",
      id: "model",
      headers: { existing: "keep", removed: "old" },
    } as any;
    const modelRegistry = {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "secret",
        env: {},
        headers: { added: "new", removed: null },
      }),
    } as any;

    await resolveRecipeCredentials({
      provider: "test",
      env: {},
      model,
      modelRegistry,
    });

    expect(model.headers).toEqual({ existing: "keep", added: "new" });
  });
});

describe("resolveRecipeAgentModel", () => {
  const openai = {
    provider: "openai",
    id: "gpt-6-luna",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  } as any;
  const codex = {
    provider: "openai-codex",
    id: "gpt-6-luna",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    headers: {},
  } as any;
  function registry(loggedIn: string[]) {
    const models: Record<string, any> = {
      "openai/gpt-6-luna": openai,
      "openai-codex/gpt-6-luna": codex,
    };
    return {
      find: (provider: string, id: string) => models[`${provider}/${id}`],
      getApiKeyAndHeaders: async (model: any) =>
        loggedIn.includes(model.provider)
          ? { ok: true, apiKey: `${model.provider}-token`, env: {} }
          : { ok: true },
    } as any;
  }

  it("runs the named model when its provider has a credential", async () => {
    const model = await resolveRecipeAgentModel(
      "openai/gpt-6-luna",
      { OPENAI_API_KEY: "sk-test" },
      registry(["openai-codex"]),
    );
    expect(model).toBe(openai);
  });

  it("runs the same model on the ChatGPT subscription without an OpenAI key", async () => {
    const model = await resolveRecipeAgentModel(
      "openai/gpt-6-luna",
      {},
      registry(["openai-codex"]),
    );
    expect(model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-6-luna",
      api: "openai-codex-responses",
    });
    expect(model).not.toBe(codex);
    expect(openai.baseUrl).toBe("https://api.openai.com/v1");
    expect(() =>
      assertRecipeModelTransport("openai/gpt-6-luna", model),
    ).not.toThrow();
  });

  it("keeps the named model when nothing serves it, so its credential error names it", async () => {
    const model = await resolveRecipeAgentModel(
      "openai/gpt-6-luna",
      {},
      registry([]),
    );
    expect(model).toBe(openai);
  });

  it("still refuses a host model that is neither the named one nor its alias", () => {
    expect(() =>
      assertRecipeModelTransport("openai/gpt-6-luna", {
        provider: "anthropic",
        id: "gpt-6-luna",
      } as any),
    ).toThrow(RecipeModelTransportError);
  });
});

describe("a child's OAuth credential", () => {
  it("reads a current token through the parent's Pi on every request", async () => {
    let issued = 0;
    const model = { provider: "openai-codex", id: "gpt-6-luna" } as any;
    const modelRegistry = {
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: `token-${++issued}`,
        env: {},
      }),
    } as any;

    const store = await resolveRecipeCredentials({
      provider: "openai-codex",
      env: {},
      model,
      modelRegistry,
    });

    expect(await store.read("openai-codex")).toMatchObject({
      type: "oauth",
      access: "token-2",
    });
    expect(await store.read("openai-codex")).toMatchObject({
      access: "token-3",
    });
    expect(await store.read("anthropic")).toBeUndefined();
  });
});
