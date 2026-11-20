import { createHash } from "node:crypto";

/** The version of the judge evidence a `JudgeInput` carries. */
const TRAJECTORY_SCHEMA_VERSION = 2;
/** Records past this are refused, so one conversation cannot exhaust a run. */
const MAX_JUDGE_INPUT_RECORDS = 20_000;
/** A tool result larger than this was captured truncated: a gate cannot inspect it. */
export const TOOL_RESULT_TRUNCATE_BYTES = 4096;

interface TrajectoryError {
  type: string;
  message: string;
}

/** A runner-neutral agent transcript event: what a judge reads and a gate matches. */
export type TrajectoryEvent =
  | {
      type: "message";
      role: "user" | "assistant";
      content: string;
      timestamp?: string;
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments?: Record<string, unknown>;
      timestamp?: string;
    }
  | {
      type: "tool_result";
      tool_call_id: string;
      name?: string;
      content?: unknown;
      error?: TrajectoryError;
      timestamp?: string;
    };

/** One record of a conversation's trajectory export, keyed by `role`. */
export type ReplayTrajectoryRecord =
  | { role: "meta"; source: string; model?: string; [key: string]: unknown }
  | { role: "user"; content: string; timestamp: string }
  | { role: "reasoning"; content: string; timestamp: string }
  | {
      role: "assistant";
      content?: string | null;
      timestamp: string;
      tool_calls?: { id: string; name: string; args: string }[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
      timestamp: string;
      ok?: boolean;
    };

/** The evidence one judge run grades. */
export interface JudgeInput {
  schema_version: number;
  trajectory: TrajectoryEvent[];
  system_instructions?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A tool result's text as the JSON it holds, or the text itself. */
export function parseMaybeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * A trajectory export as judge evidence. Reasoning and meta records are not
 * evidence; a tool call's arguments arrive as a JSON string and are parsed.
 */
export function normalizeReplayTrajectory(
  records: readonly ReplayTrajectoryRecord[],
): TrajectoryEvent[] {
  const names = new Map<string, string>();
  for (const record of records) {
    if (record.role !== "assistant") continue;
    for (const call of record.tool_calls ?? []) names.set(call.id, call.name);
  }
  const events: TrajectoryEvent[] = [];
  for (const record of records) {
    if (record.role === "user") {
      events.push({
        type: "message",
        role: "user",
        content: record.content,
        timestamp: record.timestamp,
      });
    } else if (record.role === "assistant") {
      if (record.content) {
        events.push({
          type: "message",
          role: "assistant",
          content: record.content,
          timestamp: record.timestamp,
        });
      }
      for (const call of record.tool_calls ?? []) {
        let args: unknown;
        try {
          args = JSON.parse(call.args);
        } catch {
          throw new Error(
            `trajectory tool call "${call.id}" arguments are invalid JSON`,
          );
        }
        events.push({
          type: "tool_call",
          id: call.id,
          name: call.name,
          arguments: args as Record<string, unknown>,
          timestamp: record.timestamp,
        });
      }
    } else if (record.role === "tool") {
      const failed = record.ok === false;
      const name = names.get(record.tool_call_id);
      events.push({
        type: "tool_result",
        tool_call_id: record.tool_call_id,
        ...(name ? { name } : {}),
        ...(failed
          ? { error: { type: "ToolError", message: record.content } }
          : { content: parseMaybeJson(record.content) }),
        timestamp: record.timestamp,
      });
    }
  }
  return events;
}

/**
 * Judge evidence from either form a caller holds: a trajectory export's
 * `role` records, or events already normalized (`type`).
 */
export function toJudgeInput(
  trajectory: readonly unknown[],
  systemInstructions?: string,
): JudgeInput {
  const replay = trajectory.some(
    (record) =>
      isRecord(record) &&
      typeof record.role === "string" &&
      !("type" in record),
  );
  const input: JudgeInput = {
    schema_version: TRAJECTORY_SCHEMA_VERSION,
    trajectory: replay
      ? normalizeReplayTrajectory(trajectory as ReplayTrajectoryRecord[])
      : (trajectory as TrajectoryEvent[]),
    ...(systemInstructions?.trim()
      ? { system_instructions: systemInstructions }
      : {}),
  };
  validateJudgeInput(input);
  return input;
}

const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** Refuse evidence a judge could not read consistently; the error says what is wrong. */
export function validateJudgeInput(input: JudgeInput): void {
  if (input.trajectory.length > MAX_JUDGE_INPUT_RECORDS) {
    throw new Error(
      `judge input trajectory exceeds the ${MAX_JUDGE_INPUT_RECORDS}-record limit`,
    );
  }
  if (input.schema_version !== TRAJECTORY_SCHEMA_VERSION) {
    throw new Error(
      `judge input requires trajectory schema version ${TRAJECTORY_SCHEMA_VERSION}`,
    );
  }
  const calls = new Set<string>();
  for (const event of input.trajectory) {
    if (!isRecord(event)) throw new Error("trajectory events must be objects");
    if (event.timestamp !== undefined && !TIMESTAMP.test(event.timestamp)) {
      throw new Error("trajectory timestamps must be ISO-8601 timestamps");
    }
    if (event.type === "message") {
      if (
        (event.role !== "user" && event.role !== "assistant") ||
        typeof event.content !== "string"
      ) {
        throw new Error(
          "trajectory messages need a user or assistant role and text content",
        );
      }
    } else if (event.type === "tool_call") {
      if (!event.id?.trim() || !event.name?.trim()) {
        throw new Error("trajectory tool calls require non-empty id and name");
      }
      if (event.arguments !== undefined && !isRecord(event.arguments)) {
        throw new Error(
          `trajectory tool call "${event.id}" arguments must encode a JSON object`,
        );
      }
      if (calls.has(event.id)) {
        throw new Error(
          `trajectory contains duplicate tool call id "${event.id}"`,
        );
      }
      calls.add(event.id);
    } else if (event.type !== "tool_result") {
      throw new Error(
        `trajectory event type "${String((event as { type?: unknown }).type)}" is not message, tool_call or tool_result`,
      );
    }
  }
  for (const event of input.trajectory) {
    if (event.type === "tool_result" && !calls.has(event.tool_call_id)) {
      throw new Error(
        `trajectory tool result references unknown call "${event.tool_call_id}"`,
      );
    }
  }
}

/** Sort object keys at every depth, so a transcript and its hash do not depend on key order. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

/** The identity of what a judge read: the same evidence hashes the same in every run. */
export function evidenceHash(input: JudgeInput): string {
  validateJudgeInput(input);
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          trajectory: input.trajectory,
          system_instructions: input.system_instructions ?? null,
        }),
      ),
    )
    .digest("hex");
}
