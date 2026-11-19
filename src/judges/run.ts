import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { findRecipeModel } from "../model-binding.js";
import { findClassifierModel } from "./classifier.js";
import { promptBudget } from "../prompts/budget.js";
import {
  CLASSIFIER_BUDGET_TOKENS,
  trajectoryLlmClassify,
  trajectoryLlmJudge,
} from "../prompts/builders/trajectory.js";
import { builderId } from "../prompts/builder.js";
import { promptBuilder } from "../prompts/registry.js";
import { parsePreprocess } from "../prompts/spec.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeBatchFiles, type BatchFiles } from "../batch/files.js";
import { runBatch } from "../batch/index.js";
import { jsonlResults } from "../batch/shards.js";
import type { BatchResultLine } from "../batch/lines.js";
import type { BatchRunController } from "../batch/runner.js";
import type {
  JudgeRunController,
  JudgeRunDetails,
  JudgeUsage,
} from "./controller.js";
import type { JudgeDefinition } from "./definition.js";
import { evaluateGate, gateView, type JudgeFeedbackEvent } from "./gate.js";
import { CONTRACT_VERSION, judgementId, samplesIn } from "./identity.js";
import { trajectoryFromPiSession } from "./session.js";
import { evidenceHash, toJudgeInput } from "./trajectory.js";
import {
  completeClassifierVerdict,
  completeLlmVerdict,
  stripCodeFence,
  type JudgeVerdict,
  type Verdict,
} from "./verdict.js";

/** One conversation to judge: a line of an input file. */
export interface JudgeInputLine {
  /**
   * Your id for the conversation, unique across every input file. A line
   * without one is named by its `conversation_id`.
   */
  custom_id: string;
  /** The platform conversation this is, when it is one. Defaults to `custom_id`. */
  conversation_id?: string;
  /**
   * The conversation: a trajectory export's records (keyed by `role`), or
   * events already normalized (keyed by `type`).
   */
  trajectory: unknown[];
  /**
   * In an input file, a line may name a Pi session file in place of
   * `trajectory`; the session's active branch is read as the conversation.
   */
  session_file?: string;
  /** The agent's effective system instructions, when they are evidence too. */
  system_instructions?: string;
  /** Feedback on the conversation, for a judge whose gate matches `feedback`. */
  feedback_events?: JudgeFeedbackEvent[];
  /** Where the conversation ran. Sampling applies only in `production`. */
  environment?: string;
}

/** What the platform has set for a judge, by judge name. */
export interface JudgeOperationalConfig {
  /** The judge's registered id: the namespace its judgement ids derive from. */
  judge_id?: string;
  /** Default true. */
  enabled?: boolean;
  /** The fraction of production conversations judged, 0 to 1. Default 1. */
  sample_rate?: number;
}

/** One judge's judgement of one conversation: a line of `results.jsonl`. */
export interface JudgementLine {
  custom_id: string;
  judge: string;
  conversation_id: string;
  definition_hash: string;
  contract_version: string;
  /** Present when the judge has a registered id to derive it from. */
  judgement_id?: string;
  /** `error` when the judge could not reach a verdict; never a silent fail. */
  result: Verdict | "error";
  status: "ok" | "error";
  reasoning?: string;
  /** A classifier judge's probability of yes for each question. */
  scores?: Record<string, number>;
  /** The hash of the evidence the judge read: `evidenceHash` of its input. */
  sequence_hash?: string;
  /** The `<provider>/<model>` that answered, after any `ai.fallbacks`. */
  model?: string;
  /** The tokens the judgement took; absent when the model reported none. */
  usage?: JudgeUsage;
  error?: string;
  /** The batch run that produced it, and how many attempts it took. */
  run_id?: string;
  attempts?: number;
}

/** A judge that did not run on a conversation, and why. */
export interface SkippedJudgement {
  custom_id: string;
  judge: string;
  reason: "gate" | "no_evidence" | "disabled" | "sampled_out";
}

export interface RunJudgesOptions {
  judges: readonly JudgeDefinition[];
  /**
   * The conversations: inline lines, and the paths (or `file:` URLs) of JSONL
   * files of them, in any mix. Everything runs as one batch.
   */
  input: readonly (string | URL | JudgeInputLine)[];
  /**
   * Runs each judgement: `createJudgeRunController`, or your own. With
   * `runDetails`, each judgement names the model that answered and its usage.
   */
  controller: BatchRunController &
    Partial<Pick<JudgeRunController, "runDetails">>;
  /**
   * Where the run keeps its state and writes `results.jsonl`. Running again
   * with the same directory skips every judgement that already succeeded for
   * the same judge definition and transcript. Without it, nothing is written.
   */
  directory?: string;
  /** Judgements in flight at once, across every judge. Default 8. */
  concurrency?: number;
  /** Attempts per judgement when the provider rate-limits it. Default 3. */
  max_attempts?: number;
  operational?: Readonly<Record<string, JudgeOperationalConfig>>;
  signal?: AbortSignal;
  /** Called with each judgement as it completes, in the order they finish. */
  onResult?: (line: JudgementLine) => Promise<void> | void;
  /** Replaces the local file system. */
  files?: BatchFiles;
  /**
   * The catalog each judge's prompt budget is read from: the smallest context
   * window across its `ai.model` and `ai.fallbacks`. Pi's built-in catalog
   * without it; a model neither knows keeps the fixed budget.
   */
  modelRegistry?: ModelRegistry;
}

