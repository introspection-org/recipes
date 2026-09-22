import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadValidatedRecipeAgentDefinitions,
  validateRecipeAgentDefinitions,
} from "../src/recipe/agent.js";
import {
  applyRecipeAgentModelConfigToModel,
  applyRecipeAgentModelConfigToSession,
  cloneModelForRecipe,
  mergeRecipeAgentModelConfig,
  parseRecipeAgentAiConfig,
  parseRecipeAgentModelConfig,
  RecipeModelConfigError,
} from "../src/recipe/model.js";
import {
  mergeRecipeAgentSessionConfig,
  parseRecipeAgentSessionConfig,
} from "../src/recipe/session.js";

describe("parseRecipeAgentAiConfig", () => {
  it("normalizes future Pi options without flattening nested payloads", () => {
    expect(
      parseRecipeAgentAiConfig("test", {
        model: "openrouter/anthropic/claude-sonnet-4",
        thinking_level: "max",
        options: {
          max_tokens: 4096,
          sampling_params: { min_p: 0.1 },
          websocket_connect_timeout_ms: 5000,
        },
      })
    ).toEqual({
      name: "openrouter/anthropic/claude-sonnet-4",
      thinkingLevel: "max",
      streamOptions: {
        maxTokens: 4096,
        samplingParams: { min_p: 0.1 },
        websocketConnectTimeoutMs: 5000,
      },
    });
  });

  it("rejects mixed casing and host-owned request controls", () => {
    expect(() =>
      parseRecipeAgentAiConfig("test", { options: { maxTokens: 1 } })
    ).toThrow(/non-snake_case/);
    expect(() =>
      parseRecipeAgentAiConfig("test", { options: { api_key: "secret" } })
    ).toThrow(/host-owned/);
    expect(() =>
      parseRecipeAgentAiConfig("test", { options: { on_payload: true } })
    ).toThrow(/host-owned/);
    for (const option of [
      "client",
      "bearer_token",
      "profile",
      "region",
      "project",
      "location",
      "azure_api_version",
      "azure_resource_name",
      "azure_base_url",
      "azure_deployment_name",
      "transform_headers",
    ]) {
      expect(() =>
        parseRecipeAgentAiConfig("test", {
          options: { [option]: "host binding" },
        })
      ).toThrow(/host-owned/);
    }
  });

  it("preserves future OpenRouter routing fields without a Recipes release", () => {
    expect(
      parseRecipeAgentAiConfig("test", {
        model: "openrouter/anthropic/claude-sonnet-4",
        providers: {
          openrouter: {
            routing: {
              order: ["anthropic"],
              future_router_policy: { mode: "strict" },
            },
          },
        },
      })
    ).toMatchObject({
      openrouter: {
        order: ["anthropic"],
        future_router_policy: { mode: "strict" },
      },
    });
  });

  it("contains transparent Anthropic context management in an object envelope", () => {
    expect(
      parseRecipeAgentAiConfig("test", {
        model: "anthropic/claude-sonnet-4",
        providers: {
          anthropic: {
            context_management: {
              edits: [{ type: "clear_tool_uses_20250919" }],
              future_policy: { mode: "strict" },
            },
          },
        },
      })
    ).toMatchObject({
      anthropic: {
        contextManagement: {
          edits: [{ type: "clear_tool_uses_20250919" }],
          future_policy: { mode: "strict" },
        },
      },
    });

    expect(() =>
      parseRecipeAgentAiConfig("test", {
        providers: { anthropic: { context_management: "invalid" } },
      })
    ).toThrow(/context_management: expected object/);
  });

  it("preserves Vercel AI Gateway routing but rejects request-scoped credentials", () => {
    expect(
      parseRecipeAgentAiConfig("test", {
        model: "vercel-ai-gateway/anthropic/claude-sonnet-5",
        providers: {
          vercel_ai_gateway: {
            routing: {
              order: ["anthropic", "bedrock"],
              only: ["anthropic", "bedrock"],
              sort: "cost",
              future_gateway_policy: { mode: "strict" },
            },
          },
        },
      })
    ).toMatchObject({
      vercelAiGateway: {
        order: ["anthropic", "bedrock"],
        only: ["anthropic", "bedrock"],
        sort: "cost",
        future_gateway_policy: { mode: "strict" },
      },
    });

    expect(() =>
      parseRecipeAgentAiConfig("test", {
        providers: {
          vercel_ai_gateway: {
            routing: { byok: { anthropic: [{ apiKey: "secret" }] } },
          },
        },
      })
    ).toThrow(/host-owned.*byok/);
  });
});

