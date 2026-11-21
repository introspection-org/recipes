import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai/compat";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunStatus } from "../src/agents.js";
import { resolveRecipe } from "../src/recipe/resolve.js";
import { createAgentSession } from "../src/session.js";
import type { RecipeStep } from "../src/skill-progress.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";

function assistantMessage(text: string): AssistantMessage {
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

async function credentialStore(): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: "test-key",
  }));
  return store;
}

describe("the session's step", () => {
  const disposals: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const dispose of disposals.splice(0)) await dispose();
  });

  it("counts the session's running subagent runs on its step, re-reporting when one starts or ends", async () => {
    const { recipeDir, workspaceDir, cleanup } = writeFixtureRecipe({
      manifestPi: { skills: ["skills"] },
      subagents: ["helper"],
      agentExtras: ["skills: [build-draft]"],
    });
    mkdirSync(join(recipeDir, "skills", "build-draft"), { recursive: true });
    writeFileSync(
      join(recipeDir, "skills", "build-draft", "SKILL.md"),
      "---\nname: build-draft\ndescription: The draft step.\n---\n\n# build-draft\n",
    );
    const run = {
      agent_run_id: "child-1",
      invocation_name: "helper",
      agent_name: "helper",
      label: "helper",
      prompt: "help",
      status: "running" as AgentRunStatus,
      started_at: 1,
      last_activity_at: 1,
    };
    const runs: (typeof run)[] = [];
    let update: ((summary: typeof run) => unknown) | undefined;
    const runController = {
      list: () => runs,
      get: () => null,
      start: vi.fn(async (input: { onUpdate?: (s: any) => unknown }) => {
        update = input.onUpdate;
        runs.push(run);
        return run;
      }),
      wait: vi.fn(),
      message: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn(),
      shutdown: vi.fn(async () => {}),
    };
    const steps: RecipeStep[] = [];
    const handle = await createAgentSession({
      recipe: resolveRecipe({ recipeDir }),
      credentials: await credentialStore(),
      env: cleanEnv(),
      cwd: workspaceDir,
      runController,
      onRecipeStep: (step) => steps.push(step),
    });
    disposals.push(async () => {
      await handle.dispose();
      cleanup();
    });
    let calls = 0;
    handle.session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage("Drafting.");
      calls += 1;
      if (calls <= 2) {
        message.content = [
          calls === 1
            ? {
                type: "toolCall",
                id: "read-1",
                name: "read",
                arguments: {
                  path: join(recipeDir, "skills", "build-draft", "SKILL.md"),
                },
              }
            : {
                type: "toolCall",
                id: "agent-1",
                name: "agent",
                arguments: { action: "start", name: "helper", prompt: "help" },
              },
        ];
        message.stopReason = "toolUse";
      }
      queueMicrotask(() => {
        stream.push({ type: "start", partial: assistantMessage("") });
        stream.push({
          type: "done",
          reason: message.stopReason as "stop" | "toolUse",
          message,
        });
      });
      return stream;
    };
    await handle.session.prompt("build me an agent");
    expect(runController.start).toHaveBeenCalledOnce();
    expect(steps.find((step) => step.agents === 1)).toMatchObject({
      skill: "build-draft",
      agents: 1,
    });

    run.status = "completed";
    await update?.(run);
    expect(steps.at(-1)).toMatchObject({ skill: "build-draft" });
    expect(steps.at(-1)).not.toHaveProperty("agents");

    // A run a host starts through the handle is counted too.
    run.status = "running";
    await handle.agentRuns.start({ name: "helper", prompt: "again" });
    // The mock lists the run once per start, so both starts are running now.
    expect(steps.at(-1)).toMatchObject({ skill: "build-draft", agents: 2 });
  });
});
