import { getHeapStatistics } from "node:v8";

import type { AgentRunController } from "../agents.js";
import type { BatchFiles } from "./files.js";
import { AdaptiveLimiter } from "./limiter.js";
import {
  buildInputLine,
  checkInputLine,
  completedIds,
  inputFingerprint,
  parseInputLine,
  type BuildLinePrompt,
  type CheckedInputLine,
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
  "start" | "wait" | "message" | "close" | "forget"
>;

/** The run's progress, reported after every line and when the run stops. */
export interface BatchProgress extends BatchSummary {
  state: "running" | "stopping" | "finished";
  remaining: number;
}

export interface BatchRunDeps {
  controller: BatchRunController;
  files: BatchFiles;
  /** The lines to run, as they arrive, or the path of a JSONL file holding them. */
  input: string | Iterable<unknown> | AsyncIterable<unknown>;
  /**
   * What the lines in flight may hold, in bytes. Default: half the heap free
   * when the batch starts, so a heap sized to its container bounds the batch.
   */
  memoryBudget?: number;
  /** Where the batch reports how it sized itself. Default: one line on stderr. */
  log?: (message: string) => void;
  /** Builds the prompt of a line that carries an `input` (`linePromptBuilder`). */
  buildPrompt?: BuildLinePrompt;
  /** Called once the run ends with each line it reached: its fingerprint and its place in the input. */
  onLines?: (
    lines: ReadonlyMap<string, { fingerprint: string; index: number }>,
  ) => void;
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
   * Why a settled line's output cannot be used, or null when it can. A
   * refused output records the line as errored, so a resumed run retries it.
   */
  checkOutput?: (line: BatchInputLine, output: string) => string | null;
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
  /**
   * Whether the whole input was read, so `total` counts every line. A stopped
   * run over a stream closes it unread, leaving `total` at the lines it took.
   */
  input_complete: boolean;
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

/** The input's lines as values, one at a time, each with the label its errors use. */
async function* inputValues(deps: BatchRunDeps): AsyncGenerator<InputItem> {
  if (typeof deps.input !== "string") {
    let index = 0;
    for await (const value of deps.input) {
      index += 1;
      // A value is charged as its JSON, the size it would be as a line.
      yield {
        value,
        label: `input ${index}`,
        size: JSON.stringify(value)?.length ?? 0,
      };
    }
    return;
  }
  let raws: AsyncIterable<string> | Iterable<string>;
  if (deps.files.lines) {
    const lines = await deps.files.lines(deps.input);
    if (lines === null)
      throw new Error(`batch input ${deps.input} does not exist`);
    raws = lines;
  } else {
    const text = await deps.files.read(deps.input);
    if (text === null)
      throw new Error(`batch input ${deps.input} does not exist`);
    raws = text.split("\n");
  }
  let number = 0;
  for await (const raw of raws) {
    number += 1;
    if (!raw.trim()) continue;
    yield { raw, label: `input line ${number}`, size: raw.length };
  }
}

const mb = (bytes: number) => Math.round(bytes / 1e6);

/** How a batch sized itself, and where each number came from. */
export interface BatchMemory {
  heap_limit_bytes: number;
  /** `--max-old-space-size=N`, when the process was started with it, or Node's own default. */
  heap_limit_source: string;
  heap_used_bytes: number;
  budget_bytes: number;
  budget_source: string;
}

/**
 * The heap this process has, whether it was configured, and what the lines
 * in flight may hold of it. A configured `--max-old-space-size` is the space
 * that runs out, so the budget comes from it; V8's own `heap_size_limit` also
 * counts its young generation, about 200 MB more than can actually be held.
 */
export function batchMemory(configuredBudget?: number): BatchMemory {
  const heap = getHeapStatistics();
  const flag = [
    ...process.execArgv,
    ...(process.env.NODE_OPTIONS ?? "").split(/\s+/),
  ]
    .map((arg) => /^--max[-_]old[-_]space[-_]size=(\d+)$/.exec(arg))
    .find((match) => match !== null);
  const limit = flag ? Number(flag[1]) * 1024 * 1024 : heap.heap_size_limit;
  return {
    heap_limit_bytes: limit,
    heap_limit_source: flag
      ? `configured: --max-old-space-size=${flag[1]}`
      : "detected: Node's default for this machine",
    heap_used_bytes: heap.used_heap_size,
    budget_bytes:
      configuredBudget ??
      Math.max(0, Math.floor((limit - heap.used_heap_size) / 2)),
    budget_source:
      configuredBudget !== undefined
        ? "configured: memoryBudget"
        : "derived: half the heap free at start",
  };
}

/** One input line: already a value, or its text to parse once admitted, and the text's size. */
interface InputItem {
  value?: unknown;
  raw?: string;
  label: string;
  size: number;
}

/**
 * What a line in flight is taken to hold, as a multiple of its text: the
 * text, its parsed input and the build from it.
 */
const LINE_MEMORY_FACTOR = 3;

/** A line's `custom_id`: from its value, or near the start of its text without parsing all of it. */
function customIdOf(
  raw: string | undefined,
  value?: unknown,
): string | undefined {
  const id = (value as { custom_id?: unknown } | null | undefined)?.custom_id;
  if (typeof id === "string") return id;
  const match = /"custom_id"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(
    raw?.slice(0, 1_000) ?? "",
  );
  return match?.[1];
}

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
  const canBuild = deps.buildPrompt !== undefined;
  const done = completedIds(await deps.results.read());
  // Each line's place in the input, assigned as it streams past.
  const recordIndex = new Map<string, number>();
  const fingerprint = new Map<string, string>();
  const deadline =
    params.deadline_ms === undefined ? null : now() + params.deadline_ms;
  const limiter = new AdaptiveLimiter(params.concurrency);
  const summary: BatchSummary = {
    total: 0,
    already_completed: 0,
    completed: 0,
    failed: 0,
    not_started: 0,
    stopped: false,
    input_complete: false,
  };

  let inputError: unknown;
  let inputComplete = false;
  const stopped = (): boolean =>
    inputError !== undefined ||
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
      if (settled.status === "completed" && deps.checkOutput) {
        const problem = deps.checkOutput(line, settled.output ?? "");
        if (problem !== null) {
          return { ...settled, status: "failed", error: problem };
        }
      }
      return settled;
    } finally {
      await deps.controller.close(started.agent_run_id);
      // A batch never reads a line's run again; keeping it would hold every
      // prompt for the life of the controller.
      deps.controller.forget?.(started.agent_run_id);
    }
  };

  const runLine = async (
    line: BatchInputLine,
  ): Promise<BatchResultLine | null> => {
    const record = { index: recordIndex.get(line.custom_id) ?? -1 };
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
        ...(line.built ? { built: line.built } : {}),
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
    const remaining = pending();
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

  // Lines read but not yet answered; the input's total is known when it ends.
  const pending = () =>
    summary.total -
    summary.already_completed -
    summary.completed -
    summary.failed;

  // One pass: each line is checked, built and run as a worker takes it, so at
  // most `concurrency` prompts are held at once.
  const lines = inputValues(deps)[Symbol.asyncIterator]();
  // Every line that is recorded claims its custom_id first: a later line
  // with the same id, valid or not, is counted but never recorded, since a
  // result under the same id would replace the first line's answer.
  // A line's record index is its position in the input, whatever happened
  // to the lines before it.
  let position = -1;
  const claim = (customId: string): boolean => {
    if (recordIndex.has(customId)) return false;
    recordIndex.set(customId, position);
    return true;
  };
  const fail = async (
    customId: string,
    message: string,
    extra: Partial<BatchResultLine> = {},
    claimed = false,
  ) => {
    if (!claimed && !claim(customId)) {
      summary.failed += 1;
      return;
    }
    // Reached, so it is returned with the batch's results.
    fingerprint.set(customId, "");
    const failed: BatchResultLine = {
      custom_id: customId,
      result: { type: "errored", error: { message } },
      batch: {
        record_index: recordIndex.get(customId) ?? -1,
        input_sha256: "",
        attempts: 0,
      },
      ...extra,
    };
    await record(failed);
    await deps.onResult?.(failed);
    summary.failed += 1;
    await progress(stopped() ? "stopping" : "running");
  };
  // Read, check and build the next line. Its raw text and parsed input stay
  // in this call, so they are released once the prompt exists, not held while
  // the line waits on its model.
  // Lines are admitted by size, not count: a worker takes the next line only
  // when what is in flight leaves room for it, so long conversations run with
  // fewer neighbours and only a line larger than the whole budget fails.
  const memory = batchMemory(deps.memoryBudget);
  const budget = memory.budget_bytes;
  (deps.log ?? ((message) => process.stderr.write(`${message}\n`)))(
    `batch memory: heap limit ${mb(memory.heap_limit_bytes)} MB (${memory.heap_limit_source}), ` +
      `${mb(memory.heap_used_bytes)} MB in use at start, ` +
      `${mb(budget)} MB for lines in flight (${memory.budget_source})`,
  );
  let inFlight = 0;
  let waiting: Array<() => void> = [];
  const releaseCharge = (charge: number) => {
    inFlight -= charge;
    const woken = waiting;
    waiting = [];
    woken.forEach((wake) => wake());
  };
  // One worker reads and waits for room at a time, so waiting holds one line.
  let admitting: Promise<void> = Promise.resolve();
  const takeLine = async (): Promise<
    { line: BatchInputLine; charge: number } | "failed" | "end"
  > => {
    const turn = admitting;
    let done!: () => void;
    admitting = new Promise((resolve) => (done = resolve));
    await turn;
    try {
      return await admit();
    } finally {
      done();
    }
  };
  const admit = async (): Promise<
    { line: BatchInputLine; charge: number } | "failed" | "end"
  > => {
    if (inputError !== undefined) return "end";
    let next: IteratorResult<InputItem>;
    try {
      next = await lines.next();
    } catch (error) {
      // The input itself failed: schedule nothing more, let the lines in
      // flight finish and record, and rethrow once they have.
      inputError = error;
      return "end";
    }
    if (next.done) {
      inputComplete = true;
      return "end";
    }
    summary.total += 1;
    position = summary.total - 1;
    const { raw, label, size } = next.value;
    const charge = size * LINE_MEMORY_FACTOR;
    if (charge > budget) {
      await fail(
        customIdOf(raw, next.value.value) ?? label,
        `${label} is ${Math.ceil(size / 1e6)} MB, more than this batch can hold in memory (${Math.floor(budget / LINE_MEMORY_FACTOR / 1e6)} MB a line)`,
      );
      return "failed";
    }
    while (inFlight > 0 && inFlight + charge > budget) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    inFlight += charge;
    const taken = await buildTaken(raw, next.value.value, label);
    if (taken === "failed") releaseCharge(charge);
    return taken === "failed" ? taken : { line: taken, charge };
  };
  const buildTaken = async (
    raw: string | undefined,
    given: unknown,
    label: string,
  ): Promise<BatchInputLine | "failed"> => {
    let value: unknown;
    try {
      value = raw === undefined ? given : parseInputLine(raw, label);
    } catch (error) {
      await fail(customIdOf(raw) ?? label, (error as Error).message);
      return "failed";
    }
    // A line that cannot run fails alone: earlier lines keep their answers.
    let checked: CheckedInputLine;
    try {
      checked = checkInputLine(value, label, canBuild);
    } catch (error) {
      const id = (value as { custom_id?: unknown } | null)?.custom_id;
      await fail(typeof id === "string" ? id : label, (error as Error).message);
      return "failed";
    }
    if (!claim(checked.custom_id)) {
      summary.failed += 1;
      return "failed";
    }
    try {
      return buildInputLine(checked, deps.buildPrompt);
    } catch (error) {
      await fail(
        checked.custom_id,
        `could not build the prompt: ${(error as Error).message}`,
        checked.metadata ? { metadata: checked.metadata } : {},
        true,
      );
      return "failed";
    }
  };
  const worker = async (): Promise<void> => {
    while (!stopped()) {
      const taken = await takeLine();
      if (taken === "end") return;
      if (taken === "failed") continue;
      const { line, charge } = taken;
      try {
        const lineFingerprint = inputFingerprint(params.agent, line);
        fingerprint.set(line.custom_id, lineFingerprint);
        if (done.get(line.custom_id) === lineFingerprint) {
          summary.already_completed += 1;
          continue;
        }
        // A builder that found nothing to ask records its state without a session.
        const result =
          line.prompt === ""
            ? {
                custom_id: line.custom_id,
                result: { type: "skipped" as const },
                batch: {
                  record_index: recordIndex.get(line.custom_id) ?? -1,
                  input_sha256: lineFingerprint,
                  attempts: 0,
                },
                ...(line.metadata ? { metadata: line.metadata } : {}),
                ...(line.built ? { built: line.built } : {}),
              }
            : await runLine(line);
        // Null: the run stopped before this line started; it counts as not started.
        if (result === null) return;
        await record(result);
        await deps.onResult?.(result);
        if (
          result.result.type === "succeeded" ||
          result.result.type === "skipped"
        ) {
          summary.completed += 1;
        } else summary.failed += 1;
        await progress(stopped() ? "stopping" : "running");
      } finally {
        releaseCharge(charge);
      }
    }
  };
  await progress("running");
  await Promise.all(Array.from({ length: params.concurrency }, worker));
  if (!inputComplete && inputError === undefined) {
    if (typeof deps.input === "string") {
      // A file ends: count the lines a stopped run left for the next one,
      // reading them without parsing.
      for (
        let next = await lines.next();
        !next.done;
        next = await lines.next()
      ) {
        summary.total += 1;
      }
      inputComplete = true;
    } else {
      // A stream may never end: close it rather than wait for the rest.
      await lines.return(undefined);
    }
  }
  summary.input_complete = inputComplete;
  summary.not_started = pending();
  summary.stopped = summary.not_started > 0 || !inputComplete || stopped();
  await deps.onProgress?.({
    ...summary,
    state: summary.stopped ? "stopping" : "finished",
    remaining: summary.not_started,
  });
  deps.onLines?.(
    new Map(
      [...fingerprint].map(([id, value]) => [
        id,
        { fingerprint: value, index: recordIndex.get(id) ?? -1 },
      ]),
    ),
  );
  if (inputError !== undefined) throw inputError;
  return summary;
}
