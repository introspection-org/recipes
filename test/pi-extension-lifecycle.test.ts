/**
 * Lifecycle semantics of background agent runs: wait-abort detaches instead
 * of interrupting, interrupt only targets in-flight work, close stops running
 * children, and persisted runs rehydrate read-only after a process restart.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRecipesExtension } from "../src/pi-extension.js";
import {
  createMockExtensionAPI,
  type MockExtensionAPI,
} from "./helpers/mock-extension.js";

function extensionContext(cwd: string, notify = vi.fn()) {
  const authStorage = { kind: "shared-auth-storage" };
  return {
    cwd,
    hasUI: true,
    ui: { notify },
    modelRegistry: {
      authStorage,
      find: vi.fn((provider: string, id: string) => ({ provider, id })),
    },
  } as any;
}

function writeRecipe(root: string) {
  const recipeDir = join(root, "recipe");
  mkdirSync(join(recipeDir, "defs"), { recursive: true });
  writeFileSync(
    join(recipeDir, "package.json"),
    `${JSON.stringify(
      {
        name: "demo",
        version: "1.0.0",
        pi: { agents: ["defs/*.yaml"] },
      },
      null,
      2
    )}\n`
  );
  writeFileSync(join(recipeDir, "SYSTEM.md"), "Base recipe prompt");
  writeFileSync(
    join(recipeDir, "defs", "main.yaml"),
    [
      "name: main",
      "model:",
      "  name: openai/gpt-4.1",
      "  thinking_level: low",
      "tools:",
      "  - read",
      "skills: []",
      "subagents:",
      "  - explorer",
      "system_instructions:",
      "  mode: append",
      "  content: Agent-specific prompt",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(recipeDir, "defs", "explorer.yaml"),
    [
      "name: explorer",
      "model:",
      "  name: openai/gpt-4.1",
      "  thinking_level: low",
      "tools: []",
      "skills: []",
      "subagents: []",
      "system_instructions:",
      "  mode: append",
      "  content: Explorer prompt",
      "",
    ].join("\n")
  );
  return recipeDir;
}

type HangingRunner = ReturnType<typeof hangingRunner>;

/** Child runner whose prompt hangs until the test calls finish() (or cancel). */
function hangingRunner() {
  let finishRun!: (output: string) => void;
  let failRun!: (err: Error) => void;
  const done = new Promise<string>((resolve, reject) => {
    finishRun = resolve;
    failRun = reject;
  });
  const cancel = vi.fn(async () => {
    failRun(new Error("cancelled"));
  });
  const steer = vi.fn(async () => {});
  const createChildAgentRunner = vi.fn(() => ({
    async start() {},
    async prompt() {
      return await done;
    },
    steer,
    cancel,
    async shutdown() {},
  }));
  return {
    createChildAgentRunner,
    cancel,
    steer,
    finish: (output = "child output") => finishRun(output),
  };
}

async function startSession(
  createChildAgentRunner: (opts?: any) => any,
  root: string
): Promise<{ pi: MockExtensionAPI; ctx: any; projectDir: string }> {
  const recipeDir = writeRecipe(root);
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  const pi = createMockExtensionAPI();
  pi.flagValues.set("recipe", recipeDir);
  pi.flagValues.set("agent", "main");
  const ctx = extensionContext(projectDir);
  createRecipesExtension({ createChildAgentRunner: createChildAgentRunner as any })(pi);
  await pi.emitExtensionEvent({ type: "session_start", reason: "startup" } as any, ctx);
  return { pi, ctx, projectDir };
}

function agentTool(pi: MockExtensionAPI) {
  const tool = pi.tools.get("agent");
  if (!tool) throw new Error("agent tool not registered");
  return tool;
}

