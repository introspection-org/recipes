import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";

const InputLine = Type.Object({
  custom_id: Type.String({ minLength: 1 }),
  /** The prompt as written; or `input`, built into one through the agent's `prompt:` spec. */
  prompt: Type.Optional(Type.String()),
  input: Type.Optional(Type.Unknown()),
  /** The caller's own context for the line, copied onto its result unread. */
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  /** Set on a line already built from its `input`, kept when it is validated again. */
  built: Type.Optional(Type.Unknown()),
});

/** What built a line's prompt from its `input`: copied onto its result. */
export interface BatchLineBuild {
  /** `name@version` */
  builder: string;
  applied: string[];
  digest?: string;
  /** What the builder hands back, such as where the next pass resumes. */
  state?: unknown;
}

/** One input: a prompt, run in its own session, identified by the caller's `custom_id`. */
export interface BatchInputLine {
  custom_id: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  built?: BatchLineBuild;
}

/** Builds a line's prompt from its raw `input`. */
export type BuildLinePrompt = (input: unknown) => {
  prompt: string;
  build: BatchLineBuild;
};

/**
 * How a line ended, in the Message Batches vocabulary: `canceled` is a line
 * the stop grace cut off, `skipped` one whose builder found nothing to ask.
 */
export type BatchResultType = "succeeded" | "errored" | "canceled" | "skipped";

/** What the line's session produced. */
export interface BatchResult {
  type: BatchResultType;
  /** The session's final assistant output. */
  output?: string;
  error?: { message: string };
  /** The line's agent run. */
  run_id?: string;
  /** The line's own conversation, when the host gives each line one (`lineScope`). */
  conversation_id?: string;
}

/** The batch's own bookkeeping for a line, apart from the caller's `metadata`. */
export interface BatchRecordInfo {
  /** The line's position in the input; a gap in the results is a record that never ran. */
  record_index: number;
  /** What the line asked (agent + prompt); resume skips a succeeded line only when it still matches. */
  input_sha256: string;
  attempts: number;
}

/** One results line. A line retried by a later run appends again; the last line per `custom_id` wins. */
export interface BatchResultLine {
  custom_id: string;
  result: BatchResult;
  batch: BatchRecordInfo;
  /** The caller's own context for the line, copied from its input unread. */
  metadata?: Record<string, unknown>;
  /** What built the line's prompt from its `input`. */
  built?: BatchLineBuild;
}

/**
 * Check input lines given as values, refusing a malformed line or a repeated
 * `custom_id`. `label(i)` names the i-th value in an error, so a file's
 * errors name its line numbers.
 */
export function validateInputLines(
  values: readonly unknown[],
  label: (index: number) => string = (index) => `input ${index + 1}`,
  build?: BuildLinePrompt,
): BatchInputLine[] {
  const seen = new Set<string>();
  return values.map((value, index) => {
    if (!Check(InputLine, value)) {
      const problems = [...Errors(InputLine, value)]
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; ");
      throw new Error(
        `${label(index)} needs a custom_id and a prompt or an input: ${problems}`,
      );
    }
    if (seen.has(value.custom_id)) {
      throw new Error(`${label(index)} repeats custom_id ${value.custom_id}`);
    }
    seen.add(value.custom_id);
    const metadata = value.metadata ? { metadata: value.metadata } : {};
    if ((value.prompt === undefined) === (value.input === undefined)) {
      throw new Error(`${label(index)} needs exactly one of prompt and input`);
    }
    if (value.prompt === "" && value.built === undefined) {
      throw new Error(`${label(index)} has an empty prompt`);
    }
    if (value.prompt !== undefined) {
      return {
        custom_id: value.custom_id,
        prompt: value.prompt,
        ...metadata,
        ...(value.built !== undefined
          ? { built: value.built as BatchLineBuild }
          : {}),
      };
    }
    if (build === undefined) {
      throw new Error(
        `${label(index)} carries an input, but the agent declares no preprocess: builder to build it`,
      );
    }
    let built: ReturnType<BuildLinePrompt>;
    try {
      built = build(value.input);
    } catch (error) {
      throw new Error(`${label(index)}: ${(error as Error).message}`);
    }
    return {
      custom_id: value.custom_id,
      prompt: built.prompt,
      ...metadata,
      built: built.build,
    };
  });
}

/** Parse the input JSONL, refusing a malformed line or a repeated `custom_id` by line number. */
export function parseInputLines(
  text: string,
  build?: BuildLinePrompt,
): BatchInputLine[] {
  const values: unknown[] = [];
  const lineNumbers: number[] = [];
  text.split("\n").forEach((raw, index) => {
    if (!raw.trim()) return;
    try {
      // `timestamp_ns` keeps its digits: a nanosecond instant is past what a
      // JSON number holds exactly.
      values.push(
        JSON.parse(raw, (key, value, context?: { source?: string }) =>
          key === "timestamp_ns" && context?.source !== undefined
            ? context.source
            : value,
        ),
      );
    } catch (error) {
      throw new Error(`input line ${index + 1} is not JSON: ${String(error)}`);
    }
    lineNumbers.push(index + 1);
  });
  return validateInputLines(
    values,
    (i) => `input line ${lineNumbers[i]}`,
    build,
  );
}

/** The fingerprint of what a line asks: a changed prompt or agent is a different question. */
export function inputFingerprint(agent: string, line: BatchInputLine): string {
  const hash = createHash("sha256")
    .update(agent)
    .update("\0")
    .update(line.prompt);
  // What built the prompt is part of the question: the same prompt with a newer
  // resume state answers again, so its result carries the state to record.
  if (line.built) hash.update("\0").update(JSON.stringify(line.built));
  return hash.digest("hex");
}

/**
 * The `custom_id`s whose latest result line succeeded, keyed to the input
 * fingerprint it answered: a restarted run skips a line only when its
 * fingerprint still matches, so an edited prompt or agent runs again.
 */
export function completedIds(resultsText: string | null): Map<string, string> {
  const latest = new Map<string, BatchResultLine>();
  for (const raw of (resultsText ?? "").split("\n")) {
    if (!raw.trim()) continue;
    const line = JSON.parse(raw) as BatchResultLine;
    latest.set(line.custom_id, line);
  }
  return new Map(
    [...latest]
      .filter(
        ([, line]) =>
          line.result?.type === "succeeded" || line.result?.type === "skipped",
      )
      .map(([id, line]) => [id, line.batch?.input_sha256]),
  );
}
