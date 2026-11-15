import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeBatchFiles, type BatchFiles } from "./files.js";
import type { BatchInputLine, BatchResultLine } from "./lines.js";
import { parseBatchParams, type BatchParams } from "./params.js";
import {
  runBatchWith,
  type BatchProgress,
  type BatchRunController,
  type BatchSummary,
} from "./runner.js";
import { jsonlResults, memoryResults } from "./shards.js";

export { AdaptiveLimiter } from "./limiter.js";
export {
  completedIds,
  inputFingerprint,
  parseInputLines,
  validateInputLines,
  type BatchInputLine,
  type BatchRecordInfo,
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
  /** Replaces the local file system. */
  files?: BatchFiles;
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
    files = nodeBatchFiles,
    ...settings
  } = options;
  const params = parseBatchParams(settings);
  const inputPath =
    input instanceof URL
      ? fileURLToPath(input)
      : typeof input === "string" && directory && !isAbsolute(input)
        ? join(directory, input)
        : input;
  const results = directory
    ? jsonlResults(files, join(directory, params.output_name))
    : memoryResults();
  const summary = await runBatchWith(params, {
    controller,
    files,
    input: inputPath,
    results,
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onProgress } : {}),
    ...(onResult ? { onResult } : {}),
  });
  const latest = new Map<string, BatchResultLine>();
  for (const raw of (await results.read()).split("\n")) {
    if (!raw.trim()) continue;
    const line = JSON.parse(raw) as BatchResultLine;
    latest.set(line.custom_id, line);
  }
  return {
    ...summary,
    results: [...latest.values()].sort(
      (a, b) => a.batch.record_index - b.batch.record_index,
    ),
  };
}
