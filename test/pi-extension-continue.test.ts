/**
 * The `continue` flag on the `agent` tool's `start` action: a role's next
 * dispatch can build on its own most recent *successful* run, never a
 * failed or interrupted one (the retention rule on `AgentRunController`).
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

function extensionContext(cwd: string) {
  const authStorage = { kind: "shared-auth-storage" };
  return {
    cwd,
    hasUI: true,
    ui: { notify: vi.fn() },
    isIdle: () => true,
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

/** Child runner whose successive calls follow a fixed script; records every prompt it received. */
function scriptedRunner(script: ReadonlyArray<{ output?: string; error?: Error }>) {
  const prompts: string[] = [];
  let callIndex = -1;
  const createChildAgentRunner = vi.fn(() => {
    callIndex += 1;
    const step = script[callIndex] ?? { output: "" };
    return {
      async start() {},
      async prompt(prompt: string) {
        prompts.push(prompt);
        if (step.error) throw step.error;
        return step.output ?? "";
      },
      steer: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      async shutdown() {},
    };
  });
  return { createChildAgentRunner, prompts };
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

/** Start a run and wait for it to settle, returning the terminal summary. */
async function startAndWait(
  pi: MockExtensionAPI,
  ctx: any,
  params: { name: string; prompt: string; continue?: boolean },
  callId: string
) {
  const started = await agentTool(pi).execute(
    `${callId}-start`,
    params,
    undefined,
    undefined,
    ctx
  );
  const id = started?.details?.agent?.agent_run_id as string;
  const waited = await agentTool(pi).execute(
    `${callId}-wait`,
    { action: "wait", id },
    undefined,
    undefined,
    ctx
  );
  return waited?.details?.agent;
}

describe("agent tool continue flag", () => {
  it("start with continue and no prior run behaves exactly like omitting it", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-continue-"));
    try {
      const runner = scriptedRunner([{ output: "first output" }]);
      const { pi, ctx } = await startSession(runner.createChildAgentRunner, root);

      await startAndWait(
        pi,
        ctx,
        { name: "explorer", prompt: "first task", continue: true },
        "call-1"
      );
      expect(runner.prompts).toEqual(["first task"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prepends the prior completed run's output exactly once when continue is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-continue-"));
    try {
      const runner = scriptedRunner([
        { output: "first output" },
        { output: "second output" },
      ]);
      const { pi, ctx } = await startSession(runner.createChildAgentRunner, root);

      await startAndWait(
        pi,
        ctx,
        { name: "explorer", prompt: "first task", continue: true },
        "call-1"
      );
      await startAndWait(
        pi,
        ctx,
        { name: "explorer", prompt: "second task", continue: true },
        "call-2"
      );

      expect(runner.prompts[0]).toBe("first task");
      expect(runner.prompts[1]).toBe(
        "<prior_episode>\nfirst output\n</prior_episode>\n\nsecond task"
      );
      // Only one prior-episode block, not a growing chain of them.
      expect(runner.prompts[1]?.match(/<prior_episode>/g)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a follow-up run's own displayed prompt stays the caller's original text", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-continue-"));
    try {
      const runner = scriptedRunner([
        { output: "first output" },
        { output: "second output" },
      ]);
      const { pi, ctx } = await startSession(runner.createChildAgentRunner, root);

      await startAndWait(
        pi,
        ctx,
        { name: "explorer", prompt: "first task", continue: true },
        "call-1"
      );
      const second = await startAndWait(
        pi,
        ctx,
        { name: "explorer", prompt: "second task", continue: true },
        "call-2"
      );
      // Status/UI surfaces should never show the <prior_episode> wrapper.
      expect(second?.prompt).toBe("second task");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never reuses a failed run's output, even when it is the most recent dispatch for that role", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-continue-"));
    try {
      const runner = scriptedRunner([
        { error: new Error("boom") },
        { output: "retry output" },
      ]);
      const { pi, ctx } = await startSession(runner.createChildAgentRunner, root);

      const failed = await startAndWait(
        pi,
        ctx,
        { name: "explorer", prompt: "first task", continue: true },
        "call-1"
      );
      expect(failed?.status).toBe("failed");

      await startAndWait(
        pi,
        ctx,
        { name: "explorer", prompt: "second task", continue: true },
        "call-2"
      );
      // The failed run's output must never appear as a prior episode.
      expect(runner.prompts[1]).toBe("second task");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
