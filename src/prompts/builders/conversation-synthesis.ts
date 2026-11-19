import { createHash } from "node:crypto";

import { withinBudget, type PromptBuilder } from "../builder.js";
import { CHARS_PER_TOKEN } from "../budget.js";
import { prefix, suffix } from "../text.js";

/**
 * `conversation_synthesis@1`: one conversation, from the turns past its resume
 * cursor, as the case observation synthesis reads, with the plan its next
 * segment resumes from. It reads conversations as the data plane's Python
 * builder did, held to the same shape by
 * `test/conversation-synthesis-parity.test.ts`; message fingerprints and the
 * resume cursor are the same bytes, so a resume crosses the switch.
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

const MESSAGE_MAX_CHARS = 6_000;
const TRANSCRIPT_MAX_TOKENS = 300_000;
const TRANSCRIPT_HEAD_MESSAGES = 10;
const SLIM_HEAD_CHARS = 1_500;
const SLIM_TAIL_CHARS = 500;
const SLIM_PROTECTED_TAIL = 8;
const TAIL_FINGERPRINT_LIMIT = 50;
const DIAGNOSTIC_EVENT_LIMIT = 120;
const DIAGNOSTIC_EVENT_TEXT_LIMIT = 2_000;

const SUMMARY =
  /\b(summary|summarized|previous context|conversation so far|compact|compaction|continue from|continuation|prior context|earlier conversation)\b/i;
const MEDIA_PARTS = new Set([
  "image-url",
  "audio-url",
  "video-url",
  "document-url",
  "binary",
  "blob",
  "uri",
  "file",
  "image",
  "input_image",
  "image_url",
  "input_file",
  "attachment",
]);
const IMAGE_PARTS = new Set(["image", "input_image", "image_url"]);
const FILE_PARTS = new Set(["file", "input_file", "attachment"]);
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

interface Source {
  kind: "input" | "output";
  span_id: string;
  timestamp?: string;
  message_hash?: string;
  response_id?: string;
}

interface CaseMessage {
  ref: string;
  role: string;
  content: string;
  truncated?: true;
  part_types: string[];
  source: Source;
  compaction_ref?: string;
  occurrences: number;
}

interface DiagnosticEvent {
  ref?: string;
  message_ref: string;
  kind: string;
  tool_name?: string;
  input?: string;
  status?: string;
  output?: string;
  content?: string;
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const present = (value: unknown) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0);

/** JSON with every object's keys sorted: the form a fingerprint hashes. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isMap(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}

/** A value as compact JSON, an object without its empty fields. */
const compact = (value: unknown) =>
  canonicalJson(
    isMap(value)
      ? Object.fromEntries(
          Object.entries(value).filter(([, item]) => present(item)),
        )
      : value,
  );

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** `text` cut to `max` units, with a marker saying how much was cut. */
const clip = (text: string, max: number, marker: (cut: number) => string) =>
  text.length <= max
    ? text
    : `${prefix(text, max)}${marker(text.length - max)}`;

const squeeze = (text: string) =>
  text.length <= SLIM_HEAD_CHARS + SLIM_TAIL_CHARS + 200
    ? text
    : `${prefix(text, SLIM_HEAD_CHARS)} […] ${suffix(text, SLIM_TAIL_CHARS)}`;

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (text: string) => `"${escapeXml(text).replace(/"/g, "&quot;")}"`;

const string = (value: unknown) => (typeof value === "string" ? value : "");

function partText(part: ConversationPart): string {
  switch (part.type) {
    case "text":
      return string(part.content);
    case "compaction":
      return string(part.content) || "[compaction]";
    case "thinking":
    case "reasoning":
      return `[${part.type}] ${string(part.content)}`.trimEnd();
    case "tool_call":
    case "tool_call_response": {
      const label = [part.name, part.id].filter(Boolean).join(" ");
      const payload =
        part.type === "tool_call" ? part.arguments : part.response;
      return `[${label ? `${part.type} ${label}` : part.type}] ${compact(payload ?? part)}`;
    }
  }
  if (MEDIA_PARTS.has(part.type)) return `[${part.type} provided]`;
  const key = GENERIC_CONTENT_KEYS.find((name) => part[name] != null);
  const content = key === undefined ? part : part[key];
  return `[${part.type}] ${typeof content === "string" ? content : compact(content)}`;
}

