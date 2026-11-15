import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

const InputLine = Type.Object({
  custom_id: Type.String({ minLength: 1 }),
  prompt: Type.String({ minLength: 1 }),
  /** The caller's own context for the line, copied onto its result unread. */
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

/** One input: a prompt, run in its own session, identified by the caller's `custom_id`. */
export type BatchInputLine = Static<typeof InputLine>;

/** How a line ended, in the Message Batches vocabulary: `canceled` is a line the stop grace cut off. */
export type BatchResultType = "succeeded" | "errored" | "canceled";

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
}

/**
 * Check input lines given as values, refusing a malformed line or a repeated
 * `custom_id`. `label(i)` names the i-th value in an error, so a file's
 * errors name its line numbers.
 */
export function validateInputLines(
  values: readonly unknown[],
  label: (index: number) => string = (index) => `input ${index + 1}`,
): BatchInputLine[] {
  const seen = new Set<string>();
  return values.map((value, index) => {
    if (!Check(InputLine, value)) {
      const problems = [...Errors(InputLine, value)]
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; ");
      throw new Error(
        `${label(index)} needs a custom_id and a prompt: ${problems}`,
      );
    }
    if (seen.has(value.custom_id)) {
      throw new Error(`${label(index)} repeats custom_id ${value.custom_id}`);
    }
    seen.add(value.custom_id);
    return {
      custom_id: value.custom_id,
      prompt: value.prompt,
      ...(value.metadata ? { metadata: value.metadata } : {}),
    };
  });
}

/** Parse the input JSONL, refusing a malformed line or a repeated `custom_id` by line number. */
export function parseInputLines(text: string): BatchInputLine[] {
  const values: unknown[] = [];
  const lineNumbers: number[] = [];
  text.split("\n").forEach((raw, index) => {
    if (!raw.trim()) return;
    try {
      values.push(JSON.parse(raw));
    } catch (error) {
      throw new Error(`input line ${index + 1} is not JSON: ${String(error)}`);
    }
    lineNumbers.push(index + 1);
  });
  return validateInputLines(values, (i) => `input line ${lineNumbers[i]}`);
}

/** The fingerprint of what a line asks: a changed prompt or agent is a different question. */
export function inputFingerprint(agent: string, line: BatchInputLine): string {
  return createHash("sha256")
    .update(agent)
    .update("\0")
    .update(line.prompt)
    .digest("hex");
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
      .filter(([, line]) => line.result?.type === "succeeded")
      .map(([id, line]) => [id, line.batch?.input_sha256]),
  );
}
