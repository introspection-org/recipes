import { describe, expect, it } from "vitest";

import {
  elapsed,
  lastSkillRead,
  readsWhole,
  registerSkillProgress,
  nextStep,
  phases,
  skillRead,
  stepLine,
} from "../src/skill-progress.js";

const names = [
  "build-brainstorm",
  "build-draft",
  "build-review",
  "eval-case",
  "eval-run",
];
const skills = { names };

describe("where the agent is", () => {
  it("finds the agent's skill a path or command reads", () => {
    expect(skillRead("/x/skills/build-draft/SKILL.md", skills)).toBe(
      "build-draft",
    );
    expect(skillRead("cat /x/skills/build-review/SKILL.md && ls", skills)).toBe(
      "build-review",
    );
    expect(skillRead("/x/skills/other/SKILL.md", skills)).toBeUndefined();
    expect(
      skillRead("/x/skills/build-draft/references/evals.md", skills),
    ).toBeUndefined();
  });

  it("shows the phase's steps in order, done ticked, the current one marked, the clock at the end", () => {
    expect(stepLine("build-brainstorm", names, "00:17")).toBe(
      "build ▸ brainstorm ○ draft ○ review · 00:17",
    );
    expect(stepLine("build-draft", names, "12:04")).toBe(
      "build ✓ brainstorm ▸ draft ○ review · 12:04",
    );
    expect(stepLine("build-review", names, "03:10")).toBe(
      "build ✓ brainstorm ✓ draft ▸ review · 03:10",
    );
    expect(stepLine("research", ["research"], "00:05")).toBe(
      "▸ research · 00:05",
    );
  });

  it("finds a skill whose name isn't its folder's", () => {
    const renamed = {
      names: ["build-brainstorm", "build-draft"],
      folders: new Map([["draft-folder", "build-draft"]]),
    };
    expect(skillRead("/x/skills/draft-folder/SKILL.md", renamed)).toBe(
      "build-draft",
    );
  });

  it("steps through one phase at a time, moving on only from its last step", () => {
    const flow = [
      "build-brainstorm",
      "build-draft",
      "build-review",
      "deploy-runtime",
      "deploy-test",
      "eval-case",
      "eval-run",
    ];
    expect(phases(flow).map((steps) => steps[0])).toEqual([
      "build-brainstorm",
      "deploy-runtime",
      "eval-case",
    ]);
    expect(nextStep(undefined, "build-brainstorm", flow)).toBe(
      "build-brainstorm",
    );
    expect(nextStep(undefined, "deploy-runtime", flow)).toBeUndefined();
    // A skill consulted along the way doesn't move the step.
    expect(nextStep("build-draft", "eval-case", flow)).toBe("build-draft");
    // The next phase waits for this one's last step.
    expect(nextStep("build-draft", "deploy-runtime", flow)).toBe("build-draft");
    expect(nextStep("build-review", "deploy-runtime", flow)).toBe(
      "deploy-runtime",
    );
    // Only the next phase's first step moves on to it.
    expect(nextStep("build-review", "deploy-test", flow)).toBe("build-review");
    // Never back to an earlier phase.
    expect(nextStep("deploy-runtime", "build-review", flow)).toBe(
      "deploy-runtime",
    );
    expect(stepLine("deploy-test", flow, "14:40")).toBe(
      "deploy ✓ runtime ▸ test · 14:40",
    );
    expect(nextStep(undefined, "write", ["research", "write"])).toBe("write");
  });

  it("shows the improve, optimize and harden phases the same way", () => {
    const later = [
      "improve-collect",
      "improve-classify",
      "improve-propose",
      "optimize-quality",
      "optimize-cost",
      "optimize-latency",
      "harden-scan",
      "harden-spar",
      "harden-stress",
    ];
    expect(stepLine("improve-classify", later, "03:00")).toBe(
      "improve ✓ collect ▸ classify ○ propose · 03:00",
    );
    expect(nextStep("improve-propose", "optimize-quality", later)).toBe(
      "optimize-quality",
    );
    expect(stepLine("optimize-quality", later, "09:30")).toBe(
      "optimize ▸ quality ○ cost ○ latency · 09:30",
    );
    expect(nextStep("optimize-latency", "harden-scan", later)).toBe(
      "harden-scan",
    );
    expect(stepLine("harden-spar", later, "20:00")).toBe(
      "harden ✓ scan ▸ spar ○ stress · 20:00",
    );
  });

  it("counts reading a skill, not glancing at its top", () => {
    expect(readsWhole({ path: "s/build-review/SKILL.md", limit: 30 })).toBe(
      false,
    );
    expect(readsWhole({ path: "s/build-review/SKILL.md", limit: 200 })).toBe(
      true,
    );
    expect(readsWhole({ path: "s/build-review/SKILL.md" })).toBe(true);
    expect(readsWhole({ command: "head -30 s/build-review/SKILL.md" })).toBe(
      false,
    );
    expect(readsWhole({ command: "cat s/build-review/SKILL.md" })).toBe(true);
  });

  it("gives how long the step has run", () => {
    expect(elapsed(17_000)).toBe("00:17");
    expect(elapsed(222_000)).toBe("03:42");
    expect(elapsed(3_909_000)).toBe("1:05:09");
  });

  it("recovers the last step from the session", () => {
    const call = (args: Record<string, unknown>) => ({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: args }],
      },
    });
    expect(
      lastSkillRead(
        [
          call({ path: "/x/skills/build-brainstorm/SKILL.md" }),
          call({ command: "cat /x/skills/build-draft/SKILL.md" }),
        ],
        skills,
      ),
    ).toBe("build-draft");
    expect(
      lastSkillRead(
        [
          call({ path: "/x/skills/build-brainstorm/SKILL.md" }),
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  name: "read",
                  id: "t2",
                  arguments: { path: "/wrong/build-draft/SKILL.md" },
                },
              ],
            },
          },
          {
            type: "message",
            message: { role: "toolResult", toolCallId: "t2", isError: true },
          },
        ],
        skills,
      ),
    ).toBe("build-brainstorm");
  });

  it("shows the step and the agent's working time, paused while the person is in the loop", () => {
    const handlers = new Map<string, (event: any, ctx: any) => void>();
    const pi = {
      on: (name: string, handler: any) => handlers.set(name, handler),
    } as any;
    let clock = 0;
    let tick: (() => void) | undefined;
    const progress = registerSkillProgress(
      pi,
      () => skills,
      () => clock,
      (fn) => {
        tick = fn;
        return () => {};
      },
    );
    const statuses: string[] = [];
    const ctx = {
      hasUI: true,
      cwd: "/home/u/interview-8",
      ui: {
        setStatus: (_key: string, text: string) => statuses.push(text),
        setTitle: () => {
          throw new Error("the title is Pi's");
        },
        setWorkingMessage: () => {
          throw new Error("the working line is Pi's");
        },
      },
      sessionManager: {
        getEntries: () => [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  name: "read",
                  arguments: { path: "s/build-brainstorm/SKILL.md" },
                },
              ],
            },
          },
        ],
      },
    };
    progress.resume(ctx as any);
    clock = 5 * 60_000; // waiting for the first prompt doesn't count
    handlers.get("agent_start")!({}, ctx);
    clock += 60_000;
    handlers.get("tool_execution_start")!(
      { toolName: "review_artifacts", args: {} },
      ctx,
    );
    clock = 15 * 60_000; // nine minutes with the owner don't count
    tick!();
    expect(statuses.at(-1)).toBe(
      "⧈ Introspection build ⏸ brainstorm ○ draft ○ review · 01:00",
    );
    handlers.get("tool_result")!(
      { toolName: "review_artifacts", input: {} },
      ctx,
    );
    handlers.get("tool_result")!(
      { toolName: "read", input: { path: "s/build-draft/SKILL.md" } },
      ctx,
    );
    handlers.get("tool_result")!(
      { toolName: "edit", input: { path: "s/build-review/SKILL.md" } },
      ctx,
    ); // editing a skill isn't reading it
    clock = 15 * 60_000 + 30_000; // the clock carries on across steps
    tick!();
    expect(statuses.at(-1)).toBe(
      "⧈ Introspection build ✓ brainstorm ▸ draft ○ review · 01:30",
    );
    handlers.get("agent_end")!({}, ctx);
    clock = 20 * 60_000;
    tick!();
    expect(statuses.at(-1)).toBe(
      "⧈ Introspection build ✓ brainstorm ⏸ draft ○ review · 01:30",
    );
    handlers.get("agent_start")!({}, ctx);
    clock = 20 * 60_000 + 5_000;
    tick!();
    expect(statuses.at(-1)).toBe(
      "⧈ Introspection build ✓ brainstorm ▸ draft ○ review · 01:35",
    );
    // Another session in the same process keeps nothing of this one.
    const fresh = { ...ctx, sessionManager: { getEntries: () => [] } };
    progress.resume(fresh as any);
    expect(statuses.at(-1)).toBeUndefined();
    handlers.get("tool_result")!({ toolName: "bash", input: {} }, fresh);
    expect(statuses.at(-1)).toBeUndefined();
  });

  it("does nothing outside a Recipe session", () => {
    const handlers = new Map<string, (event: any, ctx: any) => void>();
    const pi = {
      on: (name: string, handler: any) => handlers.set(name, handler),
    } as any;
    registerSkillProgress(pi, () => undefined);
    const ctx = {
      hasUI: true,
      cwd: "/x",
      ui: {
        setStatus: () => {
          throw new Error("called");
        },
        setTitle: () => {},
      },
    };
    expect(() =>
      handlers.get("tool_result")!(
        { input: { path: "s/build-draft/SKILL.md" } },
        ctx,
      ),
    ).not.toThrow();
  });
});