const excerpt = (value: unknown) =>
  clip(
    typeof value === "string" ? value : compact(value),
    DIAGNOSTIC_EVENT_TEXT_LIMIT,
    (cut) => `... [truncated ${cut} chars]`,
  );

function toolStatus(result: unknown): string | undefined {
  if (!isMap(result)) return undefined;
  const key = [
    "status",
    "status_code",
    "exit_code",
    "returncode",
    "error",
    "exception",
  ].find((name) => present(result[name]));
  return key === undefined ? undefined : `${key}=${String(result[key])}`;
}

/** The tool calls, results, reasoning and attachments a message carries. */
function diagnosticEvents(
  message: ConversationMessage,
  ref: string,
): DiagnosticEvent[] {
  return message.parts.flatMap((part): DiagnosticEvent[] => {
    const name = typeof part.name === "string" ? { tool_name: part.name } : {};
    switch (part.type) {
      case "tool_call":
        return [
          {
            message_ref: ref,
            kind: "tool_call",
            ...name,
            input: excerpt(part.arguments ?? {}),
          },
        ];
      case "tool_call_response": {
        const status = toolStatus(part.response);
        return [
          {
            message_ref: ref,
            kind: "tool_response",
            ...name,
            ...(status ? { status } : {}),
            output: excerpt(part.response ?? part),
          },
        ];
      }
      case "thinking":
      case "reasoning": {
        const content = excerpt(string(part.content));
        return [
          {
            message_ref: ref,
            kind: part.type,
            ...(content ? { content } : {}),
          },
        ];
      }
    }
    if (FILE_PARTS.has(part.type))
      return [{ message_ref: ref, kind: "file_provided" }];
    if (IMAGE_PARTS.has(part.type))
      return [{ message_ref: ref, kind: "image_provided" }];
    return [];
  });
}

/** What dedupes a message: its role and parts, the empty fields of each part left out. */
const fingerprint = (message: ConversationMessage) =>
  sha256(
    canonicalJson({
      role: message.role,
      parts: message.parts.map((part) =>
        Object.fromEntries(
          Object.entries(part).filter(([, item]) => item != null),
        ),
      ),
    }),
  ).slice(0, 24);

const messageContent = (message: ConversationMessage) =>
  squash(message.parts.map(partText).join("\n"));

const isSummary = (message: ConversationMessage) =>
  message.parts.some((part) => part.type === "compaction") ||
  SUMMARY.test(messageContent(message));

/**
 * Whether a call follows a compaction: an explicit compaction part, or a sharp
 * drop in its input size with a summary-like message (or almost nothing) left.
 */
function followsCompaction(
  previous: number,
  current: number,
  window: ConversationMessage[],
) {
  if (
    window.some((message) =>
      message.parts.some((part) => part.type === "compaction"),
    )
  ) {
    return true;
  }
  if (previous < 3 || current === 0 || window.length === 0) return false;
  const sharpDrop =
    current === 1 || current <= Math.max(2, Math.floor(previous / 4));
  return sharpDrop && (current <= 5 || window.some(isSummary));
}

const estimateChars = (value: unknown) => JSON.stringify(value).length;
const estimateTokens = (value: unknown) =>
  Math.max(1, Math.floor(estimateChars(value) / CHARS_PER_TOKEN));

const nanos = (iso: string) => BigInt(Date.parse(iso)) * 1_000_000n;

interface Turn {
  call: ConversationModelCall;
  ns?: bigint;
}

const turnOf = (call: ConversationModelCall): Turn => ({
  call,
  ns:
    call.timestamp_ns != null
      ? BigInt(call.timestamp_ns)
      : call.timestamp
        ? nanos(call.timestamp)
        : undefined,
});

