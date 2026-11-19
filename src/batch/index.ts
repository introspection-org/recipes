import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { context as otelContext, propagation } from "@opentelemetry/api";
import { CONVERSATION_ID_BAGGAGE } from "../otel-baggage.js";
import { fileURLToPath } from "node:url";
import { nodeBatchFiles, type BatchFiles } from "./files.js";
import {
  inputFingerprint,
  parseInputLines,
  validateInputLines,
  type BatchInputLine,
  type BatchResultLine,
  type BuildLinePrompt,
} from "./lines.js";
import { parseBatchParams, type BatchParams } from "./params.js";
import {
  runBatchWith,
  type BatchProgress,
  type BatchRecord,
  type BatchRunController,
  type BatchSummary,
  type LineScope,
} from "./runner.js";
import { jsonlResults, memoryResults } from "./shards.js";
import { buildPrompt } from "../prompts/builder.js";
import type { FitBudget } from "../prompts/fit.js";
import { promptBuilder } from "../prompts/registry.js";
import { validatePromptSpec, type PromptSpec } from "../prompts/spec.js";
import { fitBudget } from "../prompts/budget.js";
import { TRANSCRIPT_BUDGET_UNITS } from "../prompts/builders/trajectory.js";
import { findRecipeModel } from "../model-binding.js";
import type { RecipeAgentModelConfig } from "../recipe/model.js";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export { AdaptiveLimiter } from "./limiter.js";
export {
  completedIds,
  inputFingerprint,
  parseInputLines,
  validateInputLines,
  type BatchInputLine,
  type BatchLineBuild,
  type BatchRecordInfo,
  type BuildLinePrompt,
  type BatchResult,
  type BatchResultLine,
  type BatchResultType,
} from "./lines.js";
export {
  DEFAULT_BATCH_CONCURRENCY,
  MAX_BATCH_CONCURRENCY,
  MAX_JSON_REPAIRS,
  parseBatchParams,
  resultsStem,
  type BatchParams,
} from "./params.js";
export {
  runBatchWith,
  type BatchProgress,
  type BatchRecord,
  type BatchRunController,
  type BatchRunDeps,
  type BatchSummary,
  type LineScope,
} from "./runner.js";
export {
  jsonlResults,
  memoryResults,
  ResultShards,
  shardName,
  type BatchResults,
} from "./shards.js";
export { nodeBatchFiles, type BatchFiles } from "./files.js";
// The in-process controller runs each line in this process, so a batch needs
// nothing beyond this package and a resolved Recipe.
export {
  createInProcessRunController,
  type InProcessRunControllerOptions,
} from "../run-controller.js";

/** Options for `runBatch`: the batch's settings, where its lines come from, and where results go. */
export interface RunBatchOptions extends Partial<Omit<BatchParams, "agent">> {
  /** The Recipe agent that answers each line. */
  agent: string;
  /** The lines to run, or the path (or `file:` URL) of a JSONL file holding them. */
  input: string | URL | readonly BatchInputLine[];
  /** Runs each line: `createInProcessRunController`, or your own `AgentRunController`. */
  controller: BatchRunController;
  /**
   * Where results are written, as `<directory>/<output_name>`, and read back
   * when the batch runs again. A relative `input` path is read from here too.
   * Without it, results are kept in memory and the batch cannot resume.
   */
  directory?: string;
  /** Aborted to stop: no new line starts, and the lines in flight finish. */
  signal?: AbortSignal;
  /** Called after every line and when the batch stops. */
  onProgress?: (progress: BatchProgress) => Promise<void>;
  /**
   * Called with each line's result as soon as it is recorded, so answers can
   * stream into your own store or UI while the batch runs.
   */
  onResult?: (result: BatchResultLine) => Promise<void> | void;
  /** Why a settled line's output cannot be used, or null; a refused one is recorded errored. */
  checkOutput?: (line: BatchInputLine, output: string) => string | null;
  /** Replaces the local file system. */
  files?: BatchFiles;
  /**
   * How a line that carries an `input` becomes its prompt: the agent's
   * `prompt:` spec, and the budget of the models that answer it
   * (`agentPromptBudget`). A line with a `prompt` runs as written.
   */
  prompt?: { spec: PromptSpec; budget: FitBudget };
  /**
   * Names the batch in each prompt's conversation id, `<batch_id>:<index>`.
   * Defaults to an id derived from the results file, so a resumed batch keeps
   * its conversation ids, or a random one without a `directory`.
   */
  batch_id?: string;
  /**
   * OpenTelemetry baggage set around each prompt's session, beside its
   * conversation id. Recipes sessions add every entry to their spans.
   */
  baggage?:
    | Record<string, string>
    | ((line: BatchInputLine, record: BatchRecord) => Record<string, string>);
}

/**
 * What a prompt built for this agent may hold: the smallest window among its
 * `ai:` model and fallbacks, so it fits whichever answers. A model the catalog
 * does not know keeps the transcript default.
 */
