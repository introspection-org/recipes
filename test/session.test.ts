import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventStream,
  getModel,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai/compat";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpBindingError } from "../src/mcp/index.js";
import { registerChannelTools } from "../src/channels/index.js";
import type { LoadMemoryIndexOptions } from "../src/memory.js";
import {
  resolveRecipe,
} from "../src/recipe/resolve.js";
import { createInProcessRunController } from "../src/run-controller.js";
import { createDelegatedRuns } from "../src/agents.js";
import { createIsolatedChildSession } from "../src/child/session.js";
import {
  createAgentSession,
  createAgentSessionInternal,
  RecipeCredentialError,
  RecipeMcpEnvironmentInUseError,
  RecipeModelError,
  RecipeModelTransportError,
  type RecipeSessionHandle,
} from "../src/session.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";
import {
  installSlackRecipeConnector,
  SLACK_RECIPE_CHANNEL_PACKAGE,
} from "./helpers/recipe-connectors.js";

const detachTelemetry = vi.hoisted(() => vi.fn());
const instrumentSession = vi.hoisted(() =>
  vi.fn(() => ({ detach: detachTelemetry }))
);

vi.mock("@introspection-sdk/introspection-pi", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@introspection-sdk/introspection-pi")
  >()),
  instrumentSession,
}));

class MockAssistantStream extends EventStream<
  AssistantMessageEvent,
  AssistantMessage
> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected event type");
      }
    );
  }
}

function assistantMessage(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop"
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "mock",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function scriptReply(handle: RecipeSessionHandle, text: string): void {
  handle.session.agent.streamFunction = () => {
    const stream = new MockAssistantStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: assistantMessage("") });
      stream.push({ type: "done", reason: "stop", message: assistantMessage(text) });
    });
    return stream;
  };
}

async function credentialStore(): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: "test-key",
  }));
  return store;
}

async function openRouterCredentialStore(): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify("openrouter", async () => ({
    type: "api_key",
    key: "test-openrouter-key",
  }));
  return store;
}

async function vercelAiGatewayCredentialStore(): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify("vercel-ai-gateway", async () => ({
    type: "api_key",
    key: "test-vercel-ai-gateway-key",
  }));
  return store;
}

async function providerCredentialStore(
  provider: string
): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  if (provider === "openai-codex") {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "test-account",
        },
      })
    ).toString("base64url");
    await store.modify(provider, async () => ({
      type: "oauth",
      access: `e30.${payload}.signature`,
      refresh: "test-openai-codex-refresh-token",
      expires: Date.now() + 60 * 60 * 1000,
    }));
    return store;
  }
  await store.modify(provider, async () => ({
    type: "api_key",
    // Pi treats an OpenAI key without `sk-` as a ChatGPT sign-in and drops
    // request options it does not accept.
    key: `sk-test-${provider}-key`,
    ...(provider === "azure-openai-responses"
      ? { env: { AZURE_OPENAI_RESOURCE_NAME: "test-resource" } }
      : {}),
  }));
  return store;
}

function nestedValue(
  value: Record<string, unknown>,
  path: readonly string[]
): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