/** The instant a resume state stopped at: its cursor's, else its watermark's. */
function resumeNanos(
  state: ResumeState | null | undefined,
): bigint | undefined {
  if (!state) return undefined;
  if (state.cursor) {
    const token = JSON.parse(
      Buffer.from(state.cursor, "base64url").toString("utf8"),
    ) as {
      v?: string;
    };
    if (token.v)
      return /^\d+$/.test(token.v) ? BigInt(token.v) : nanos(token.v);
  }
  return nanos(state.watermark);
}

/** The keyset cursor the conversations API pages with, at one call. */
const encodeCursor = (spanId: string, ns: bigint) =>
  Buffer.from(
    JSON.stringify({ i: spanId, s: "created_at", d: "asc", v: ns.toString() }),
  ).toString("base64url");

interface Read {
  messages: CaseMessage[];
  events: DiagnosticEvent[];
  compactions: number;
  turnsSkipped: number;
  turns: Turn[];
  finalInputCount: number;
}

/** The deduplicated messages of the turns past the resume point, with what they carried. */
function read(input: ConversationSynthesisInput): Read {
  const resume = input.watermark ?? undefined;
  const after = resumeNanos(resume);
  const all = input.model_calls.map(turnOf);
  const turns =
    after === undefined
      ? all
      : all.filter((turn) => turn.ns === undefined || turn.ns > after);
  const seen = new Set(resume?.tail_fingerprints ?? []);
  const seenSummaries = new Set<string>();
  const messages: CaseMessage[] = [];
  const events: DiagnosticEvent[] = [];
  let compactions = 0;
  let previousCount = after !== undefined ? (resume?.last_input_count ?? 0) : 0;

  const append = (
    message: ConversationMessage,
    kind: Source["kind"],
    turn: Turn,
    compactionRef?: string,
  ) => {
    const hash = fingerprint(message);
    if (seen.has(hash)) {
      const earlier = messages.find(
        (item) => item.source.message_hash === hash,
      );
      if (earlier) earlier.occurrences += 1;
      return;
    }
    seen.add(hash);
    const content = messageContent(message);
    const shown = clip(
      content,
      MESSAGE_MAX_CHARS,
      (cut) => `... [message truncated ${cut} chars]`,
    );
    const responseId =
      kind === "output"
        ? message.response_id || turn.call.response_id
        : undefined;
    const ref = `m${messages.length + 1}`;
    messages.push({
      ref,
      role: message.role,
      content: shown,
      ...(shown !== content ? { truncated: true as const } : {}),
      part_types: [...new Set(message.parts.map((part) => part.type))],
      source: {
        kind,
        span_id: turn.call.span_id,
        ...(turn.call.timestamp ? { timestamp: turn.call.timestamp } : {}),
        message_hash: hash,
        ...(responseId ? { response_id: responseId } : {}),
      },
      ...(compactionRef ? { compaction_ref: compactionRef } : {}),
      occurrences: 1,
    });
    events.push(
      ...diagnosticEvents(message, ref).slice(
        0,
        Math.max(0, DIAGNOSTIC_EVENT_LIMIT - events.length),
      ),
    );
  };

  for (const turn of turns) {
    const window = turn.call.input_new_messages;
    const count = turn.call.input_message_count ?? 0;
    let summaries = new Set<ConversationMessage>();
    let compactionRef: string | undefined;
    if (followsCompaction(previousCount, count, window)) {
      let found = window.filter(isSummary);
      if (found.length === 0 && window.length === 1) found = [...window];
      const hashes = found.map(fingerprint);
      // A summary already recorded is the same compaction seen again.
      if (
        hashes.length === 0 ||
        !hashes.every((hash) => seenSummaries.has(hash))
      ) {
        hashes.forEach((hash) => seenSummaries.add(hash));
        compactions += 1;
        compactionRef = `c${compactions}`;
        summaries = new Set(found);
      }
    }
    for (const message of window) {
      append(
        message,
        "input",
        turn,
        summaries.has(message) ? compactionRef : undefined,
      );
    }
    for (const message of turn.call.output_messages)
      append(message, "output", turn);
    if (count) previousCount = count;
  }
  return {
    messages,
    events,
    compactions,
    turnsSkipped: all.length - turns.length,
    turns,
    finalInputCount: previousCount,
  };
}