describe("parseRecipeAgentSessionConfig", () => {
  it("maps portable session policy onto Pi settings", () => {
    expect(
      parseRecipeAgentSessionConfig("test", {
        steering_mode: "one-at-a-time",
        follow_up_mode: "all",
        tool_execution: "sequential",
        retry: { max_retries: 4, base_delay_ms: 250 },
        compaction: { reserve_tokens: 2048 },
      })
    ).toEqual({
      steeringMode: "one-at-a-time",
      followUpMode: "all",
      toolExecution: "sequential",
      settings: {
        steeringMode: "one-at-a-time",
        followUpMode: "all",
        retry: { maxRetries: 4, baseDelayMs: 250 },
        compaction: { reserveTokens: 2048 },
      },
    });
  });

  it("merges inherited session policy", () => {
    expect(
      mergeRecipeAgentSessionConfig(
        { steeringMode: "all", settings: { retry: { maxRetries: 2 } } },
        { toolExecution: "sequential", settings: { images: { autoResize: false } } }
      )
    ).toEqual({
      steeringMode: "all",
      toolExecution: "sequential",
      settings: {
        retry: { maxRetries: 2 },
        images: { autoResize: false },
      },
    });
  });

  it("treats empty session policy as a no-op", () => {
    expect(parseRecipeAgentSessionConfig("test", {})).toBeUndefined();
    expect(
      parseRecipeAgentSessionConfig("test", {
        retry: {},
        compaction: {},
        images: {},
      })
    ).toBeUndefined();
  });

  it.each([
    [{ retry: { max_retriez: 3 } }, /max_retriez/],
    [{ retry: { enabled: "yes" } }, /expected boolean/],
    [{ retry: { max_retries: 1.5 } }, /expected integer/],
    [{ retry: { provider: { timeout_ms: 0 } } }, /integer >= 1/],
    [{ compaction: { reserve_tokens: -1 } }, /integer >= 0/],
    [{ branch_summary: {} }, /unsupported session key/],
    [{ images: { block_images: null } }, /expected boolean/],
  ] as const)("rejects invalid portable session policy %#", (session, error) => {
    expect(() => parseRecipeAgentSessionConfig("test", session)).toThrow(error);
  });
});

describe("parseRecipeAgentModelConfig", () => {
  it("parses the full model block", () => {
    const config = parseRecipeAgentModelConfig("test", {
      name: "anthropic/claude-fable-5",
      thinking_level: "high",
      temperature: 0.4,
      max_tokens: 4096,
      cache_retention: "long",
      timeout_ms: 30000,
      max_retries: 3,
      max_retry_delay_ms: 10000,
      providers: {
        openrouter: { routing: { sort: "throughput", zdr: true } },
        anthropic: { betas: ["context-1m-2025-08-07"] },
      },
    });

    expect(config).toEqual({
      name: "anthropic/claude-fable-5",
      thinkingLevel: "high",
      streamOptions: {
        temperature: 0.4,
        maxTokens: 4096,
        cacheRetention: "long",
        timeoutMs: 30000,
        maxRetries: 3,
        maxRetryDelayMs: 10000,
      },
      openrouter: { sort: "throughput", zdr: true },
      anthropic: { betas: ["context-1m-2025-08-07"] },
    });
  });

  it("rejects non-canonical thinking-level aliases", () => {
    expect(() =>
      parseRecipeAgentModelConfig("test", { thinkingLevel: "low" })
    ).toThrow(/unsupported model key/);
    expect(() =>
      parseRecipeAgentModelConfig("test", { reasoning_effort: "high" })
    ).toThrow(/unsupported model key/);
  });

  it("rejects unknown keys and invalid values", () => {
    expect(() => parseRecipeAgentModelConfig("test", { cache_rention: "long" })).toThrow(
      RecipeModelConfigError
    );
    expect(() => parseRecipeAgentModelConfig("test", { temperature: "hot" })).toThrow(
      /temperature/
    );
    expect(() => parseRecipeAgentModelConfig("test", "gpt")).toThrow(/expected object/);
  });

  it("returns undefined for an absent block", () => {
    expect(parseRecipeAgentModelConfig("test", undefined)).toBeUndefined();
  });
});

