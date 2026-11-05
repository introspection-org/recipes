import { describe, expect, it } from "vitest";

import {
  elapsed,
  lastSkillRead,
  registerSkillProgress,
  skillRead,
  STEP_STATUS_KEY,
  stepLine,
  stepTitle,
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

  it("shows the phase's steps in order, done ticked, the current one with its clock", () => {
    expect(stepLine("build-brainstorm", skills, "00:17")).toBe(
      "build ▸ brainstorm · 00:17 → draft → review",
    );
    expect(stepLine("build-draft", skills, "12:04")).toBe(
      "build ✓ brainstorm → ▸ draft · 12:04 → review",
    );
    expect(stepLine("build-review", skills, "01:00")).toBe(
      "build ✓ brainstorm → ✓ draft → ▸ review · 01:00",
    );
    expect(stepLine("research", ["research"], "00:05")).toBe(
      "research · 00:05",
    );
    expect(stepTitle("build-draft", skills)).toBe("build ▸ draft");
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

  it("sets the footer status and title as the agent moves, with a running clock, and on resume", () => {
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
    const titles: string[] = [];
    const ctx = {
      hasUI: true,
      cwd: "/home/u/interview-8",
      ui: {
        setStatus: (key: string, text: string) => statuses.push([key, text]),
        setTitle: (t: string) => titles.push(t),
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
    expect(titles).toEqual([
      "⧈ Introspection · interview-8 · build ▸ brainstorm",
      "⧈ Introspection · interview-8 · build ▸ draft",
    ]);
    expect(statuses.at(-1)).toEqual([
      STEP_STATUS_KEY,
      "⧈ Introspection build ✓ brainstorm → ▸ draft · 03:17 → review",
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
