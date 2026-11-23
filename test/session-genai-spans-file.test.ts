/**
 * `PI_RECIPE_GENAI_SPANS_FILE` on an embedded session: the root session keeps
 * the file current, as the Pi extension does.
 */
import { existsSync, readFileSync } from "node:fs";
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

const handles: RecipeSessionHandle[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function reply(text: string): AssistantMessage {
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
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** Runs one scripted turn and returns where the spans file would be. */
async function runTurn(spansFile: boolean): Promise<string> {
  const { recipeDir, workspaceDir, cleanup } = writeFixtureRecipe();
  cleanups.push(cleanup);
  const path = join(workspaceDir, "out", "genai-spans.json");
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => ({
    type: "api_key",
    key: "test-key",
  }));
  const handle = await createAgentSession({
    recipe: resolveRecipe({ recipeDir }),
    cwd: workspaceDir,
    credentials,
    env: spansFile
      ? { ...cleanEnv(), PI_RECIPE_GENAI_SPANS_FILE: path }
      : cleanEnv(),
  });
  handles.push(handle);
  handle.session.agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: reply("") });
      stream.push({ type: "done", reason: "stop", message: reply("hello") });
    });
    return stream;
  };
  await handle.session.prompt("hi");
  return path;
}

describe("an embedded session's GenAI spans file", () => {
  it("writes the spans after a turn when the env names a file", async () => {
    const path = await runTurn(true);
    const spans = JSON.parse(readFileSync(path, "utf8")) as {
      data: { name: string }[];
    };
    expect(spans.data.map((span) => span.name)).toContain("chat mock");
    expect(JSON.stringify(spans)).toContain("hello");
  });

  it("writes nothing when the env names none", async () => {
    const path = await runTurn(false);
    expect(existsSync(path)).toBe(false);
  });
});
