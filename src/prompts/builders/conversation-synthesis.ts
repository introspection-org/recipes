import { createHash } from "node:crypto";

import type { PromptBuilder } from "../builder.js";
import { withinBudget } from "../builder.js";
import {
  cpHead,
  cpLength,
  cpTail,
  isoMicros,
  microsToNanos,
  pyDumps,
  pydanticDatetime,
  pyFloatField,
  pyRstrip,
  pyStr,
  pyStrip,
  squashSpace,
  xmlEscape,
  xmlQuoteAttr,
} from "../pycompat.js";

/**
 * `conversation_synthesis@1`: one conversation, from the turns past its resume
 * cursor, as the case observation synthesis reads, with the plan its next
 * segment resumes from. A port of the data plane's Python case builder
 * (`observation_synthesis_context.py`, `render_case_prompt`, `build_segment`),
 * held to it byte for byte by `test/conversation-synthesis-parity.test.ts`.
 */

/** A message part as the conversation API returns it, discriminated by `type`. */
export interface ConversationPart {
  type: string;
  [key: string]: unknown;
}

export interface ConversationMessage {
  role: string;
  parts: ConversationPart[];
  response_id?: string | null;
  [key: string]: unknown;
}

/** One model call: the messages new to its input window and what it answered. */
export interface ConversationModelCall {
  span_id: string;
  response_id?: string | null;
  timestamp?: string | null;
  /** Unix nanoseconds; a string or bigint keeps the precision a JSON number loses. */
  timestamp_ns?: string | number | bigint | null;
  input_new_messages: ConversationMessage[];
  input_message_count?: number;
  output_messages: ConversationMessage[];
}

/** Where the previous segment stopped. */
export interface ResumeState {
  watermark: string;
  cursor?: string | null;
  segment: number;
  tail_fingerprints?: string[];
  last_input_count?: number;
  completed_at?: string | null;
}

export interface PriorObservation {
  lens: string;
  label?: string | null;
  summary?: string | null;
}

export interface ConversationSynthesisInput {
  conversation_id: string;
  completed_at: string;
  model_calls: ConversationModelCall[];
  watermark?: ResumeState | null;
  prior_observations?: PriorObservation[];
  prior_resolution?: { id: string } | null;
  span_count?: number;
  error_count?: number;
  duration_ms?: number;
  service_name?: string | null;
  agent_name?: string | null;
  model?: string | null;
  last_error_message?: string | null;
}

export interface SegmentPlan {
  conversation_id: string;
  completed_at: string;
  digest: string;
  segment_start: string;
  segment: number;
  watermark_next: ResumeState;
  prior_resolution?: { id: string };
}

/** Why a conversation has no segment to ask this run. */
export interface SegmentSkip {
  drafts: readonly [];
  model: "";
  hashes: Record<string, never>;
  segment: number;
  watermark_next?: ResumeState;
  skipped?: string;
}

export type ConversationSynthesisState =
  { plan: SegmentPlan } | { outcome: SegmentSkip };

// What synthesis has always run, at the Python original's limits.
const MESSAGE_MAX_CHARS = 6_000;
const TRANSCRIPT_MAX_TOKENS = 300_000;
const TRANSCRIPT_HEAD_MESSAGES = 10;
const SLIM_HEAD_CHARS = 1_500;
const SLIM_TAIL_CHARS = 500;
const SLIM_PROTECTED_TAIL = 8;

const TAIL_FINGERPRINT_LIMIT = 50;
const DIAGNOSTIC_EVENT_LIMIT = 120;
const DIAGNOSTIC_EVENT_TEXT_LIMIT = 2_000;
const CHARS_PER_TOKEN = 3;
const SLIM_MARKER = " […] ";

const SUMMARY_PATTERNS =
  /(?<![\p{L}\p{N}_])(summary|summarized|previous context|conversation so far|compact|compaction|continue from|continuation|prior context|earlier conversation)(?![\p{L}\p{N}_])/iu;
