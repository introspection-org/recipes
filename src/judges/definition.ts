import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  parseRecipeAgentAiConfig,
  type RecipeAgentModelConfig,
} from "../recipe/model.js";

/** One yes/no question a classifier judge asks of a conversation. */
export interface JudgeQuestion {
  instructions: string;
  /** What a yes and a no each mean; a decision model needs both spelled out. */
  criteria: { true: string; false: string };
  /** The probability of yes, 0 to 1, this question must reach for the judge to pass. */
  threshold: number;
}

interface JudgeBase {
  name: string;
  description?: string;
  /** The gate: which conversations the judge applies to. Absent means all. */
  on: unknown;
  /** The agent `ai:` block: model, fallbacks, thinking level and options. */
  ai: RecipeAgentModelConfig & { name: string };
  /** The file the judge was read from, relative to the Recipe. */
  path: string;
  /** SHA-256 of the definition file: a changed definition is a different judge. */
  definitionHash: string;
}

/** A judge a chat model answers by reading `instructions`. */
export interface LlmJudgeDefinition extends JudgeBase {
  kind: "llm";
  instructions: string;
}

/** A judge a decision model answers as probabilities of yes to `questions`. */
export interface ClassifierJudgeDefinition extends JudgeBase {
  kind: "classifier";
  questions: Record<string, JudgeQuestion>;
}

export type JudgeDefinition = LlmJudgeDefinition | ClassifierJudgeDefinition;

export class JudgeDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeDefinitionError";
  }
}

const TOP_LEVEL_FIELDS = new Set([
  "ai",
  "description",
  "instructions",
  "judge",
  "name",
  "on",
  "questions",
  "type",
]);
const QUESTION_FIELDS = new Set(["criteria", "instructions", "threshold"]);
const JUDGE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const QUESTION_NAME = /^[a-z][a-z0-9_]*$/;
const GATE_EVENTS = new Set(["message", "tool", "feedback"]);
const MAX_QUESTIONS = 8;
const DEFAULT_THRESHOLD = 0.5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseGate(path: string, on: unknown): unknown {
  if (on === undefined || on === null) return [];
  if (isRecord(on) && Object.keys(on).length === 0) return [];
  if (!Array.isArray(on)) {
    throw new JudgeDefinitionError(
      `${path}: \`on\` must be a list of event matchers`,
    );
  }
  for (const matcher of on) {
    if (
      !isRecord(matcher) ||
      typeof matcher.event !== "string" ||
      !GATE_EVENTS.has(matcher.event)
    ) {
      throw new JudgeDefinitionError(
        `${path}: each \`on\` entry must be \`{ event: message | tool | feedback, match? }\``,
      );
    }
    if (matcher.match !== undefined && !isRecord(matcher.match)) {
      throw new JudgeDefinitionError(
        `${path}: an \`on\` entry's \`match\` must be a mapping of field to value`,
      );
    }
    for (const field of Object.keys(matcher.match ?? {})) {
      // Where a judge runs is the platform's setting, not the judge's.
      if (
        field === "environment" ||
        field === "runtime_group" ||
        field.endsWith("pattern_id")
      ) {
        throw new JudgeDefinitionError(
          `${path}: \`on\` cannot match on "${field}"`,
        );
      }
    }
  }
  return on;
}

function parseQuestions(
  path: string,
  value: unknown,
): Record<string, JudgeQuestion> {
  if (!isRecord(value)) {
    throw new JudgeDefinitionError(
      `${path}: \`questions\` must be a mapping of question name to question`,
    );
  }
  const names = Object.keys(value);
  if (names.length < 1 || names.length > MAX_QUESTIONS) {
    throw new JudgeDefinitionError(
      `${path}: \`questions\` needs 1 to ${MAX_QUESTIONS} questions`,
    );
  }
  const questions: Record<string, JudgeQuestion> = {};
  for (const name of names) {
    const question = value[name];
    if (!QUESTION_NAME.test(name) || !isRecord(question)) {
      throw new JudgeDefinitionError(
        `${path}: question "${name}" must be a snake_case name mapped to \`{ instructions, criteria?, threshold? }\``,
      );
    }
    for (const field of Object.keys(question)) {
      if (!QUESTION_FIELDS.has(field)) {
        throw new JudgeDefinitionError(
          `${path}: question "${name}" has unknown field "${field}"`,
        );
      }
    }
    if (
      typeof question.instructions !== "string" ||
      !question.instructions.trim()
    ) {
      throw new JudgeDefinitionError(
        `${path}: question "${name}" needs \`instructions\``,
      );
    }
    const criteria = question.criteria;
    if (
      !isRecord(criteria) ||
      typeof criteria.true !== "string" ||
      typeof criteria.false !== "string"
    ) {
      throw new JudgeDefinitionError(
        `${path}: question "${name}" needs \`criteria\` with a \`true\` and a \`false\` description`,
      );
    }
    const threshold = question.threshold ?? DEFAULT_THRESHOLD;
    if (typeof threshold !== "number" || !(threshold > 0 && threshold <= 1)) {
      throw new JudgeDefinitionError(
        `${path}: question "${name}" \`threshold\` must be a number above 0 and at most 1`,
      );
    }
    questions[name] = {
      instructions: question.instructions,
      criteria: { true: criteria.true, false: criteria.false },
      threshold,
    };
  }
  return questions;
}

