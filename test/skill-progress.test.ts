import { describe, expect, it } from "vitest";

import {
  elapsed,
  lastSkillRead,
  readsWhole,
  registerSkillProgress,
  skillRead,
  STEP_STATUS_KEY,
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
      "research · 00:05",
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

  it("sets the footer status as the agent moves, with a running clock, and on resume", () => {
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
    const statuses: Array<[string, string]> = [];
    const ctx = {
      hasUI: true,
      cwd: "/home/u/interview-8",
      ui: {
        setStatus: (key: string, text: string) => statuses.push([key, text]),
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
    handlers.get("tool_result")!(
      { input: { path: "s/build-draft/SKILL.md" } },
      ctx,
    );
    clock = 3 * 60_000 + 17_000;
    tick!();
    expect(statuses.at(-1)).toEqual([
      STEP_STATUS_KEY,
      "⧈ Introspection build ✓ brainstorm ▸ draft ○ review · 03:17",
    ]);
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