describe("mergeRecipeAgentModelConfig", () => {
  it("resets inherited tuning when model identity changes", () => {
    const merged = mergeRecipeAgentModelConfig(
      {
        name: "openai/gpt-5.5",
        streamOptions: { temperature: 0.2, maxTokens: 1024 },
        anthropic: { betas: ["a"] },
      },
      {
        name: "anthropic/claude-fable-5",
        streamOptions: { temperature: 0.7 },
        openrouter: { sort: "price" },
      }
    );

    expect(merged).toEqual({
      name: "anthropic/claude-fable-5",
      streamOptions: { temperature: 0.7 },
      openrouter: { sort: "price" },
    });
  });

  it("merges sections when the child omits model identity", () => {
    expect(
      mergeRecipeAgentModelConfig(
        {
          name: "anthropic/claude-fable-5",
          streamOptions: { temperature: 0.2, maxTokens: 1024 },
        },
        { streamOptions: { temperature: 0.7 } }
      )
    ).toEqual({
      name: "anthropic/claude-fable-5",
      streamOptions: { temperature: 0.7, maxTokens: 1024 },
    });
  });

  it("passes through one-sided configs", () => {
    const only = { name: "openai/gpt-5.5" };
    expect(mergeRecipeAgentModelConfig(only, undefined)).toBe(only);
    expect(mergeRecipeAgentModelConfig(undefined, only)).toBe(only);
  });
});

describe("applyRecipeAgentModelConfigToModel", () => {
  it("applies configuration to a session-local model clone", () => {
    const shared = {
      provider: "anthropic",
      id: "claude",
      headers: { existing: "yes" },
      compat: { supportsStore: true },
    } as any;
    const local = cloneModelForRecipe(shared);
    applyRecipeAgentModelConfigToModel(local, {
      anthropic: { betas: ["context-1m"] },
    });

    expect(local).not.toBe(shared);
    expect(local.headers).not.toBe(shared.headers);
    expect(shared.headers).toEqual({ existing: "yes" });
    expect(shared.compat).toEqual({ supportsStore: true });
  });

  it("applies routing and merges anthropic beta headers", () => {
    const model = {
      headers: { "anthropic-beta": "existing" },
    } as never;
    const applied = applyRecipeAgentModelConfigToModel(model, {
      openrouter: { sort: "throughput" },
      anthropic: { betas: ["new-beta"] },
    }) as { compat?: Record<string, unknown>; headers?: Record<string, string> };

    expect(applied.compat?.openRouterRouting).toEqual({ sort: "throughput" });
    expect(applied.headers?.["anthropic-beta"]).toBe("existing,new-beta");
  });
});

