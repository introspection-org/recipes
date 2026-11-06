/**
 * Where a Recipe agent is, in Pi's footer:
 * `⧈ Introspection build ✓ brainstorm ▸ draft ○ review · 12:04`. Pi's own
 * "Working" line and the terminal title are left as they are. The clock is the
 * agent's working time from the start of the session, across every step, paused
 * while the person is in the loop, when the current step shows ⏸ in place of ▸; no estimate of what's left is given, since
 * steps vary too much for one to be honest.
 *
 * Nothing need be declared for it. The step is the agent's skill it last read: a
 * skill named `<phase>-<step>` (the Operator's `build-draft`) shows its phase's
 * steps in the agent's order, any other by its name. An agent that declares
 * `phases: [build, improve]` moves between them: the phase is that of the last
 * step it read, and any other of its skills is a helper, shown after the
 * current step until it next reads a step:
 * `build ✓ brainstorm ▸ draft · eval run ○ review · 12:04`. On resume the step
 * is recovered from the session's earlier reads.
 */

import { basename, dirname } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import { skillName } from "./recipe/skills.js";

/** Introspection's mark (two concentric squares) and name, at the front of the footer line. */
const BRAND = "⧈ Introspection";

/** The current step's mark while the clock is paused for the person, in place of ▸. */
const PAUSED_MARK = "⏸";

/** Tools that wait for the person: the step's clock stops while one is open. */
const PERSON_IN_THE_LOOP = new Set([
  "ask_user_question",
  "review_artifacts",
  "introspection_open",
]);

/** Tools that read a skill; a write or edit of a `SKILL.md` isn't a step. */
const SKILL_READ_TOOLS = new Set(["read", "bash"]);

/** The footer status the step shows under. */
const STEP_STATUS_KEY = "recipe-step";

/** Lines a read must cover to count as reading a skill; fewer is a glance at it, not the step. */
const SKILL_READ_MIN_LINES = 100;

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

/**
 * The agent's skills in their listed order, the name of each by its folder
 * where the two differ, and the phases its agent file declares, if any.
 */
export type RecipeSkills = {
  names: readonly string[];
  folders?: ReadonlyMap<string, string>;
  phases?: readonly string[];
};

/** Where the agent is: the step it last read and, with declared phases, the helper it read since. */
export type Position = { step?: string; helper?: string };

/** The declared phase a skill is a step of (`improve` for `improve-classify`), if any; the longest prefix wins. */
function declaredPhase(
  skill: string,
  phases: readonly string[],
): string | undefined {
  return phases
    .filter((phase) => skill.startsWith(`${phase}-`))
    .sort((a, b) => b.length - a.length)[0];
}

/** Where the agent is after reading `skill`: a step of a declared phase moves the step and clears the helper; any other skill is a helper, and the step stays. */
export function advance(
  at: Position,
  skill: string,
  skills: RecipeSkills,
): Position {
  if (!skills.phases?.length) return { step: skill };
  return declaredPhase(skill, skills.phases)
    ? { step: skill }
    : { ...at, helper: skill };
}

/** A helper as the footer shows it: `eval-run` as `eval run`, a name without a dash as it is. */
function helperLabel(skill: string): string {
  const dash = skill.indexOf("-");
  return dash <= 0 ? skill : `${skill.slice(0, dash)} ${skill.slice(dash + 1)}`;
}

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
  // With declared phases every one of the agent's skills counts: steps move the phase, the rest are helpers.
  const steps = skills.phases?.length ? skills.names : stepSkills(skills.names);
  for (const match of text.matchAll(/([A-Za-z0-9_-]+)\/SKILL\.md\b/g)) {
    const name = skills.folders?.get(match[1]!) ?? match[1]!;
    if (steps.includes(name)) return name;
  }
  return undefined;
}

/**
 * A skill's phase and its steps in the agent's order, or undefined when it
 * isn't one of several `<phase>-<step>` skills. A declared phase is a phase
 * even with a single step.
 */
