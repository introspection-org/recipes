import {
  canonical,
  TOOL_RESULT_TRUNCATE_BYTES,
  type JudgeInput,
} from "./trajectory.js";

/** A feedback event a `feedback` matcher reads; its fields are matched by name. */
export type JudgeFeedbackEvent = Record<string, unknown>;

interface GateMessage {
  ordinal: number;
  agent: string;
  turn: number;
  role: "system" | "user" | "assistant";
  text: string;
  ref: string;
}

interface GateToolCall {
  ordinal: number;
  agent: string;
  turn: number;
  name: string;
  status: "ok" | "error";
  ref: string;
  truncated: boolean;
  args?: unknown;
  result?: unknown;
}

/** What a judge's `on:` matchers see of a conversation. */
export interface GateView {
  messages: GateMessage[];
  tool_calls: GateToolCall[];
  feedback_events: JudgeFeedbackEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueBytes(value: unknown): number {
  if (value === undefined || value === null) return 0;
  return Buffer.byteLength(
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

/**
 * The messages and executed tool calls a gate matches. A tool call counts
 * only once it has a result: a request alone is transcript evidence, not an
 * executed tool event.
 */
export function gateView(
  input: JudgeInput,
  feedbackEvents: readonly JudgeFeedbackEvent[] = [],
): GateView {
  const results = new Map<string, { content: unknown; error?: string }>();
  for (const event of input.trajectory) {
    if (event.type === "tool_result") {
      results.set(event.tool_call_id, {
        content: event.content,
        ...(event.error ? { error: event.error.message } : {}),
      });
    }
  }
  const messages: GateMessage[] = [];
  const toolCalls: GateToolCall[] = [];
  let turn = 0;
  let ordinal = 0;
  for (const event of input.trajectory) {
    if (event.type === "message") {
      if (event.role === "user") turn += 1;
      messages.push({
        ordinal,
        agent: "agent",
        turn,
        role: event.role,
        text: event.content,
        ref: `trajectory-${ordinal}`,
      });
      ordinal += 1;
    } else if (event.type === "tool_call") {
      const settled = results.get(event.id);
      if (!settled) continue;
      const result = settled.error ?? settled.content;
      toolCalls.push({
        ordinal,
        agent: "agent",
        turn,
        name: event.name,
        status: settled.error === undefined ? "ok" : "error",
        ref: event.id,
        truncated: valueBytes(result) > TOOL_RESULT_TRUNCATE_BYTES,
        ...(event.arguments !== undefined ? { args: event.arguments } : {}),
        ...(result !== undefined ? { result } : {}),
      });
      ordinal += 1;
    }
  }
  if (input.system_instructions?.trim()) {
    messages.push({
      ordinal,
      agent: "agent",
      turn: 0,
      role: "system",
      text: input.system_instructions,
      ref: `system-${ordinal}`,
    });
  }
  return {
    messages,
    tool_calls: toolCalls,
    feedback_events: [...feedbackEvents],
  };
}

const EXACT_FIELDS = new Set([
  "name",
  "role",
  "status",
  "source",
  "channel",
  "surface",
  "message_id",
  "turn_id",
  "response_id",
  "user_id",
  "anonymous_id",
  "agent_name",
  "agent_id",
  "service_name",
]);

function textLike(path: string): boolean {
  return (
    path === "text" ||
    path === "comments" ||
    path.startsWith("args.") ||
    path.startsWith("result.") ||
    path.startsWith("attributes.")
  );
}

function isResultPath(path: string): boolean {
  return path === "result" || path.startsWith("result.");
}

function readParts(value: unknown, head: string, rest: string[]): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => readParts(item, head, rest));
  }
  if (!isRecord(value) || !(head in value)) return [];
  const next = value[head];
  if (rest.length === 0) return [next];
  const joined = rest.join(".");
  if (isRecord(next) && joined in next) return [next[joined]];
  return readParts(next, rest[0]!, rest.slice(1));
}

/** Every value at a dotted path; a key that itself contains dots wins over descending. */
function readPath(value: unknown, path: string): unknown[] {
  if (isRecord(value) && path in value) return [value[path]];
  const [head, ...rest] = path.split(".");
  return readParts(value, head!, rest);
}

