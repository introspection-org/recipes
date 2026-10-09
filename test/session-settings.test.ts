import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai/compat";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRecipe } from "../src/recipe/resolve.js";
import {
  parseRecipeAgentSessionConfig,
  RecipeSessionConfigError,
} from "../src/recipe/session.js";
import { createInProcessRunController } from "../src/run-controller.js";
import {
  createAgentSession,
  createAgentSessionInternal,
  type RecipeSessionHandle,
} from "../src/session.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";

/**
 * Every Pi setting, as Pi's own settings reference lists it, is either
 * authored by a Recipe or deliberately left to the host. A Pi release that
 * adds a setting fails the drift guard below until it is classified here.
 */

/** Pi setting path -> the `session` path a Recipe authors it at. */
const RECIPE_SESSION: Record<string, string> = {
  steeringMode: "steering_mode",
  followUpMode: "follow_up_mode",
  "compaction.enabled": "compaction.enabled",
  "compaction.reserveTokens": "compaction.reserve_tokens",
  "compaction.keepRecentTokens": "compaction.keep_recent_tokens",
  "retry.enabled": "retry.enabled",
  "retry.maxRetries": "retry.max_retries",
  "retry.baseDelayMs": "retry.base_delay_ms",
  "retry.maxAgentDelayMs": "retry.max_agent_delay_ms",
  "retry.provider.timeoutMs": "retry.provider.timeout_ms",
  "retry.provider.maxRetries": "retry.provider.max_retries",
  "retry.provider.maxRetryDelayMs": "retry.provider.max_retry_delay_ms",
  "images.autoResize": "images.auto_resize",
  "images.blockImages": "images.block_images",
};

/** Pi settings a Recipe controls through another part of its format. */
const RECIPE_ELSEWHERE: Record<string, string> = {
  defaultProvider: "ai.model",
  defaultModel: "ai.model",
  defaultThinkingLevel: "ai.thinking_level",
  modelThinkingLevels: "ai.thinking_level",
  thinkingBudgets: "ai.options.thinking_budgets",
  // An agent binds one model, so per-agent `session.compaction` already is
  // the per-model value.
  "compaction.modelOverrides": "session.compaction",
  defaultTools: "agent tools",
  extensions: "package.json pi.extensions",
  skills: "package.json pi.skills and agent skills",
  prompts: "package.json pi.prompts",
  packages: "package.json dependencies",
};

/** Pi settings that are not portable session policy. */
const HOST_OWNED = new Set([
  // Model selection and display in an interactive client.
  "enabledModels",
  "hideThinkingBlock",
  "showCacheMissNotices",
  // Prompt-cache spend is a host cost policy, and global-only in Pi.
  "cacheWarming",
  // Interactive navigation and branch summaries.
  "externalEditor",
  "doubleEscapeAction",
  "treeFilterMode",
  "branchSummary.reserveTokens",
  "branchSummary.skipPrompt",
  // Trust, persistence, packaging and analytics.
  "defaultProjectTrust",
  "sessionDir",
  "npmCommand",
  "themes",
  "enableSkillCommands",
  "collapseChangelog",
  "enableInstallTelemetry",
  "enableAnalytics",
  "warnings.anthropicExtraUsage",
  // Pi's built-in codemode extension; Recipe sessions load no Pi extensions.
  "codemode.mode",
  "codemode.inlineBudget",
  // Terminal UI.
  "theme",
  "quietStartup",
  "tuiMode",
  "fullscreenExitOutput",
  "fullscreenScrollbar",
  "fullscreenCopyOnSelect",
  "fullscreenWheelScrollLines",
  "editorPaddingX",
  "outputPad",
  "autocompleteMaxVisible",
  "showHardwareCursor",
  "terminal.showImages",
  "terminal.imageWidthCells",
  "terminal.clearOnShrink",
  "terminal.showTerminalProgress",
  "terminal.hyperlinks",
  "terminal.images",
  "terminal.trueColor",
  "markdown.codeBlockIndent",
  "markdown.mermaid",
  // Networking and shell authority.
  "transport",
  "httpProxy",
  "httpIdleTimeoutMs",
  "websocketConnectTimeoutMs",
  "shellPath",
  "shellCommandPrefix",
]);

/** Non-default values a Recipe authors for every portable leaf. */
const RECIPE_VALUES: Record<string, unknown> = {
  steeringMode: "all",
  followUpMode: "all",
  "compaction.enabled": false,
  "compaction.reserveTokens": 7001,
  "compaction.keepRecentTokens": 7002,
  "retry.enabled": false,
  "retry.maxRetries": 7,
  "retry.baseDelayMs": 7003,
  "retry.maxAgentDelayMs": 7004,
  "retry.provider.timeoutMs": 7005,
  "retry.provider.maxRetries": 5,
  "retry.provider.maxRetryDelayMs": 7006,
  "images.autoResize": false,
  "images.blockImages": true,
};