async function captureSerializedPayload(handle: RecipeSessionHandle): Promise<{
  payload: Record<string, unknown>;
}> {
  let payload: Record<string, unknown> | undefined;
  const previousOnPayload = handle.session.agent.onPayload;
  handle.session.agent.onPayload = async (nextPayload, model) => {
    const previousResult = previousOnPayload
      ? await previousOnPayload(nextPayload, model)
      : undefined;
    payload = (previousResult === undefined
      ? nextPayload
      : previousResult) as Record<string, unknown>;
    throw new Error("request payload captured");
  };

  await handle.session.prompt("capture the request").catch(() => {});
  if (!payload) {
    throw new Error("Expected Pi to construct a provider request");
  }
  return { payload };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Pi 0.86 folds the `systemPrompt` shorthand into the leading system message. */
function leadingSystemText(context: { messages: readonly unknown[] }): string {
  const system = context.messages.find(
    (message): message is { role: "system"; content: string | { text?: string }[]; sections?: Record<string, string | null> } =>
      (message as { role?: string }).role === "system",
  );
  if (!system) return "";
  const content = typeof system.content === "string"
    ? system.content
    : system.content.map((part) => part.text ?? "").join("");
  return [content, ...Object.values(system.sections ?? {})].filter(Boolean).join("\n");
}

describe("createAgentSession", () => {
  const cleanups: Array<() => void> = [];
  const handles: RecipeSessionHandle[] = [];

  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      await handle.dispose().catch(() => {});
    }
    for (const cleanup of cleanups.splice(0)) cleanup();
    instrumentSession.mockClear();
    detachTelemetry.mockClear();
  });

  function fixture(options?: Parameters<typeof writeFixtureRecipe>[0]) {
    const created = writeFixtureRecipe(options);
    cleanups.push(created.cleanup);
    return created;
  }

  async function open(
    options: Omit<Partial<Parameters<typeof createAgentSession>[0]>, "recipe"> & {
      recipeDir: string;
      cwd: string;
    }
  ): Promise<RecipeSessionHandle> {
    const { recipeDir, ...sessionOptions } = options;
    const handle = await createAgentSession({
      recipe: resolveRecipe({ recipeDir }),
      credentials: await credentialStore(),
      env: cleanEnv(),
      ...sessionOptions,
    });
    handles.push(handle);
    return handle;
  }

  it("creates a live session from a recipe directory", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const handle = await open({ recipeDir, cwd: workspaceDir });

    expect(handle.agent.name).toBe("agent");
    expect(handle.session.model?.id).toBe("claude-sonnet-4-5");
    expect(handle.session.systemPrompt).toContain("conformance fixture");
    expect(handle.session.systemPrompt).toContain("Conformance agent");
  });

  it("settles only after the required-channel-reply continuation, with a bounded failure", async () => {
    const { recipeDir, workspaceDir } = fixture({ tools: ["channels"] });
    const handle = await open({ recipeDir, cwd: workspaceDir, extensionFactories: [
      (pi) => registerChannelTools(pi, {
        provider: "test",
        capabilities: { react: false, edit: false, retract: false, read: false,
          attach: false, fetchFile: false, documents: false, resolveAuthors: false, permalinks: false },
        reply: async () => ({ ref: "message-1" }),
      }, { target: { provider: "test", conversation: "C1" }, requireReply: true }),
    ] });
    scriptReply(handle, "Private answer without a tool call");
    const scripted = handle.session.agent.streamFunction;
    handle.session.agent.streamFunction = (model, context, options) => {
      const users = context.messages.filter((message) => message.role === "user");
      expect(JSON.stringify(users[0])).toContain("hello");
      expect(JSON.stringify(users[0])).not.toContain("<channel_context>");
      expect(leadingSystemText(context)).toContain('<channel_context>\n{"provider":"test","channel_id":"C1","conversation_scope":"conversation"}\n</channel_context>');
      for (const reminder of users.filter((message) => JSON.stringify(message).includes("No successful final channel reply"))) {
        expect(JSON.stringify(reminder)).toContain("<channel_context>");
        expect(JSON.stringify(reminder)).toContain("C1");
      }
      return scripted(model, context, options);
    };
    const events: string[] = [];
    const unsubscribe = handle.session.subscribe((event) => {
      if (event.type === "agent_end" || event.type === "agent_settled") events.push(event.type);
    });
    try {
      await handle.session.prompt("hello");
      expect(events).toEqual(["agent_end", "agent_end", "agent_settled"]);
      expect(handle.session.messages.filter((message) => message.role === "custom" && message.customType === "channel-delivery-failed")).toHaveLength(1);
      // A new inbound prompt gets its own single corrective attempt.
      await handle.session.prompt("another question");
      expect(events).toEqual(["agent_end", "agent_end", "agent_settled", "agent_end", "agent_end", "agent_settled"]);
    } finally { unsubscribe(); }
  });

  it("delivers through the real channels tool during the corrective continuation", async () => {
    const { recipeDir, workspaceDir } = fixture({ tools: ["channels"] });
    const reply = vi.fn(async () => ({ ref: "message-1" }));
    const handle = await open({ recipeDir, cwd: workspaceDir, extensionFactories: [
      (pi) => registerChannelTools(pi, {
        provider: "test",
        capabilities: { react: false, edit: false, retract: false, read: false,
          attach: false, fetchFile: false, documents: false, resolveAuthors: false, permalinks: false },
        reply,
      }, { target: { provider: "test", conversation: "C1" }, requireReply: true }),
    ] });
    let calls = 0;
    handle.session.agent.streamFunction = () => {
      const stream = new MockAssistantStream();
      const message = assistantMessage("Private answer");
      if (++calls === 2) {
        message.content = [{ type: "toolCall", id: "reply-1", name: "channels", arguments: { command: "reply", text: "Delivered answer", final: true } }];
        message.stopReason = "toolUse";
      }
      queueMicrotask(() => {
        stream.push({ type: "start", partial: assistantMessage("") });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      });
      return stream;
    };
    await handle.session.prompt("hello");
    expect(calls).toBe(3);
    expect(reply, JSON.stringify(handle.session.messages.filter((message) => message.role === "toolResult"))).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ target: { provider: "test", conversation: "C1" } }), { text: "Delivered answer" });
    expect(handle.session.messages.some((message) => message.role === "custom" && message.customType === "channel-delivery-failed")).toBe(false);
  });

  it("loads memory before the host transforms the resolved prompt", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const memoriesDir = join(workspaceDir, "memories");
    mkdirSync(memoriesDir);
    writeFileSync(
      join(memoriesDir, "MEMORY.md"),
      "- [Testing preferences](testing.md)"
    );
    let transformed = "";

    const handle = await open({
      recipeDir,
      cwd: workspaceDir,
      memory: {
        indexPath: "memories/MEMORY.md",
      },
      transformSystemPrompt: (resolved) => {
        transformed = resolved;
        return `${resolved}\n\nHost context.`;
      },
    });

    expect(transformed).toContain("<memories>");
    expect(transformed).toContain("Testing preferences");
    expect(handle.session.systemPrompt).toContain("Host context.");
  });

  it("keeps the session cwd authoritative for memory paths", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const otherWorkspace = join(workspaceDir, "other");
    mkdirSync(otherWorkspace);
    writeFileSync(join(workspaceDir, "MEMORY.md"), "session memory");
    writeFileSync(join(otherWorkspace, "MEMORY.md"), "other memory");
    const memory: LoadMemoryIndexOptions = {
      cwd: otherWorkspace,
      indexPath: "MEMORY.md",
    };

    const handle = await open({ recipeDir, cwd: workspaceDir, memory });

    expect(handle.session.systemPrompt).toContain("session memory");
    expect(handle.session.systemPrompt).not.toContain("other memory");
  });

  it("allows the host to replace or disable loaded memory", async () => {
    const { recipeDir, workspaceDir } = fixture();
    writeFileSync(join(workspaceDir, "MEMORY.md"), "original memory");

    const handle = await open({
      recipeDir,
      cwd: workspaceDir,
      memory: { indexPath: "MEMORY.md" },
      memoryOverride: (current) => ({
        ...current,
        memory: current.memory
          ? { ...current.memory, content: "replacement memory" }
          : null,
      }),
    });

    expect(handle.session.systemPrompt).toContain("replacement memory");
    expect(handle.session.systemPrompt).not.toContain("original memory");
  });

  it("starts connector sessions with the default Slack loadout", async () => {
    const { recipeDir, workspaceDir } = fixture({
      dependencies: { [SLACK_RECIPE_CHANNEL_PACKAGE]: "0.1.0" },
      tools: ["channels"],
      manifestPi: {
        channels: [{ provider: "slack" }],
      },
    });
    installSlackRecipeConnector(recipeDir);
    const handle = await open({ recipeDir, cwd: workspaceDir });

    expect(handle.session.getActiveToolNames()).toEqual(
      expect.arrayContaining([
        "channels",
      ])
    );
    expect(handle.session.getActiveToolNames()).not.toContain("tool_search");
  });

  it("rejects connector tools unsupported by the provider", async () => {
    const { recipeDir, workspaceDir } = fixture({
      dependencies: { [SLACK_RECIPE_CHANNEL_PACKAGE]: "0.1.0" },
      tools: ["channels", "channel_delete_workspace"],
      manifestPi: {
        channels: [{ provider: "slack" }],
      },
    });
    installSlackRecipeConnector(recipeDir);

    await expect(open({ recipeDir, cwd: workspaceDir })).rejects.toThrow(
      /declares unavailable tool\(s\): channel_delete_workspace/
    );
  });

  it("applies authored session policy to the session-local Pi agent", async () => {
    const { recipeDir, workspaceDir } = fixture();
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "ai:",
        "  model: anthropic/claude-sonnet-4-5",
        "session:",
        "  steering_mode: all",
        "  follow_up_mode: all",
        "  tool_execution: sequential",
        "  retry:",
        "    enabled: true",
        "    max_retries: 4",
        "    base_delay_ms: 250",
        "    provider:",
        "      timeout_ms: 30000",
        "      max_retries: 1",
        "      max_retry_delay_ms: 5000",
        "  compaction:",
        "    enabled: true",
        "    reserve_tokens: 12000",
        "    keep_recent_tokens: 6000",
        "  images:",
        "    auto_resize: false",
        "    block_images: true",
      ].join("\n")
    );

    const handle = await open({ recipeDir, cwd: workspaceDir });

    expect(handle.session.agent.steeringMode).toBe("all");
    expect(handle.session.agent.followUpMode).toBe("all");
    expect(handle.session.agent.toolExecution).toBe("sequential");
    expect(handle.session.settingsManager.getRetrySettings()).toEqual({
      enabled: true,
      maxRetries: 4,
      baseDelayMs: 250,
      maxAgentDelayMs: 60000,
    });
    expect(handle.session.settingsManager.getProviderRetrySettings()).toEqual({
      timeoutMs: 30000,
      maxRetries: 1,
      maxRetryDelayMs: 5000,
    });
    expect(handle.session.settingsManager.getCompactionSettings()).toEqual({
      enabled: true,
      reserveTokens: 12000,
      keepRecentTokens: 6000,
    });
    expect(handle.session.settingsManager.getImageAutoResize()).toBe(false);
    expect(handle.session.settingsManager.getBlockImages()).toBe(true);
  });

  it("forwards transparent AI options and provider routing to root and subagent requests", async () => {
    // Exercise OpenRouter's OpenAI-compatible serializer. Pi 0.85 routes
    // Anthropic models through the native Anthropic API instead.
    const { recipeDir, workspaceDir } = fixture();
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "ai:",
        "  model: openrouter/openai/gpt-4.1",
        "  options:",
        "    max_tokens: 321",
        "    sampling_params:",
        "      future_option: enabled",
        "  providers:",
        "    openrouter:",
        "      routing:",
        "        order: [anthropic, google-vertex, amazon-bedrock]",
        "        only: [anthropic, google-vertex, amazon-bedrock]",
        "        ignore: [azure]",
        "        allow_fallbacks: true",
        "        require_parameters: false",
        "        data_collection: deny",
        "        zdr: true",
        "        enforce_distillable_text: false",
        "        quantizations: [fp16]",
        "        sort:",
        "          by: price",
        "        max_price:",
        '          prompt: "10"',
        '          completion: "20"',
        "        preferred_min_throughput:",
        "          p50: 1",
        "          p99: 4",
        "        preferred_max_latency:",
        "          p50: 5",
        "          p99: 8",
        "        future_router_policy:",
        "          mode: strict",
        "tools: []",
        "subagents: [explorer]",
      ].join("\n")
    );
    writeFileSync(
      join(recipeDir, "agents", "explorer.yaml"),
      [
        "name: explorer",
        "from: agent",
        "tools: []",
      ].join("\n")
    );
    const recipe = resolveRecipe({ recipeDir });
    const credentials = await openRouterCredentialStore();
    const root = await createAgentSession({
      recipe,
      cwd: workspaceDir,
      credentials,
      env: cleanEnv(),
      runController: null,
    });
    handles.push(root);
    const child = await createAgentSessionInternal({
      recipe,
      agentName: "explorer",
      cwd: workspaceDir,
      credentials,
      env: cleanEnv(),
      runController: null,
      sessionRole: "subagent",
    });
    handles.push(child);

    for (const handle of [root, child]) {
      const captured = await captureSerializedPayload(handle);
      expect(captured.payload).toMatchObject({
        model: "openai/gpt-4.1",
        max_completion_tokens: 321,
        future_option: "enabled",
        provider: {
          order: ["anthropic", "google-vertex", "amazon-bedrock"],
          only: ["anthropic", "google-vertex", "amazon-bedrock"],
          ignore: ["azure"],
          allow_fallbacks: true,
          require_parameters: false,
          data_collection: "deny",
          zdr: true,
          enforce_distillable_text: false,
          quantizations: ["fp16"],
          sort: { by: "price" },
          max_price: { prompt: "10", completion: "20" },
          preferred_min_throughput: { p50: 1, p99: 4 },
          preferred_max_latency: { p50: 5, p99: 8 },
          future_router_policy: { mode: "strict" },
        },
      });
    }
  });

  it("forwards Vercel AI Gateway routing to root and subagent request payloads", async () => {
    const { recipeDir, workspaceDir } = fixture();
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "ai:",
        "  model: vercel-ai-gateway/anthropic/claude-sonnet-5",
        "  providers:",
        "    vercel_ai_gateway:",
        "      routing:",
        "        order: [anthropic, bedrock]",
        "        only: [anthropic, bedrock]",
        "        sort: cost",
        "        caching: auto",
        "        future_gateway_policy:",
        "          mode: strict",
        "tools: []",
        "subagents: [explorer]",
      ].join("\n")
    );
    writeFileSync(
      join(recipeDir, "agents", "explorer.yaml"),
      ["name: explorer", "from: agent", "tools: []"].join("\n")
    );
    const recipe = resolveRecipe({ recipeDir });
    const credentials = await vercelAiGatewayCredentialStore();
    const root = await createAgentSession({
      recipe,
      cwd: workspaceDir,
      credentials,
      env: cleanEnv(),
      runController: null,
    });
    handles.push(root);
    const child = await createAgentSessionInternal({
      recipe,
      agentName: "explorer",
      cwd: workspaceDir,
      credentials,
      env: cleanEnv(),
      runController: null,
      sessionRole: "subagent",
    });
    handles.push(child);

    for (const handle of [root, child]) {
      const captured = await captureSerializedPayload(handle);
      expect(captured.payload).toMatchObject({
        providerOptions: {
          gateway: {
            order: ["anthropic", "bedrock"],
            only: ["anthropic", "bedrock"],
            sort: "cost",
            caching: "auto",
            future_gateway_policy: { mode: "strict" },
          },
        },
      });
    }
  });

  it.each([
    {
      provider: "openai",
      model: "gpt-4.1",
      maxTokensPath: ["max_output_tokens"],
    },
    {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      maxTokensPath: ["max_tokens"],
    },
    {
      provider: "google",
      model: "gemini-2.5-flash",
      maxTokensPath: ["config", "maxOutputTokens"],
    },
    {
      provider: "google-vertex",
      model: "gemini-2.5-flash",
      maxTokensPath: ["config", "maxOutputTokens"],
    },
    {
      provider: "amazon-bedrock",
      model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
      maxTokensPath: ["inferenceConfig", "maxTokens"],
    },
    {
      provider: "azure-openai-responses",
      model: "gpt-4.1",
      maxTokensPath: ["max_output_tokens"],
    },
    {
      provider: "mistral",
      model: "mistral-large-latest",
      maxTokensPath: ["maxTokens"],
    },
  ])(
    "serializes portable AI options through the $provider adapter",
    async ({ provider, model, maxTokensPath }) => {
      const { recipeDir, workspaceDir } = fixture();
      writeFileSync(
        join(recipeDir, "agents", "agent.yaml"),
        [
          "name: agent",
          "ai:",
          `  model: ${provider}/${model}`,
          "  thinking_level: off",
          "  options:",
          "    max_tokens: 321",
          "tools: []",
        ].join("\n")
      );
      const handle = await createAgentSession({
        recipe: resolveRecipe({ recipeDir }),
        cwd: workspaceDir,
        credentials: await providerCredentialStore(provider),
        env: cleanEnv(),
        runController: null,
      });
      handles.push(handle);

      const captured = await captureSerializedPayload(handle);
      expect(nestedValue(captured.payload, maxTokensPath)).toBe(321);
    }
  );

  it("serializes supported portable AI options through the OpenAI Codex adapter", async () => {
    const { recipeDir, workspaceDir } = fixture();
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "ai:",
        "  model: openai-codex/gpt-5.5",
        "  thinking_level: off",
        "  options:",
        "    temperature: 0.4",
        "tools: []",
      ].join("\n")
    );
    const handle = await createAgentSession({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      credentials: await providerCredentialStore("openai-codex"),
      env: cleanEnv(),
      runController: null,
    });
    handles.push(handle);

    const captured = await captureSerializedPayload(handle);
    expect(captured.payload.temperature).toBe(0.4);
    expect(captured.payload).not.toHaveProperty("max_output_tokens");
  });

  it("fails closed when a package extension cannot load", async () => {
    const { recipeDir, workspaceDir } = fixture({
      manifestPi: { extensions: ["extensions/fail.ts"] },
    });
    mkdirSync(join(recipeDir, "extensions"), { recursive: true });
    writeFileSync(
      join(recipeDir, "extensions", "fail.ts"),
      "export default () => { throw new Error('extension exploded'); };\n"
    );

    await expect(
      open({ recipeDir, cwd: workspaceDir })
    ).rejects.toThrow("extension exploded");
  });

  it("fails closed when an agent declares an unavailable tool", async () => {
    const { recipeDir, workspaceDir } = fixture({
      tools: ["missing_tool"],
    });

    await expect(
      open({ recipeDir, cwd: workspaceDir })
    ).rejects.toThrow(
      'Recipe agent "agent" declares unavailable tool(s): missing_tool'
    );
  });

  it("prevents package extensions from activating undeclared tools", async () => {
    const { recipeDir, workspaceDir } = fixture({
      manifestPi: { extensions: ["extensions/policy.ts"] },
      tools: ["read"],
    });
    mkdirSync(join(recipeDir, "extensions"), { recursive: true });
    writeFileSync(
      join(recipeDir, "extensions", "policy.ts"),
      [
        "export default (pi) => {",
        '  pi.setActiveTools(["bash"]);',
        "};",
      ].join("\n")
    );

    await expect(
      open({ recipeDir, cwd: workspaceDir })
    ).rejects.toThrow(
      "Recipe extension attempted to activate undeclared tool(s): bash"
    );
  });

  it("preserves an extension-owned tool_search when generated search is not needed", async () => {
    const { recipeDir, workspaceDir } = fixture({
      manifestPi: { extensions: ["extensions/tool-search.ts"] },
      tools: ["tool_search"],
    });
    mkdirSync(join(recipeDir, "extensions"), { recursive: true });
    writeFileSync(
      join(recipeDir, "extensions", "tool-search.ts"),
      [
        "export default (pi) => {",
        "  pi.registerTool({",
        "    name: 'tool_search',",
        "    label: 'Recipe tool search',",
        "    description: 'Search this Recipe.',",
        "    parameters: { type: 'object', properties: {} },",
        "    async execute() { return { content: [], details: {} }; }",
        "  });",
        "};",
      ].join("\n")
    );

    const handle = await open({ recipeDir, cwd: workspaceDir });

    expect(handle.session.getActiveToolNames()).toContain("tool_search");
  });

  it("does not auto-load ambient Recipe-directory extensions", async () => {
    const { recipeDir, workspaceDir } = fixture({
      tools: ["ambient_tool"],
    });
    mkdirSync(join(recipeDir, ".pi", "extensions"), { recursive: true });
    writeFileSync(
      join(recipeDir, ".pi", "extensions", "ambient.ts"),
      [
        "export default (pi) => {",
        "  pi.registerTool({",
        "    name: 'ambient_tool',",
        "    description: 'Must not load',",
        "    parameters: { type: 'object', properties: {} },",
        "    async execute() { return { content: [], details: {} }; }",
        "  });",
        "};",
      ].join("\n")
    );

    await expect(
      open({ recipeDir, cwd: workspaceDir })
    ).rejects.toThrow("declares unavailable tool(s): ambient_tool");
  });

  it("creates the exact Recipe definition already inspected by the host", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const recipe = resolveRecipe({ recipeDir });
    const agent = recipe.selectAgent();
    const handle = await createAgentSession({
      recipe,
      cwd: workspaceDir,
      credentials: await credentialStore(),
      env: cleanEnv(),
    });
    handles.push(handle);

    expect(handle.agent).toBe(agent);
    expect(handle.agent.name).toBe("agent");
  });

  it("accepts host model wiring and reports construction diagnostics", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const base = getModel("anthropic", "claude-sonnet-4-5");
    expect(base).toBeDefined();
    const modelOverride = {
      ...base!,
      baseUrl: "https://managed-gateway.example/v1",
    };
    const onDiagnostics = vi.fn();

    const handle = await open({
      recipeDir,
      cwd: workspaceDir,
      modelOverride,
      onDiagnostics,
    });

    expect(handle.session.model?.baseUrl).toBe(
      "https://managed-gateway.example/v1"
    );
    expect(onDiagnostics).toHaveBeenCalledOnce();
  });

  it("accepts gateway-authenticated model wiring without provider credentials", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const base = getModel("anthropic", "claude-sonnet-4-5");
    expect(base).toBeDefined();

    const handle = await createAgentSession({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      modelOverride: {
        ...base!,
        baseUrl: "https://managed-gateway.example/v1",
        headers: { authorization: "Bearer gateway-token" },
      },
    });
    handles.push(handle);

    expect(handle.session.model?.baseUrl).toBe(
      "https://managed-gateway.example/v1"
    );
  });

  it("rejects a host transport for a different Recipe model", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const modelOverride = {
      ...getModel("openai", "gpt-5.5")!,
      baseUrl: "https://managed-gateway.example/v1",
    };

    await expect(
      open({ recipeDir, cwd: workspaceDir, modelOverride })
    ).rejects.toBeInstanceOf(RecipeModelTransportError);
  });

  it("normalizes Gemini tool schemas for every host", async () => {
    const { recipeDir, workspaceDir } = fixture();
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "model:",
        "  name: anthropic/gemini-2.5-flash",
        "tools: [read]",
        "",
      ].join("\n")
    );
    const base = getModel("anthropic", "claude-sonnet-4-5");
    expect(base).toBeDefined();
    const parameters = Type.Object({
      nested: Type.Object({}, { additionalProperties: false }),
      additionalProperties: Type.String(),
      literal: Type.Optional(
        Type.Unknown({
          default: { additionalProperties: "kept" },
        })
      ),
    });
    const symbolMetadata = Symbol("schema-metadata");
    Object.defineProperty(parameters, symbolMetadata, {
      value: "preserved",
      enumerable: false,
    });
    const handle = await open({
      recipeDir,
      cwd: workspaceDir,
      modelOverride: {
        ...base!,
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
      },
      customTools: [
        {
          name: "read",
          description: "Structured tool",
          parameters,
          execute: async () => ({ content: [], details: {} }),
        } as never,
      ],
    });

    const tool = handle.session.agent.state.tools.find(
      (candidate) => candidate.name === "read"
    );
    expect(tool?.parameters).toEqual({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: {},
        },
        additionalProperties: { type: "string" },
        literal: {
          default: { additionalProperties: "kept" },
        },
      },
      required: ["nested", "additionalProperties"],
    });
    expect(Object.getPrototypeOf(tool?.parameters)).toBe(
      Object.getPrototypeOf(parameters)
    );
    expect(
      (tool?.parameters as Record<PropertyKey, unknown>)[symbolMetadata]
    ).toBe("preserved");
    expect(
      Object.getOwnPropertyDescriptor(tool?.parameters, symbolMetadata)
        ?.enumerable
    ).toBe(false);
  });

  it("resolves credentials from provider env keys when no store is given", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const handle = await createAgentSession({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: { ...cleanEnv(), ANTHROPIC_API_KEY: "env-key" },
    });
    handles.push(handle);
    expect(handle.session.model?.provider).toBe("anthropic");
  });

  it("fails closed when the provider has no credential", async () => {
    const { recipeDir, workspaceDir } = fixture();
    await expect(
      createAgentSession({
        recipe: resolveRecipe({ recipeDir }),
        cwd: workspaceDir,
        env: cleanEnv(),
      })
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RecipeCredentialError);
      expect((err as Error).message).toContain("ANTHROPIC_API_KEY");
      return true;
    });
  });

  it("fails closed on an unknown model spec", async () => {
    const { recipeDir, workspaceDir } = fixture();
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "model:",
        "  name: anthropic/not-a-model",
        "tools: [read]",
        "",
      ].join("\n")
    );
    await expect(
      open({ recipeDir, cwd: workspaceDir })
    ).rejects.toBeInstanceOf(RecipeModelError);
  });

  it("fails closed on an unbound required MCP server, naming it", async () => {
    const { recipeDir, workspaceDir } = fixture({
      manifestPi: {
        mcp: {
          servers: [{ id: "linear", required: true, tools: { include: ["*"] } }],
        },
      },
      agentExtras: [
        "mcp:",
        "  mode: cli",
        "  servers:",
        "    linear:",
        '      include: ["*"]',
      ],
    });
    await expect(
      open({ recipeDir, cwd: workspaceDir })
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(McpBindingError);
      expect((err as McpBindingError).servers).toEqual(["linear"]);
      expect((err as Error).message).toContain("LINEAR_MCP_URL");
      return true;
    });
  });

  it("materializes inline MCP bindings", async () => {
    const { recipeDir, workspaceDir } = fixture({
      manifestPi: {
        mcp: {
          servers: [{ id: "linear", required: true, tools: { include: ["*"] } }],
        },
      },
      agentExtras: [
        "mcp:",
        "  mode: cli",
        "  servers:",
        "    linear:",
        '      include: ["*"]',
      ],
    });
    const env = cleanEnv();
    const handle = await open({
      recipeDir,
      cwd: workspaceDir,
      env,
      mcpBindings: {
        servers: [
          {
            id: "linear",
            transport: "streamable_http",
            url: "http://127.0.0.1:9/mcp",
          },
        ],
      },
    });
    expect(env.PI_RECIPES_MCP_SESSION).toBeDefined();
    await handle.dispose();
  });

  it("does not clobber host MCP state when a Recipe selects no MCP servers", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const env = {
      ...cleanEnv(),
      PI_RECIPES_MCP_SESSION: "/host/session.json",
      MCPORTER_CONFIG: "/host/mcporter.json",
    };
    const handle = await open({ recipeDir, cwd: workspaceDir, env });

    expect(env.PI_RECIPES_MCP_SESSION).toBe("/host/session.json");
    expect(env.MCPORTER_CONFIG).toBe("/host/mcporter.json");
    await handle.dispose();
    expect(env.PI_RECIPES_MCP_SESSION).toBe("/host/session.json");
    expect(env.MCPORTER_CONFIG).toBe("/host/mcporter.json");
  });

  it("leases and restores a host environment for materialized MCP", async () => {
    const { recipeDir, workspaceDir } = fixture({
      manifestPi: {
        mcp: {
          servers: [
            { id: "linear", required: true, tools: { include: ["*"] } },
          ],
        },
      },
      agentExtras: [
        "mcp:",
        "  mode: cli",
        "  servers:",
        "    linear:",
        '      include: ["*"]',
      ],
    });
    const hostSession = join(workspaceDir, "host-session.json");
    const hostMcporter = join(workspaceDir, "host-mcporter.json");
    const env = {
      ...cleanEnv(),
      PI_RECIPES_MCP_SESSION: hostSession,
      MCPORTER_CONFIG: hostMcporter,
    };
    const options = {
      recipeDir,
      cwd: workspaceDir,
      env,
      mcpBindings: {
        servers: [
          {
            id: "linear",
            transport: "streamable_http",
            url: "http://127.0.0.1:9/mcp",
          },
        ],
      },
    };
    const first = await open(options);

    await expect(open(options)).rejects.toBeInstanceOf(
      RecipeMcpEnvironmentInUseError
    );
    expect(env.PI_RECIPES_MCP_SESSION).not.toBe(hostSession);

    await first.dispose();
    expect(env.PI_RECIPES_MCP_SESSION).toBe(hostSession);
    expect(env.MCPORTER_CONFIG).toBe(hostMcporter);
  });

  it("rolls back materialized MCP when session construction fails", async () => {
    const { recipeDir, workspaceDir } = fixture({
      manifestPi: {
        mcp: {
          servers: [
            { id: "linear", required: true, tools: { include: ["*"] } },
          ],
        },
      },
      agentExtras: [
        "mcp:",
        "  mode: cli",
        "  servers:",
        "    linear:",
        '      include: ["*"]',
      ],
    });
    const hostSession = join(workspaceDir, "host-session.json");
    const hostMcporter = join(workspaceDir, "host-mcporter.json");
    const env = {
      ...cleanEnv(),
      PI_RECIPES_MCP_SESSION: hostSession,
      MCPORTER_CONFIG: hostMcporter,
    };
    const baseOptions = {
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env,
      credentials: await credentialStore(),
      mcpBindings: {
        servers: [
          {
            id: "linear",
            transport: "streamable_http",
            url: "http://127.0.0.1:9/mcp",
          },
        ],
      },
    };

    await expect(
      createAgentSession({
        ...baseOptions,
        transformSystemPrompt: () => {
          throw new Error("prompt construction failed");
        },
      })
    ).rejects.toThrow("prompt construction failed");
    expect(env.PI_RECIPES_MCP_SESSION).toBe(hostSession);
    expect(env.MCPORTER_CONFIG).toBe(hostMcporter);

    const recovered = await createAgentSession(baseOptions);
    handles.push(recovered);
    await recovered.dispose();
  });

  it("prompts through a scripted model and surfaces the reply", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const handle = await open({ recipeDir, cwd: workspaceDir });
    scriptReply(handle, "scripted hello");

    await handle.session.prompt("hi");
    const last = handle.session.messages.at(-1) as { content?: unknown };
    expect(JSON.stringify(last?.content)).toContain("scripted hello");
  });

  it("taps session events through onEvent and detaches on dispose", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const events: string[] = [];
    const handle = await open({
      recipeDir,
      cwd: workspaceDir,
      onEvent: (event) => events.push(event.type),
    });
    scriptReply(handle, "ok");
    await handle.session.prompt("hi");
    expect(events).toContain("agent_start");
    expect(events).toContain("agent_end");
  });

  it("closes completed child sessions when the parent disposes", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const child = {
      agent_run_id: "child-1",
      invocation_name: "helper",
      agent_name: "helper",
      label: "helper",
      prompt: "help",
      status: "completed" as const,
      started_at: 1,
      last_activity_at: 2,
    };
    const close = vi.fn(async (_id: string) => ({
      ...child,
      status: "closed" as const,
    }));
    const runController = {
      list: () => [child],
      get: () => null,
      start: vi.fn(),
      wait: vi.fn(),
      message: vi.fn(),
      interrupt: vi.fn(),
      close,
      shutdown: vi.fn(async () => {
        await close("child-1");
      }),
    };
    const handle = await open({
      recipeDir,
      cwd: workspaceDir,
      runController,
    });

    await handle.dispose();
    expect(runController.shutdown).toHaveBeenCalledOnce();
  });

  it("attaches a host-owned OTel tracer and detaches it on dispose", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const tracer = {} as never;
    const handle = await open({
      recipeDir,
      cwd: workspaceDir,
      otel: {
        tracer,
        runSpans: false,
        meta: { conversationId: "conversation-1" },
      },
    });

    expect(instrumentSession).toHaveBeenCalledOnce();
    expect(instrumentSession).toHaveBeenCalledWith(
      handle.session,
      expect.objectContaining({
        tracer,
        runSpans: false,
        meta: {
          conversationId: "conversation-1",
          agentId: "conformance-fixture/agent",
          agentName: "agent",
        },
      })
    );

    await handle.dispose();
    expect(detachTelemetry).toHaveBeenCalledOnce();
  });
});