const REGEX_FLAGS = new Set(["i", "m", "s", "u"]);

/** A `/pattern/flags` target as a regular expression, or null when it is a plain string. */
function regexLiteral(target: string): RegExp | null {
  if (!target.startsWith("/")) return null;
  const end = target.lastIndexOf("/");
  if (end === 0) return null;
  const flags = [...target.slice(end + 1)];
  if (!flags.every((flag) => REGEX_FLAGS.has(flag))) {
    throw new Error(
      `unsupported regex flags in "${target}"; a judge gate supports i, m, s and u`,
    );
  }
  if (new Set(flags).size !== flags.length) {
    throw new Error(`duplicate regex flag in "${target}"`);
  }
  const own = flags.filter((flag) => flag !== "u").join("");
  const pattern = target.slice(1, end);
  // Unicode sets mode first: it reads the class set operations (`--`, `&&`)
  // gate patterns may use. Never the legacy mode, which would match a
  // pattern it cannot parse as something else instead of refusing it.
  for (const mode of ["v", "u"]) {
    try {
      return new RegExp(pattern, own + mode);
    } catch {
      // Try the next mode.
    }
  }
  throw new Error(`invalid regex "${target}"`);
}

function scalarString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number")
    return String(value);
  return JSON.stringify(canonical(value));
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function scalarMatches(path: string, value: unknown, target: unknown): boolean {
  if (Array.isArray(target)) {
    return target.some((one) => scalarMatches(path, value, one));
  }
  if (typeof target !== "string") return sameValue(value, target);
  const regex = regexLiteral(target);
  if (regex) {
    const text = scalarString(value);
    return text !== null && regex.test(text);
  }
  if (typeof value !== "string") return sameValue(value, target);
  if (EXACT_FIELDS.has(path) || !textLike(path)) return value === target;
  return value.toLowerCase().includes(target.toLowerCase());
}

function itemMatches(
  item: unknown,
  spec: Record<string, unknown> | undefined,
): boolean {
  if (!spec) return true;
  for (const [path, target] of Object.entries(spec)) {
    if (path === "event") {
      throw new Error("`event` belongs beside `match`, not inside it");
    }
    const values = readPath(item, path);
    if (!values.some((value) => scalarMatches(path, value, target))) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a judge applies to a conversation. `on` absent or empty means
 * always; otherwise any one matcher suffices, and every field of a matcher's
 * `match` must hold on one event.
 *
 * A tool matcher that tests a result cannot decide a call whose result was
 * captured truncated. If such a call would otherwise match and no other
 * event does, the gate throws rather than guess.
 */
export function evaluateGate(on: unknown, view: GateView): boolean {
  if (on === null || on === undefined) return true;
  if (
    Array.isArray(on)
      ? on.length === 0
      : isRecord(on) && Object.keys(on).length === 0
  ) {
    return true;
  }
  if (!Array.isArray(on)) {
    throw new Error("judge `on` must be a list of event matchers");
  }
  let indeterminate = false;
  for (const matcher of on) {
    if (!isRecord(matcher) || typeof matcher.event !== "string") {
      throw new Error("each `on` entry must be `{ event, match? }`");
    }
    const spec = isRecord(matcher.match) ? matcher.match : undefined;
    if (matcher.event === "tool") {
      const resultPaths = spec ? Object.keys(spec).filter(isResultPath) : [];
      const withoutResult = spec
        ? Object.fromEntries(
            Object.entries(spec).filter(([path]) => !isResultPath(path)),
          )
        : undefined;
      for (const call of view.tool_calls) {
        if (call.truncated && resultPaths.length > 0) {
          if (itemMatches(call, withoutResult)) indeterminate = true;
          continue;
        }
        if (itemMatches(call, spec)) return true;
      }
      continue;
    }
    const items =
      matcher.event === "message"
        ? view.messages
        : matcher.event === "feedback"
          ? view.feedback_events
          : null;
    if (items === null) {
      throw new Error(
        `judge \`on\` event "${matcher.event}" is not message, tool or feedback`,
      );
    }
    if (items.some((item) => itemMatches(item, spec))) return true;
  }
  if (indeterminate) {
    throw new Error("judge gate cannot inspect a truncated tool result");
  }
  return false;
}