/** Different values a host applies to the same leaves. */
const HOST_VALUES: Record<string, unknown> = {
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  "compaction.enabled": true,
  "compaction.reserveTokens": 9001,
  "compaction.keepRecentTokens": 9002,
  "retry.enabled": true,
  "retry.maxRetries": 9,
  "retry.baseDelayMs": 9003,
  "retry.maxAgentDelayMs": 9004,
  "retry.provider.timeoutMs": 9005,
  "retry.provider.maxRetries": 3,
  "retry.provider.maxRetryDelayMs": 9006,
  "images.autoResize": true,
  "images.blockImages": false,
};

function piSettingsReference(): string {
  let dir = dirname(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))
  );
  while (!dir.endsWith("pi-coding-agent")) dir = dirname(dir);
  return readFileSync(join(dir, "docs", "settings.md"), "utf8");
}

function nest(flat: Record<string, unknown>): Record<string, unknown> {
  const tree: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const keys = path.split(".");
    let node = tree;
    for (const key of keys.slice(0, -1)) {
      node = (node[key] ??= {}) as Record<string, unknown>;
    }
    node[keys.at(-1)!] = value;
  }
  return tree;
}

function leaf(settings: object, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) => (node as Record<string, unknown> | undefined)?.[key],
      settings
    );
}

function sessionYaml(values: Record<string, unknown>): string[] {
  const authored = Object.fromEntries(
    Object.entries(values).map(([path, value]) => [RECIPE_SESSION[path], value])
  );
  const lines = ["session:"];
  const write = (node: Record<string, unknown>, indent: string) => {
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object") {
        lines.push(`${indent}${key}:`);
        write(value as Record<string, unknown>, `${indent}  `);
      } else {
        lines.push(`${indent}${key}: ${String(value)}`);
      }
    }
  };
  write(nest(authored), "  ");
  return lines;
}

/** Pi >=0.99 only; this suite runs on the dev pin, not the Pi floor. */
function effectiveSettings(manager: SettingsManager): object {
  return (manager as unknown as { getSettings(): object }).getSettings();
}

function hostSettings(): SettingsManager {
  const manager = SettingsManager.inMemory();
  manager.applyOverrides(
    nest(HOST_VALUES) as Parameters<SettingsManager["applyOverrides"]>[0]
  );
  return manager;
}

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

function scriptReply(handle: RecipeSessionHandle, text: string): void {
  const message: AssistantMessage = {
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
    stopReason: "stop",
    timestamp: Date.now(),
  };
  handle.session.agent.streamFunction = () => {
    const stream = new MockAssistantStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "stop", message });
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

describe("Pi settings coverage", () => {
  const documented = [
    ...piSettingsReference().matchAll(/^\| `([A-Za-z.]+)` \|/gm),
  ].map((match) => match[1]!);

  it("reads Pi's settings reference", () => {
    expect(documented).toContain("compaction.reserveTokens");
  });

  it("classifies every Pi setting exactly once", () => {
    const classified = [
      ...Object.keys(RECIPE_SESSION),
      ...Object.keys(RECIPE_ELSEWHERE),
      ...HOST_OWNED,
    ];
    expect(new Set(classified).size).toBe(classified.length);
    expect(
      documented.filter((key) => !classified.includes(key))
    ).toEqual([]);
    expect(
      classified.filter((key) => !documented.includes(key))
    ).toEqual([]);
  });

  it("has a test value for every Recipe session leaf", () => {
    expect(Object.keys(RECIPE_VALUES).sort()).toEqual(
      Object.keys(RECIPE_SESSION).sort()
    );
    expect(Object.keys(HOST_VALUES).sort()).toEqual(
      Object.keys(RECIPE_SESSION).sort()
    );
  });

  it.each(Object.entries(RECIPE_SESSION))(
    "rejects a %s of the wrong type",
    (_piPath, recipePath) => {
      const session = nest({ [recipePath]: "not-a-valid-value" });
      expect(() =>
        parseRecipeAgentSessionConfig("Agent YAML", session)
      ).toThrow(RecipeSessionConfigError);
    }
  );
});

