/**
 * The step a Recipe agent is in, in Pi's footer: the skill it last loaded.
 *
 * Nothing is declared for it. When the agent reads one of its skills'
 * `SKILL.md`, the footer names that skill. A skill named `<phase>-<step>`
 * (the Operator's `build-brainstorm`, `build-draft`, `build-review`) shows
 * its phase's steps in the order the agent lists them, done, current and to
 * come. On resume the step is recovered from the session's earlier reads.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SKILL_PROGRESS_STATUS_KEY = "recipe-progress";

/** The agent's skill whose `SKILL.md` a tool call's path or command reads, if any. */
export function skillRead(text: unknown, skills: readonly string[]): string | undefined {
  if (typeof text !== "string") return undefined;
  for (const match of text.matchAll(/([A-Za-z0-9_-]+)\/SKILL\.md\b/g)) {
    if (skills.includes(match[1]!)) return match[1];
  }
  return undefined;
}

/** The footer line for `current`, among the agent's skills in their listed order. */
export function progressLine(current: string, skills: readonly string[]): string {
  const dash = current.indexOf("-");
  if (dash <= 0) return `▸ ${current}`;
  const phase = current.slice(0, dash);
  const steps = skills.filter((skill) => skill.startsWith(`${phase}-`));
  if (steps.length < 2) return `▸ ${current}`;
  const at = steps.indexOf(current);
  const parts = steps.map((skill, index) => {
    const step = skill.slice(phase.length + 1);
    return index < at ? `✓ ${step}` : index === at ? `▸ ${step}` : `○ ${step}`;
  });
  return `${phase} · ${parts.join("  ")}`;
}

type Entry = { type?: string; message?: { role?: string; content?: unknown } };

/** The last of the agent's skills the session read, from its entries. */
export function lastSkillRead(entries: readonly unknown[], skills: readonly string[]): string | undefined {
  let last: string | undefined;
  for (const entry of entries as Entry[]) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const content = Array.isArray(entry.message.content) ? entry.message.content : [];
    for (const block of content as Array<{ type?: string; arguments?: Record<string, unknown> }>) {
      if (block.type !== "toolCall") continue;
      last = skillRead(block.arguments?.path, skills) ?? skillRead(block.arguments?.command, skills) ?? last;
    }
  }
  return last;
}

/**
 * Keep the footer on the agent's current skill. `skillsFor` gives the active
 * agent's skills in their listed order, or undefined outside a Recipe session.
 * Returns `resume`, for the host's own session-start handler to call, so a
 * resumed session shows the step it was in before any tool runs.
 */
export function registerSkillProgress(
  pi: ExtensionAPI,
  skillsFor: (ctx: ExtensionContext) => readonly string[] | undefined
): { resume(ctx: ExtensionContext): void } {
  let shown: string | undefined;
  const show = (ctx: ExtensionContext, skill: string | undefined, skills: readonly string[]) => {
    if (!skill || skill === shown || !ctx.hasUI) return;
    shown = skill;
    ctx.ui.setStatus(SKILL_PROGRESS_STATUS_KEY, progressLine(skill, skills));
  };
  pi.on("tool_result", (event, ctx) => {
    const skills = skillsFor(ctx);
    if (!skills?.length) return;
    const input = (event.input ?? {}) as Record<string, unknown>;
    show(ctx, skillRead(input.path, skills) ?? skillRead(input.command, skills), skills);
  });
  return {
    resume(ctx) {
      if (shown) return;
      const skills = skillsFor(ctx);
      if (!skills?.length) return;
      show(ctx, lastSkillRead(ctx.sessionManager?.getEntries?.() ?? [], skills), skills);
    },
  };
}