describe("in-process run controller", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function fixture() {
    const created = writeFixtureRecipe({ subagents: ["helper"] });
    cleanups.push(created.cleanup);
    return created;
  }

  it("settles a vanished-profile start as failed without wedging", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
    });
    const run = await controller.start({ name: "ghost", prompt: "hello" });
    const settled = await controller.wait(run.agent_run_id);
    expect(settled.status).toBe("failed");
    expect(settled.error).toBeTruthy();
  });

  it("runs a child through an injected session factory", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const parentEnv = cleanEnv();
    const memory = {
      indexPath: "memories/MEMORY.md",
    };
    const memoryOverride = vi.fn((current) => current);
    let scripted: RecipeSessionHandle | null = null;
    let childOptions:
      | Parameters<typeof createAgentSessionInternal>[0]
      | undefined;
    const tracer = {} as never;
    const onAgentRunEvent = vi.fn(() => {
      throw new Error("observer failed");
    });
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: parentEnv,
      memory,
      memoryOverride,
      otel: {
        tracer,
        meta: {
          conversationId: "conversation-tree",
          agentId: "root-id",
          agentName: "root",
        },
      },
      onAgentRunEvent,
      sessionFactory: async (options) => {
        childOptions = options;
        const handle = await createAgentSessionInternal({
          ...options,
          credentials: await credentialStore(),
        });
        scripted = handle;
        scriptReply(handle, "child says hi");
        return handle;
      },
    });
    const run = await controller.start({ name: "helper", prompt: "go" });
    const settled = await controller.wait(run.agent_run_id);
    expect(settled.status).toBe("completed");
    expect(settled.output).toContain("child says hi");
    expect(childOptions?.otel).toMatchObject({
      tracer,
      meta: { conversationId: "conversation-tree" },
    });
    expect(childOptions?.otel?.meta?.agentId).toBeUndefined();
    expect(childOptions?.otel?.meta?.agentName).toBeUndefined();
    expect(childOptions?.runController).toBeNull();
    expect(childOptions?.sessionRole).toBe("subagent");
    expect(childOptions?.memory).toBe(memory);
    expect(childOptions?.memoryOverride).toBe(memoryOverride);
    expect(onAgentRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent_run_event",
        agent_run_id: run.agent_run_id,
        parent_agent_run_id: "root",
        agent_name: "helper",
        depth: 1,
      })
    );
    expect(childOptions?.env).not.toBe(parentEnv);
    expect(childOptions?.env).toEqual(parentEnv);
    await controller.close(run.agent_run_id);
    expect(scripted).not.toBeNull();
  });

  it("marks a child provider error as failed with the provider message", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      sessionFactory: async () =>
        ({
          session: {
            messages: [
              {
                ...assistantMessage("", "error"),
                errorMessage: "413 Payload Too Large",
              },
            ],
            prompt: vi.fn(async () => {}),
            abort: vi.fn(async () => {}),
          },
          dispose: vi.fn(async () => {}),
        }) as unknown as RecipeSessionHandle,
    });

    const run = await controller.start({ name: "helper", prompt: "go" });
    const settled = await controller.wait(run.agent_run_id);

    expect(settled.status).toBe("failed");
    expect(settled.error).toBe("413 Payload Too Large");
    await controller.close(run.agent_run_id);
  });

  it("bounds concurrency", async () => {
    const { recipeDir, workspaceDir } = fixture();
    let live = 0;
    let peak = 0;
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      concurrency: 1,
      sessionFactory: async (options) => {
        const handle = await createAgentSessionInternal({
          ...options,
          credentials: await credentialStore(),
        });
        handle.session.agent.streamFunction = () => {
          const stream = new MockAssistantStream();
          live += 1;
          peak = Math.max(peak, live);
          setTimeout(() => {
            live -= 1;
            stream.push({ type: "start", partial: assistantMessage("") });
            stream.push({ type: "done", reason: "stop", message: assistantMessage("done") });
          }, 50);
          return stream;
        };
        return handle;
      },
    });
    const first = await controller.start({ name: "helper", prompt: "a" });
    const second = await controller.start({ name: "helper", prompt: "b" });
    await controller.wait(first.agent_run_id);
    await controller.wait(second.agent_run_id);
    expect(peak).toBe(1);
    await controller.close(first.agent_run_id);
    await controller.close(second.agent_run_id);
  });

  it("serializes a message sent while the child session is starting", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const factoryGate = deferred();
    let factoryCalls = 0;
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      sessionFactory: async (options) => {
        factoryCalls += 1;
        await factoryGate.promise;
        const handle = await createAgentSessionInternal({
          ...options,
          credentials: await credentialStore(),
        });
        scriptReply(handle, "done");
        return handle;
      },
    });

    const run = await controller.start({ name: "helper", prompt: "first" });
    const followUp = controller.message(run.agent_run_id, "second");
    factoryGate.resolve();
    await followUp;
    await controller.wait(run.agent_run_id);

    expect(factoryCalls).toBe(1);
    await controller.close(run.agent_run_id);
  });

  it("does not prompt a child interrupted while its session is starting", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const factoryGate = deferred();
    const constructed = deferred();
    const prompt = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      sessionFactory: async () => {
        await factoryGate.promise;
        constructed.resolve();
        return {
          session: {
            prompt,
            messages: [],
          },
          dispose,
        } as unknown as RecipeSessionHandle;
      },
    });

    const run = await controller.start({ name: "helper", prompt: "first" });
    await controller.interrupt(run.agent_run_id);
    factoryGate.resolve();
    await constructed.promise;
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());

    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not finish shutdown until a constructing child has quiesced", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const factoryGate = deferred();
    const factoryEntered = deferred();
    const dispose = vi.fn(async () => {});
    const prompt = vi.fn(async () => {});
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      sessionFactory: async () => {
        factoryEntered.resolve();
        await factoryGate.promise;
        return {
          session: { prompt, messages: [] },
          dispose,
        } as unknown as RecipeSessionHandle;
      },
    });

    await controller.start({ name: "helper", prompt: "first" });
    await factoryEntered.promise;
    let shutdownFinished = false;
    const shutdown = controller.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);

    factoryGate.resolve();
    await shutdown;

    expect(prompt).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(controller.list()[0]?.status).toBe("closed");
  });

  it("rejects an already-aborted child wait immediately", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const factoryGate = deferred();
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      sessionFactory: async () => {
        await factoryGate.promise;
        throw new Error("not reached");
      },
    });
    const run = await controller.start({ name: "helper", prompt: "first" });
    const signal = new AbortController();
    signal.abort(new Error("stop waiting"));

    await expect(
      controller.wait(run.agent_run_id, signal.signal)
    ).rejects.toThrow("stop waiting");
    await controller.interrupt(run.agent_run_id);
    factoryGate.resolve();
  });

  it("clears terminal output and tool state before a follow-up", async () => {
    const { recipeDir, workspaceDir } = fixture();
    let onEvent:
      | ((event: {
          type: string;
          toolName?: string;
        }) => void)
      | undefined;
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      sessionFactory: async (options) => {
        onEvent = options.onEvent as typeof onEvent;
        return {
          session: {
            messages: [{ role: "assistant", content: "done" }],
            prompt: vi.fn(async () => {
              onEvent?.({ type: "tool_execution_start", toolName: "search" });
              onEvent?.({ type: "tool_execution_end", toolName: "search" });
            }),
            steer: vi.fn(async () => {}),
            abort: vi.fn(async () => {}),
          },
          dispose: vi.fn(async () => {}),
        } as unknown as RecipeSessionHandle;
      },
    });
    const run = await controller.start({ name: "helper", prompt: "first" });
    const completed = await controller.wait(run.agent_run_id);
    expect(completed.output).toBeTruthy();
    expect(completed.current_tool).toBeUndefined();

    const resumed = await controller.message(run.agent_run_id, "second");
    expect(resumed.status).toBe("running");
    expect(resumed.completed_at).toBeUndefined();
    expect(resumed.output).toBeUndefined();
    expect(resumed.error).toBeUndefined();
    await controller.wait(run.agent_run_id);
    await controller.close(run.agent_run_id);
  });
});

