/**
 * Wake-on-completion delivery through the extension: a background child run
 * settling wakes the parent model with a `recipe-agent-completions` message
 * (triggerTurn), results the model saw synchronously are never re-delivered,
 * mid-turn batches hold until the agent_end settle boundary, and
 * interrupted runs are not announced.
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

function extensionContext(cwd: string, opts: { isIdle?: () => boolean } = {}) {
  const authStorage = { kind: "shared-auth-storage" };
  return {
    cwd,
    hasUI: true,
    ui: { notify: vi.fn() },
    isIdle: opts.isIdle ?? (() => true),
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
      { name: "demo", version: "1.0.0", pi: { agents: ["defs/*.yaml"] } },
      null,
      2
    )}\n`
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

/** Pool of controllable child runners, one per agent-tool start. */
function runnerPool() {
  const runs: Array<{
    finish: (output: string) => void;
    fail: (err: Error) => void;
  }> = [];
  const cancel = vi.fn(async () => {
    // Interrupt path: reject the in-flight prompt like a real cancel.
    runs[runs.length - 1]?.fail(new Error("cancelled"));
  });
  const createChildAgentRunner = vi.fn(() => {
    let finishRun!: (output: string) => void;
    let failRun!: (err: Error) => void;
    const done = new Promise<string>((resolve, reject) => {
      finishRun = resolve;
      failRun = reject;
    });
    runs.push({ finish: finishRun, fail: failRun });
    return {
      async start() {},
      async prompt() {
        return await done;
      },
      cancel,
      async shutdown() {},
    };
  });
  return { createChildAgentRunner, runs, cancel };
}

async function startSession(
  createChildAgentRunner: (opts?: any) => any,
  root: string,
  ctxOpts: { isIdle?: () => boolean } = {}
): Promise<{ pi: MockExtensionAPI; ctx: any; projectDir: string }> {
  const recipeDir = writeRecipe(root);
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  const pi = createMockExtensionAPI();
  pi.flagValues.set("recipe", recipeDir);
  pi.flagValues.set("agent", "main");
  const ctx = extensionContext(projectDir, ctxOpts);
  createRecipesExtension({ createChildAgentRunner: createChildAgentRunner as any })(pi);
  await pi.emitExtensionEvent({ type: "session_start", reason: "startup" } as any, ctx);
  return { pi, ctx, projectDir };
}

function agentTool(pi: MockExtensionAPI) {
  const tool = pi.tools.get("agent");
  if (!tool) throw new Error("agent tool not registered");
  return tool;
}

function completionMessages(pi: MockExtensionAPI) {
  return pi.sentMessages.filter(
    (entry) => entry.message?.customType === "recipe-agent-completions"
  );
}

/** Wait until the run's persisted snapshot reaches a terminal status. */
async function waitForPersistedStatus(
  projectDir: string,
  id: string,
  status: string
): Promise<void> {
  const path = join(projectDir, ".pi", "agents", id, "status.json");
  await vi.waitFor(() => {
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).status).toBe(status);
  });
}

