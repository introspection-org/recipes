import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRecipe } from "../src/recipe/resolve.js";
import {
  createAgentSession,
  type RecipeSessionHandle,
} from "../src/session.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";

function reply(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
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
}

/** Answers every request with `text`, recording each request's messages. */
function script(handle: RecipeSessionHandle, requests: string[]): void {
  handle.session.agent.streamFunction = (_model, context) => {
    requests.push(JSON.stringify(context.messages));
    const message = reply("summary");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

describe("session.compaction", () => {
  const cleanups: Array<() => void> = [];
  const handles: RecipeSessionHandle[] = [];

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.dispose();
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  async function open(compaction: string[]): Promise<RecipeSessionHandle> {
    const created = writeFixtureRecipe();
    cleanups.push(created.cleanup);
    writeFileSync(
      join(created.recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "ai:",
        "  model: anthropic/claude-sonnet-4-5",
        "tools: []",
        "session:",
        "  compaction:",
        ...compaction.map((line) => `    ${line}`),
      ].join("\n"),
    );
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("anthropic", async () => ({
      type: "api_key",
      key: "test-key",
    }));
    const handle = await createAgentSession({
      recipe: resolveRecipe({ recipeDir: created.recipeDir }),
      cwd: created.workspaceDir,
      credentials,
      env: cleanEnv(),
      runController: null,
    });
    handles.push(handle);
    return handle;
  }

  async function compactAfterTwoTurns(
    handle: RecipeSessionHandle,
    customInstructions?: string,
  ): Promise<string> {
    const requests: string[] = [];
    script(handle, requests);
    await handle.session.prompt("first question");
    await handle.session.prompt("second question");
    requests.length = 0;
    await handle.session.compact(customInstructions);
    return requests.join("\n");
  }

  it("resolves each token setting through the model override, then the block", async () => {
    const handle = await open([
      "reserve_tokens: 16384",
      "keep_recent_tokens: 20000",
      "model_overrides:",
      "  anthropic/claude-sonnet-4-5:",
      "    reserve_tokens: 65536",
      "  anthropic/Claude-Sonnet-4-5:",
      "    keep_recent_tokens: 1",
    ]);
    const settings = handle.session.settingsManager;

    expect(settings.getCompactionSettings(handle.session.model)).toEqual({
      enabled: true,
      reserveTokens: 65536,
      keepRecentTokens: 20000,
    });
    expect(settings.getCompactionSettings()).toEqual({
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    });
  });

  it("gives every compaction the authored instructions", async () => {
    const handle = await open([
      "keep_recent_tokens: 1",
      "instructions: Keep every open decision.",
    ]);

    const request = await compactAfterTwoTurns(handle);

    expect(request).toContain("Additional focus: Keep every open decision.");
  });

  it("adds a manual compaction's instructions after the authored ones", async () => {
    const handle = await open([
      "keep_recent_tokens: 1",
      "instructions: Keep every open decision.",
    ]);

    const request = await compactAfterTwoTurns(handle, "Name the files.");

    expect(request).toContain(
      String.raw`Additional focus: Keep every open decision.\n\nName the files.`,
    );
  });

  it("leaves Pi's summary unchanged without instructions", async () => {
    const handle = await open(["keep_recent_tokens: 1"]);

    expect(await compactAfterTwoTurns(handle)).not.toContain(
      "Additional focus",
    );
    const session = await open(["keep_recent_tokens: 1"]);
    expect(await compactAfterTwoTurns(session, "Name the files.")).toContain(
      "Additional focus: Name the files.",
    );
  });
});