describe("Recipe session policy over host settings", () => {
  const cleanups: Array<() => void> = [];
  const handles: RecipeSessionHandle[] = [];

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.dispose();
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function fixture(agentLines: string[], helperLines: string[] = []) {
    const created = writeFixtureRecipe({ subagents: ["helper"] });
    cleanups.push(created.cleanup);
    writeFileSync(
      join(created.recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "ai:",
        "  model: anthropic/claude-sonnet-4-5",
        "tools: []",
        "subagents: [helper]",
        ...agentLines,
      ].join("\n")
    );
    writeFileSync(
      join(created.recipeDir, "agents", "helper.yaml"),
      [
        "name: helper",
        "ai:",
        "  model: anthropic/claude-sonnet-4-5",
        "tools: []",
        ...helperLines,
      ].join("\n")
    );
    return created;
  }

  async function open(
    recipeDir: string,
    cwd: string,
    settingsManager?: SettingsManager
  ): Promise<RecipeSessionHandle> {
    const handle = await createAgentSession({
      recipe: resolveRecipe({ recipeDir }),
      cwd,
      credentials: await credentialStore(),
      env: cleanEnv(),
      runController: null,
      ...(settingsManager ? { settingsManager } : {}),
    });
    handles.push(handle);
    return handle;
  }

  it("applies every authored leaf over the host's overrides", async () => {
    const { recipeDir, workspaceDir } = fixture(sessionYaml(RECIPE_VALUES));
    const host = hostSettings();

    const handle = await open(recipeDir, workspaceDir, host);

    const effective = effectiveSettings(handle.session.settingsManager);
    for (const [path, value] of Object.entries(RECIPE_VALUES)) {
      expect(leaf(effective, path), path).toEqual(value);
    }
    expect(handle.session.agent.steeringMode).toBe("all");
    expect(handle.session.agent.followUpMode).toBe("all");
    expect(handle.session.settingsManager.getCompactionSettings()).toEqual({
      enabled: false,
      reserveTokens: 7001,
      keepRecentTokens: 7002,
    });
    expect(handle.session.settingsManager.getRetrySettings()).toEqual({
      enabled: false,
      maxRetries: 7,
      baseDelayMs: 7003,
      maxAgentDelayMs: 7004,
    });
    // The host's manager is layered over, never written to.
    for (const [path, value] of Object.entries(HOST_VALUES)) {
      expect(leaf(effectiveSettings(host), path), path).toEqual(value);
    }
  });

  it.each(Object.keys(RECIPE_SESSION))(
    "keeps every host override beside an authored %s",
    async (path) => {
      const { recipeDir, workspaceDir } = fixture(
        sessionYaml({ [path]: RECIPE_VALUES[path] })
      );

      const handle = await open(recipeDir, workspaceDir, hostSettings());

      const effective = effectiveSettings(handle.session.settingsManager);
      for (const [other, value] of Object.entries(HOST_VALUES)) {
        expect(leaf(effective, other), other).toEqual(
          other === path ? RECIPE_VALUES[path] : value
        );
      }
    }
  );

  it("uses the host's settings when the agent authors no session policy", async () => {
    const { recipeDir, workspaceDir } = fixture([]);

    const host = hostSettings();
    const handle = await open(recipeDir, workspaceDir, host);

    const effective = effectiveSettings(handle.session.settingsManager);
    for (const [path, value] of Object.entries(HOST_VALUES)) {
      expect(leaf(effective, path), path).toEqual(value);
      expect(leaf(effectiveSettings(host), path), path).toEqual(value);
    }
  });

  it("keeps host and Recipe values across a Pi settings reload", async () => {
    const { recipeDir, workspaceDir } = fixture(
      sessionYaml({ "compaction.reserveTokens": 7001 })
    );

    const handle = await open(recipeDir, workspaceDir, hostSettings());
    await handle.session.settingsManager.reload();

    const effective = effectiveSettings(handle.session.settingsManager);
    expect(leaf(effective, "compaction.reserveTokens")).toBe(7001);
    expect(leaf(effective, "retry.maxRetries")).toBe(9);
  });

  it("sends ai.options.thinking_budgets to the provider", async () => {
    const { recipeDir, workspaceDir } = fixture([]);
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "ai:",
        "  model: anthropic/claude-sonnet-4-5",
        "  thinking_level: medium",
        "  options:",
        "    thinking_budgets:",
        "      medium: 4321",
        "tools: []",
      ].join("\n")
    );
    const handle = await open(recipeDir, workspaceDir);
    let payload: Record<string, unknown> | undefined;
    handle.session.agent.onPayload = async (next) => {
      payload = next as Record<string, unknown>;
      throw new Error("request payload captured");
    };

    await handle.session.prompt("capture the request").catch(() => {});

    expect(payload?.thinking).toMatchObject({ budget_tokens: 4321 });
  });

  it("falls back to Pi's defaults when neither side sets a value", async () => {
    const { recipeDir, workspaceDir } = fixture([
      "session:",
      "  steering_mode: all",
    ]);

    const handle = await open(
      recipeDir,
      workspaceDir,
      SettingsManager.inMemory()
    );

    expect(handle.session.settingsManager.getCompactionSettings()).toEqual(
      SettingsManager.inMemory().getCompactionSettings()
    );
    expect(handle.session.settingsManager.getRetrySettings()).toEqual(
      SettingsManager.inMemory().getRetrySettings()
    );
  });

  it("gives an in-process child the host's settings under its own policy", async () => {
    const { recipeDir, workspaceDir } = fixture(
      sessionYaml({ "compaction.reserveTokens": 7001 }),
      sessionYaml({ "retry.maxRetries": 7 })
    );
    let child: RecipeSessionHandle | undefined;
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      settingsManager: hostSettings(),
      sessionFactory: async (options) => {
        child = await createAgentSessionInternal({
          ...options,
          credentials: await credentialStore(),
        });
        scriptReply(child, "done");
        return child;
      },
    });

    const run = await controller.start({ name: "helper", prompt: "go" });
    await controller.wait(run.agent_run_id);

    const effective = effectiveSettings(child!.session.settingsManager);
    for (const [path, value] of Object.entries(HOST_VALUES)) {
      expect(leaf(effective, path), path).toEqual(
        path === "retry.maxRetries" ? 7 : value
      );
    }
    await controller.close(run.agent_run_id);
  });
});
