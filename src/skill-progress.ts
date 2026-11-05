/**
 * Where a Recipe agent is, while it works: Pi's working line reads
 * `build ▰▰▱ 2/3 draft · next review (12m) › introspection tasks prompt runs/C1-1`
 * in place of "Working", and the terminal title names the folder and the step.
 * The time is how long the step has run; no estimate of what's left is given,
 * since steps vary too much for one to be honest.
 *
 * Nothing is declared for it. The step is the agent's skill it last read: a
 * skill named `<phase>-<step>` (the Operator's `build-draft`) shows as
 * `build › draft`, any other by its name. The last part is the tool call in
 * progress: a bash command, shortened, or the tool's name. On resume the step
 * is recovered from the session's earlier reads.
 */

import { basename } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The longest a command shows in the working line. */
export const ACTIVITY_MAX_CHARS = 60;

/** The agent's skill whose `SKILL.md` a tool call's path or command reads, if any. */
export function skillRead(text: unknown, skills: readonly string[]): string | undefined {
  if (typeof text !== "string") return undefined;
  for (const match of text.matchAll(/([A-Za-z0-9_-]+)\/SKILL\.md\b/g)) {
    if (skills.includes(match[1]!)) return match[1];
  }
  return undefined;
}

/**
 * `build ▰▰▱ 2/3 draft · next review` for a `<phase>-<step>` skill the agent
 * lists with others of its phase: a bar of the phase's steps in the agent's
 * order, done and current filled. Any other skill shows by its name.
 */
export function stepCrumb(skill: string, skills: readonly string[]): string {
  const dash = skill.indexOf("-");
  if (dash <= 0) return skill;
  const phase = skill.slice(0, dash);
  const steps = skills.filter((name) => name.startsWith(`${phase}-`));
  const at = steps.indexOf(skill);
  if (steps.length < 2 || at < 0) return skill;
  const bar = steps.map((_, index) => (index <= at ? "▰" : "▱")).join("");
  const next = steps[at + 1]?.slice(phase.length + 1);
  return `${phase} ${bar} ${at + 1}/${steps.length} ${skill.slice(dash + 1)}${next ? ` · next ${next}` : ""}`;
}

/** How long a step has run, as the working line shows it: `45s`, `12m`, `1h 5m`. */
export function elapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** What a tool call is doing, in a few words: a bash command's first line without a leading `cd …&&`, else the tool's name. */
export function activity(toolName: string, args: unknown): string {
  const input = (args ?? {}) as Record<string, unknown>;
  if (toolName === "bash" && typeof input.command === "string") {
    const command = input.command
      .split("\n")[0]!
      .replace(/^\s*cd\s+[^&;]+(&&|;)\s*/, "")
      .trim();
    return command.length > ACTIVITY_MAX_CHARS ? `${command.slice(0, ACTIVITY_MAX_CHARS - 1)}…` : command;
  }
  if (toolName === "ask_user_question" || toolName === "review_artifacts") return "waiting for you";
  return toolName;
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
 * Keep the working line and the terminal title on the agent's step.
 * `skillsFor` gives the active agent's skills in their listed order, or
 * undefined outside a Recipe session. Returns `resume`, for the host's own
 * session-start handler to call, so a resumed session shows its step at once.
 */
export function registerSkillProgress(
  pi: ExtensionAPI,
  skillsFor: (ctx: ExtensionContext) => readonly string[] | undefined,
  now: () => number = Date.now
): { resume(ctx: ExtensionContext): void } {
  let crumb: string | undefined;
  let since = 0;
  const show = (ctx: ExtensionContext, text: string | undefined) => {
    if (!ctx.hasUI || !crumb) return;
    const line = `${crumb} (${elapsed(now() - since)})`;
    ctx.ui.setWorkingMessage(text ? `${line} › ${text}` : line);
  };
  const setStep = (ctx: ExtensionContext, skill: string | undefined, skills: readonly string[]) => {
    if (!skill || !ctx.hasUI) return;
    const next = stepCrumb(skill, skills);
    if (next === crumb) return;
    crumb = next;
    since = now();
    ctx.ui.setTitle(`${basename(ctx.cwd)} · ${crumb}`);
    show(ctx, undefined);
  };
  pi.on("tool_execution_start", (event, ctx) => {
    if (!skillsFor(ctx)?.length) return;
    show(ctx, activity(event.toolName, event.args));
  });
  pi.on("tool_result", (event, ctx) => {
    const skills = skillsFor(ctx);
    if (!skills?.length) return;
    const input = (event.input ?? {}) as Record<string, unknown>;
    setStep(ctx, skillRead(input.path, skills) ?? skillRead(input.command, skills), skills);
    show(ctx, undefined);
  });
  return {
    resume(ctx) {
      const skills = skillsFor(ctx);
      if (!skills?.length) return;
      setStep(ctx, lastSkillRead(ctx.sessionManager?.getEntries?.() ?? [], skills), skills);
    },
  };
}