/** Keep the opening messages, then fill from the tail backwards, within `maxTokens`. */
function capTranscript(messages: CaseMessage[]): CaseMessage[] {
  if (estimateTokens(messages) <= TRANSCRIPT_MAX_TOKENS) return messages;
  const maxChars = TRANSCRIPT_MAX_TOKENS * CHARS_PER_TOKEN;
  const kept = new Map<string, CaseMessage>();
  let used = 2;
  const add = (message: CaseMessage, force: boolean) => {
    if (kept.has(message.ref) || used >= maxChars) return;
    const size = estimateChars(message);
    if (used + size <= maxChars) {
      kept.set(message.ref, message);
      used += size;
      return;
    }
    if (!force && kept.size > 0) return;
    const room =
      maxChars - used - estimateChars({ ...message, content: "" }) - 200;
    if (room <= 100) return;
    const cut = {
      ...message,
      content: clip(message.content, room, (n) => `... [truncated ${n} chars]`),
      truncated: true as const,
    };
    kept.set(message.ref, cut);
    used += estimateChars(cut);
  };
  messages
    .slice(0, TRANSCRIPT_HEAD_MESSAGES)
    .forEach((message) => add(message, true));
  [...messages].reverse().forEach((message) => add(message, kept.size === 0));
  return messages.flatMap((message) => kept.get(message.ref) ?? []);
}

/**
 * Head-and-tail: the first user and assistant messages and the last few stay
 * whole; tool output between them keeps its head and tail, and an event whose
 * content the transcript already shows is dropped.
 */
function slim(messages: CaseMessage[], events: DiagnosticEvent[]) {
  const kept = new Set(messages.map((message) => message.ref));
  const whole = new Set(
    messages.slice(-SLIM_PROTECTED_TAIL).map((message) => message.ref),
  );
  for (const role of ["user", "assistant"]) {
    const first = messages.find((message) => message.role === role);
    if (first) whole.add(first.ref);
  }
  const transcript = messages.map((message) => message.content).join("\n");
  return {
    messages: messages.map((message) =>
      message.role === "tool" && !whole.has(message.ref)
        ? { ...message, content: squeeze(message.content) }
        : message,
    ),
    events: events
      .filter((event) => kept.has(event.message_ref))
      .filter((event) => {
        const shown =
          event.content ||
          (event.kind === "tool_response" ? event.output : event.input);
        return (
          whole.has(event.message_ref) || !shown || !transcript.includes(shown)
        );
      })
      .map((event, index) => ({
        ref: `d${index + 1}`,
        ...event,
        ...(event.kind === "tool_response" &&
        event.output &&
        !whole.has(event.message_ref)
          ? { output: squeeze(event.output) }
          : {}),
      })),
  };
}

