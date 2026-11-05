/**
 * Where a Recipe agent is, in Pi's footer:
 * `⧈ Introspection build ✓ brainstorm ▸ draft ○ review · 12:04`. Pi's own
 * "Working" line and the terminal title are left as they are. The clock is the
 * agent's working time from the start of the session, across every step, paused
 * while the person is in the loop, when the current step shows ⏸ in place of ▸; no estimate of what's left is given, since
 * steps vary too much for one to be honest.
 *
 * Nothing is declared for it. The step is the agent's skill it last read: a
 * skill named `<phase>-<step>` (the Operator's `build-draft`) shows its phase's
 * steps in the agent's order, any other by its name. On resume the step is
 * recovered from the session's earlier reads.
 */

import { basename, dirname } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { skillName } from "./recipe/skills.js";

/** Introspection's mark (two concentric squares) and name, at the front of the footer line. */
export const BRAND = "⧈ Introspection";

/** The current step's mark while the clock is paused for the person, in place of ▸. */
export const PAUSED_MARK = "⏸";

/** Tools that wait for the person: the step's clock stops while one is open. */
export const PERSON_IN_THE_LOOP = new Set([
  "ask_user_question",
  "review_artifacts",
]);

/** Tools that read a skill; a write or edit of a `SKILL.md` isn't a step. */
export const SKILL_READ_TOOLS = new Set(["read", "bash"]);

/** The footer status the step shows under. */
export const STEP_STATUS_KEY = "recipe-step";

/** Lines a read must cover to count as reading a skill; fewer is a glance at it, not the step. */
export const SKILL_READ_MIN_LINES = 100;

/** Whether a tool call's input reads a whole file rather than glancing at its top. */
export function readsWhole(input: Record<string, unknown>): boolean {
  if (typeof input.limit === "number" && input.limit < SKILL_READ_MIN_LINES)
    return false;
  if (
    typeof input.command === "string" &&
    /\b(head|sed\s+-n)\b/.test(input.command)
  )
    return false;
  return true;
}

/**
 * The skills that are the agent's steps: those of the phase its first skill
 * belongs to (`build-*` for an agent listing `build-brainstorm` first). Others
 * it lists (`eval-case`, read while writing cases) are consulted, not stepped
 * into, so they don't move the footer. An agent whose first skill has no phase
 * steps through all of them.
 */
export function stepSkills(skills: readonly string[]): readonly string[] {
  const first = skills[0];
  const dash = first ? first.indexOf("-") : -1;
  if (!first || dash <= 0) return skills;
  const phase = first.slice(0, dash + 1);
  const steps = skills.filter((name) => name.startsWith(phase));
  return steps.length > 1 ? steps : skills;
}

/** The agent's skills in their listed order, and the name of each by its folder where the two differ. */
export type RecipeSkills = {
  names: readonly string[];
  folders?: ReadonlyMap<string, string>;
};

/** Each skill's name by its folder, for the skills whose `name` isn't their folder's. */
export function skillFolders(
  skillPaths: readonly string[],
  recipeDir: string,
): Map<string, string> {
  const folders = new Map<string, string>();
  for (const path of skillPaths) {
    const folder = basename(dirname(path));
    const name = skillName(path, recipeDir);
    if (name !== folder) folders.set(folder, name);
  }
  return folders;
}