describe("nested delegation", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  /** agent -> [background, explorer]; background -> [explorer]. */
  function fixture(delegation: Record<string, string[]> = { background: ["explorer"] }) {
    const created = writeFixtureRecipe({
      subagents: [...new Set(["background", "explorer", ...Object.keys(delegation)])],
    });
    cleanups.push(created.cleanup);
    for (const [name, subagents] of Object.entries(delegation)) {
      writeFileSync(
        join(created.recipeDir, "agents", `${name}.yaml`),
        [
          `name: ${name}`,
          "model:",
          "  name: anthropic/claude-sonnet-4-5",
          "tools: [read]",
          `subagents: [${subagents.join(", ")}]`,
          "",
        ].join("\n")
      );
    }
    return created;
  }

  type Options = Parameters<typeof createAgentSessionInternal>[0];

  function messageText(message: unknown): string {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    return Array.isArray(content)
      ? content.map((part) => (part as { text?: string }).text ?? "").join("")
      : "";
  }

  /**
   * A real background session: it starts two explorers, ends its turn
   * without waiting, then answers from the completion notice.
   */
  function scriptBackground(handle: RecipeSessionHandle, turns: string[]) {
    handle.session.agent.streamFunction = (_model, context) => {
      const stream = new MockAssistantStream();
      const last = context.messages.at(-1)!;
      let message: AssistantMessage;
      if (last.role === "user" && !messageText(last).includes("<agent_run_completions>")) {
        turns.push("fan-out");
        message = assistantMessage("");
        message.content = [
          { type: "toolCall", id: "start-a", name: "agent", arguments: { name: "explorer", prompt: "find A", label: "a" } },
          { type: "toolCall", id: "start-b", name: "agent", arguments: { name: "explorer", prompt: "find B", label: "b" } },
        ];
        message.stopReason = "toolUse";
      } else if (last.role === "toolResult") {
        turns.push("yield");
        message = assistantMessage("Started two explorers.");
      } else {
        turns.push("notice");
        const notice = messageText(last);
        const found = ["found A", "found B"].filter((text) => notice.includes(text));
        message = assistantMessage(`Final: ${found.join(" + ")}`);
      }
      queueMicrotask(() => {
        stream.push({ type: "start", partial: assistantMessage("") });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      });
      return stream;
    };
  }

  /** A fake explorer whose reply waits for its gate (or its abort). */
  function fakeExplorer(options: Options, gates: Map<string, ReturnType<typeof deferred<void>>>) {
    const messages: unknown[] = [];
    let release: (() => void) | undefined;
    const handle = {
      session: {
        messages,
        prompt: vi.fn(async (prompt: string) => {
          options.onEvent?.({ type: "agent_start" } as never);
          const gate = deferred();
          gates.set(prompt, gate);
          release = gate.resolve;
          await gate.promise;
          messages.push(assistantMessage(prompt.replace("find", "found")));
        }),
        abort: vi.fn(async () => release?.()),
      },
      agentRuns: undefined,
      dispose: vi.fn(async () => {}),
    };
    return handle as unknown as RecipeSessionHandle & {
      session: { abort: ReturnType<typeof vi.fn> };
      dispose: ReturnType<typeof vi.fn>;
    };
  }

  function tree(
    recipeDir: string,
    workspaceDir: string,
    extra: Partial<Parameters<typeof createInProcessRunController>[0]> = {},
    background: typeof scriptBackground = scriptBackground
  ) {
    const options = new Map<string, Options>();
    const handles = new Map<string, RecipeSessionHandle>();
    const explorers: Array<ReturnType<typeof fakeExplorer>> = [];
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const turns: string[] = [];
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      ...extra,
      sessionFactory: async (opts) => {
        options.set(opts.agentName!, opts);
        if (opts.agentName === "explorer") {
          const handle = fakeExplorer(opts, gates);
          explorers.push(handle);
          return handle;
        }
        const handle = await createAgentSessionInternal({
          ...opts,
          credentials: await credentialStore(),
        });
        handles.set(opts.agentName!, handle);
        if (opts.agentName === "background") background(handle, turns);
        else scriptReply(handle, `${opts.agentName} done`);
        return handle;
      },
    });
    return { controller, options, handles, explorers, gates, turns };
  }

  it("gives a child with subagents the agent tool and its children none", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const { controller, options, handles } = tree(recipeDir, workspaceDir);
    const background = await controller.start({ name: "background", prompt: "plan" });
    await vi.waitFor(() => expect(handles.get("background")).toBeDefined());
    const handle = handles.get("background")!;
    expect(handle.session.getActiveToolNames()).toContain("agent");
    expect(options.get("background")?.runController).toBeUndefined();
    expect(options.get("background")?.agentRun).toEqual({
      id: background.agent_run_id,
      depth: 1,
    });

    // A depth-2 session never gets the agent tool, whatever it declares.
    const grandchild = await createAgentSessionInternal({
      recipe: resolveRecipe({ recipeDir }),
      agentName: "background",
      cwd: workspaceDir,
      env: cleanEnv(),
      credentials: await credentialStore(),
      sessionRole: "subagent",
      agentRun: { id: "agent-run-x", depth: 2 },
    });
    try {
      expect(grandchild.session.getActiveToolNames()).not.toContain("agent");
      expect(grandchild.session.getAllTools().map((tool) => tool.name)).not.toContain("agent");
    } finally {
      await grandchild.dispose();
    }
    await controller.shutdown();
  });

  it("finishes a child only after its parallel runs settle, with their results", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const onAgentRunEvent = vi.fn();
    const { controller, gates, turns, options } = tree(recipeDir, workspaceDir, { onAgentRunEvent });
    const background = await controller.start({ name: "background", prompt: "plan" });

    await vi.waitFor(() => expect(gates.size).toBe(2));
    await vi.waitFor(() => expect(turns).toEqual(["fan-out", "yield"]));
    expect(controller.get(background.agent_run_id)?.status).toBe("running");

    gates.get("find A")!.resolve(undefined);
    await vi.waitFor(() =>
      expect(options.get("explorer")?.agentRun).toBeUndefined()
    );
    expect(controller.get(background.agent_run_id)?.status).toBe("running");
    gates.get("find B")!.resolve(undefined);

    const settled = await controller.wait(background.agent_run_id);
    expect(settled.status).toBe("completed");
    expect(settled.output).toBe("Final: found A + found B");
    // One notice carrying both results, then the run ends.
    expect(turns).toEqual(["fan-out", "yield", "notice"]);

    expect(options.get("explorer")?.runController).toBeNull();
    expect(onAgentRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_name: "explorer",
        parent_agent_run_id: background.agent_run_id,
        depth: 2,
      })
    );
    expect(onAgentRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_run_id: background.agent_run_id,
        parent_agent_run_id: "root",
        depth: 1,
      })
    );
    await controller.shutdown();
  });

  it("does not notify a child about runs it already waited on", async () => {
    const { recipeDir, workspaceDir } = fixture();
    // Fan out, then wait on both runs inside the same turn.
    const waitInTurn = (handle: RecipeSessionHandle, turns: string[]) => {
      handle.session.agent.streamFunction = (_model, context) => {
        const stream = new MockAssistantStream();
        const last = context.messages.at(-1)!;
        let message = assistantMessage("");
        const results = context.messages.filter((entry) => entry.role === "toolResult");
        if (last.role === "user") {
          turns.push(messageText(last).includes("<agent_run_completions>") ? "notice" : "fan-out");
          message.content = [
            { type: "toolCall", id: "start-a", name: "agent", arguments: { name: "explorer", prompt: "find A" } },
            { type: "toolCall", id: "start-b", name: "agent", arguments: { name: "explorer", prompt: "find B" } },
          ];
          message.stopReason = "toolUse";
        } else if (results.length === 2) {
          turns.push("wait");
          const ids = results.map((entry) => /\((agent-run-[^)]+)\)/.exec(messageText(entry))![1]);
          message.content = ids.map((id, index) => ({
            type: "toolCall" as const, id: `wait-${index}`, name: "agent", arguments: { action: "wait", id },
          }));
          message.stopReason = "toolUse";
        } else {
          turns.push("answer");
          const found = results.slice(2).map(messageText).join(" ");
          message = assistantMessage(`Waited: ${["found A", "found B"].filter((text) => found.includes(text)).join(" + ")}`);
        }
        queueMicrotask(() => {
          stream.push({ type: "start", partial: assistantMessage("") });
          stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        });
        return stream;
      };
    };
    const { controller, gates, turns } = tree(recipeDir, workspaceDir, {}, waitInTurn);
    const background = await controller.start({ name: "background", prompt: "plan" });
    await vi.waitFor(() => expect(gates.size).toBe(2));
    for (const gate of gates.values()) gate.resolve(undefined);

    const settled = await controller.wait(background.agent_run_id);
    expect(settled.status).toBe("completed");
    expect(settled.output).toBe("Waited: found A + found B");
    expect(turns).toEqual(["fan-out", "wait", "answer"]);
    await controller.shutdown();
  });

  it("lets a host run a delegating child itself and settle its runs", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const turns: string[] = [];
    const delegated = createDelegatedRuns();
    // A host's own controller made this child: it passes the run it serves
    // through the public API, and settles the child's runs with the helper.
    const child = await createAgentSession({
      recipe: resolveRecipe({ recipeDir }),
      agentName: "background",
      cwd: workspaceDir,
      env: cleanEnv(),
      credentials: await credentialStore(),
      agentRun: { id: "host-run-1", depth: 1 },
      agentToolOptions: delegated.agentToolOptions,
      // Test seam: fake explorers for the child's own runs.
      ...({
        sessionFactory: async (opts: Options) => fakeExplorer(opts, gates),
      } as object),
    });
    try {
      scriptBackground(child, turns);
      expect(child.session.getActiveToolNames()).toContain("agent");
      const settled = delegated.run(child, "plan", async (input) => {
        await child.session.prompt(input);
      });
      await vi.waitFor(() => expect(gates.size).toBe(2));
      for (const gate of gates.values()) gate.resolve(undefined);
      await settled;
      expect(turns).toEqual(["fan-out", "yield", "notice"]);
      expect(messageText(child.session.messages.at(-1))).toBe("Final: found A + found B");
    } finally {
      await child.dispose();
    }
  });

  it("binds a child's own runs through Pi's model registry, each for its own provider", async () => {
    const { recipeDir, workspaceDir } = fixture();
    // The explorer runs on another provider than the background that starts it.
    writeFileSync(
      join(recipeDir, "agents", "explorer.yaml"),
      ["name: explorer", "model:", "  name: openai/gpt-5.5", "tools: [read]", ""].join("\n")
    );
    const recipe = resolveRecipe({ recipeDir });
    const registry = {
      find: (provider: string, id: string) => getModel(provider as never, id as never),
      getApiKeyAndHeaders: async (model: { provider: string }) => ({
        ok: true,
        apiKey: `pi-managed-${model.provider}`,
      }),
    };
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const bound: Options[] = [];
    const background = await createIsolatedChildSession({
      recipe,
      agentName: "background",
      cwd: workspaceDir,
      env: cleanEnv(),
      // Resolved for the background's provider only.
      credentials: await credentialStore(),
      credentialsResolved: true,
      agentRunId: "run-1",
      modelRegistry: registry as never,
      sessionFactory: async (opts) => {
        if (opts.agentName !== "explorer")
          return createAgentSessionInternal(opts);
        bound.push(opts);
        return fakeExplorer(opts, gates);
      },
    });
    try {
      await background.agentRuns.start({ name: "explorer", prompt: "find A" });
      await vi.waitFor(() => expect(bound).toHaveLength(1));
      expect(bound[0]!.modelOverride?.provider).toBe("openai");
      expect(await bound[0]!.credentials?.read("openai")).toBeTruthy();
      gates.get("find A")?.resolve(undefined);
    } finally {
      await background.dispose();
    }
  });

  it("hands a child the new result of a run it resumed", async () => {
    const { recipeDir, workspaceDir } = fixture();
    // One explorer; on its result, send it back for more; answer from the second result.
    const resume = (handle: RecipeSessionHandle, turns: string[]) => {
      handle.session.agent.streamFunction = (_model, context) => {
        const stream = new MockAssistantStream();
        const last = context.messages.at(-1)!;
        let message = assistantMessage("");
        const text = messageText(last);
        if (last.role === "user" && !text.includes("<agent_run_completions>")) {
          turns.push("fan-out");
          message.content = [
            { type: "toolCall", id: "start-a", name: "agent", arguments: { name: "explorer", prompt: "find A" } },
          ];
          message.stopReason = "toolUse";
        } else if (last.role === "toolResult") {
          turns.push("yield");
          message = assistantMessage("Waiting on the explorer.");
        } else if (text.includes("found A")) {
          turns.push("resume");
          const id = /\((agent-run-[^)]+)\)/.exec(text)![1];
          message.content = [
            { type: "toolCall", id: "more", name: "agent", arguments: { action: "message", id, message: "find C" } },
          ];
          message.stopReason = "toolUse";
        } else {
          turns.push("answer");
          message = assistantMessage(text.includes("found C") ? "Final: found C" : "Final: nothing new");
        }
        queueMicrotask(() => {
          stream.push({ type: "start", partial: assistantMessage("") });
          stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        });
        return stream;
      };
    };
    const { controller, gates, turns } = tree(recipeDir, workspaceDir, {}, resume);
    const background = await controller.start({ name: "background", prompt: "plan" });
    await vi.waitFor(() => expect(gates.has("find A")).toBe(true));
    gates.get("find A")!.resolve(undefined);
    await vi.waitFor(() => expect(gates.has("find C")).toBe(true));
    gates.get("find C")!.resolve(undefined);

    const settled = await controller.wait(background.agent_run_id);
    expect(settled.status).toBe("completed");
    expect(settled.output).toBe("Final: found C");
    expect(turns).toEqual(["fan-out", "yield", "resume", "yield", "answer"]);
    await controller.shutdown();
  });

  it("interrupts and closes a child's runs with the child", async () => {
    const { recipeDir, workspaceDir } = fixture();
    for (const action of ["interrupt", "close"] as const) {
      const { controller, handles, gates, explorers, turns } = tree(recipeDir, workspaceDir);
      const background = await controller.start({ name: "background", prompt: "plan" });
      await vi.waitFor(() => expect(gates.size).toBe(2));
      await vi.waitFor(() => expect(turns).toEqual(["fan-out", "yield"]));
      const nested = handles.get("background")!.agentRuns;

      await controller[action](background.agent_run_id);

      expect(nested.list().map((run) => run.status)).toEqual(
        action === "interrupt"
          ? ["interrupted", "interrupted"]
          : ["closed", "closed"]
      );
      for (const explorer of explorers) {
        expect(explorer.session.abort).toHaveBeenCalled();
        if (action === "close") expect(explorer.dispose).toHaveBeenCalled();
      }
      const settled = await controller.wait(background.agent_run_id);
      expect(settled.status).toBe(action === "interrupt" ? "interrupted" : "closed");
      expect(turns).toEqual(["fan-out", "yield"]);
      await controller.shutdown();
      expect(nested.list().every((run) => run.status === "closed")).toBe(true);
    }
  });

  it("bounds a subagent cycle at the maximum depth", async () => {
    const { recipeDir, workspaceDir } = fixture({ a: ["b"], b: ["a"] });
    const options: Options[] = [];
    const handles: RecipeSessionHandle[] = [];
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      sessionFactory: async (opts) => {
        options.push(opts);
        const handle = await createAgentSessionInternal({
          ...opts,
          credentials: await credentialStore(),
        });
        scriptReply(handle, `${opts.agentName} done`);
        handles.push(handle);
        return handle;
      },
    });
    const a = await controller.start({ name: "a", prompt: "go" });
    await controller.wait(a.agent_run_id);
    expect(handles[0]!.session.getActiveToolNames()).toContain("agent");

    const b = await handles[0]!.agentRuns.start({ name: "b", prompt: "go" });
    const settled = await handles[0]!.agentRuns.wait(b.agent_run_id);
    expect(settled.status).toBe("completed");
    expect(options[1]).toMatchObject({ agentName: "b", runController: null });
    expect(options[1]?.agentRun).toBeUndefined();
    expect(handles[1]!.session.getAllTools().map((tool) => tool.name)).not.toContain("agent");
    expect(handles[1]!.agentRuns.list()).toEqual([]);
    await expect(
      handles[1]!.agentRuns.start({ name: "a", prompt: "again" })
    ).rejects.toThrow();
    await controller.shutdown();
  });
});