export interface JudgesOutcome {
  /** Every judgement, by judge and then in input order. */
  results: JudgementLine[];
  skipped: SkippedJudgement[];
  /** True when a signal ended the run before every judgement ran. */
  stopped: boolean;
}

/** One judge's judgement of one conversation, ready to run as a batch line. */
interface Pair {
  judge: JudgeDefinition;
  line: JudgeInputLine;
  transcript: string;
  evidence: string;
}

/** The batch's agent name; each line's own judge is resolved from its id. */
const BATCH_AGENT = "judges";

/**
 * The run details recorded under `path`, by run id. A last line a crash cut
 * short is trimmed from the file, as the batch trims its own results, so the
 * next append starts a line of its own; its run has no recorded line in the
 * batch either, and runs again.
 */
async function readRunDetails(
  files: BatchFiles,
  path: string,
): Promise<Map<string, JudgeRunDetails>> {
  const details = new Map<string, JudgeRunDetails>();
  for (const raw of (await jsonlResults(files, path).read()).split("\n")) {
    if (!raw.trim()) continue;
    try {
      const { run_id: runId, ...rest } = JSON.parse(raw) as {
        run_id?: unknown;
      } & JudgeRunDetails;
      if (typeof runId === "string") details.set(runId, rest);
    } catch {
      // Not a details line; nothing reads it.
    }
  }
  return details;
}