function phaseOf(
  skill: string,
  skills: readonly string[],
  phases?: readonly string[],
): { phase: string; steps: string[]; at: number } | undefined {
  const declared = phases?.length ? declaredPhase(skill, phases) : undefined;
  const dash = declared ? declared.length : skill.indexOf("-");
  if (dash <= 0) return undefined;
  const phase = skill.slice(0, dash);
  const steps = skills
    .filter((name) =>
      phases?.length
        ? declaredPhase(name, phases) === phase
        : name.startsWith(`${phase}-`),
    )
    .map((name) => name.slice(phase.length + 1));
  const at = steps.indexOf(skill.slice(dash + 1));
  return at < 0 || (steps.length < 2 && !declared)
    ? undefined
    : { phase, steps, at };
}

/**
 * The footer's line for a step: `build ✓ brainstorm ▸ draft ○ review · 12:04`,
 * the phase's steps in the agent's order (done ticked,
 * the current one marked, the rest to come), then how long the current one has
 * run. Any other skill shows by its name. With declared phases, a helper the
 * agent read since its step shows right after it:
 * `build ✓ brainstorm ▸ draft · eval run ○ review · 12:04`.
 */
export function stepLine(
  skill: string,
  skills: readonly string[],
  clock: string,
  paused = false,
  { phases, helper }: { phases?: readonly string[]; helper?: string } = {},
): string {
  const found = phaseOf(skill, skills, phases);
  const mark = paused ? PAUSED_MARK : "▸";
  const aside = helper ? ` · ${helperLabel(helper)}` : "";
  if (!found) return `${mark} ${skill}${aside} · ${clock}`;
  const done = found.steps
    .slice(0, found.at)
    .map((step) => `✓ ${step}`)
    .join(" ");
  const rest = found.steps
    .slice(found.at + 1)
    .map((step) => `○ ${step}`)
    .join(" ");
  const line = [done, `${mark} ${found.steps[found.at]}${aside}`, rest]
    .filter(Boolean)
    .join(" ");
  return `${found.phase} ${line} · ${clock}`;
}

/** One of a phase's steps, for a host that draws the line itself. */
export interface RecipeStepItem {
  name: string;
  state: "done" | "current" | "todo";
}

/**
 * Where a Recipe agent is, for a host that draws its own line (a browser): what
 * the footer shows, as data. `steps` is empty for a skill that isn't one of a
 * phase's steps, which a host shows by `skill`; `helper` is a skill read since
 * the step, shown beside it. The clock is `worked_ms` as of this report,
 * running on from it while `paused` is false.
 */
export interface RecipeStep {
  skill?: string;
  phase?: string;
  steps: RecipeStepItem[];
  helper?: string;
  paused: boolean;
  worked_ms: number;
}

/** Where the agent is among its steps, without the clock. */
export function stepState(
  at: Position,
  skills: RecipeSkills,
): Pick<RecipeStep, "skill" | "phase" | "steps" | "helper"> {
  const helper = at.helper ? { helper: helperLabel(at.helper) } : {};
  if (!at.step) return { steps: [], ...helper };
  const found = phaseOf(at.step, skills.names, skills.phases);
  if (!found) return { skill: at.step, steps: [], ...helper };
  return {
    skill: at.step,
    phase: found.phase,
    steps: found.steps.map((name, index) => ({
      name,
      state:
        index < found.at ? "done" : index === found.at ? "current" : "todo",
    })),
    ...helper,
  };
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

/** The footer's line for where the agent is: its step, or a helper read before any step. */
export function positionLine(
  at: Position,
  skills: RecipeSkills,
  clock: string,
  paused = false,
): string {
  const mark = paused ? PAUSED_MARK : "▸";
  if (!at.step) return `${mark} ${helperLabel(at.helper ?? "")} · ${clock}`;
  return stepLine(at.step, skills.names, clock, paused, {
    phases: skills.phases,
    helper: at.helper,
  });
}

/** Where the session's reads of the agent's skills leave it, from its entries; a read that failed doesn't count. */
export function lastPosition(
  entries: readonly unknown[],
  skills: RecipeSkills,
): Position | undefined {
  let at: Position | undefined;
  for (const skill of skillReads(entries, skills)) {
    at = advance(at ?? {}, skill, skills);
  }
  return at;
}

/** The last of the agent's skills the session read, from its entries; a read that failed doesn't count. */
export function lastSkillRead(
  entries: readonly unknown[],
  skills: RecipeSkills,
): string | undefined {
  return skillReads(entries, skills).at(-1);
}

/** The agent's skills the session read, in order. */
function skillReads(
  entries: readonly unknown[],
  skills: RecipeSkills,
): string[] {
  const failed = new Set(
    (entries as Entry[])
      .filter(
        (entry) =>
          entry.message?.role === "toolResult" && entry.message.isError,
      )
      .map((entry) => entry.message!.toolCallId),
  );
  const reads: string[] = [];
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
      const read =
        skillRead(block.arguments?.path, skills) ??
        skillRead(block.arguments?.command, skills);
      if (read) reads.push(read);
    }
  }
  return reads;
}