const MEDIA_PART_TYPES = new Set([
  "image-url",
  "audio-url",
  "video-url",
  "document-url",
  "binary",
  "blob",
  "uri",
  "file",
]);
const GENERIC_IMAGE_PART_TYPES = new Set(["image", "input_image", "image_url"]);
const GENERIC_FILE_PART_TYPES = new Set(["file", "input_file", "attachment"]);
const GENERIC_CONTENT_KEYS = [
  "content",
  "text",
  "summary",
  "response",
  "result",
  "arguments",
  "image_url",
  "url",
  "file",
  "metadata",
];

interface MessageSource {
  kind: string;
  span_id: string;
  timestamp?: string;
  message_hash?: string;
  response_id?: string;
  suspected_compaction_ref?: string;
}

interface CaseMessage {
  ref: string;
  role: string;
  content: string;
  content_status: "complete" | "truncated";
  content_truncated?: true;
  part_types: string[];
  source: MessageSource;
  suspected_compaction_ref?: string;
  compaction_parts?: ConversationPart[];
  occurrence_count: number;
  last_seen_source?: MessageSource;
}

/** Field order is the Python model's: an event with no detail renders as its JSON. */
interface DiagnosticEvent {
  ref?: string;
  message_ref?: string;
  message_role?: string;
  span_id?: string;
  timestamp?: string;
  kind: string;
  tool_name?: string;
  tool_call_id?: string;
  input?: string;
  status?: string;
  output?: string;
  content?: string;
  detail?: string;
}

/** Top-level `None` keys dropped, as the API's message and part models serialize. */
function omitNone<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => item !== null && item !== undefined,
    ),
  ) as T;
}

const jsonForHash = (value: unknown) =>
  pyDumps(value, { sortKeys: true, compact: true });

function compactMapping(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return jsonForHash(value);
  }
  return jsonForHash(
    Object.fromEntries(
      Object.entries(value).filter(
        ([, item]) =>
          item !== null &&
          item !== undefined &&
          item !== "" &&
          !(Array.isArray(item) && item.length === 0),
      ),
    ),
  );
}

const textOf = (value: unknown): string =>
  typeof value === "string" ? value : "";

function partText(part: ConversationPart): string {
  const type = part.type;
  if (type === "text") return textOf(part.content);
  if (type === "compaction") return textOf(part.content) || "[compaction]";
  if (type === "tool_call" || type === "tool_call_response") {
    const details = [part.name, part.id]
      .filter((item) => item)
      .map(String)
      .join(" ");
    const prefix = details ? `[${type} ${details}]` : `[${type}]`;
    const payload = type === "tool_call" ? part.arguments : part.response;
    return `${prefix} ${compactMapping(payload !== null && payload !== undefined ? payload : part)}`;
  }
  if (type === "thinking" || type === "reasoning") {
    return pyRstrip(`[${type}] ${textOf(part.content)}`);
  }
  if (
    MEDIA_PART_TYPES.has(type) ||
    GENERIC_IMAGE_PART_TYPES.has(type) ||
    GENERIC_FILE_PART_TYPES.has(type)
  ) {
    return `[${type} provided]`;
  }
  const key = GENERIC_CONTENT_KEYS.find(
    (name) => part[name] !== null && part[name] !== undefined,
  );
  const content = key === undefined ? part : part[key];
  return typeof content === "string"
    ? `[${type}] ${content}`
    : `[${type}] ${compactMapping(content)}`;
}

function messageContent(message: ConversationMessage): string {
  return squashSpace(message.parts.map(partText).join("\n"));
}

function partTypes(message: ConversationMessage): string[] {
  const types: string[] = [];
  for (const part of message.parts)
    if (!types.includes(part.type)) types.push(part.type);
  return types;
}

function excerpt(value: unknown): string {
  const rendered = typeof value === "string" ? value : compactMapping(value);
  const length = cpLength(rendered);
  if (length <= DIAGNOSTIC_EVENT_TEXT_LIMIT) return rendered;
  return `${cpHead(rendered, DIAGNOSTIC_EVENT_TEXT_LIMIT)}... [truncated ${length - DIAGNOSTIC_EVENT_TEXT_LIMIT} chars]`;
}

