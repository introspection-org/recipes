import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { BatchRunController } from "../batch/runner.js";
import { resolveRecipe } from "../recipe/resolve.js";
import { piClassifier } from "./classifier.js";
import {
  createJudgeRunController,
  type JudgeRunController,
} from "./controller.js";
import { loadJudges, type JudgeDefinition } from "./definition.js";
import {
  runJudges,
  type JudgeInputLine,
  type JudgementLine,
  type JudgeOperationalConfig,
  type SkippedJudgement,
} from "./run.js";

const USAGE = `Usage: node judges/cli.js --recipe <dir> --input <file|-> [options]

Run a Recipe's judges over conversations and print the judgements as JSON.

  --recipe <dir>               The Recipe whose judges/ to run.
  --input <file|->             A JSONL file of conversations, or - for stdin. Repeatable.
  --judge <name>               Run only this judge. Repeatable. Default: every judge.
  --out <dir>                  Keep the run's state and write results.jsonl here; a rerun resumes.
  --operational <file>         JSON of platform settings by judge name: judge_id, enabled, sample_rate.
  --concurrency <n>            Judgements in flight at once. Default 8.
  --max-attempts <n>           Tries of a rate-limited judgement. Default 3.
  --fallback-after-retries <n> Retries of a judge's model before its next ai.fallbacks entry. Default 2.
`;

/** What the runner prints: every judgement, what was skipped, and the counts by result. */
export interface JudgeCliReport {
  schema_version: 1;
  results: JudgementLine[];
  skipped: SkippedJudgement[];
  counts: Record<JudgementLine["result"], number>;
  stopped: boolean;
}

export interface JudgeCliArgs {
  recipe: string;
  input: string[];
  judge: string[];
  out?: string;
  operational?: string;
  concurrency?: number;
  maxAttempts?: number;
  fallbackAfterRetries?: number;
}

function positiveInteger(flag: string, value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`--${flag} must be a whole number, got "${value}"`);
  }
  return number;
}

/** Parse the runner's arguments; a missing or malformed one throws with the usage. */
export function parseJudgeCliArgs(argv: readonly string[]): JudgeCliArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      recipe: { type: "string" },
      input: { type: "string", multiple: true },
      judge: { type: "string", multiple: true },
      out: { type: "string" },
      operational: { type: "string" },
      concurrency: { type: "string" },
      "max-attempts": { type: "string" },
      "fallback-after-retries": { type: "string" },
    },
    strict: true,
  });
  if (!values.recipe || !values.input?.length) {
    throw new Error(
      `--recipe and at least one --input are required\n\n${USAGE}`,
    );
  }
  if (values.input.filter((entry) => entry === "-").length > 1) {
    throw new Error("--input - may be given once");
  }
  const concurrency = positiveInteger("concurrency", values.concurrency);
  const maxAttempts = positiveInteger("max-attempts", values["max-attempts"]);
  const fallbackAfterRetries = positiveInteger(
    "fallback-after-retries",
    values["fallback-after-retries"],
  );
  return {
    recipe: values.recipe,
    input: values.input,
    judge: values.judge ?? [],
    ...(values.out ? { out: values.out } : {}),
    ...(values.operational ? { operational: values.operational } : {}),
    ...(concurrency ? { concurrency } : {}),
    ...(maxAttempts ? { maxAttempts } : {}),
    ...(fallbackAfterRetries !== undefined ? { fallbackAfterRetries } : {}),
  };
}

function parseStdin(text: string): JudgeInputLine[] {
  return text.split("\n").flatMap((raw, index) => {
    if (!raw.trim()) return [];
    try {
      return [JSON.parse(raw) as JudgeInputLine];
    } catch (error) {
      throw new Error(
        `stdin line ${index + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

export interface JudgeCliDeps {
  /** Runs the judgements. Default: the judges' own controller on this machine's Pi. */
  controller?: (
    judges: readonly JudgeDefinition[],
  ) => Promise<
    BatchRunController & Partial<Pick<JudgeRunController, "shutdown">>
  >;
  readStdin?: () => Promise<string>;
  signal?: AbortSignal;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Run the judges an invocation names and return its report. Models and
 * credentials are this machine's Pi: its logins and provider keys, with each
 * judge's `ai.fallbacks`.
 */
export async function judgeCli(
  args: JudgeCliArgs,
  deps: JudgeCliDeps = {},
): Promise<JudgeCliReport> {
  const recipeDir = resolve(args.recipe);
  const all = loadJudges(recipeDir);
  const unknown = args.judge.filter(
    (name) => !all.some((judge) => judge.name === name),
  );
  if (unknown.length > 0) {
    throw new Error(
      `the Recipe has no judge named ${unknown.join(", ")}; its judges are ${all.map((judge) => judge.name).join(", ") || "none"}`,
    );
  }
  const judges =
    args.judge.length > 0
      ? all.filter((judge) => args.judge.includes(judge.name))
      : all;
  const operational = args.operational
    ? (JSON.parse(await readFile(args.operational, "utf8")) as Record<
        string,
        JudgeOperationalConfig
      >)
    : undefined;
  const stdin = args.input.includes("-")
    ? parseStdin(await (deps.readStdin ?? (() => readAll(process.stdin)))())
    : [];
  const files = args.input.filter((entry) => entry !== "-");
  // Files run as one input; stdin's lines join them, so a custom_id repeated
  // across the two is refused like one repeated across files.
  const input: (string | JudgeInputLine)[] = [...files, ...stdin];

  const concurrency = args.concurrency ?? 8;
  const controller = deps.controller
    ? await deps.controller(judges)
    : createJudgeRunController({
        recipe: resolveRecipe({ recipeDir }),
        judges,
        cwd: process.cwd(),
        concurrency,
        modelRegistry: new ModelRegistry(await ModelRuntime.create()),
        // Above `fallbackAfterRetries`, so a fallback is reached.
        settingsManager: SettingsManager.inMemory({
          retry: {
            enabled: true,
            maxRetries: (args.fallbackAfterRetries ?? 2) + 2,
          },
        }),
        classify: piClassifier(),
        ...(args.fallbackAfterRetries !== undefined
          ? { fallbackAfterRetries: args.fallbackAfterRetries }
          : {}),
      });
  try {
    const outcome = await runJudges({
      judges,
      input,
      controller,
      concurrency,
      ...(args.out ? { directory: resolve(args.out) } : {}),
      ...(args.maxAttempts ? { max_attempts: args.maxAttempts } : {}),
      ...(operational ? { operational } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    const counts = { pass: 0, fail: 0, not_applicable: 0, error: 0 };
    for (const line of outcome.results) counts[line.result] += 1;
    return { schema_version: 1, ...outcome, counts };
  } finally {
    await controller.shutdown?.();
  }
}

/** Run the command line and set the process's exit code: 0 finished, 130 stopped, 2 refused. */
export async function main(argv: readonly string[]): Promise<void> {
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());
  try {
    const report = await judgeCli(parseJudgeCliArgs(argv), {
      signal: abort.signal,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.stopped ? 130 : 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