describe("background agent run lifecycle", () => {
  it("steers a running agent without waiting for it to settle", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-lifecycle-"));
    try {
      const runner = hangingRunner();
      const { pi, ctx } = await startSession(runner.createChildAgentRunner, root);
      const started = await agentTool(pi).execute(
        "call-1",
        { name: "explorer", prompt: "look around" },
        undefined,
        undefined,
        ctx
      );
      const id = started?.details?.agent?.agent_run_id as string;

      const messaged = await agentTool(pi).execute(
        "call-2",
        { action: "message", id, message: "focus on tests" },
        undefined,
        undefined,
        ctx
      );

      expect(runner.steer).toHaveBeenCalledWith("focus on tests");
      expect(messaged?.details?.agent?.status).toBe("running");
      runner.finish("done");
      await agentTool(pi).execute(
        "call-3",
        { action: "wait", id },
        undefined,
        undefined,
        ctx
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a settled run's status on interrupt", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-lifecycle-"));
    try {
      const runner = hangingRunner();
      const { pi, ctx } = await startSession(runner.createChildAgentRunner, root);

      runner.finish("done");
      const result = await agentTool(pi).execute(
        "call-1",
        { name: "explorer", prompt: "look around" },
        undefined,
        undefined,
        ctx
      );
      const id = result?.details?.agent?.agent_run_id as string;
      const waited = await agentTool(pi).execute(
        "call-2",
        { action: "wait", id },
        undefined,
        undefined,
        ctx
      );
      expect(id).toBe("agent-run-1");
      expect(waited?.details?.agent?.status).toBe("completed");

      const interrupted = await agentTool(pi).execute(
        "call-3",
        { action: "interrupt", id },
        undefined,
        undefined,
        ctx
      );
      expect(interrupted?.details?.agent?.status).toBe("completed");
      expect(runner.cancel).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an intentional interrupt from becoming a child failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-lifecycle-"));
    try {
      const runner = hangingRunner();
      const { pi, ctx } = await startSession(runner.createChildAgentRunner, root);
      const started = await agentTool(pi).execute(
        "call-1",
        { name: "explorer", prompt: "look around" },
        undefined,
        undefined,
        ctx
      );
      const id = started?.details?.agent?.agent_run_id as string;

      const interrupted = await agentTool(pi).execute(
        "call-2",
        { action: "interrupt", id },
        undefined,
        undefined,
        ctx
      );

      expect(runner.cancel).toHaveBeenCalledOnce();
      expect(interrupted?.details?.agent).toEqual(
        expect.objectContaining({ status: "interrupted", error: undefined })
      );

      const status = await agentTool(pi).execute(
        "call-3",
        { action: "status", id },
        undefined,
        undefined,
        ctx
      );
      expect(status?.details?.agent).toEqual(
        expect.objectContaining({ status: "interrupted", error: undefined })
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("interrupts and closes an in-flight run on close", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-lifecycle-"));
    try {
      const runner = hangingRunner();
      const { pi, ctx } = await startSession(runner.createChildAgentRunner, root);

      const result = await agentTool(pi).execute(
        "call-1",
        { name: "explorer", prompt: "look around" },
        undefined,
        undefined,
        ctx
      );
      const id = result?.details?.agent?.agent_run_id as string;
      const closed = await agentTool(pi).execute(
        "call-2",
        { action: "close", id },
        undefined,
        undefined,
        ctx
      );
      expect(runner.cancel).toHaveBeenCalled();
      expect(String(closed?.content[0]?.type === "text" ? closed.content[0].text : "")).toContain(
        `Closed run ${id} (explorer: `
      );
      const status = await agentTool(pi).execute(
        "call-3",
        { action: "status", id },
        undefined,
        undefined,
        ctx
      );
      expect((status as any)?.isError).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps completed local agents available for follow-up messages", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-lifecycle-"));
    try {
      const prompt = vi
        .fn()
        .mockResolvedValueOnce("first answer")
        .mockResolvedValueOnce("second answer");
      const shutdown = vi.fn(async () => {});
      const createChildAgentRunner = vi.fn(() => ({
        async start() {},
        prompt,
        async cancel() {},
        shutdown,
      }));
      const { pi, ctx } = await startSession(createChildAgentRunner, root);

      const started = await agentTool(pi).execute(
        "call-1",
        { name: "explorer", prompt: "first" },
        undefined,
        undefined,
        ctx
      );
      const id = started?.details?.agent?.agent_run_id as string;
      await agentTool(pi).execute(
        "call-2",
        { action: "wait", id },
        undefined,
        undefined,
        ctx
      );

      await agentTool(pi).execute(
        "call-3",
        { action: "message", id, message: "second" },
        undefined,
        undefined,
        ctx
      );
      const followedUp = await agentTool(pi).execute(
        "call-4",
        { action: "wait", id },
        undefined,
        undefined,
        ctx
      );

      expect(followedUp?.details?.agent).toEqual(
        expect.objectContaining({ status: "completed", output: "second answer" })
      );
      expect(prompt).toHaveBeenNthCalledWith(1, "first");
      expect(prompt).toHaveBeenNthCalledWith(2, "second");
      expect(shutdown).not.toHaveBeenCalled();

      await agentTool(pi).execute(
        "call-5",
        { action: "close", id },
        undefined,
        undefined,
        ctx
      );
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists run snapshots under .pi/agents", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-lifecycle-"));
    try {
      const runner = hangingRunner();
      const { pi, ctx, projectDir } = await startSession(
        runner.createChildAgentRunner,
        root
      );

      runner.finish("persisted output");
      const result = await agentTool(pi).execute(
        "call-1",
        {
          name: "explorer",
          prompt: "look around",
        },
        undefined,
        undefined,
        ctx
      );
      const id = result?.details?.agent?.agent_run_id as string;
      await agentTool(pi).execute(
        "call-2",
        { action: "wait", id },
        undefined,
        undefined,
        ctx
      );
      const statusPath = join(projectDir, ".pi", "agents", id, "status.json");
      await vi.waitFor(() => expect(existsSync(statusPath)).toBe(true));
      const snapshot = JSON.parse(readFileSync(statusPath, "utf8"));
      expect(snapshot).toEqual(
        expect.objectContaining({
          id,
          agent: "explorer",
          prompt: "look around",
          status: "completed",
          output: "persisted output",
        })
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rehydrates persisted runs read-only and flips stale running to interrupted", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-lifecycle-"));
    try {
      const projectDir = join(root, "project");
      const runDir = join(projectDir, ".pi", "agents", "recipe-agent-3");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "status.json"),
        `${JSON.stringify({
          id: "recipe-agent-3",
          agent: "explorer",
          task: "old task",
          status: "running",
          startedAt: new Date().toISOString(),
          toolCalls: [],
        })}\n`
      );

      const runner = hangingRunner();
      const { pi, ctx } = await startSession(runner.createChildAgentRunner, root);

      const status = await agentTool(pi).execute(
        "call-1",
        { action: "status", id: "recipe-agent-3" },
        undefined,
        undefined,
        ctx
      );
      expect(status?.details?.agent).toEqual(
        expect.objectContaining({
          agent_run_id: "recipe-agent-3",
          prompt: "old task",
          status: "interrupted",
          error: "Pi session restarted while the run was in flight",
        })
      );

      const migratedSnapshot = JSON.parse(
        readFileSync(join(runDir, "status.json"), "utf8")
      );
      expect(migratedSnapshot.prompt).toBe("old task");
      expect(migratedSnapshot).not.toHaveProperty("task");

      // Waiting on a rehydrated run returns immediately with its snapshot.
      const waited = await agentTool(pi).execute(
        "call-2",
        { action: "wait", id: "recipe-agent-3" },
        undefined,
        undefined,
        ctx
      );
      expect(waited?.details?.agent).toEqual(
        expect.objectContaining({
          agent_run_id: "recipe-agent-3",
          status: "interrupted",
        })
      );

      // Control actions on rehydrated runs fail with a clear error.
      const interrupted = await agentTool(pi).execute(
        "call-3",
        { action: "interrupt", id: "recipe-agent-3" },
        undefined,
        undefined,
        ctx
      );
      expect((interrupted as any)?.isError).toBe(true);
      expect(String(interrupted?.content[0]?.type === "text" ? interrupted.content[0].text : "")).toContain(
        "previous Pi session"
      );

      // New runs never collide with rehydrated ids.
      runner.finish();
      const started = await agentTool(pi).execute(
        "call-4",
        { name: "explorer", prompt: "new task" },
        undefined,
        undefined,
        ctx
      );
      expect(started?.details?.agent?.agent_run_id).toBe("agent-run-4");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