function toolResponseStatus(result: unknown): string | undefined {
  if (result === null || typeof result !== "object" || Array.isArray(result))
    return undefined;
  for (const key of [
    "status",
    "status_code",
    "exit_code",
    "returncode",
    "error",
    "exception",
  ]) {
    const value = (result as Record<string, unknown>)[key];
    if (value !== null && value !== undefined && value !== "")
      return `${key}=${pyStr(value)}`;
  }
  return undefined;
}

function diagnosticEvents(
  message: ConversationMessage,
  caseMessage: CaseMessage,
): DiagnosticEvent[] {
  const events: DiagnosticEvent[] = [];
  for (const part of message.parts) {
    let event: DiagnosticEvent | undefined;
    if (part.type === "tool_call") {
      event = {
        kind: "tool_call",
        tool_name: typeof part.name === "string" ? part.name : undefined,
        tool_call_id: typeof part.id === "string" ? part.id : undefined,
        input: excerpt(part.arguments ?? {}),
      };
    } else if (part.type === "tool_call_response") {
      event = {
        kind: "tool_response",
        tool_name: typeof part.name === "string" ? part.name : undefined,
        tool_call_id: typeof part.id === "string" ? part.id : undefined,
        status: toolResponseStatus(part.response),
        output: excerpt(
          part.response !== null && part.response !== undefined
            ? part.response
            : part,
        ),
      };
    } else if (part.type === "thinking" || part.type === "reasoning") {
      event = {
        kind: part.type,
        content: excerpt(textOf(part.content)) || undefined,
      };
    } else if (part.type === "file" || GENERIC_FILE_PART_TYPES.has(part.type)) {
      event = { kind: "file_provided" };
    } else if (GENERIC_IMAGE_PART_TYPES.has(part.type)) {
      event = { kind: "image_provided" };
    }
    if (event === undefined) continue;
    events.push(
      omitNone({
        ref: undefined,
        message_ref: caseMessage.ref,
        message_role: caseMessage.role,
        span_id: caseMessage.source.span_id || undefined,
        timestamp: caseMessage.source.timestamp,
        ...event,
      }),
    );
  }
  return events;
}

function fingerprint(message: ConversationMessage): string {
  const payload = { role: message.role, parts: message.parts.map(omitNone) };
  return createHash("sha256")
    .update(jsonForHash(payload))
    .digest("hex")
    .slice(0, 24);
}

const compactionParts = (message: ConversationMessage) =>
  message.parts.filter((part) => part.type === "compaction");

function isCompactionMessage(message: ConversationMessage): boolean {
  if (compactionParts(message).length > 0) return true;
  const content = messageContent(message);
  return Boolean(content) && SUMMARY_PATTERNS.test(content);
}

function isCompactionBoundary(
  previous: number,
  current: number,
  window: ConversationMessage[],
): boolean {
  if (window.some((message) => compactionParts(message).length > 0))
    return true;
  if (previous < 3 || current === 0 || window.length === 0) return false;
  const sharpDrop =
    current === 1 || current <= Math.max(2, Math.floor(previous / 4));
  return sharpDrop && (current <= 5 || window.some(isCompactionMessage));
}

/** `len(json.dumps(...))` of what Python estimates: the dumped case messages. */
const estimateChars = (value: unknown) => cpLength(pyDumps(value));
const estimateTokens = (value: unknown) =>
  Math.max(1, Math.floor(estimateChars(value) / CHARS_PER_TOKEN));

interface Turn {
  call: ConversationModelCall;
  ns?: bigint;
  micros?: number;
}

function turnOf(call: ConversationModelCall): Turn {
  const micros = call.timestamp ? isoMicros(call.timestamp) : undefined;
  const ns =
    call.timestamp_ns !== null && call.timestamp_ns !== undefined
      ? BigInt(call.timestamp_ns)
      : micros !== undefined
        ? microsToNanos(micros)
        : undefined;
  return { call, ns, micros };
}

