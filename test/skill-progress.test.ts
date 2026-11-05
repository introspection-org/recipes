import { describe, expect, it } from "vitest";

import {
  activity,
  elapsed,
  lastSkillRead,
  registerSkillProgress,
  skillRead,
  stepCrumb,
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

  it("shows the phase as a bar, the step and what's next", () => {
    expect(stepCrumb("build-brainstorm", skills)).toBe(
      "build ▰▱▱ 1/3 brainstorm · next draft",
    );
    expect(stepCrumb("build-review", skills)).toBe("build ▰▰▰ 3/3 review");
    expect(stepCrumb("research", ["research"])).toBe("research");
  });

  it("says what a tool call is doing in a few words", () => {
    expect(
      activity("bash", {
        command: "cd interview-agent && introspection eval run -p x.ts",
      }),
    ).toBe("introspection eval run -p x.ts");
    expect(
      activity("bash", { command: `echo ${"x".repeat(100)}` }),
    ).toHaveLength(60);
    expect(activity("review_artifacts", {})).toBe("waiting for you");
    expect(activity("read", { path: "a.md" })).toBe("read");
    expect(
      activity("agent", {
        action: "start",
        name: "case-runner",
        label: "hello-1",
      }),
    ).toBe("start case-runner hello-1");
    expect(activity("agent", { action: "wait", id: "agent-run-2" })).toBe(
      "wait agent-run-2",
    );
  });

  it("gives how long the step has run", () => {
    expect(elapsed(45_000)).toBe("45s");
    expect(elapsed(12 * 60_000)).toBe("12m");
    expect(elapsed(65 * 60_000)).toBe("1h 5m");
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

  it("sets the working line and title as the agent moves, and on resume", () => {
    const handlers = new Map<string, (event: any, ctx: any) => void>();
    const pi = {
      on: (name: string, handler: any) => handlers.set(name, handler),
    } as any;
    let clock = 0;
    const progress = registerSkillProgress(
      pi,
      () => skills,
      () => clock,
    );
    const working: string[] = [];
    const titles: string[] = [];
    const ctx = {
      hasUI: true,
      cwd: "/home/u/interview-8",
      ui: {
        setWorkingMessage: (m: string) => working.push(m),
        setTitle: (t: string) => titles.push(t),
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
    clock = 3 * 60_000;
    handlers.get("tool_execution_start")!(
      {
        toolName: "bash",
        args: { command: "introspection tasks prompt runs/C1-1 --prompt hi" },
      },
      ctx,
    );
    expect(titles).toEqual([
      "⧈ Introspection · interview-8 · build ▰▱▱ 1/3 brainstorm · next draft",
      "⧈ Introspection · interview-8 · build ▰▰▱ 2/3 draft · next review",
    ]);
    expect(working.at(-1)).toBe(
      "⧈ Introspection build ▰▰▱ 2/3 draft · next review (3m) › introspection tasks prompt runs/C1-1 --prompt hi",
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
        setWorkingMessage: () => {
          throw new Error("called");
        },
        setTitle: () => {},
      },
    };
    expect(() =>
      handlers.get("tool_execution_start")!(
        { toolName: "bash", args: { command: "ls" } },
        ctx,
      ),
    ).not.toThrow();
  });
});
