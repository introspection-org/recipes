import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validatePromptSpec, type PromptSpec } from "../prompts/spec.js";
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
  /** How its transcript is built, over the defaults for its kind. */
  input?: PromptSpec;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class JudgeDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeDefinitionError";
  }
}

/** The environment variable naming the `introspection-recipe-check` binary. */
export const RECIPE_CHECK_BIN_ENV = "INTROSPECTION_RECIPE_CHECK";

/** One judge file to normalize: its path in the Recipe and its YAML. */
export interface JudgeSource {
  path: string;
  content: string;
}

/**
 * What `introspection-recipe-check judges` prints for each online judge, and
 * what a host that links the crate passes in its place (`definitions`).
 */
export interface NormalizedJudgeDefinition {
  source_path: string;
  definition: {
    name: string;
    description?: string;
    on: unknown;
    ai: Record<string, unknown>;
    instructions?: string;
    questions?: Record<string, JudgeQuestion>;
    input?: unknown;
  };
  warnings?: string[];
}

export interface JudgeDefinitionOptions {
  /**
   * The judges already normalized, as `introspection-recipe-check judges`
   * prints them: a host that links recipe-check passes them, and nothing is
   * spawned.
   */
  definitions?: readonly NormalizedJudgeDefinition[];
  /** The `introspection-recipe-check` binary. Default: `$INTROSPECTION_RECIPE_CHECK`, else the one on PATH. */
  recipeCheck?: string;
  /** Called with each warning the normalization raised. Default: write it to stderr. */
  onWarning?: (warning: string) => void;
}

function recipeCheckBinary(options: JudgeDefinitionOptions): string {
  return (
    options.recipeCheck ??
    process.env[RECIPE_CHECK_BIN_ENV] ??
    "introspection-recipe-check"
  );
}

/**
 * The normalized definitions of `sources`, from recipe-check's native
 * validator: the one reader every runtime shares, so an older `llm:` block, a
 * gate's regular expressions and every default mean here what they mean on
 * the platform. Mission judges are left out; any invalid source fails all.
 */
function normalizeJudges(
  sources: readonly JudgeSource[],
  options: JudgeDefinitionOptions,
): NormalizedJudgeDefinition[] {
  const binary = recipeCheckBinary(options);
  const result = spawnSync(binary, ["judges"], {
    input: JSON.stringify(sources),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new JudgeDefinitionError(
      `could not run ${binary} to read the judges (set ${RECIPE_CHECK_BIN_ENV} to the introspection-recipe-check binary): ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new JudgeDefinitionError(
      result.stderr.trim() || `${binary} judges exited with ${result.status}`,
    );
  }
  return JSON.parse(result.stdout) as NormalizedJudgeDefinition[];
}

function toDefinition(
  normalized: NormalizedJudgeDefinition,
  content: string,
): JudgeDefinition {
  const { definition, source_path: path } = normalized;
  const ai = parseRecipeAgentAiConfig(
    `judge "${definition.name}"`,
    definition.ai,
  );
  if (!ai?.name) {
    throw new JudgeDefinitionError(`${path}: a judge must declare ai.model`);
  }
  const on = definition.on;
  const base: JudgeBase = {
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    on: isRecord(on) && Object.keys(on).length === 0 ? [] : on,
    ai: { ...ai, name: ai.name },
    ...(definition.input !== undefined
      ? { input: validatePromptSpec(definition.input, `${path}: input`) }
      : {}),
    path,
    definitionHash: createHash("sha256").update(content).digest("hex"),
  };
  if (definition.questions) {
    return { ...base, kind: "classifier", questions: definition.questions };
  }
  return { ...base, kind: "llm", instructions: definition.instructions ?? "" };
}

/** Normalize judge sources into definitions, in path order; mission judges are left out. */
export function parseJudgeDefinitions(
  sources: readonly JudgeSource[],
  options: JudgeDefinitionOptions = {},
): JudgeDefinition[] {
  const contents = new Map(sources.map((source) => [source.path, source]));
  const warn =
    options.onWarning ??
    ((warning: string) => process.stderr.write(`warning: ${warning}\n`));
  const normalized = options.definitions ?? normalizeJudges(sources, options);
  return normalized.map((judge) => {
    const source = contents.get(judge.source_path);
    if (!source) {
      throw new JudgeDefinitionError(
        `the judge definitions name ${judge.source_path}, which is not among the Recipe's judge files`,
      );
    }
    for (const warning of judge.warnings ?? []) warn(warning);
    return toDefinition(judge, source.content);
  });
}

/**
 * Parse one judge file. Returns null for a mission judge, which the platform's
 * egress evaluates and this runner never does.
 */
export function parseJudgeDefinition(
  path: string,
  source: string,
  options: JudgeDefinitionOptions = {},
): JudgeDefinition | null {
  return parseJudgeDefinitions([{ path, content: source }], options)[0] ?? null;
}

/** Every online judge in a Recipe's `judges/`, in file order; names are unique. */
export function loadJudges(
  recipeDir: string,
  options: JudgeDefinitionOptions = {},
): JudgeDefinition[] {
  const directory = join(recipeDir, "judges");
  if (!existsSync(directory)) return [];
  const sources = readdirSync(directory)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => ({
      path: `judges/${file}`,
      content: readFileSync(join(directory, file), "utf8"),
    }));
  return sources.length > 0 ? parseJudgeDefinitions(sources, options) : [];
}
