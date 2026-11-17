import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeBatchFiles, type BatchFiles } from "../batch/files.js";
import { runBatch } from "../batch/index.js";
import type { BatchInputLine, BatchResultLine } from "../batch/lines.js";
import type { BatchRunController } from "../batch/runner.js";
import type { JudgeDefinition } from "./definition.js";
import { evaluateGate, gateView, type JudgeFeedbackEvent } from "./gate.js";
import { CONTRACT_VERSION, judgementId, samplesIn } from "./identity.js";
import {
  CLASSIFIER_BUDGET_UNITS,
  evidenceHash,
  renderTrajectoryInput,
  toJudgeInput,
  type JudgeInput,
} from "./trajectory.js";
import {
  completeClassifierVerdict,
  completeLlmVerdict,
  type JudgeVerdict,
  type Verdict,
} from "./verdict.js";

/** One conversation to judge: a line of an input file. */
export interface JudgeInputLine {
  /** Your id for the conversation. It must be unique across every input file. */
  custom_id: string;
  /** The platform conversation this is, when it is one. Defaults to `custom_id`. */
  conversation_id?: string;
  /**
   * The conversation: a trajectory export's records (keyed by `role`), or
   * events already normalized (keyed by `type`).
   */
  trajectory: unknown[];
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
   * The conversations: inline lines, or the paths (or `file:` URLs) of one or
   * more JSONL files of them. Several files run as one batch.
   */
  input: readonly JudgeInputLine[] | readonly (string | URL)[];
  /** Runs each judgement: `createJudgeRunController`, or your own. */
  controller: BatchRunController;
  /**
   * Where the run keeps its state and writes `results.jsonl`. Running again
   * with the same directory skips every judgement that already succeeded for
   * the same judge definition and transcript. Without it, nothing is written.
   */
  directory?: string;
  /** Judgements in flight at once, per judge. Default 8. */
  concurrency?: number;
  /** Attempts per judgement when the provider rate-limits it. Default 3. */
  max_attempts?: number;
  operational?: Readonly<Record<string, JudgeOperationalConfig>>;
  signal?: AbortSignal;
  /** Called with each judgement as it is completed. */
  onResult?: (line: JudgementLine) => Promise<void> | void;
  /** Replaces the local file system. */
  files?: BatchFiles;
}

export interface JudgesOutcome {
  /** Every judgement, by judge and then in input order. */
  results: JudgementLine[];
  skipped: SkippedJudgement[];
  /** True when a signal ended the run before every judgement ran. */
  stopped: boolean;
}

interface Prepared {
  line: JudgeInputLine;
  input: JudgeInput;
  transcript: string;
  evidence: string;
  conversationId: string;
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
  return lines.map(({ value, label }) => {
    if (
      !isRecord(value) ||
      typeof value.custom_id !== "string" ||
      !value.custom_id ||
      !Array.isArray(value.trajectory)
    ) {
      throw new Error(`${label} needs a custom_id and a trajectory array`);
    }
    const earlier = seen.get(value.custom_id);
    if (earlier) {
      throw new Error(
        `${label} repeats custom_id ${value.custom_id}, first seen at ${earlier}`,
      );
    }
    seen.set(value.custom_id, label);
    return value as unknown as JudgeInputLine;
  });
}

/**
 * Run every judge over every conversation it applies to, as one batch per
 * judge, and return the judgements. A judge whose gate does not match a
 * conversation is skipped, not graded; a judge that cannot reach a verdict
 * records `error`, never `fail`.
 *
 * Each judgement is one line of a batch: an LLM judge's line is a fresh
 * session with the judge's `ai:` settings, and a classifier judge's line is
 * one decision-model call. The batch gives both its pool, its rate-limit
 * retries and its resume.
 */
