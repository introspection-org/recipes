import { describe, expect, it } from "vitest";

import {
  elapsed,
  lastSkillRead,
  readsWhole,
  registerSkillProgress,
  skillRead,
  stepSkills,
  stepLine,
} from "../src/skill-progress.js";

const skills = [
  "build-brainstorm",
  "build-draft",
  "build-review",
  "eval-case",
  "eval-run",
];

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
    expect(stepLine("build-brainstorm", skills, "00:17")).toBe(
      "build ▸ brainstorm ○ draft ○ review · 00:17",
    );
    expect(stepLine("build-draft", skills, "12:04")).toBe(
      "build ✓ brainstorm ▸ draft ○ review · 12:04",
    );
    expect(stepLine("build-review", skills, "03:10")).toBe(
      "build ✓ brainstorm ✓ draft ▸ review · 03:10",
    );
    expect(stepLine("research", ["research"], "00:05")).toBe(
      "▸ research · 00:05",
    );
  });

  it("steps only through the phase the agent lists first, not skills it consults", () => {
    expect(stepSkills(skills)).toEqual([
      "build-brainstorm",
      "build-draft",
      "build-review",
    ]);
    expect(skillRead("/x/skills/eval-case/SKILL.md", skills)).toBeUndefined();
    expect(skillRead("/x/skills/build-draft/SKILL.md", skills)).toBe(
      "build-draft",
    );
    expect(stepSkills(["research", "write"])).toEqual(["research", "write"]);
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
        content: [{ type: "toolCall", arguments: args }],
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
                  arguments: { path: "s/build-brainstorm/SKILL.md" },
                },
              ],
            },
          },
        ],
      },
    };
    progress.resume(ctx as any);
    clock = 60_000;
    handlers.get("tool_execution_start")!(
      { toolName: "review_artifacts", args: {} },
      ctx,
    );
    clock = 10 * 60_000; // nine minutes with the owner don't count
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
    clock = 10 * 60_000 + 30_000; // the clock carries on across steps
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
