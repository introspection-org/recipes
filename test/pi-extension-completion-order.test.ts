/**
 * Deterministic regression guard for the child-completion enqueue/persist
 * ordering (see pi-extension.ts `executeChildPrompt` finally block).
 *
 * The wake-on-completion path enqueues a completion envelope and persists the
 * run's status.json. The `agent_end` poke (and any observer that watches
 * status.json) must never see a persisted terminal status while the envelope
 * is still unqueued — otherwise the poke hits `ChildCompletionQueue.poke()`'s
 * empty-queue no-op and delivery slips to the full batch window.
 *
 * This test removes the real filesystem timing by mocking the store so the
 * *terminal* status write blocks on a gate. We resume the test the instant
 * persistence is in flight and fire `agent_end` there. The contract: by the
 * time persistence runs, the envelope is already queued, so the poke delivers
 * immediately. With the buggy ordering (persist before enqueue) the queue is
 * empty at this point and no notice is delivered — this test fails.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRecipesExtension } from "../src/pi-extension.js";
import {
  createMockExtensionAPI,
  type MockExtensionAPI,
} from "./helpers/mock-extension.js";

// Shared gate between the mocked store and the test body. Hoisted so the
// vi.mock factory (also hoisted) can close over it.
const persistGate = vi.hoisted(() => {
  let enteredResolve!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  let releaseResolve!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  return {
    entered,
    released,
    signalEntered: () => enteredResolve(),
    release: () => releaseResolve(),
  };
});

// Replace ChildAgentRunStore with an in-memory store whose *terminal* write
// blocks on the gate; the initial "running" write and reads pass through.
vi.mock("../src/child/agent-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/child/agent-store.js")>();
  class GatedStore {
    constructor(_workspaceDir: string) {}
    async writeStatus(snapshot: { status: string }): Promise<void> {
      if (snapshot.status === "completed" || snapshot.status === "failed") {
        persistGate.signalEntered();
        await persistGate.released;
      }
    }
    async readPersistedSnapshots(): Promise<unknown[]> {
      return [];
    }
  }
  return { ...actual, ChildAgentRunStore: GatedStore };
});

function extensionContext(cwd: string) {
  return {
    cwd,
    hasUI: true,
    ui: { notify: vi.fn() },
    isIdle: () => true,
    modelRegistry: {
      authStorage: { kind: "shared-auth-storage" },
      find: vi.fn((provider: string, id: string) => ({ provider, id })),
    },
  } as any;
}

function writeRecipe(root: string) {
  const recipeDir = join(root, "recipe");
  mkdirSync(join(recipeDir, "defs"), { recursive: true });
  writeFileSync(
    join(recipeDir, "package.json"),
    `${JSON.stringify({ name: "demo", version: "1.0.0", pi: { agents: ["defs/*.yaml"] } }, null, 2)}\n`
  );
  writeFileSync(join(recipeDir, "SYSTEM.md"), "Base recipe prompt");
  const agentYaml = (name: string, subagents: string[]) =>
    [
      `name: ${name}`,
      "model:",
      "  name: openai/gpt-4.1",
      "  thinking_level: low",
      "tools: []",
      "skills: []",
      subagents.length > 0 ? "subagents:" : "subagents: []",
      ...subagents.map((sub) => `  - ${sub}`),
      "system_instructions:",
      "  mode: append",
      "  content: prompt",
      "",
    ].join("\n");
  writeFileSync(join(recipeDir, "defs", "main.yaml"), agentYaml("main", ["explorer"]));
  writeFileSync(join(recipeDir, "defs", "explorer.yaml"), agentYaml("explorer", []));
  return recipeDir;
}

function runnerPool() {
  const runs: Array<{ finish: (output: string) => void }> = [];
  const createChildAgentRunner = vi.fn(() => {
    let finishRun!: (output: string) => void;
    const done = new Promise<string>((resolve) => {
      finishRun = resolve;
    });
    runs.push({ finish: finishRun });
    return {
      async start() {},
      async prompt() {
        return await done;
      },
      async cancel() {},
      async shutdown() {},
    };
  });
  return { createChildAgentRunner, runs };
}

function completionMessages(pi: MockExtensionAPI) {
  return pi.sentMessages.filter(
    (entry) => entry.message?.customType === "recipe-agent-completions"
  );
}

describe("child completion ordering vs persistence", () => {
  it("delivers on agent_end when the poke races the terminal persist", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-completion-order-"));
    try {
      const pool = runnerPool();
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });

      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");
      const ctx = extensionContext(projectDir);
      createRecipesExtension({ createChildAgentRunner: pool.createChildAgentRunner as any })(pi);
      await pi.emitExtensionEvent({ type: "session_start", reason: "startup" } as any, ctx);

      const started = await (pi.tools.get("agent") as any).execute(
        "call-1",
        { name: "explorer", prompt: "look around" },
        undefined,
        undefined,
        ctx
      );
      const id = started?.details?.agent?.agent_run_id as string;

      // Settle the child. The terminal status write now blocks inside the
      // gated store, freezing execution with persistence in flight.
      pool.runs[0]?.finish("background result");
      await persistGate.entered;

      // Fire the settle boundary at the exact adversarial moment: persistence
      // is mid-flight. With enqueue-before-persist the envelope is already
      // queued and this delivers; with persist-before-enqueue the queue is
      // empty here and poke() is a silent no-op.
      await pi.emitExtensionEvent({ type: "agent_end", messages: [] } as any, ctx);

      await vi.waitFor(() => {
        expect(completionMessages(pi)).toHaveLength(1);
      });
      expect(completionMessages(pi)[0]!.message.content).toContain(`(${id})`);
      expect(completionMessages(pi)[0]!.message.content).toContain("background result");
    } finally {
      persistGate.release();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