describe("applyRecipeAgentModelConfigToSession", () => {
  it("forwards future AI options to Pi without enumerating them", () => {
    const baseStreamFunction = vi.fn(() => "stream");
    const session = {
      agent: { streamFunction: baseStreamFunction },
    } as any;
    applyRecipeAgentModelConfigToSession(session, {
      streamOptions: {
        futureOption: "enabled",
        samplingParams: { future_wire_option: true },
      },
    });

    const model = {} as any;
    const context = {} as any;
    expect(
      session.agent.streamFunction(model, context, { temperature: 0.2 })
    ).toBe("stream");
    expect(baseStreamFunction).toHaveBeenCalledWith(model, context, {
      temperature: 0.2,
      futureOption: "enabled",
      samplingParams: { future_wire_option: true },
    });
  });

  it("injects Vercel gateway routing into only Vercel request payloads", async () => {
    const previousOnPayload = vi.fn((payload) => ({
      ...(payload as Record<string, unknown>),
      extensionApplied: true,
    }));
    const session = {
      agent: {
        streamFunction: vi.fn(),
        onPayload: previousOnPayload,
      },
    } as any;
    applyRecipeAgentModelConfigToSession(session, {
      vercelAiGateway: {
        order: ["anthropic", "bedrock"],
        sort: "cost",
        future_gateway_policy: { mode: "strict" },
      },
    });

    const original = {
      providerOptions: { gateway: { caching: "auto" }, existing: true },
    };
    await expect(
      session.agent.onPayload(original, { provider: "vercel-ai-gateway" })
    ).resolves.toEqual({
      providerOptions: {
        existing: true,
        gateway: {
          caching: "auto",
          order: ["anthropic", "bedrock"],
          sort: "cost",
          future_gateway_policy: { mode: "strict" },
        },
      },
      extensionApplied: true,
    });
    expect(previousOnPayload).toHaveBeenCalledOnce();

    await expect(
      session.agent.onPayload(original, { provider: "anthropic" })
    ).resolves.toEqual({ ...original, extensionApplied: true });
  });
});