function cursorNanos(
  state: ResumeState | null | undefined,
): { ns: bigint; spanId: string } | undefined {
  if (!state) return undefined;
  if (state.cursor) {
    try {
      const token = JSON.parse(
        Buffer.from(state.cursor, "base64url").toString("utf8"),
      ) as { i?: string; v?: string };
      if (token.v !== undefined) {
        const ns = /^-?\d+$/.test(token.v)
          ? BigInt(token.v)
          : microsToNanos(isoMicros(token.v));
        return { ns, spanId: token.i ?? "" };
      }
    } catch {
      // An unreadable cursor falls back to the watermark, as the Python decoder does.
    }
  }
  return { ns: microsToNanos(isoMicros(state.watermark)), spanId: "" };
}

function encodeCursor(spanId: string, ns: bigint): string {
  const json = pyDumps(
    { i: spanId, s: "created_at", d: "asc", v: ns.toString() },
    { compact: true, ensureAscii: true },
  );
  return Buffer.from(json, "utf8").toString("base64url");
}

function truncateContent(content: string, maxChars: number): string {
  const length = cpLength(content);
  if (length <= maxChars) return content;
  return `${cpHead(content, maxChars)}... [message truncated ${length - maxChars} chars]`;
}

function truncateToBudget(
  message: CaseMessage,
  maxChars: number,
): CaseMessage | undefined {
  if (maxChars < 500) return undefined;
  const content = message.content;
  const length = cpLength(content);
  const overhead = estimateChars({ ...message, content: "" }) + 200;
  let budget = maxChars - overhead;
  if (budget <= 100) return undefined;
  const cut = (units: number) =>
    `${cpHead(content, units)}... [truncated ${Math.max(0, length - units)} chars]`;
  const capped: CaseMessage = {
    ...message,
    content: cut(budget),
    content_truncated: true,
  };
  while (estimateChars(capped) > maxChars && budget > 100) {
    budget = Math.floor(budget / 2);
    capped.content = cut(budget);
  }
  return estimateChars(capped) > maxChars ? undefined : capped;
}

/** Keep the opening messages, then fill from the tail backwards, within `maxTokens`. */
function capTranscript(
  messages: CaseMessage[],
  maxTokens: number,
  headProtected: number,
): CaseMessage[] {
  if (estimateTokens(messages) <= maxTokens) return messages;
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const selected = new Map<string, CaseMessage>();
  let used = 2;
  const add = (message: CaseMessage, force: boolean) => {
    if (selected.has(message.ref) || used >= maxChars) return;
    const chars = estimateChars(message);
    if (used + chars <= maxChars) {
      selected.set(message.ref, message);
      used += chars;
      return;
    }
    if (!force && selected.size > 0) return;
    const capped = truncateToBudget(message, maxChars - used);
    if (capped === undefined) return;
    selected.set(message.ref, capped);
    used += estimateChars(capped);
  };
  for (const message of messages.slice(0, headProtected)) add(message, true);
  for (const message of [...messages].reverse()) {
    if (!selected.has(message.ref)) add(message, selected.size === 0);
  }
  return messages
    .filter((message) => selected.has(message.ref))
    .map((message) => selected.get(message.ref)!);
}

function squeeze(text: string, head: number, tail: number): string {
  if (cpLength(text) <= head + tail + 200) return text;
  return `${cpHead(text, head)}${SLIM_MARKER}${cpTail(text, tail)}`;
}

interface Read {
  messages: CaseMessage[];
  events: DiagnosticEvent[];
  compactions: number;
  turnsSkipped: number;
  turns: Turn[];
  finalInputCount: number;
}