export function agentPromptBudget(
  model: RecipeAgentModelConfig | undefined,
  modelRegistry?: ModelRegistry,
): FitBudget {
  const specs = [model?.name, ...(model?.fallbacks ?? [])].filter(
    (spec): spec is string => typeof spec === "string",
  );
  return fitBudget(
    specs.map((spec) => findRecipeModel(spec, modelRegistry)),
    TRANSCRIPT_BUDGET_UNITS,
  );
}

/** Builds each `input` line through `spec`, within `budget`. */
export function linePromptBuilder(
  spec: PromptSpec,
  budget: FitBudget,
): BuildLinePrompt {
  validatePromptSpec(spec);
  const builder = promptBuilder(spec.builder);
  return (input) => {
    const built = buildPrompt(builder, input, {
      budget,
      ...(spec.template !== undefined ? { template: spec.template } : {}),
      ...(spec.steps !== undefined ? { steps: spec.steps } : {}),
      ...(spec.options !== undefined ? { options: spec.options } : {}),
    });
    return {
      prompt: built.prompt,
      build: {
        builder: built.builder,
        applied: built.applied,
        ...(built.digest !== undefined ? { digest: built.digest } : {}),
        ...(built.state !== undefined ? { state: built.state } : {}),
      },
    };
  };
}

/** A prompt's conversation: `<batch_id>:<index>`, padded so ids sort in input order. */
export function batchConversationId(
  batchId: string,
  record: BatchRecord,
): string {
  const width = String(Math.max(0, record.count - 1)).length;
  return `${batchId}:${String(record.index).padStart(width, "0")}`;
}

/**
 * Each prompt's own conversation: its session runs inside baggage naming it
 * (`gen_ai.conversation.id`) and carrying `baggage`, so a Recipes session and
 * every subagent it starts record their spans under that conversation.
 */
export function baggageLineScope(
  batchId: string,
  baggage: RunBatchOptions["baggage"] = {},
): (line: BatchInputLine, record: BatchRecord) => LineScope {
  return (line, record) => {
    const conversationId = batchConversationId(batchId, record);
    const entries = {
      ...(typeof baggage === "function" ? baggage(line, record) : baggage),
      [CONVERSATION_ID_BAGGAGE]: conversationId,
    };
    return {
      conversationId,
      run: (_attempt, fn) => {
        const active = otelContext.active();
        let bag = propagation.getBaggage(active) ?? propagation.createBaggage();
        for (const [key, value] of Object.entries(entries)) {
          bag = bag.setEntry(key, { value });
        }
        return otelContext.with(propagation.setBaggage(active, bag), fn);
      },
    };
  };
}

/** What `runBatch` returns: the counts, and the latest result of every line, in input order. */
export interface BatchOutcome extends BatchSummary {
  results: BatchResultLine[];
}

/**
 * Run `agent` over every input line not already answered, each in a fresh
 * session, and return the results. With a `directory`, results are written
 * there and running again resumes: lines that already succeeded are skipped.
 */
export async function runBatch(
  options: RunBatchOptions,
): Promise<BatchOutcome> {
  const {
    input,
    controller,
    directory,
    signal,
    onProgress,
    onResult,
    checkOutput,
    files = nodeBatchFiles,
    batch_id,
    baggage,
    prompt,
    ...settings
  } = options;
  const params = parseBatchParams(settings);
  const build = prompt
    ? linePromptBuilder(prompt.spec, prompt.budget)
    : undefined;
  let lines: BatchInputLine[];
  if (typeof input === "string" || input instanceof URL) {
    const path =
      input instanceof URL
        ? fileURLToPath(input)
        : directory && !isAbsolute(input)
          ? join(directory, input)
          : input;
    const text = await files.read(path);
    if (text === null) throw new Error(`batch input ${path} does not exist`);
    lines = parseInputLines(text, build);
  } else {
    lines = validateInputLines(input, undefined, build);
  }
  const resultsPath = directory ? resolve(directory, params.output_name) : null;
  const results = resultsPath
    ? jsonlResults(files, resultsPath)
    : memoryResults();
  const batchId =
    batch_id ??
    (resultsPath
      ? createHash("sha256").update(resultsPath).digest("hex").slice(0, 16)
      : randomUUID());
  const summary = await runBatchWith(params, {
    controller,
    files,
    input: lines,
    results,
    lineScope: baggageLineScope(batchId, baggage),
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onProgress } : {}),
    ...(onResult ? { onResult } : {}),
    ...(checkOutput ? { checkOutput } : {}),
  });
  const latest = new Map<string, BatchResultLine>();
  for (const raw of (await results.read()).split("\n")) {
    if (!raw.trim()) continue;
    const line = JSON.parse(raw) as BatchResultLine;
    latest.set(line.custom_id, line);
  }
  // The current input decides what is returned and in what order: a stored
  // result counts only if it answered this agent and this prompt text.
  const current = lines.flatMap((line) => {
    const result = latest.get(line.custom_id);
    return result &&
      result.batch.input_sha256 === inputFingerprint(params.agent, line)
      ? [result]
      : [];
  });
  return { ...summary, results: current };
}