function render(
  input: ConversationSynthesisInput,
  conversation: Read,
  messages: CaseMessage[],
  events: DiagnosticEvent[],
  capped: boolean,
): string {
  const lines = ["<conversation_case>"];
  lines.push(
    `  <conversation_id>${escapeXml(input.conversation_id)}</conversation_id>`,
  );
  const metadata: Array<[string, unknown]> = [
    ["service_name", input.service_name],
    ["agent_name", input.agent_name],
    ["model", input.model],
    ["span_count", input.span_count ?? 0],
    ["error_count", input.error_count ?? 0],
    ["duration_ms", input.duration_ms ?? 0],
  ];
  lines.push("  <metadata>");
  for (const [key, value] of metadata) {
    if (value != null && value !== "")
      lines.push(`    <${key}>${escapeXml(String(value))}</${key}>`);
  }
  if (input.last_error_message) {
    lines.push(
      `    <last_error>${escapeXml(input.last_error_message)}</last_error>`,
    );
  }
  lines.push("  </metadata>");
  const prior = input.prior_observations ?? [];
  if (prior.length > 0) {
    lines.push("  <previous_observations>");
    for (const row of prior) {
      lines.push(
        `    <observation lens=${attr(row.lens)} label=${attr(row.label || "observation")}>${escapeXml((row.summary ?? "").trim())}</observation>`,
      );
    }
    lines.push("  </previous_observations>");
  }
  if (input.watermark) {
    lines.push(
      `  <continuation turns_skipped=${attr(String(conversation.turnsSkipped))}>Only new turns are included.</continuation>`,
    );
  }
  if (conversation.compactions > 0) {
    lines.push(
      `  <context_compactions count=${attr(String(conversation.compactions))}>Earlier turns were summarized.</context_compactions>`,
    );
  }
  lines.push("  <transcript>");
  for (const message of messages) {
    lines.push(
      `    <message ref=${attr(message.ref)} role=${attr(message.role || "unknown")}>${escapeXml(message.content.trim())}</message>`,
    );
  }
  lines.push("  </transcript>");
  if (events.length > 0) {
    lines.push("  <diagnostic_events>");
    for (const event of events) {
      lines.push(
        `    <event ref=${attr(event.ref ?? "?")} kind=${attr(event.kind)}>${escapeXml(event.content || JSON.stringify(event))}</event>`,
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
  build(input, maxTokens) {
    const resume = input.watermark ?? undefined;
    const conversation = read(input);
    const last = conversation.turns
      .filter((turn) => turn.ns !== undefined)
      .reduce<Turn | undefined>(
        (latest, turn) =>
          latest === undefined ||
          turn.ns! > latest.ns! ||
          (turn.ns === latest.ns && turn.call.span_id > latest.call.span_id)
            ? turn
            : latest,
        undefined,
      );
    const tail = conversation.messages
      .slice(-TAIL_FINGERPRINT_LIMIT)
      .map((message) => message.source.message_hash!);
    const segment = (number: number): ResumeState => ({
      watermark: last?.call.timestamp ?? input.completed_at,
      ...(last ? { cursor: encodeCursor(last.call.span_id, last.ns!) } : {}),
      segment: number,
      tail_fingerprints: [...(resume?.tail_fingerprints ?? []), ...tail].slice(
        -TAIL_FINGERPRINT_LIMIT,
      ),
      last_input_count: conversation.finalInputCount,
      completed_at: input.completed_at,
    });
    const priorSegment = resume?.segment ?? 0;
    const skip = { drafts: [], model: "", hashes: {} } as const;

    if (conversation.messages.length === 0) {
      const outcome: SegmentSkip =
        last === undefined
          ? { ...skip, segment: 0, skipped: "no_new_content" }
          : {
              ...skip,
              segment: priorSegment,
              watermark_next: segment(priorSegment),
            };
      return { prompt: "", applied: [], state: { outcome } };
    }

    const kept = capTranscript(conversation.messages);
    const capped = kept.length < conversation.messages.length;
    const digest = sha256(
      kept.map((message) => message.source.message_hash).join("\n"),
    );
    const slimmed = slim(kept, conversation.events);
    const after = resumeNanos(resume);
    const plan: SegmentPlan = {
      conversation_id: input.conversation_id,
      completed_at: input.completed_at,
      digest,
      segment_start: after === undefined ? "" : after.toString(),
      segment: priorSegment + 1,
      watermark_next: segment(priorSegment + 1),
      ...(input.prior_resolution
        ? { prior_resolution: input.prior_resolution }
        : {}),
    };
    return {
      ...withinBudget(
        render(input, conversation, slimmed.messages, slimmed.events, capped),
        maxTokens,
        capped ? ["cap_transcript"] : [],
      ),
      digest,
      state: { plan },
    };
  },
};
