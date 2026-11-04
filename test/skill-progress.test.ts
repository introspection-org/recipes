import { describe, expect, it } from "vitest";

import {
  lastSkillRead,
  progressLine,
  registerSkillProgress,
  skillRead,
  SKILL_PROGRESS_STATUS_KEY,
} from "../src/skill-progress.js";

const skills = ["build-brainstorm", "build-draft", "build-review", "eval-case", "eval-run"];

describe("skill progress", () => {
  it("finds the agent's skill a path or command reads", () => {
    expect(skillRead("/x/skills/build-draft/SKILL.md", skills)).toBe("build-draft");
    expect(skillRead("cat /x/skills/build-review/SKILL.md && ls", skills)).toBe("build-review");
    expect(skillRead("/x/skills/other/SKILL.md", skills)).toBeUndefined();
    expect(skillRead("/x/skills/build-draft/references/evals.md", skills)).toBeUndefined();
    expect(skillRead(undefined, skills)).toBeUndefined();
  });

  it("shows a phase's steps in the agent's order, or the skill alone", () => {
    expect(progressLine("build-draft", skills)).toBe("build · ✓ brainstorm  ▸ draft  ○ review");
    expect(progressLine("eval-run", skills)).toBe("eval · ✓ case  ▸ run");
    expect(progressLine("research", ["research"])).toBe("▸ research");
  });

  it("recovers the last step from the session", () => {
    const call = (args: Record<string, unknown>) => ({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", arguments: args }] },
    });
    const entries = [
      call({ path: "/x/skills/build-brainstorm/SKILL.md" }),
      call({ command: "cat /x/skills/build-draft/SKILL.md" }),
      call({ path: "/x/skills/build-draft/references/evals.md" }),
    ];
    expect(lastSkillRead(entries, skills)).toBe("build-draft");
  });

  it("sets the footer when the agent loads a step, and on resume", () => {
    const handlers = new Map<string, (event: any, ctx: any) => void>();
    const pi = { on: (name: string, handler: any) => handlers.set(name, handler) } as any;
    const progress = registerSkillProgress(pi, () => skills);
    const statuses: Array<[string, string | undefined]> = [];
    const ctx = {
      hasUI: true,
      ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) },
      sessionManager: {
        getEntries: () => [
          { type: "message", message: { role: "assistant", content: [{ type: "toolCall", arguments: { path: "s/build-brainstorm/SKILL.md" } }] } },
        ],
      },
    };
    progress.resume(ctx as any);
    handlers.get("tool_result")!({ input: { command: "cat s/build-review/SKILL.md" } }, ctx);
    handlers.get("tool_result")!({ input: { path: "s/build-review/references/x.md" } }, ctx);
    expect(statuses).toEqual([
      [SKILL_PROGRESS_STATUS_KEY, "build · ▸ brainstorm  ○ draft  ○ review"],
      [SKILL_PROGRESS_STATUS_KEY, "build · ✓ brainstorm  ✓ draft  ▸ review"],
    ]);
  });
});