/** A run whose output has had one surrounding code fence removed. */
function unfenced<T extends { output?: string | undefined }>(run: T): T {
  return typeof run.output === "string"
    ? { ...run, output: stripCodeFence(run.output) }
    : run;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readLines(
  input: RunJudgesOptions["input"],
  files: BatchFiles,
): Promise<JudgeInputLine[]> {
  const lines: { value: unknown; label: string }[] = [];
  for (const [index, entry] of input.entries()) {
    if (typeof entry !== "string" && !(entry instanceof URL)) {
      lines.push({ value: entry, label: `input ${index + 1}` });
      continue;
    }
    const path = entry instanceof URL ? fileURLToPath(entry) : entry;
    const text = await files.read(path);
    if (text === null) throw new Error(`judge input ${path} does not exist`);
    text.split("\n").forEach((raw, number) => {
      if (!raw.trim()) return;
      const label = `${path} line ${number + 1}`;
      try {
        lines.push({ value: JSON.parse(raw), label });
      } catch (error) {
        throw new Error(`${label} is not JSON: ${message(error)}`);
      }
    });
  }
  const seen = new Map<string, string>();
  for (const line of lines) {
    const { value, label } = line;
    if (
      !isRecord(value) ||
      typeof value.session_file !== "string" ||
      value.trajectory !== undefined
    ) {
      continue;
    }
    const session = await files.read(value.session_file);
    if (session === null) {
      throw new Error(`${label}: ${value.session_file} does not exist`);
    }
    const { session_file: _file, ...rest } = value;
    try {
      line.value = { ...rest, trajectory: trajectoryFromPiSession(session) };
    } catch (error) {
      throw new Error(`${label}: ${value.session_file}: ${message(error)}`);
    }
  }
  return lines.map(({ value, label }) => {
    if (!isRecord(value) || !Array.isArray(value.trajectory)) {
      throw new Error(`${label} needs a trajectory array or a session_file`);
    }
    // An exported conversation names itself by its conversation id.
    const customId = value.custom_id ?? value.conversation_id;
    if (typeof customId !== "string" || !customId) {
      throw new Error(`${label} needs a custom_id or a conversation_id`);
    }
    const earlier = seen.get(customId);
    if (earlier) {
      throw new Error(
        `${label} repeats custom_id ${customId}, first seen at ${earlier}`,
      );
    }
    seen.set(customId, label);
    return { ...value, custom_id: customId } as unknown as JudgeInputLine;
  });
}

/**
 * Run every judge over every conversation it applies to, as one batch, and
 * return the judgements. A judge whose gate does not match a conversation is
 * skipped, not graded; a judge that cannot reach a verdict records `error`,
 * never `fail`.
 *
 * Each judge and conversation pair is one line of the batch: an LLM judge's
 * line is a fresh session with the judge's `ai:` settings, and a classifier
 * judge's line is one decision-model call. One conversation under many judges
 * and many conversations under one judge are the same run, sharing the
 * batch's pool, its rate-limit retries and its resume.
 */
export async function runJudges(
  options: RunJudgesOptions,
): Promise<JudgesOutcome> {
  const files = options.files ?? nodeBatchFiles;
  const lines = await readLines(options.input, files);
  const skipped: SkippedJudgement[] = [];
  const pairs = new Map<string, Pair>();
  const failed = new Map<string, JudgementLine>();
  // A changed definition is a different judge: its lines have ids of their
  // own, so a rerun grades them rather than resuming the old definition's.
  const pairId = (judge: JudgeDefinition, line: JudgeInputLine) =>
    `${judge.name}@${judge.definitionHash.slice(0, 12)}/${line.custom_id}`;

  // Who answered each run and its usage, kept beside the batch's state: a
  // resumed run's controller never saw the runs that already completed.
  const detailsPath = options.directory
    ? join(options.directory, "run-details.jsonl")
    : undefined;
  const recorded = detailsPath
    ? await readRunDetails(files, detailsPath)
    : new Map<string, JudgeRunDetails>();
  const runDetails = (runId: string | undefined) => {
    if (!runId) return {};
    // The controller knows the runs it made; a resumed run's earlier ones are
    // only on disk.
    const live = options.controller.runDetails?.(runId);
    const details = live?.model || live?.usage ? live : recorded.get(runId);
    return {
      ...(details?.model ? { model: details.model } : {}),
      ...(details?.usage && details.usage.total_tokens > 0
        ? { usage: details.usage }
        : {}),
    };
  };

  const judgement = (
    judge: JudgeDefinition,
    line: JudgeInputLine,
    outcome: JudgeVerdict | { error: string },
    evidence?: string,
    batch?: BatchResultLine,
  ): JudgementLine => {
    const judgeId = options.operational?.[judge.name]?.judge_id;
    const conversationId = line.conversation_id ?? line.custom_id;
    return {
      custom_id: line.custom_id,
      judge: judge.name,
      conversation_id: conversationId,
      definition_hash: judge.definitionHash,
      contract_version: CONTRACT_VERSION,
      ...(judgeId && evidence
        ? {
            judgement_id: judgementId(
              judgeId,
              judge.definitionHash,
              evidence,
              conversationId,
            ),
          }
        : {}),
      ...("error" in outcome
        ? { result: "error", status: "error", error: outcome.error }
        : {
            result: outcome.verdict,
            status: "ok",
            ...(outcome.reasoning !== undefined
              ? { reasoning: outcome.reasoning }
              : {}),
            ...(outcome.scores ? { scores: outcome.scores } : {}),
          }),
      ...(evidence ? { sequence_hash: evidence } : {}),
      ...runDetails(batch?.result.run_id),
      ...(batch?.result.run_id ? { run_id: batch.result.run_id } : {}),
      ...(batch ? { attempts: batch.batch.attempts } : {}),
    };
  };

  const budgets = new Map<string, number>();
  const budgetFor = (judge: JudgeDefinition): number => {
    let tokens = budgets.get(judge.name);
    if (tokens === undefined) {
      const specs = [judge.ai.name, ...(judge.ai.fallbacks ?? [])];
      tokens =
        judge.kind === "classifier"
          ? // Jev's slim was measured cut to 25k tokens (the slimming study); a
            // classifier's window may lower that, never raise it.
            promptBudget(
              specs.map((spec) => findClassifierModel(spec)),
              CLASSIFIER_BUDGET_TOKENS,
            )
          : promptBudget(
              specs.map((spec) => findRecipeModel(spec, options.modelRegistry)),
            );
      budgets.set(judge.name, tokens);
    }
    return tokens;
  };
  const builderFor = (judge: JudgeDefinition) => {
    const spec = judge.preprocess
      ? parsePreprocess(judge.preprocess)
      : {
          builder: builderId(
            judge.kind === "classifier"
              ? trajectoryLlmClassify
              : trajectoryLlmJudge,
          ),
        };
    return { builder: promptBuilder(spec.builder), options: spec.options };
  };
  for (const judge of options.judges) {
    const operational = options.operational?.[judge.name] ?? {};
    for (const line of lines) {
      const skip = (reason: SkippedJudgement["reason"]) =>
        skipped.push({ custom_id: line.custom_id, judge: judge.name, reason });
      if (operational.enabled === false) {
        skip("disabled");
        continue;
      }
      if (
        line.environment === "production" &&
        !samplesIn(
          operational.judge_id ?? judge.name,
          line.conversation_id ?? line.custom_id,
          operational.sample_rate ?? 1,
        )
      ) {
        skip("sampled_out");
        continue;
      }
      try {
        const input = toJudgeInput(line.trajectory, line.system_instructions);
        if (input.trajectory.length === 0 && !input.system_instructions) {
          skip("no_evidence");
          continue;
        }
        if (!evaluateGate(judge.on, gateView(input, line.feedback_events))) {
          skip("gate");
          continue;
        }
        pairs.set(pairId(judge, line), {
          judge,
          line,
          transcript: (() => {
            const { builder, options: builderOptions } = builderFor(judge);
            return builder.build(input, budgetFor(judge), builderOptions)
              .prompt;
          })(),
          evidence: evidenceHash(input),
        });
      } catch (error) {
        const result = judgement(judge, line, { error: message(error) });
        failed.set(pairId(judge, line), result);
        await options.onResult?.(result);
      }
    }
  }

  // Throws when an output is outside the judge's contract.
  const verdictOf = (id: string, output: string): JudgeVerdict => {
    const { judge, transcript } = pairs.get(id)!;
    return judge.kind === "classifier"
      ? completeClassifierVerdict(
          judge.questions,
          (JSON.parse(output) as { answers: Record<string, unknown> }).answers,
        )
      : completeLlmVerdict(transcript, output);
  };

  const complete = (batch: BatchResultLine): JudgementLine => {
    const { judge, line, evidence } = pairs.get(batch.custom_id)!;
    if (batch.result.type !== "succeeded") {
      return judgement(
        judge,
        line,
        { error: batch.result.error?.message ?? `run ${batch.result.type}` },
        evidence,
        batch,
      );
    }
    try {
      return judgement(
        judge,
        line,
        verdictOf(batch.custom_id, batch.result.output ?? ""),
        evidence,
        batch,
      );
    } catch (error) {
      return judgement(judge, line, { error: message(error) }, evidence, batch);
    }
  };

  // The batch names one agent; each line's judge is the one its id was built
  // from, so the controller is asked for that judge.
  const controller: BatchRunController = {
    start: (input) => {
      const pair = pairs.get(input.label ?? "");
      return options.controller.start(
        pair
          ? { ...input, name: pair.judge.name, label: pair.line.custom_id }
          : input,
      );
    },
    // A fenced JSON reply is still an answer: unfence it before the batch's
    // JSON check, which would otherwise ask the judge to repair it.
    wait: async (id, signal) =>
      unfenced(await options.controller.wait(id, signal)),
    message: async (id, text) =>
      unfenced(await options.controller.message(id, text)),
    // The batch closes a session before it records the line, so the line's
    // details are on disk before the line is.
    close: async (id) => {
      const details = options.controller.runDetails?.(id);
      if (detailsPath && (details?.model || details?.usage)) {
        await files.appendLine(
          detailsPath,
          JSON.stringify({ run_id: id, ...details }),
        );
      }
      return options.controller.close(id);
    },
  };
  const completed = new Map<string, JudgementLine>();
  let stopped = false;
  if (pairs.size > 0) {
    const outcome = await runBatch({
      agent: BATCH_AGENT,
      input: [...pairs].map(([id, { transcript }]) => ({
        custom_id: id,
        prompt: transcript,
      })),
      controller,
      // A classifier's answers are JSON too, so one format serves every line.
      output_format: "json",
      // A reply outside the judge's contract is an errored line, not a
      // succeeded one, so a resumed run asks again.
      checkOutput: (input, output) => {
        try {
          verdictOf(input.custom_id, output);
          return null;
        } catch (error) {
          return message(error);
        }
      },
      ...(options.directory
        ? { directory: join(options.directory, "batch") }
        : {}),
      ...(options.concurrency ? { concurrency: options.concurrency } : {}),
      ...(options.max_attempts ? { max_attempts: options.max_attempts } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      files,
      // A line resumed from an earlier run was reported then, and is in the
      // returned results below.
      onResult: async (batch) => {
        const result = complete(batch);
        completed.set(batch.custom_id, result);
        await options.onResult?.(result);
      },
    });
    stopped = outcome.stopped;
    for (const batch of outcome.results) {
      if (!completed.has(batch.custom_id)) {
        completed.set(batch.custom_id, complete(batch));
      }
    }
  }

  const results = options.judges.flatMap((judge) =>
    lines.flatMap((line) => {
      const id = pairId(judge, line);
      const result = failed.get(id) ?? completed.get(id);
      return result ? [result] : [];
    }),
  );
  if (options.directory) {
    await files.write(
      join(options.directory, "results.jsonl"),
      results.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );
  }
  return { results, skipped, stopped };
}
