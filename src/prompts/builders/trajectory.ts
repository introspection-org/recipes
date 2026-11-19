import {
  canonical,
  validateJudgeInput,
  type JudgeInput,
} from "../../judges/trajectory.js";
import { buildPrompt, type PromptBuilder } from "../builder.js";
import { fitStepName, type FitSteps } from "../fit.js";
import { prefix, suffix } from "../text.js";

/** What an LLM judge reads: about 200k tokens, as UTF-16 units. */
export const TRANSCRIPT_BUDGET_UNITS = 800_000;
/** What a classifier judge reads: decision models take far less than a chat model. */
export const CLASSIFIER_BUDGET_UNITS = 75_000;
/** A tool argument or result longer than this is clipped by `clip_tool_values`. */
const CLIP_VALUE_UNITS = 2_000;

export const TRAJECTORY_TEMPLATE =
  "TRAJECTORY\n{{ transcript }}\n\nSYSTEM INSTRUCTIONS\n{{ system_instructions }}";

/** An LLM judge reads the whole trajectory; what does not fit loses its middle. */
export const LLM_JUDGE_FIT: FitSteps = { last_resort: "middle_cut" };
/**
 * A classifier reads Jev's slim first, the one measured for a yes/no gate: a
 * long tool result keeps its head and tail unless it carries an error signal,
 * so a small budget goes on the conversation without hiding a failure.
 */
export const CLASSIFIER_FIT: FitSteps = {
  always: ["slim_tool_results"],
  last_resort: "middle_cut",
};

/** A result with one of these is kept whole by `slim_tool_results`. */
const ERROR_SIGNAL =
  /error|failed|exception|invalid|denied|not found|timed out/i;

/**
 * Jev's slim of one tool result (apps/runtime-operator/eval/slimming.py): kept
 * whole when it is short or carries an error signal, else its first `head`
 * and last `tail` units around a marker.
 */
function slimResult(
  value: unknown,
  keepUnder: number,
  head: number,
  tail: number,
): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (
    text === undefined ||
    text.length <= keepUnder ||
    ERROR_SIGNAL.test(text)
  ) {
    return value;
  }
  return `${prefix(text, head)} […] ${suffix(text, tail)}`;
}

function clipValue(value: unknown, units: number): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined || text.length <= units) return value;
  return `${prefix(text, units)}… [clipped]`;
}

/** A judge's evidence as the trajectory JSON and the system instructions it ran under. */
export const trajectoryBuilder: PromptBuilder<JudgeInput> = {
  name: "trajectory",
  version: 1,
  defaultTemplate: TRAJECTORY_TEMPLATE,
  defaultFit: LLM_JUDGE_FIT,
  steps: new Set(["clip_tool_values", "slim_tool_results"]),
  build(input, steps) {
    validateJudgeInput(input);
    const applied: string[] = [];
    let trajectory = input.trajectory;
    for (const step of steps) {
      const [name, params] = fitStepName(step);
      const number = (key: string, fallback: number): number =>
        typeof params[key] === "number" ? (params[key] as number) : fallback;
      if (name === "slim_tool_results") {
        const keepUnder = number("keep_under", 400);
        const head = number("head", 150);
        const tail = number("tail", 150);
        trajectory = trajectory.map((event) =>
          event.type === "tool_result" && event.content !== undefined
            ? {
                ...event,
                content: slimResult(event.content, keepUnder, head, tail),
              }
            : event,
        );
        applied.push(name);
        continue;
      }
      if (name !== "clip_tool_values") continue;
      const units =
        typeof params.max_units === "number"
          ? params.max_units
          : CLIP_VALUE_UNITS;
      trajectory = trajectory.map((event) =>
        event.type === "tool_call" && event.arguments
          ? {
              ...event,
              arguments: clipValue(event.arguments, units) as Record<
                string,
                unknown
              >,
            }
          : event.type === "tool_result" && event.content !== undefined
            ? { ...event, content: clipValue(event.content, units) }
            : event,
      );
      applied.push(name);
    }
    return {
      slots: {
        transcript: JSON.stringify(canonical(trajectory), null, 2),
        system_instructions: input.system_instructions?.trim()
          ? input.system_instructions
          : "",
      },
      applied,
    };
  },
};

/**
 * The transcript a judge reads. `slim` clips long tool arguments and results
 * first, so a small budget is spent on the conversation rather than on one
 * tool's output; what still does not fit loses its middle.
 */
export function renderTrajectoryInput(
  input: JudgeInput,
  options: { maxUnits?: number; slim?: boolean } = {},
): string {
  return buildPrompt(trajectoryBuilder, input, {
    budget: { maxUnits: options.maxUnits ?? TRANSCRIPT_BUDGET_UNITS },
    fit: options.slim ? CLASSIFIER_FIT : LLM_JUDGE_FIT,
  }).prompt;
}