/**
 * Parse one judge file. Returns null for a mission judge, which the platform's
 * egress evaluates and this runner never does.
 */
export function parseJudgeDefinition(
  path: string,
  source: string,
): JudgeDefinition | null {
  let value: unknown;
  try {
    value = parse(source);
  } catch (error) {
    throw new JudgeDefinitionError(
      `${path}: not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) {
    throw new JudgeDefinitionError(`${path}: a judge must be a YAML mapping`);
  }
  const type = value.type ?? "online";
  if (type === "mission") return null;
  if (type !== "online") {
    throw new JudgeDefinitionError(
      `${path}: \`type\` must be online or mission`,
    );
  }
  if ("llm" in value) {
    throw new JudgeDefinitionError(
      `${path}: \`llm\` is no longer read; declare the judge's model as \`ai: { model: <provider>/<model> }\`, as an agent does`,
    );
  }
  for (const field of Object.keys(value)) {
    if (!TOP_LEVEL_FIELDS.has(field)) {
      throw new JudgeDefinitionError(`${path}: unknown field "${field}"`);
    }
  }
  const name = value.name ?? value.judge;
  if (typeof name !== "string" || !JUDGE_NAME.test(name) || name.length > 255) {
    throw new JudgeDefinitionError(
      `${path}: \`name\` must be lowercase kebab-case`,
    );
  }
  const ai = parseRecipeAgentAiConfig(`judge "${name}"`, value.ai);
  if (!ai?.name) {
    throw new JudgeDefinitionError(
      `${path}: a judge must declare \`ai.model\` as <provider>/<model>`,
    );
  }
  if (
    value.description !== undefined &&
    typeof value.description !== "string"
  ) {
    throw new JudgeDefinitionError(`${path}: \`description\` must be text`);
  }
  const base: JudgeBase = {
    name,
    ...(value.description ? { description: value.description } : {}),
    on: parseGate(path, value.on),
    ai: { ...ai, name: ai.name },
    path,
    definitionHash: createHash("sha256").update(source).digest("hex"),
  };
  const hasInstructions = value.instructions !== undefined;
  const hasQuestions = value.questions !== undefined;
  if (hasInstructions === hasQuestions) {
    throw new JudgeDefinitionError(
      `${path}: a judge declares either \`instructions\`, answered by a chat model, or \`questions\`, answered by a classifier`,
    );
  }
  if (hasQuestions) {
    return {
      ...base,
      kind: "classifier",
      questions: parseQuestions(path, value.questions),
    };
  }
  if (typeof value.instructions !== "string" || !value.instructions.trim()) {
    throw new JudgeDefinitionError(`${path}: \`instructions\` must be text`);
  }
  return { ...base, kind: "llm", instructions: value.instructions };
}

/** Every online judge in a Recipe's `judges/`, in file order; names are unique. */
export function loadJudges(recipeDir: string): JudgeDefinition[] {
  const directory = join(recipeDir, "judges");
  if (!existsSync(directory)) return [];
  const judges: JudgeDefinition[] = [];
  const seen = new Map<string, string>();
  for (const file of readdirSync(directory).sort()) {
    if (!/\.ya?ml$/.test(file)) continue;
    const path = `judges/${file}`;
    const judge = parseJudgeDefinition(
      path,
      readFileSync(join(directory, file), "utf8"),
    );
    if (!judge) continue;
    const earlier = seen.get(judge.name);
    if (earlier) {
      throw new JudgeDefinitionError(
        `${path}: judge name "${judge.name}" is already declared in ${earlier}`,
      );
    }
    seen.set(judge.name, path);
    judges.push(judge);
  }
  return judges;
}
