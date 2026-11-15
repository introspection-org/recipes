import type { AgentRunController } from "../agents.js";
import type { BatchFiles } from "./files.js";
import { AdaptiveLimiter } from "./limiter.js";
import {
  completedIds,
  inputFingerprint,
  parseInputLines,
  validateInputLines,
  type BatchInputLine,
  type BatchResultLine,
  type BatchResultType,
} from "./lines.js";
import { MAX_JSON_REPAIRS, type BatchParams } from "./params.js";
import type { BatchResults } from "./shards.js";

/**
 * What a batch drives: any `AgentRunController`, such as a host's own or
 * Recipes' in-process one. Each line is one `start`; `message` serves the
 * JSON repairs and `close` releases the line's session.
 */
export type BatchRunController = Pick<
  AgentRunController,
  "start" | "wait" | "message" | "close"
>;

/** The run's progress, reported after every line and when the run stops. */
export interface BatchProgress extends BatchSummary {
  state: "running" | "stopping" | "finished";
  remaining: number;
}

export interface BatchRunDeps {
  controller: BatchRunController;
  files: BatchFiles;
  /** The lines to run, or the path of a JSONL file holding them. */
  input: string | readonly unknown[];
  /** Where results are recorded, and read back on a resume. */
  results: BatchResults;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Aborted to stop: no new line starts, and the lines in flight finish. */
  signal?: AbortSignal;
  /**
   * Aborted when a stopping run can wait no longer: the lines still in flight
   * are recorded as failed, so the next run retries them.
   */
  cancel?: AbortSignal;
  /**
   * Called after every line and when the run stops. The core needs nothing
   * from it: a host may checkpoint, persist or copy results here.
   */
  onProgress?: (progress: BatchProgress) => Promise<void>;
  /** Called with each line's result once it is recorded, in the order lines finish. */
  onResult?: (result: BatchResultLine) => Promise<void> | void;
  /**
   * Each line's own conversation, when the host keeps one per line: the id
   * its session records under, and a wrapper the line's session starts
   * inside, so the line's whole exchange can be read back by that id.
   */
  lineScope?: (line: BatchInputLine, record: BatchRecord) => LineScope;
}

/** Where a line sits in its batch: stable across resumes, so a gap in the results names a skipped record. */
export interface BatchRecord {
  index: number;
  count: number;
}

export interface LineScope {
  conversationId: string;
  run<T>(attempt: number, fn: () => Promise<T>): Promise<T>;
}

export interface BatchSummary {
  total: number;
  already_completed: number;
  completed: number;
  failed: number;
  /** Lines left unstarted because the run was stopped or hit its deadline; the next run picks them up. */
  not_started: number;
  /** True when a signal or the deadline ended the run before every line ran. */
  stopped: boolean;
}

/** What the runner reads of a settled run. */
type Settled = Pick<
  Awaited<ReturnType<BatchRunController["wait"]>>,
  "agent_run_id" | "status" | "output" | "error"
> & {
  /** The stop grace ran out before the session settled. */
  canceled?: boolean;
};