/**
 * Keep the footer on the agent's step, with its clock running.
 * `skillsFor` gives the active agent's skills in their listed order, or
 * undefined outside a Recipe session. Returns `resume`, for the host's own
 * session-start handler to call, so a resumed session shows its step at once.
 * `report`, when given, receives the step as data whenever it or the clock's
 * running state changes (not every second), with or without a UI, for a host
 * that draws its own line.
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
  report?: (step: RecipeStep) => void,
): { resume(ctx: ExtensionContext): void } {
  let current: { at: Position; skills: RecipeSkills } | undefined;
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
  let reported: string | undefined;
  const tell = () => {
    if (!report || !current) return;
    const paused = runningSince === undefined;
    const key = `${current.at.step}\u0000${current.at.helper}\u0000${paused}`;
    if (key === reported) return;
    reported = key;
    report({
      ...stepState(current.at, current.skills),
      paused,
      worked_ms: worked(),
    });
  };
  const show = (ctx: ExtensionContext) => {
    tell();
    if (!ctx.hasUI || !current) return;
    shown = ctx;
    ctx.ui.setStatus(
      STEP_STATUS_KEY,
      `${BRAND} ${positionLine(current.at, current.skills, elapsed(worked()), runningSince === undefined)}`,
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
  const moveTo = (
    ctx: ExtensionContext,
    at: Position | undefined,
    skills: RecipeSkills,
  ) => {
    if (!at || (!ctx.hasUI && !report)) return;
    if (current?.at.step === at.step && current?.at.helper === at.helper)
      return;
    current = { at, skills };
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
      const read =
        skillRead(input.path, skills) ?? skillRead(input.command, skills);
      if (read) moveTo(ctx, advance(current?.at ?? {}, read, skills), skills);
    }
    show(ctx);
  });
  return {
    resume(ctx) {
      // Another session in the same process starts from nothing: no step, no time.
      if (current && ctx.hasUI) ctx.ui.setStatus(STEP_STATUS_KEY, undefined);
      current = undefined;
      reported = undefined;
      banked = 0;
      runningSince = undefined;
      const skills = skillsFor(ctx);
      if (!skills?.names.length) return;
      moveTo(
        ctx,
        lastPosition(ctx.sessionManager?.getEntries?.() ?? [], skills),
        skills,
      );
    },
  };
}

/**
 * The session API's step reporter: none without a host callback or for an agent
 * with no skills, else one extension reporting the agent's step to `report`.
 */
export function recipeStepExtensions(
  agent: {
    readonly definition: {
      readonly skills: readonly string[];
      readonly phases?: readonly string[];
    };
    readonly skillPaths: readonly string[];
    readonly recipeDir: string;
  },
  report: ((step: RecipeStep) => void) | undefined,
): ExtensionFactory[] {
  if (!report || agent.definition.skills.length === 0) return [];
  const skills: RecipeSkills = {
    names: agent.definition.skills,
    folders: skillFolders(agent.skillPaths, agent.recipeDir),
    ...(agent.definition.phases?.length
      ? { phases: agent.definition.phases }
      : {}),
  };
  return [
    (pi) => {
      const progress = registerSkillProgress(
        pi,
        () => skills,
        undefined,
        undefined,
        report,
      );
      pi.on("session_start", (_event, ctx) => progress.resume(ctx));
    },
  ];
}