/** The deduplicated message stream of the turns past `after`, as the Python builder reads it. */
function readTurns(input: ConversationSynthesisInput): Read {
  const resume = input.watermark ?? undefined;
  const after = cursorNanos(resume);
  const all = input.model_calls.map(turnOf);
  // The Python builder filters on the instant alone, after the reader's (instant, span) keyset.
  const turns =
    after === undefined
      ? all
      : all.filter((turn) => turn.ns === undefined || turn.ns > after.ns);
  const seen = new Set(resume?.tail_fingerprints ?? []);
  const seenCompactions = new Set<string>();
  const messages: CaseMessage[] = [];
  const events: DiagnosticEvent[] = [];
  let compactions = 0;
  let previousInputCount =
    after !== undefined ? (resume?.last_input_count ?? 0) : 0;

  const append = (
    message: ConversationMessage,
    kind: "input" | "output",
    turn: Turn,
    suspectedCompactionRef?: string,
  ) => {
    const hash = fingerprint(message);
    const timestamp =
      turn.micros !== undefined ? pydanticDatetime(turn.micros) : undefined;
    if (seen.has(hash)) {
      const existing = messages.find(
        (item) => item.source.message_hash === hash,
      );
      if (existing) {
        existing.occurrence_count += 1;
        existing.last_seen_source = omitNone({
          kind,
          span_id: turn.call.span_id,
          timestamp,
        });
      }
      return;
    }
    seen.add(hash);
    const responseId =
      (kind === "output" ? message.response_id : undefined) ||
      (kind === "output" ? turn.call.response_id : undefined) ||
      undefined;
    const content = messageContent(message);
    const shown = truncateContent(content, MESSAGE_MAX_CHARS);
    const caseMessage: CaseMessage = omitNone({
      ref: `m${messages.length + 1}`,
      role: message.role,
      content: shown,
      content_status: shown !== content ? "truncated" : "complete",
      content_truncated: shown !== content ? (true as const) : undefined,
      part_types: partTypes(message),
      source: omitNone({
        kind,
        span_id: turn.call.span_id,
        timestamp,
        message_hash: hash,
        response_id: responseId ?? undefined,
        suspected_compaction_ref: suspectedCompactionRef,
      }),
      suspected_compaction_ref: suspectedCompactionRef,
      compaction_parts:
        compactionParts(message).length > 0
          ? compactionParts(message)
          : undefined,
      occurrence_count: 1,
    });
    messages.push(caseMessage);
    if (events.length < DIAGNOSTIC_EVENT_LIMIT) {
      events.push(
        ...diagnosticEvents(message, caseMessage).slice(
          0,
          DIAGNOSTIC_EVENT_LIMIT - events.length,
        ),
      );
    }
  };

  for (const turn of turns) {
    const window = turn.call.input_new_messages;
    const current = turn.call.input_message_count ?? 0;
    let compactionMessages: ConversationMessage[] = [];
    let compactionRef: string | undefined;
    if (isCompactionBoundary(previousInputCount, current, window)) {
      compactionMessages = window.filter(isCompactionMessage);
      if (compactionMessages.length === 0 && window.length === 1)
        compactionMessages = [...window];
      const hashes = compactionMessages.map(fingerprint);
      const known =
        hashes.length > 0 && hashes.every((hash) => seenCompactions.has(hash));
      if (known) {
        compactionMessages = [];
      } else {
        hashes.forEach((hash) => seenCompactions.add(hash));
        compactions += 1;
        compactionRef = `c${compactions}`;
      }
    }
    const summaries = new Set(
      compactionMessages.map((message) => jsonForHash(message)),
    );
    for (const message of window) {
      append(
        message,
        "input",
        turn,
        summaries.has(jsonForHash(message)) ? compactionRef : undefined,
      );
    }
    for (const message of turn.call.output_messages)
      append(message, "output", turn);
    if (current) previousInputCount = current;
  }
  return {
    messages,
    events,
    compactions,
    turnsSkipped: all.length - turns.length,
    turns,
    finalInputCount: previousInputCount,
  };
}

function consumedWindow(read: Read): {
  micros?: number;
  cursor?: string;
  tail: string[];
} {
  let micros: number | undefined;
  let ns: bigint | undefined;
  let spanId = "";
  for (const turn of read.turns) {
    if (
      turn.micros !== undefined &&
      (micros === undefined || turn.micros > micros)
    )
      micros = turn.micros;
    if (turn.ns === undefined) continue;
    if (
      ns === undefined ||
      turn.ns > ns ||
      (turn.ns === ns && turn.call.span_id > spanId)
    ) {
      ns = turn.ns;
      spanId = turn.call.span_id;
    }
  }
  const tail = read.messages
    .slice(-TAIL_FINGERPRINT_LIMIT)
    .map((message) => message.source.message_hash)
    .filter((hash): hash is string => hash !== undefined);
  return {
    micros,
    cursor: ns === undefined ? undefined : encodeCursor(spanId, ns),
    tail,
  };
}