describe("recipe agent model config loading", () => {
  let recipeDir: string;

  beforeEach(() => {
    recipeDir = mkdtempSync(join(tmpdir(), "recipes-model-"));
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({ name: "model-recipe", version: "0.0.1", pi: { agents: ["agents/*.yaml"] } })
    );
    mkdirSync(join(recipeDir, "agents"));
  });

  afterEach(() => {
    rmSync(recipeDir, { recursive: true, force: true });
  });

  it("starts fresh model config when identity changes across the from chain", () => {
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "description: base",
        "model:",
        "  name: openai/gpt-5.5",
        "  temperature: 0.2",
        "  providers:",
        "    anthropic:",
        "      betas: [interleaved-thinking]",
      ].join("\n")
    );
    writeFileSync(
      join(recipeDir, "agents", "sweep.yaml"),
      [
        "name: sweep",
        "from: agent",
        "description: sweep",
        "model:",
        "  name: anthropic/claude-fable-5",
        "  thinking_level: high",
      ].join("\n")
    );

    const definitions = loadValidatedRecipeAgentDefinitions(recipeDir).definitions;
    const sweep = definitions.get("sweep");

    expect(sweep?.model).toEqual({ name: "anthropic/claude-fable-5", thinkingLevel: "high" });
    expect(sweep?.modelConfig).toEqual({
      name: "anthropic/claude-fable-5",
      thinkingLevel: "high",
    });
  });

  it("accepts the minimal explicitly named agent", () => {
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      "name: agent\nmodel:\n  name: openai/gpt-5.5\n"
    );

    expect(validateRecipeAgentDefinitions(recipeDir)).toEqual([]);
    expect(
      loadValidatedRecipeAgentDefinitions(recipeDir).definitions.get("agent")
    ).toMatchObject({
      name: "agent",
      tools: [],
      skills: [],
      subagents: [],
    });
  });

  it("loads the preferred ai and session blocks", () => {
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "ai:",
        "  model: openai/gpt-5.5",
        "  thinking_level: high",
        "  options:",
        "    max_tokens: 2048",
        "session:",
        "  steering_mode: all",
        "  tool_execution: sequential",
      ].join("\n")
    );

    expect(validateRecipeAgentDefinitions(recipeDir)).toEqual([]);
    expect(
      loadValidatedRecipeAgentDefinitions(recipeDir).definitions.get("agent")
    ).toMatchObject({
      model: { name: "openai/gpt-5.5", thinkingLevel: "high" },
      modelConfig: { streamOptions: { maxTokens: 2048 } },
      sessionConfig: {
        steeringMode: "all",
        toolExecution: "sequential",
      },
    });
  });

  it("inherits ai and session settings into child agents", () => {
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "ai:",
        "  model: anthropic/claude-sonnet-4-6",
        "  options:",
        "    max_tokens: 4096",
        "session:",
        "  retry:",
        "    enabled: true",
        "    max_retries: 2",
      ].join("\n")
    );
    writeFileSync(
      join(recipeDir, "agents", "reviewer.yaml"),
      [
        "name: reviewer",
        "from: agent",
        "ai:",
        "  thinking_level: high",
        "session:",
        "  retry:",
        "    max_retries: 5",
        "  tool_execution: sequential",
      ].join("\n")
    );

    const reviewer = loadValidatedRecipeAgentDefinitions(recipeDir).definitions.get(
      "reviewer"
    );
    expect(reviewer).toMatchObject({
      modelConfig: {
        name: "anthropic/claude-sonnet-4-6",
        thinkingLevel: "high",
        streamOptions: { maxTokens: 4096 },
      },
      sessionConfig: {
        toolExecution: "sequential",
        settings: { retry: { enabled: true, maxRetries: 5 } },
      },
    });
  });

  it("rejects declaring legacy model and ai together", () => {
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "model:",
        "  name: openai/gpt-5.5",
        "ai:",
        "  model: openai/gpt-5.5",
      ].join("\n")
    );

    expect(validateRecipeAgentDefinitions(recipeDir)).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/both model and ai/) }),
    ]);
  });

  it("rejects the unshipped runtime spelling instead of creating an alias", () => {
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "ai:",
        "  model: openai/gpt-5.5",
        "runtime:",
        "  tool_execution: parallel",
      ].join("\n")
    );

    expect(validateRecipeAgentDefinitions(recipeDir)).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/runtime/) }),
    ]);
  });

  it.each(["append", "replace"] as const)(
    "accepts explicitly blank %s system instructions",
    (mode) => {
      writeFileSync(
        join(recipeDir, "agents", "agent.yaml"),
        [
          "name: agent",
          "model:",
          "  name: openai/gpt-5.5",
          "system_instructions:",
          `  mode: ${mode}`,
          "  content: '   '",
        ].join("\n")
      );

      expect(validateRecipeAgentDefinitions(recipeDir)).toEqual([]);
      expect(
        loadValidatedRecipeAgentDefinitions(recipeDir).definitions.get("agent")
          ?.systemInstructions
      ).toEqual({ mode, content: "" });
    }
  );

  it("rejects legacy agent instruction keys", () => {
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "model:",
        "  name: openai/gpt-5.5",
        "systemInstructions:",
        "  content: legacy",
        "prompt: legacy",
      ].join("\n")
    );

    expect(validateRecipeAgentDefinitions(recipeDir)).toEqual([
      expect.objectContaining({
        agentName: "agent",
        field: "file",
        message: expect.stringMatching(/unsupported key\(s\): .*prompt.*systemInstructions|unsupported key\(s\): .*systemInstructions.*prompt/),
      }),
    ]);
  });

  it.each([
    ["name", "name: 42"],
    ["from", "from: []"],
    ["description", "description: {}"],
    ["tools", "tools: [read, 42]"],
    ["skills", "skills: missing"],
    ["subagents", "subagents: ['']"],
    ["extensions", "extensions:\n  include: [42]"],
    [
      "system instructions",
      "system_instructions:\n  mode: invalid\n  content: Test",
    ],
  ])("rejects malformed present %s fields", (_label, fieldYaml) => {
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        ...(_label === "name" ? [] : ["name: agent"]),
        "model:",
        "  name: openai/gpt-5.5",
        fieldYaml,
      ].join("\n")
    );

    expect(validateRecipeAgentDefinitions(recipeDir)).toEqual([
      expect.objectContaining({
        agentName: "agent",
        field: "file",
      }),
    ]);
  });

  it("excludes invalid files from the parsed graph and returns their diagnostics", () => {
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      ["name: agent", "description: ok", "model:", "  name: openai/gpt-5.5"].join("\n")
    );
    writeFileSync(
      join(recipeDir, "agents", "broken.yaml"),
      ["name: broken", "description: bad", "model:", "  temprature: 1"].join("\n")
    );

    const result = loadValidatedRecipeAgentDefinitions(recipeDir);
    const definitions = result.definitions;

    expect(definitions.has("agent")).toBe(true);
    expect(definitions.has("broken")).toBe(false);
    expect(
      result.findings.some(
        (finding) => finding.field === "file" && finding.agentName === "broken"
      )
    ).toBe(true);
  });
});
