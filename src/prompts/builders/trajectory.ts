import {
  canonical,
  validateJudgeInput,
  type JudgeInput,
} from "../../judges/trajectory.js";
import {
  numberOption,
  withinBudget,
  type BuilderOptions,
  type PromptBuilder,
} from "../builder.js";
import { renderTemplate } from "../template.js";
import { prefix, suffix } from "../text.js";

/** What a classifier judge reads at most: Jev's slim was measured at 75k characters. */
export const CLASSIFIER_BUDGET_TOKENS = 25_000;

const TRAJECTORY_TEMPLATE =
  "TRAJECTORY\n{{ transcript }}\n\nSYSTEM INSTRUCTIONS\n{{ system_instructions }}";

/** A result with one of these is kept whole by Jev's slim. */
const ERROR_SIGNAL =
  /error|failed|exception|invalid|denied|not found|timed out/i;

function render(input: JudgeInput, trajectory: JudgeInput["trajectory"]) {
  return renderTemplate(TRAJECTORY_TEMPLATE, {
    transcript: JSON.stringify(canonical(trajectory), null, 2),
    system_instructions: input.system_instructions?.trim()
      ? input.system_instructions
      : "",
  });
}

/**
 * Jev's slim of one tool result, as the slimming study measured it: kept
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

/** An LLM judge reads the whole trajectory and the system instructions it ran under. */
export const trajectoryLlmJudge: PromptBuilder<JudgeInput> = {
  name: "trajectory_llm_judge",
  version: 1,
  build(input, maxTokens) {
    validateJudgeInput(input);
    return withinBudget(render(input, input.trajectory), maxTokens);
  },
};

/**
 * A classifier judge reads Jev's slim, the one measured for a yes/no gate: a
 * long tool result keeps its head and tail unless it carries an error
 * signal, so a small budget goes on the conversation without hiding a
 * failure. Options: `keep_under` (400), `head` (150), `tail` (150).
 */
export const trajectoryLlmClassify: PromptBuilder<JudgeInput> = {
  name: "trajectory_llm_classify",
  version: 1,
  build(input, maxTokens, options?: BuilderOptions) {
    validateJudgeInput(input);
    const keepUnder = numberOption(options, "keep_under", 400);
    const head = numberOption(options, "head", 150);
    const tail = numberOption(options, "tail", 150);
    const trajectory = input.trajectory.map((event) =>
      event.type === "tool_result" && event.content !== undefined
        ? {
            ...event,
            content: slimResult(event.content, keepUnder, head, tail),
          }
        : event,
    );
    return withinBudget(render(input, trajectory), maxTokens, [
      "slim_tool_results",
    ]);
  },
};
