import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { AgentRunSummary } from "../src/agents.js";
import { createRecipesExtension } from "../src/pi-extension.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

function extensionContext(cwd: string) {
  return {
    cwd,
    hasUI: true,
    ui: { notify: vi.fn() },
    modelRegistry: {
      find: vi.fn((provider: string, id: string) => ({ provider, id })),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: "test-key",
      })),
    },
  } as any;
}

/** A Recipe whose `main` agent can start the `explorer` subagent. */
function writeRecipe(root: string) {
  const recipeDir = join(root, "recipe");
  mkdirSync(join(recipeDir, "defs"), { recursive: true });
  writeFileSync(
    join(recipeDir, "package.json"),
    `${JSON.stringify({
      name: "demo",
      version: "1.0.0",
      pi: { agents: ["defs/*.yaml"] },
    })}\n`,
  );
  writeFileSync(join(recipeDir, "SYSTEM.md"), "Base recipe prompt");
  writeFileSync(
    join(recipeDir, "defs", "main.yaml"),
    [
      "name: main",
      "model:",
      "  name: openai/gpt-4.1",
      "tools:",
      "  - read",
      "subagents:",
      "  - explorer",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(recipeDir, "defs", "explorer.yaml"),
    [
      "name: explorer",
      "model:",
      "  name: openai/gpt-4.1",
      "tools: []",
      "",
    ].join("\n"),
  );
  return recipeDir;
}

describe("agent tool progress", () => {
  it("renders a waited-on child's latest tool call, elapsed time and count while it runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-progress-"));
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      const longCommand = `python3 tests/sow_checks.py ${"--verbose ".repeat(20)}\n  --and-more`;
      const createChildAgentRunner = vi.fn((opts: any = {}) => ({
        async start() {},
        async prompt() {
          opts.onToolEvent?.({
            type: "start",
            id: "bash-1",
            name: "bash",
            args: { command: longCommand },
          });
          opts.onToolEvent?.({
            type: "start",
            id: "write-1",
            name: "write",
            args: { path: "tests/test.sh", content: "#!/bin/sh" },
          });
          return "checks written";
        },
        async steer() {},
        async cancel() {},
        async shutdown() {},
      }));
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");
      const ctx = extensionContext(projectDir);

      createRecipesExtension({ createChildAgentRunner })(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx,
      );

      const tool = pi.tools.get("agent")!;
      const updates: AgentToolResult<any>[] = [];
      const final = await tool.execute(
        "tool-call-1",
        { name: "explorer", prompt: "write the checks", wait: true },
        undefined,
        (update) => updates.push(update),
        ctx,
      );

      const running = updates.filter(
        (update) => update.details?.agent?.status === "running",
      );
      const bash = running.find(
        (update) => update.details.agent.tool_call_count === 1,
      )!;
      expect(bash.details.agent.latest_tool_call).toMatch(
        /^bash python3 tests\/sow_checks\.py --verbose .*…$/,
      );
      expect(bash.details.agent.latest_tool_call).not.toContain("\n");
      const latest = running.at(-1)!;
      // Plain-text hosts read the same line from the partial result.
      expect(latest.content[0]).toEqual(
        expect.objectContaining({
          text: expect.stringMatching(
            /^explorer: write tests\/test\.sh · \d+s · 2 tool calls$/,
          ),
        }),
      );

      const theme = { fg: (_name: string, text: string) => text } as any;
      const invalidate = vi.fn();
      const context = {
        lastComponent: undefined,
        state: {},
        invalidate,
      } as any;
      const progress = tool.renderResult!(
        latest as any,
        { expanded: false, isPartial: true },
        theme,
        context,
      );
      expect(progress.render(120).join("\n").trim()).toMatch(
        /^explorer: write tests\/test\.sh · \d+s · 2 tool calls$/,
      );
      expect(context.state.ticker).toBeDefined();

      const done = tool.renderResult!(
        final as any,
        { expanded: false, isPartial: false },
        theme,
        { ...context, lastComponent: progress },
      );
      expect(context.state.ticker).toBeUndefined();
      expect(done.render(120).join("\n")).toContain("checks written");
      expect(done.render(120).join("\n")).toMatch(
        /\(explorer: .*\) \[completed\]/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("agent progress for several runs", () => {
  /** A child runner per run that makes one tool call, then holds until released. */
  function gatedChildRunners() {
    const gates: Array<() => void> = [];
    const createChildAgentRunner = vi.fn((opts: any = {}) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      gates.push(release);
      return {
        async start() {},
        async prompt(prompt: string) {
          opts.onToolEvent?.({
            type: "start",
            id: "bash-1",
            name: "bash",
            args: { command: `run ${prompt}` },
          });
          await gate;
          return `${prompt} done`;
        },
        async steer() {},
        async cancel() {},
        async shutdown() {},
      };
    });
    return { gates, createChildAgentRunner };
  }

  async function startExtension(root: string, ctxOverrides: any = {}) {
    const recipeDir = writeRecipe(root);
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const runners = gatedChildRunners();
    const pi = createMockExtensionAPI();
    pi.flagValues.set("recipe", recipeDir);
    pi.flagValues.set("agent", "main");
    const base = extensionContext(projectDir);
    const ctx = {
      ...base,
      ...ctxOverrides,
      ui: { ...base.ui, ...ctxOverrides.ui },
    };
    createRecipesExtension({
      createChildAgentRunner: runners.createChildAgentRunner,
    })(pi);
    await pi.emitExtensionEvent(
      { type: "session_start", reason: "startup" } as any,
      ctx,
    );
    const tool = pi.tools.get("agent")!;
    const start = async (label: string) => {
      const started = await tool.execute(
        `start-${label}`,
        { name: "explorer", prompt: label, label },
        undefined,
        undefined,
        ctx,
      );
      return started.details.agent as AgentRunSummary;
    };
    return { ...runners, pi, ctx, tool, start };
  }

  it("shows one line per awaited run while a wait over several run ids runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-progress-many-"));
    try {
      const { gates, ctx, tool, start } = await startExtension(root);
      const first = await start("case-a");
      const second = await start("case-b");

      const updates: AgentToolResult<any>[] = [];
      const waiting = tool.execute(
        "wait-1",
        { action: "wait", ids: [first.agent_run_id, second.agent_run_id] },
        undefined,
        (update) => updates.push(update),
        ctx,
      );
      await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));
      const progress = updates[0]!;
      const lines = (progress.content[0] as { text: string }).text.split("\n");
      expect(lines).toEqual([
        expect.stringMatching(
          /^explorer \(case-a\): bash run case-a · \d+s · 1 tool call$/,
        ),
        expect.stringMatching(
          /^explorer \(case-b\): bash run case-b · \d+s · 1 tool call$/,
        ),
      ]);
      // RPC hosts read every awaited run's summary.
      expect(
        progress.details.agents.map((run: AgentRunSummary) => run.label),
      ).toEqual(["case-a", "case-b"]);

      const theme = { fg: (_name: string, text: string) => text } as any;
      const context = {
        lastComponent: undefined,
        state: {},
        invalidate: vi.fn(),
      } as any;
      const rendered = tool.renderResult!(
        progress as any,
        { expanded: false, isPartial: true },
        theme,
        context,
      );
      expect(rendered.render(120).join("\n").trim().split("\n")).toHaveLength(
        2,
      );

      gates.forEach((release) => release());
      const final = await waiting;
      const text = (final.content[0] as { text: string }).text;
      expect(text).toContain("case-a done");
      expect(text).toContain("case-b done");
      expect(
        final.details.agents.map((run: AgentRunSummary) => run.status),
      ).toEqual(["completed", "completed"]);
      tool.renderResult!(
        final as any,
        { expanded: false, isPartial: false },
        theme,
        { ...context, lastComponent: rendered },
      );
      expect(context.state.ticker).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows a status line per background run and removes it when the run settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-progress-bg-"));
    try {
      const setWidget = vi.fn();
      const { gates, pi, ctx, tool, start } = await startExtension(root, {
        mode: "tui",
        ui: { setWidget },
      });
      const first = await start("case-a");
      await start("case-b");
      await vi.waitFor(() =>
        expect(setWidget.mock.calls.at(-1)?.[1]).toEqual([
          expect.stringMatching(
            /^explorer \(case-a\): bash run case-a · \d+s · 1 tool call$/,
          ),
          expect.stringMatching(
            /^explorer \(case-b\): bash run case-b · \d+s · 1 tool call$/,
          ),
        ]),
      );
      const key = setWidget.mock.calls.at(-1)![0];

      gates[0]!();
      await tool.execute(
        "wait-a",
        { action: "wait", id: first.agent_run_id },
        undefined,
        undefined,
        ctx,
      );
      await vi.waitFor(() =>
        expect(setWidget.mock.calls.at(-1)).toEqual([
          key,
          [expect.stringMatching(/^explorer \(case-b\): /)],
        ]),
      );

      gates[1]!();
      await vi.waitFor(() =>
        expect(setWidget.mock.calls.at(-1)).toEqual([key, undefined]),
      );
      await pi.emitExtensionEvent({ type: "session_shutdown" } as any, ctx);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps print mode quiet while background runs work", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-progress-print-"));
    try {
      const setWidget = vi.fn();
      const { gates, ctx, tool, start } = await startExtension(root, {
        mode: "print",
        hasUI: false,
        ui: { setWidget },
      });
      const run = await start("case-a");
      gates[0]!();
      await tool.execute(
        "wait-a",
        { action: "wait", id: run.agent_run_id },
        undefined,
        undefined,
        ctx,
      );
      expect(setWidget).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