/** Why `output` is not JSON, or null when it parses. */
function jsonProblem(output: string | undefined): string | null {
  if (!output?.trim()) return "the reply was empty";
  try {
    JSON.parse(output);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const RATE_LIMITED = /\b429\b|rate[ _-]?limit/i;
const RETRY_BASE_DELAY_MS = 2_000;

/**
 * Run every input line not already completed as a fresh session of
 * `params.agent`, at most `params.concurrency` at once, appending one result
 * line as each finishes. Code decides what runs next and when to stop; the
 * model only ever answers one prompt.
 *
 * The results file is the run's durable state: a line is recorded once its
 * session settles, and a restart skips every line already completed. A crash
 * loses only the lines in flight, which run again (at-least-once).
 */
export async function runBatchWith(
  params: BatchParams,
  deps: BatchRunDeps,
): Promise<BatchSummary> {
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lines: BatchInputLine[];
  if (typeof deps.input === "string") {
    const inputText = await deps.files.read(deps.input);
    if (inputText === null) {
      throw new Error(`batch input ${deps.input} does not exist`);
    }
    lines = parseInputLines(inputText);
  } else {
    lines = validateInputLines(deps.input);
  }
  const done = completedIds(await deps.results.read());
  const recordIndex = new Map(
    lines.map((line, index) => [line.custom_id, index]),
  );
  const fingerprint = new Map(
    lines.map((line) => [line.custom_id, inputFingerprint(params.agent, line)]),
  );
  const queue = lines.filter(
    (line) =>
      !done.has(line.custom_id) ||
      done.get(line.custom_id) !== fingerprint.get(line.custom_id),
  );
  const deadline =
    params.deadline_ms === undefined ? null : now() + params.deadline_ms;
  const limiter = new AdaptiveLimiter(params.concurrency);
  const summary: BatchSummary = {
    total: lines.length,
    already_completed: lines.length - queue.length,
    completed: 0,
    failed: 0,
    not_started: 0,
    stopped: false,
  };

  const stopped = (): boolean =>
    (deps.signal?.aborted ?? false) ||
    (deps.cancel?.aborted ?? false) ||
    (deadline !== null && now() >= deadline);

  // A controller may answer a cancelled wait by rejecting (Recipes'
  // in-process one does) rather than returning the run still running; both
  // mean the session did not settle, so the line is recorded as canceled.
  const waitFor = async (id: string): Promise<Settled> => {
    try {
      return await deps.controller.wait(id, deps.cancel);
    } catch (error) {
      if (deps.cancel?.aborted) return { agent_run_id: id, status: "running" };
      throw error;
    }
  };

  const runOnce = async (line: BatchInputLine): Promise<Settled> => {
    let started: { agent_run_id: string };
    try {
      started = await deps.controller.start({
        name: params.agent,
        prompt: line.prompt,
        label: line.custom_id,
      });
    } catch (error) {
      // A session that cannot open fails its line, not the batch: the lines
      // already running finish and every outcome is recorded.
      const message = error instanceof Error ? error.message : String(error);
      return {
        agent_run_id: "",
        status: "failed",
        error: `session did not start: ${message}`,
      };
    }
    try {
      let settled: Settled = await waitFor(started.agent_run_id);
      for (
        let repair = 1;
        params.output_format === "json" &&
        settled.status === "completed" &&
        repair <= MAX_JSON_REPAIRS;
        repair += 1
      ) {
        const problem = jsonProblem(settled.output);
        if (problem === null) break;
        await deps.controller.message(
          started.agent_run_id,
          `Your reply was not valid JSON (${problem}). Reply again with only the corrected JSON object: no prose, no code fence.`,
        );
        settled = await waitFor(started.agent_run_id);
        if (repair === MAX_JSON_REPAIRS && settled.status === "completed") {
          const still = jsonProblem(settled.output);
          if (still !== null) {
            return {
              ...settled,
              status: "failed",
              error: `output is not JSON after ${MAX_JSON_REPAIRS} repairs: ${still}`,
            };
          }
        }
      }
      if (settled.status === "running") {
        return {
          ...settled,
          status: "failed",
          canceled: true,
          error: "the run stopped before this session settled",
        };
      }
      return settled;
    } finally {
      await deps.controller.close(started.agent_run_id);
    }
  };

  const runLine = async (
    line: BatchInputLine,
  ): Promise<BatchResultLine | null> => {
    const record = {
      index: recordIndex.get(line.custom_id) ?? -1,
      count: lines.length,
    };
    const scope = deps.lineScope?.(line, record);
    const resultLine = (
      settled: Settled,
      attempts: number,
    ): BatchResultLine => {
      const type: BatchResultType =
        settled.status === "completed"
          ? "succeeded"
          : settled.canceled
            ? "canceled"
            : "errored";
      return {
        custom_id: line.custom_id,
        result: {
          type,
          ...(type === "succeeded"
            ? { output: settled.output }
            : {
                error: {
                  message: settled.error ?? `run ended ${settled.status}`,
                },
              }),
          ...(settled.agent_run_id ? { run_id: settled.agent_run_id } : {}),
          ...(scope ? { conversation_id: scope.conversationId } : {}),
        },
        batch: {
          record_index: record.index,
          input_sha256: fingerprint.get(line.custom_id) ?? "",
          attempts,
        },
        ...(line.metadata ? { metadata: line.metadata } : {}),
      };
    };
    // The last attempt that ran, so a stop before the next one still records it.
    let previous: { settled: Settled; attempt: number } | null = null;
    for (let attempt = 1; ; attempt += 1) {
      const release = await limiter.acquire();
      // Capacity can free up after the run stopped: a line that never started
      // stays unstarted for the next run; one that ran keeps its last attempt.
      if (stopped()) {
        release();
        return previous ? resultLine(previous.settled, previous.attempt) : null;
      }
      let settled: Settled;
      try {
        settled = scope
          ? await scope.run(attempt, () => runOnce(line))
          : await runOnce(line);
      } finally {
        release();
      }
      if (settled.status === "completed") {
        limiter.onSuccess();
        return resultLine(settled, attempt);
      }
      const rateLimited = RATE_LIMITED.test(settled.error ?? "");
      if (rateLimited) limiter.onRateLimited();
      if (!rateLimited || attempt >= params.max_attempts || stopped()) {
        return resultLine(settled, attempt);
      }
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      // The attempt ran: a stop that lands during the wait records it, as a
      // stop that landed just before the wait does.
      if (stopped()) return resultLine(settled, attempt);
      previous = { settled, attempt };
    }
  };

  const progress = async (state: BatchProgress["state"]): Promise<void> => {
    const remaining = queue.length - summary.completed - summary.failed;
    await deps.onProgress?.({ ...summary, not_started: 0, state, remaining });
  };
  // One writer: the workers' results are appended in turn, never concurrently.
  let recording: Promise<void> = Promise.resolve();
  const record = (result: BatchResultLine): Promise<void> => {
    recording = recording.then(() =>
      deps.results.append(JSON.stringify(result)),
    );
    return recording;
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length) {
      if (stopped()) return;
      const line = queue[next];
      next += 1;
      const result = await runLine(line);
      // Null: the run stopped before this line started; it counts as not started.
      if (result === null) return;
      await record(result);
      await deps.onResult?.(result);
      if (result.result.type === "succeeded") summary.completed += 1;
      else summary.failed += 1;
      await progress(stopped() ? "stopping" : "running");
    }
  };
  await progress("running");
  await Promise.all(
    Array.from({ length: Math.min(params.concurrency, queue.length) }, worker),
  );
  summary.not_started = queue.length - summary.completed - summary.failed;
  summary.stopped = summary.not_started > 0 || stopped();
  await deps.onProgress?.({
    ...summary,
    state: summary.stopped ? "stopping" : "finished",
    remaining: summary.not_started,
  });
  return summary;
}
