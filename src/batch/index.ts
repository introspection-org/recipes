import { isAbsolute, join } from "node:path";
import { nodeBatchFiles, type BatchFiles } from "./files.js";
import { parseBatchParams } from "./params.js";
import {
  runBatch,
  type BatchProgress,
  type BatchRunController,
  type BatchSummary,
} from "./runner.js";
import { jsonlResults } from "./shards.js";

export { AdaptiveLimiter } from "./limiter.js";
export {
  completedIds,
  inputFingerprint,
  parseInputLines,
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
  runBatch,
  type BatchProgress,
  type BatchRecord,
  type BatchRunController,
  type BatchRunDeps,
  type BatchSummary,
  type LineScope,
} from "./runner.js";
export {
  jsonlResults,
  ResultShards,
  shardName,
  type BatchResults,
} from "./shards.js";
export { nodeBatchFiles, type BatchFiles } from "./files.js";

/** Options for `runBatchFromFiles`. */
export interface RunBatchFromFilesOptions {
  /** The batch's settings; validated, defaults filled. */
  params: unknown;
  /** Runs each line; Recipes' in-process controller or a host's own. */
  controller: BatchRunController;
  /** Resolves a relative `input_path`, and holds the results file. */
  directory: string;
  /** Aborted to stop: no new line starts, and the lines in flight finish. */
  signal?: AbortSignal;
  onProgress?: (progress: BatchProgress) => Promise<void>;
  files?: BatchFiles;
}

/**
 * Run a batch from local files: input from `input_path`, results appended to
 * `<directory>/<output_name>`, resumable by running again. Self-contained:
 * nothing outside the directory is read or written.
 */
export async function runBatchFromFiles(
  options: RunBatchFromFilesOptions,
): Promise<BatchSummary> {
  const params = parseBatchParams(options.params);
  const files = options.files ?? nodeBatchFiles;
  const inputPath = isAbsolute(params.input_path)
    ? params.input_path
    : join(options.directory, params.input_path);
  return runBatch(params, {
    controller: options.controller,
    files,
    inputPath,
    results: jsonlResults(files, join(options.directory, params.output_name)),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
}
