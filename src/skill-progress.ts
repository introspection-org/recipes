/**
 * Where a Recipe agent is, in Pi's footer:
 * `⧈ Introspection build ✓ brainstorm ▸ draft ○ review · 12:04`. Pi's own
 * "Working" line and the terminal title are left as they are. The clock is how
 * long the current step has run; no estimate of what's left is given, since
 * steps vary too much for one to be honest.
 *
 * Nothing is declared for it. The step is the agent's skill it last read: a
 * skill named `<phase>-<step>` (the Operator's `build-draft`) shows its phase's
 * steps in the agent's order, any other by its name. On resume the step is
 * recovered from the session's earlier reads.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Introspection's mark (two concentric squares) and name, at the front of the footer line. */
export const BRAND = "⧈ Introspection";

/** The footer status the step shows under. */
export const STEP_STATUS_KEY = "recipe-step";

/** The agent's skill whose `SKILL.md` a tool call's path or command reads, if any. */
export function skillRead(
  text: unknown,
  skills: readonly string[],
): string | undefined {
  if (typeof text !== "string") return undefined;
  for (const match of text.matchAll(/([A-Za-z0-9_-]+)\/SKILL\.md\b/g)) {
    if (skills.includes(match[1]!)) return match[1];
  }
  return undefined;
}

/** A skill's phase and its steps in the agent's order, or undefined when it isn't one of several `<phase>-<step>` skills. */
function phaseOf(
  skill: string,
  skills: readonly string[],
): { phase: string; steps: string[]; at: number } | undefined {
  const dash = skill.indexOf("-");
  if (dash <= 0) return undefined;
  const phase = skill.slice(0, dash);
  const steps = skills
    .filter((name) => name.startsWith(`${phase}-`))
    .map((name) => name.slice(phase.length + 1));
  const at = steps.indexOf(skill.slice(dash + 1));
  return steps.length < 2 || at < 0 ? undefined : { phase, steps, at };
}

/**
 * The footer's line for a step: `build ✓ brainstorm ▸ draft ○ review · 12:04`,
 * the phase's steps in the agent's order (done ticked and joined by arrows,
 * the current one marked, the rest to come), then how long the current one has
 * run. Any other skill shows by its name.
 */
export function stepLine(
  skill: string,
  skills: readonly string[],
  clock: string,
): string {
  const found = phaseOf(skill, skills);
  if (!found) return `${skill} · ${clock}`;
  const done = found.steps
    .slice(0, found.at)
    .map((step) => `✓ ${step}`)
    .join(" → ");
  const rest = found.steps
    .slice(found.at + 1)
    .map((step) => `○ ${step}`)
    .join(" ");
  const line = [done, `▸ ${found.steps[found.at]}`, rest]
    .filter(Boolean)
    .join(" ");
  return `${found.phase} ${line} · ${clock}`;
}

/** How long a step has run, as a clock: `00:17`, `03:42`, `1:05:09`. */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  const [hours, minutes, seconds] = [
    Math.floor(total / 3600),
    Math.floor((total % 3600) / 60),
    total % 60,
  ];
  return hours > 0
    ? `${hours}:${two(minutes)}:${two(seconds)}`
    : `${two(minutes)}:${two(seconds)}`;
}

type Entry = { type?: string; message?: { role?: string; content?: unknown } };

/** The last of the agent's skills the session read, from its entries. */
export function lastSkillRead(
  entries: readonly unknown[],
  skills: readonly string[],
): string | undefined {
  let last: string | undefined;
  for (const entry of entries as Entry[]) {
    if (entry.type !== "message" || entry.message?.role !== "assistant")
      continue;
    const content = Array.isArray(entry.message.content)
      ? entry.message.content
      : [];
    for (const block of content as Array<{
      type?: string;
      arguments?: Record<string, unknown>;
    }>) {
      if (block.type !== "toolCall") continue;
      last =
        skillRead(block.arguments?.path, skills) ??
        skillRead(block.arguments?.command, skills) ??
        last;
    }
  }
  return last;
}

/**
 * Keep the footer on the agent's step, with its clock running.
 * `skillsFor` gives the active agent's skills in their listed order, or
 * undefined outside a Recipe session. Returns `resume`, for the host's own
 * session-start handler to call, so a resumed session shows its step at once.
 */
export function registerSkillProgress(
  pi: ExtensionAPI,
  skillsFor: (ctx: ExtensionContext) => readonly string[] | undefined,
  now: () => number = Date.now,
  /** Calls `tick` every second until the returned stop is called; injected by tests. */
  every: (tick: () => void) => () => void = (tick) => {
    const timer = setInterval(tick, 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  },
): { resume(ctx: ExtensionContext): void } {
  let current: { skill: string; skills: readonly string[] } | undefined;
  let since = 0;
  // Redrawn every second, so the clock runs during a long call.
  let shown: ExtensionContext | undefined;
  let stop: (() => void) | undefined;
  const show = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || !current) return;
    shown = ctx;
    ctx.ui.setStatus(
      STEP_STATUS_KEY,
      `${BRAND} ${stepLine(current.skill, current.skills, elapsed(now() - since))}`,
    );
    stop ??= every(() => {
      if (shown) show(shown);
    });
  };
  pi.on("session_shutdown", () => {
    stop?.();
    stop = undefined;
    shown = undefined;
  });
  const setStep = (
    ctx: ExtensionContext,
    skill: string | undefined,
    skills: readonly string[],
  ) => {
    if (!skill || !ctx.hasUI) return;
    if (current?.skill === skill) return;
    current = { skill, skills };
    since = now();
    show(ctx);
  };
  pi.on("tool_result", (event, ctx) => {
    const skills = skillsFor(ctx);
    if (!skills?.length) return;
    const input = (event.input ?? {}) as Record<string, unknown>;
    setStep(
      ctx,
      skillRead(input.path, skills) ?? skillRead(input.command, skills),
      skills,
    );
    show(ctx);
  });
  return {
    resume(ctx) {
      const skills = skillsFor(ctx);
      if (!skills?.length) return;
      setStep(
        ctx,
        lastSkillRead(ctx.sessionManager?.getEntries?.() ?? [], skills),
        skills,
      );
    },
  };
}