function slim(
  messages: CaseMessage[],
  events: DiagnosticEvent[],
): { messages: CaseMessage[]; events: DiagnosticEvent[] } {
  const protectedRefs = new Set(
    messages.slice(-SLIM_PROTECTED_TAIL).map((message) => message.ref),
  );
  for (const role of ["user", "assistant"]) {
    const first = messages.find((message) => message.role === role);
    if (first) protectedRefs.add(first.ref);
  }
  const transcript = messages.map((message) => message.content).join("\n");
  const slimmed = messages.map((message) =>
    message.role !== "tool" || protectedRefs.has(message.ref)
      ? message
      : {
          ...message,
          content: squeeze(message.content, SLIM_HEAD_CHARS, SLIM_TAIL_CHARS),
        },
  );
  const kept: DiagnosticEvent[] = [];
  for (const event of events) {
    const owned =
      event.message_ref !== undefined && protectedRefs.has(event.message_ref);
    const shown =
      event.detail ||
      event.content ||
      (event.kind === "tool_response" ? event.output : event.input);
    if (!owned && shown && transcript.includes(shown)) continue;
    const {
      ref: _ref,
      span_id: _span,
      timestamp: _time,
      tool_call_id: _call,
      message_role: _role,
      ...rest
    } = event;
    const next: DiagnosticEvent = { ...rest };
    if (!owned && event.kind === "tool_response" && event.output) {
      next.output = squeeze(event.output, SLIM_HEAD_CHARS, SLIM_TAIL_CHARS);
    }
    kept.push(next);
  }
  return {
    messages: slimmed,
    events: kept.map((event, index) => ({ ref: `d${index + 1}`, ...event })),
  };
}

function render(
  input: ConversationSynthesisInput,
  read: Read,
  messages: CaseMessage[],
  events: DiagnosticEvent[],
  capped: boolean,
): string {
  const lines = ["<conversation_case>"];
  lines.push(
    `  <conversation_id>${xmlEscape(input.conversation_id ?? "")}</conversation_id>`,
  );
  const stats: Array<[string, string | undefined]> = [
    ["service_name", input.service_name || undefined],
    ["agent_name", input.agent_name || undefined],
    ["model", input.model || undefined],
    ["span_count", String(input.span_count ?? 0)],
    ["error_count", String(input.error_count ?? 0)],
    ["duration_ms", pyFloatField(input.duration_ms ?? 0)],
  ];
  const present = stats.filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (present.length > 0 || input.last_error_message) {
    lines.push("  <metadata>");
    for (const [key, value] of present)
      lines.push(`    <${key}>${xmlEscape(value)}</${key}>`);
    if (input.last_error_message)
      lines.push(
        `    <last_error>${xmlEscape(input.last_error_message)}</last_error>`,
      );
    lines.push("  </metadata>");
  }
  const prior = input.prior_observations ?? [];
  if (prior.length > 0) {
    lines.push("  <previous_observations>");
    for (const row of prior) {
      lines.push(
        `    <observation lens=${xmlQuoteAttr(row.lens)} label=${xmlQuoteAttr(row.label || "observation")}>${xmlEscape(pyStrip(row.summary ?? ""))}</observation>`,
      );
    }
    lines.push("  </previous_observations>");
  }
  if (cursorNanos(input.watermark) !== undefined) {
    lines.push(
      `  <continuation turns_skipped=${xmlQuoteAttr(String(read.turnsSkipped))}>Only new turns are included.</continuation>`,
    );
  }
  if (read.compactions > 0) {
    lines.push(
      `  <context_compactions count=${xmlQuoteAttr(String(read.compactions))}>Earlier turns were summarized.</context_compactions>`,
    );
  }
  lines.push("  <transcript>");
  for (const message of messages) {
    lines.push(
      `    <message ref=${xmlQuoteAttr(message.ref)} role=${xmlQuoteAttr(message.role || "unknown")}>${xmlEscape(pyStrip(message.content))}</message>`,
    );
  }
  lines.push("  </transcript>");
  if (events.length > 0) {
    lines.push("  <diagnostic_events>");
    for (const event of events) {
      const detail =
        event.detail || event.content || pyDumps(event, { ensureAscii: true });
      lines.push(
        `    <event ref=${xmlQuoteAttr(event.ref || "?")} kind=${xmlQuoteAttr(event.kind)}>${xmlEscape(detail)}</event>`,
      );
    }
    lines.push("  </diagnostic_events>");
  }
  if (capped)
    lines.push(
      "  <transcript_capped>Middle sections may be missing.</transcript_capped>",
    );
  lines.push("</conversation_case>");
  return lines.join("\n");
}