describe("recipe child agent completion delivery", () => {
  it("wakes the parent when a background run completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-completions-"));
    try {
      const pool = runnerPool();
      const { pi, ctx, projectDir } = await startSession(pool.createChildAgentRunner, root);

      const started = await agentTool(pi).execute(
        "call-1",
        { name: "explorer", prompt: "look around" },
        undefined,
        undefined,
        ctx
      );
      expect(started?.details?.agent?.status).toBe("running");
      const id = started?.details?.agent?.agent_run_id as string;
      pool.runs[0]?.finish("background result");
      await waitForPersistedStatus(projectDir, id, "completed");

      // Settle boundary: flush without waiting out the batch window.
      await pi.emitExtensionEvent({ type: "agent_end", messages: [] } as any, ctx);
      await vi.waitFor(() => {
        expect(completionMessages(pi)).toHaveLength(1);
      });
      const { message, options } = completionMessages(pi)[0]!;
      expect(options).toEqual(
        expect.objectContaining({ triggerTurn: true, deliverAs: "followUp" })
      );
      expect(message.display).toBe(true);
      expect(message.content).toContain("<agent_run_completions>");
      expect(message.content).toContain(`(${id})`);
      expect(message.content).toContain("background result");
      expect(message.details?.completions?.[0]).toEqual(
        expect.objectContaining({ id, agent: "explorer", status: "completed" })
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("delivers a failed background run immediately while idle", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-completions-"));
    try {
      const pool = runnerPool();
      const { pi, ctx } = await startSession(pool.createChildAgentRunner, root);

      await agentTool(pi).execute(
        "call-1",
        { name: "explorer", prompt: "look around" },
        undefined,
        undefined,
        ctx
      );
      pool.runs[0]?.fail(new Error("boom"));
      await vi.waitFor(() => {
        expect(completionMessages(pi)).toHaveLength(1);
      });
      expect(completionMessages(pi)[0]?.message.content).toContain(
        "Agent failed: boom"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not re-deliver results read via terminal status or wait", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-completions-"));
    try {
      const pool = runnerPool();
      const { pi, ctx, projectDir } = await startSession(pool.createChildAgentRunner, root);

      const first = await agentTool(pi).execute(
        "call-1",
        { name: "explorer", prompt: "slice one" },
        undefined,
        undefined,
        ctx
      );
      const second = await agentTool(pi).execute(
        "call-2",
        { name: "explorer", prompt: "slice two" },
        undefined,
        undefined,
        ctx
      );
      const firstId = first?.details?.agent?.agent_run_id as string;
      const secondId = second?.details?.agent?.agent_run_id as string;
      pool.runs[0]?.finish("one done");
      pool.runs[1]?.finish("two done");
      await waitForPersistedStatus(projectDir, firstId, "completed");
      await waitForPersistedStatus(projectDir, secondId, "completed");

      await agentTool(pi).execute(
        "call-3",
        { action: "status", id: firstId },
        undefined,
        undefined,
        ctx
      );
      await agentTool(pi).execute(
        "call-4",
        { action: "wait", id: secondId },
        undefined,
        undefined,
        ctx
      );

      await pi.emitExtensionEvent({ type: "agent_end", messages: [] } as any, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(completionMessages(pi)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("holds delivery mid-turn and retries to idle after the agent_end poke", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-completions-"));
    try {
      const pool = runnerPool();
      let idle = false;
      const { pi, ctx } = await startSession(pool.createChildAgentRunner, root, {
        isIdle: () => idle,
      });

      await agentTool(pi).execute(
        "call-1",
        { name: "explorer", prompt: "look around" },
        undefined,
        undefined,
        ctx
      );
      // Failures flush immediately, but the parent is mid-turn: hold.
      pool.runs[0]?.fail(new Error("boom"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(completionMessages(pi)).toHaveLength(0);

      // Still mid-turn at the settle poke (pi tears the loop down after
      // agent_end): the retry timer must carry delivery to the idle point.
      await pi.emitExtensionEvent({ type: "agent_end", messages: [] } as any, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(completionMessages(pi)).toHaveLength(0);

      idle = true;
      await vi.waitFor(() => {
        expect(completionMessages(pi)).toHaveLength(1);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not announce interrupted runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-completions-"));
    try {
      const pool = runnerPool();
      const { pi, ctx } = await startSession(pool.createChildAgentRunner, root);

      const started = await agentTool(pi).execute(
        "call-1",
        { name: "explorer", prompt: "look around" },
        undefined,
        undefined,
        ctx
      );
      await agentTool(pi).execute(
        "call-2",
        { action: "interrupt", id: started?.details?.agent?.agent_run_id },
        undefined,
        undefined,
        ctx
      );
      expect(pool.cancel).toHaveBeenCalled();

      await pi.emitExtensionEvent({ type: "agent_end", messages: [] } as any, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(completionMessages(pi)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("announces a run rehydrated as interrupted after a process restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-completions-"));
    try {
      const projectDir = join(root, "project");
      const runDir = join(projectDir, ".pi", "agents", "recipe-agent-9");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "status.json"),
        `${JSON.stringify({
          id: "recipe-agent-9",
          agent: "explorer",
          prompt: "old task",
          status: "running",
          startedAt: new Date().toISOString(),
          toolCalls: [],
        })}\n`
      );

      const pool = runnerPool();
      const { pi, ctx } = await startSession(pool.createChildAgentRunner, root);

      // Rehydration runs during session_start, before any child runs. A
      // child that died with the previous process must still wake the
      // parent — without this, nothing would ever tell it.
      await pi.emitExtensionEvent({ type: "agent_end", messages: [] } as any, ctx);
      await vi.waitFor(() => {
        expect(completionMessages(pi)).toHaveLength(1);
      });
      const { message } = completionMessages(pi)[0]!;
      expect(message.content).toContain("(recipe-agent-9)");
      expect(message.content).toContain("[interrupted]");
      expect(message.details?.completions?.[0]).toEqual(
        expect.objectContaining({
          id: "recipe-agent-9",
          agent: "explorer",
          status: "interrupted",
          error: "Pi session restarted while the run was in flight",
        })
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders the wake-up notice compactly in the TUI", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-completions-"));
    try {
      const pool = runnerPool();
      const { pi } = await startSession(pool.createChildAgentRunner, root);
      const renderer = pi.messageRenderers.get("recipe-agent-completions");
      expect(renderer).toBeDefined();
      const component = renderer!(
        {
          customType: "recipe-agent-completions",
          content: "ignored",
          details: {
            completions: [
              {
                id: "recipe-agent-1",
                agent: "explorer",
                label: "scan",
                status: "completed",
                output_preview: "line one\nline two",
                duration_ms: 65_000,
              },
              {
                id: "recipe-agent-2",
                agent: "explorer",
                status: "failed",
                error: "boom",
              },
            ],
          },
        },
        { expanded: false },
        undefined
      ) as { render(width: number): string[] };
      const text = component.render(200).join("\n");
      expect(text).toContain("✓ explorer recipe-agent-1 (scan) completed · 1m 5s");
      expect(text).toContain("⎿  line one");
      expect(text).not.toContain("line two");
      expect(text).toContain("expand for full output");
      expect(text).toContain("✗ explorer recipe-agent-2 failed");
      expect(text).toContain("⎿  boom");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