/** The agent's step whose `SKILL.md` a tool call's path or command reads, if any. */
export function skillRead(
  text: unknown,
  skills: RecipeSkills,
): string | undefined {
  if (typeof text !== "string") return undefined;
  const steps = stepSkills(skills.names);
  for (const match of text.matchAll(/([A-Za-z0-9_-]+)\/SKILL\.md\b/g)) {
    const name = skills.folders?.get(match[1]!) ?? match[1]!;
    if (steps.includes(name)) return name;
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
 * the phase's steps in the agent's order (done ticked,
 * the current one marked, the rest to come), then how long the current one has
 * run. Any other skill shows by its name.
 */
export function stepLine(
  skill: string,
  skills: readonly string[],
  clock: string,
  paused = false,
): string {
  const found = phaseOf(skill, skills);
  const mark = paused ? PAUSED_MARK : "▸";
  if (!found) return `${mark} ${skill} · ${clock}`;
  const done = found.steps
    .slice(0, found.at)
    .map((step) => `✓ ${step}`)
    .join(" ");
  const rest = found.steps
    .slice(found.at + 1)
    .map((step) => `○ ${step}`)
    .join(" ");
  const line = [done, `${mark} ${found.steps[found.at]}`, rest]
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

type Entry = {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    isError?: boolean;
  };
};

/** The last of the agent's skills the session read, from its entries; a read that failed doesn't count. */
export function lastSkillRead(
  entries: readonly unknown[],
  skills: RecipeSkills,
): string | undefined {
  const failed = new Set(
    (entries as Entry[])
      .filter(
        (entry) =>
          entry.message?.role === "toolResult" && entry.message.isError,
      )
      .map((entry) => entry.message!.toolCallId),
  );
  let last: string | undefined;
  for (const entry of entries as Entry[]) {
    if (entry.type !== "message" || entry.message?.role !== "assistant")
      continue;
    const content = Array.isArray(entry.message.content)
      ? entry.message.content
      : [];
    for (const block of content as Array<{
      type?: string;
      id?: string;
      name?: string;
      arguments?: Record<string, unknown>;
    }>) {
      if (
        block.type !== "toolCall" ||
        !SKILL_READ_TOOLS.has(block.name ?? "") ||
        failed.has(block.id) ||
        !readsWhole(block.arguments ?? {})
      )
        continue;
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
  skillsFor: (ctx: ExtensionContext) => RecipeSkills | undefined,
  now: () => number = Date.now,
  /** Calls `tick` every second until the returned stop is called; injected by tests. */
  every: (tick: () => void) => () => void = (tick) => {
    const timer = setInterval(tick, 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  },
): { resume(ctx: ExtensionContext): void } {
  let current: { skill: string; skills: readonly string[] } | undefined;
  // The agent's working time this session, across every step: what's banked, plus the run in
  // progress. It pauses while the person is in the loop (the agent's turn has ended, or a question
  // or review is open).
  // Paused until the agent's first turn starts: time before the first prompt isn't the agent's.
  let banked = 0;
  let runningSince: number | undefined;
  const worked = () =>
    banked + (runningSince === undefined ? 0 : now() - runningSince);
  const pause = () => {
    if (runningSince === undefined) return;
    banked += now() - runningSince;
    runningSince = undefined;
  };
  const run = () => {
    runningSince ??= now();
  };
  // Redrawn every second, so the clock runs during a long call.
  let shown: ExtensionContext | undefined;
  let stop: (() => void) | undefined;
  const show = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || !current) return;
    shown = ctx;
    ctx.ui.setStatus(
      STEP_STATUS_KEY,
      `${BRAND} ${stepLine(current.skill, current.skills, elapsed(worked()), runningSince === undefined)}`,
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
    show(ctx);
  };
  pi.on("agent_start", (_event, ctx) => {
    run();
    show(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    pause();
    show(ctx);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (!PERSON_IN_THE_LOOP.has(event.toolName)) return;
    pause();
    show(ctx);
  });
  pi.on("tool_result", (event, ctx) => {
    const skills = skillsFor(ctx);
    if (!skills?.names.length) return;
    if (PERSON_IN_THE_LOOP.has(event.toolName)) run();
    const input = (event.input ?? {}) as Record<string, unknown>;
    if (
      !event.isError &&
      SKILL_READ_TOOLS.has(event.toolName) &&
      readsWhole(input)
    ) {
      setStep(
        ctx,
        skillRead(input.path, skills) ?? skillRead(input.command, skills),
        skills.names,
      );
    }
    show(ctx);
  });
  return {
    resume(ctx) {
      // Another session in the same process starts from nothing: no step, no time.
      if (current && ctx.hasUI) ctx.ui.setStatus(STEP_STATUS_KEY, undefined);
      current = undefined;
      banked = 0;
      runningSince = undefined;
      const skills = skillsFor(ctx);
      if (!skills?.names.length) return;
      setStep(
        ctx,
        lastSkillRead(ctx.sessionManager?.getEntries?.() ?? [], skills),
        skills.names,
      );
    },
  };
}