/**
 * One conversation, from the turns past its resume cursor, as the case
 * observation synthesis reads, with the plan its next segment resumes from.
 * Messages are cut at 6,000 characters, the transcript at 300k tokens (the
 * first 10 messages, then from the tail), and tool output between the ends
 * keeps its head and tail, as synthesis always has.
 */
export const conversationSynthesis: PromptBuilder<
  ConversationSynthesisInput,
  ConversationSynthesisState
> = {
  name: "conversation_synthesis",
  version: 1,
  build(input, maxUnits) {
    const resume = input.watermark ?? undefined;
    const read = readTurns(input);
    const window = consumedWindow(read);
    const priorTail = resume?.tail_fingerprints ?? [];
    const priorSegment = resume?.segment ?? 0;
    const completedAt = pydanticDatetime(isoMicros(input.completed_at));
    const watermarkNext = (segment: number): ResumeState =>
      omitNone({
        watermark:
          window.micros !== undefined
            ? pydanticDatetime(window.micros)
            : completedAt,
        cursor: window.cursor,
        segment,
        tail_fingerprints: [...priorTail, ...window.tail].slice(
          -TAIL_FINGERPRINT_LIMIT,
        ),
        last_input_count: read.finalInputCount,
        completed_at: completedAt,
      });
    const skip = { drafts: [], model: "", hashes: {} } as const;

    if (read.messages.length === 0) {
      const outcome: SegmentSkip =
        window.micros === undefined
          ? { ...skip, segment: 0, skipped: "no_new_content" }
          : {
              ...skip,
              segment: priorSegment,
              watermark_next: watermarkNext(priorSegment),
            };
      return { prompt: "", applied: [], state: { outcome } };
    }

    const kept = capTranscript(
      read.messages,
      TRANSCRIPT_MAX_TOKENS,
      TRANSCRIPT_HEAD_MESSAGES,
    );
    const capped = kept.length < read.messages.length;
    const digest = createHash("sha256")
      .update(
        kept
          .map(
            (message) => message.source.message_hash || message.content || "",
          )
          .join("\n"),
      )
      .digest("hex");
    const keptRefs = new Set(kept.map((message) => message.ref));
    const keptEvents = read.events.filter(
      (event) =>
        event.message_ref !== undefined && keptRefs.has(event.message_ref),
    );
    const slimmed = slim(kept, keptEvents);
    const segment = priorSegment + 1;
    const after = cursorNanos(resume);
    const plan: SegmentPlan = omitNone({
      conversation_id: input.conversation_id,
      completed_at: completedAt,
      digest,
      segment_start: after === undefined ? "" : after.ns.toString(),
      segment,
      watermark_next: watermarkNext(segment),
      prior_resolution: input.prior_resolution ?? undefined,
    });
    return {
      ...withinBudget(
        render(input, read, slimmed.messages, slimmed.events, capped),
        maxUnits,
        capped ? ["cap_transcript"] : [],
      ),
      digest,
      state: { plan },
    };
  },
};