export async function runJudges(
  options: RunJudgesOptions,
): Promise<JudgesOutcome> {
  const files = options.files ?? nodeBatchFiles;
  const lines = await readLines(options.input, files);
  const results: JudgementLine[] = [];
  const skipped: SkippedJudgement[] = [];
  let stopped = false;

  for (const judge of options.judges) {
    const operational = options.operational?.[judge.name] ?? {};
    const prepared = new Map<string, Prepared>();
    const failed = new Map<string, string>();
    for (const line of lines) {
      const skip = (reason: SkippedJudgement["reason"]) =>
        skipped.push({ custom_id: line.custom_id, judge: judge.name, reason });
      const conversationId = line.conversation_id ?? line.custom_id;
      if (operational.enabled === false) {
        skip("disabled");
        continue;
      }
      if (
        line.environment === "production" &&
        !samplesIn(
          operational.judge_id ?? judge.name,
          conversationId,
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
        prepared.set(line.custom_id, {
          line,
          input,
          transcript:
            judge.kind === "classifier"
              ? renderTrajectoryInput(input, {
                  maxUnits: CLASSIFIER_BUDGET_UNITS,
                  slim: true,
                })
              : renderTrajectoryInput(input),
          evidence: evidenceHash(input),
          conversationId,
        });
      } catch (error) {
        failed.set(line.custom_id, message(error));
      }
    }

    const judgement = (
      line: JudgeInputLine,
      outcome: JudgeVerdict | { error: string },
      batch?: BatchResultLine,
    ): JudgementLine => {
      const ready = prepared.get(line.custom_id);
      const conversationId = line.conversation_id ?? line.custom_id;
      return {
        custom_id: line.custom_id,
        judge: judge.name,
        conversation_id: conversationId,
        definition_hash: judge.definitionHash,
        contract_version: CONTRACT_VERSION,
        ...(operational.judge_id && ready
          ? {
              judgement_id: judgementId(
                operational.judge_id,
                judge.definitionHash,
                ready.evidence,
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
        ...(batch?.result.run_id ? { run_id: batch.result.run_id } : {}),
        ...(batch ? { attempts: batch.batch.attempts } : {}),
      };
    };

    const complete = (batch: BatchResultLine): JudgementLine => {
      const ready = prepared.get(batch.custom_id)!;
      if (batch.result.type !== "succeeded") {
        return judgement(
          ready.line,
          { error: batch.result.error?.message ?? `run ${batch.result.type}` },
          batch,
        );
      }
      try {
        const output = batch.result.output ?? "";
        return judgement(
          ready.line,
          judge.kind === "classifier"
            ? completeClassifierVerdict(
                judge.questions,
                (JSON.parse(output) as { answers: Record<string, unknown> })
                  .answers,
              )
            : completeLlmVerdict(ready.transcript, output),
          batch,
        );
      } catch (error) {
        return judgement(ready.line, { error: message(error) }, batch);
      }
    };

    const batchInput: BatchInputLine[] = [...prepared.values()].map(
      ({ line, transcript }) => ({
        custom_id: line.custom_id,
        prompt: transcript,
      }),
    );
    const completed = new Map<string, JudgementLine>();
    if (batchInput.length > 0) {
      const outcome = await runBatch({
        agent: judge.name,
        input: batchInput,
        controller: options.controller,
        ...(options.directory
          ? {
              directory: join(options.directory, "batch"),
              // A changed definition is a different judge: it starts a file of
              // its own rather than resuming the old definition's answers.
              output_name: `${judge.name}-${judge.definitionHash.slice(0, 12)}.jsonl`,
            }
          : {}),
        ...(judge.kind === "llm" ? { output_format: "json" as const } : {}),
        ...(options.concurrency ? { concurrency: options.concurrency } : {}),
        ...(options.max_attempts ? { max_attempts: options.max_attempts } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        files,
      });
      stopped ||= outcome.stopped;
      for (const batch of outcome.results) {
        completed.set(batch.custom_id, complete(batch));
      }
    }
    for (const line of lines) {
      const error = failed.get(line.custom_id);
      const result = error
        ? judgement(line, { error })
        : completed.get(line.custom_id);
      if (!result) continue;
      results.push(result);
      await options.onResult?.(result);
    }
  }

  if (options.directory) {
    await files.write(
      join(options.directory, "results.jsonl"),
      results.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );
  }
  return { results, skipped, stopped };
}
