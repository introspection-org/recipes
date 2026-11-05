import { describe, expect, it } from "vitest";

import {
  advance,
  elapsed,
  lastPosition,
  lastSkillRead,
  positionLine,
  readsWhole,
  registerSkillProgress,
  skillRead,
  stepSkills,
  stepLine,
  type RecipeSkills,
} from "../src/skill-progress.js";

const names = [
  "build-brainstorm",
  "build-draft",
  "build-review",
  "eval-case",
  "eval-run",
];
const skills = { names };

/** The footer registered against a fake Pi, with a clock the test moves and a UI that records the status. */
function harness(recipeSkills: RecipeSkills) {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const pi = {
    on: (name: string, handler: any) => handlers.set(name, handler),
  } as any;
  let clock = 0;
  let tick: (() => void) | undefined;
  const statuses: (string | undefined)[] = [];
  const ctx = (entries: unknown[] = []) => ({
    hasUI: true,
    cwd: "/home/u/interview-8",
    ui: {
      setStatus: (_key: string, text: string | undefined) =>
        statuses.push(text),
      setTitle: () => {
        throw new Error("the title is Pi's");
      },
      setWorkingMessage: () => {
        throw new Error("the working line is Pi's");
      },
    },
    sessionManager: { getEntries: () => entries },
  });
  const progress = registerSkillProgress(
    pi,
    () => recipeSkills,
    () => clock,
    (fn) => {
      tick = fn;
      return () => {};
    },
  );
  return {
    handlers,
    statuses,
    ctx,
    progress,
    setClock: (ms: number) => {
      clock = ms;
    },
    /** Move the clock and redraw, as Pi's timer does every second. */
    at: (ms: number) => {
      clock = ms;
      tick?.();
    },
  };
}

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

  it("steps only through the phase the agent lists first, not skills it consults", () => {
    expect(stepSkills(names)).toEqual([
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
    const f = harness(skills);
    const ctx = f.ctx([
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
    ]);
    const { handlers, statuses } = f;
    f.progress.resume(ctx as any);
    f.setClock(5 * 60_000); // waiting for the first prompt doesn't count
    handlers.get("agent_start")!({}, ctx);
    f.setClock(6 * 60_000);
    handlers.get("tool_execution_start")!(
      { toolName: "review_artifacts", args: {} },
      ctx,
    );
    f.at(15 * 60_000); // nine minutes with the owner don't count
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
    f.at(15 * 60_000 + 30_000); // the clock carries on across steps
    expect(statuses.at(-1)).toBe(
      "⧈ Introspection build ✓ brainstorm ▸ draft ○ review · 01:30",
    );
    handlers.get("agent_end")!({}, ctx);
    f.at(20 * 60_000);
    expect(statuses.at(-1)).toBe(
      "⧈ Introspection build ✓ brainstorm ⏸ draft ○ review · 01:30",
    );
    handlers.get("agent_start")!({}, ctx);
    f.at(20 * 60_000 + 5_000);
    expect(statuses.at(-1)).toBe(
      "⧈ Introspection build ✓ brainstorm ▸ draft ○ review · 01:35",
    );
    // Another session in the same process keeps nothing of this one.
    const fresh = f.ctx();
    f.progress.resume(fresh as any);
    expect(statuses.at(-1)).toBeUndefined();
    handlers.get("tool_result")!({ toolName: "bash", input: {} }, fresh);
    expect(statuses.at(-1)).toBeUndefined();
  });

  describe("with declared phases", () => {
    const phased = {
      names: [
        "build-brainstorm",
        "build-draft",
        "build-review",
        "build-deploy",
        "improve-collect",
        "improve-classify",
        "improve-propose",
        "eval-run",
        "research",
      ],
      phases: ["build", "improve"],
    };
    /** A footer whose agent has started working and has read `reads`, in order. */
    const working = (...reads: string[]) => {
      const f = harness(phased);
      const ctx = f.ctx();
      f.progress.resume(ctx as any);
      f.handlers.get("agent_start")!({}, ctx);
      const result = (event: unknown) =>
        f.handlers.get("tool_result")!(event, ctx);
      const read = (name: string) =>
        result({ toolName: "read", input: { path: `/x/skills/${name}/SKILL.md` } });
      reads.forEach(read);
      return { ...f, ctx, read, result };
    };

    it("moves to the phase of the step it last read", () => {
      const f = working("build-draft");
      expect(f.statuses.at(-1)).toBe(
        "⧈ Introspection build ✓ brainstorm ▸ draft ○ review ○ deploy · 00:00",
      );
      f.read("improve-classify");
      f.at(65_000);
      expect(f.statuses.at(-1)).toBe(
        "⧈ Introspection improve ✓ collect ▸ classify ○ propose · 01:05",
      );
    });

    it("shows a helper after the current step until the next step is read", () => {
      const f = working("build-draft", "eval-run");
      f.at(12 * 60_000 + 4_000);
      expect(f.statuses.at(-1)).toBe(
        "⧈ Introspection build ✓ brainstorm ▸ draft · eval run ○ review ○ deploy · 12:04",
      );
      f.read("research");
      expect(f.statuses.at(-1)).toBe(
        "⧈ Introspection build ✓ brainstorm ▸ draft · research ○ review ○ deploy · 12:04",
      );
      // A glance at a helper's top doesn't count.
      f.result({
        toolName: "bash",
        input: { command: "head -20 /x/skills/eval-run/SKILL.md" },
      });
      f.result({
        toolName: "read",
        input: { path: "/x/skills/eval-run/SKILL.md", limit: 30 },
      });
      expect(f.statuses.at(-1)).toContain("· research ○ review");
      f.read("build-review");
      expect(f.statuses.at(-1)).toBe(
        "⧈ Introspection build ✓ brainstorm ✓ draft ▸ review ○ deploy · 12:04",
      );
    });

    it("pauses with the helper shown", () => {
      const f = working("build-draft", "eval-run");
      f.at(30_000);
      f.handlers.get("tool_execution_start")!(
        { toolName: "ask_user_question", args: {} },
        f.ctx,
      );
      f.at(10 * 60_000);
      expect(f.statuses.at(-1)).toBe(
        "⧈ Introspection build ✓ brainstorm ⏸ draft · eval run ○ review ○ deploy · 00:30",
      );
    });

    it("restores phase, step and helper on resume", () => {
      const call = (path: string) => ({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "read",
              arguments: { path: `/x/skills/${path}/SKILL.md` },
            },
          ],
        },
      });
      const entries = [
        call("build-draft"),
        call("eval-run"),
        call("improve-collect"),
        call("research"),
      ];
      expect(lastPosition(entries, phased)).toEqual({
        step: "improve-collect",
        helper: "research",
      });
      const f = harness(phased);
      f.progress.resume(f.ctx(entries) as any);
      expect(f.statuses.at(-1)).toBe(
        "⧈ Introspection improve ⏸ collect · research ○ classify ○ propose · 00:00",
      );
    });

    it("never lets a helper change the phase, and shows one read before any step by its name", () => {
      expect(advance({ step: "improve-collect" }, "eval-run", phased)).toEqual({
        step: "improve-collect",
        helper: "eval-run",
      });
      expect(
        advance({ step: "build-draft", helper: "eval-run" }, "improve-collect", phased),
      ).toEqual({ step: "improve-collect" });
      expect(positionLine({ helper: "eval-run" }, phased, "00:05")).toBe(
        "▸ eval run · 00:05",
      );
      // A declared phase with a single step is still a phase.
      expect(
        positionLine({ step: "ship-it" }, { names: ["ship-it"], phases: ["ship"] }, "00:01"),
      ).toBe("ship ▸ it · 00:01");
    });

    it("leaves an agent without phases as it was", () => {
      const plain = { names: phased.names };
      expect(advance({ step: "build-draft" }, "build-review", plain)).toEqual({
        step: "build-review",
      });
      expect(skillRead("/x/skills/eval-run/SKILL.md", plain)).toBeUndefined();
      expect(skillRead("/x/skills/improve-collect/SKILL.md", plain)).toBeUndefined();
      expect(positionLine({ step: "build-draft" }, plain, "12:04")).toBe(
        "build ✓ brainstorm ▸ draft ○ review ○ deploy · 12:04",
      );
      expect(positionLine({ step: "build-draft" }, { ...plain, phases: [] }, "12:04")).toBe(
        "build ✓ brainstorm ▸ draft ○ review ○ deploy · 12:04",
      );
    });
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
