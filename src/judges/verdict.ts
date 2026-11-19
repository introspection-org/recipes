import type { JudgeQuestion } from "./definition.js";

export type Verdict = "pass" | "fail" | "not_applicable";

/** What a judge concluded about one conversation. */
export interface JudgeVerdict {
  verdict: Verdict;
  reasoning?: string;
  /** A classifier judge's probability for each question, 0 to 1. */
  scores?: Record<string, number>;
}

/** The longest run of transcript a judge's output may repeat, in UTF-16 units. */
const ECHO_GUARD_MIN_SPAN = 60;
/** No verdict needs more than this; a longer string is the model copying its input. */
const MAX_OUTPUT_LEAF_UNITS = 4_000;

/**
 * The reply an LLM judge must give. The vocabulary is closed because every
 * pass-rate aggregate keys on it; an authored judge cannot change it.
 */
export const VERDICT_INSTRUCTIONS = [
  "The conversational evidence is a trajectory JSON array. Effective system instructions, when available, are labelled separately.",
  'Reply with only a JSON object, no prose and no code fence: {"reasoning": string, "verdict": "pass" | "fail" | "not_applicable"}.',
  "Output safety requirement: Explain the verdict in fewer than 20 words and entirely in your own words. Paraphrase all evidence. Do not quote or copy transcript language, and do not include file paths, commands, repository names, or other transcript identifiers.",
].join(" ");

/**
 * A judge reply without one surrounding code fence: the reply is trimmed, then
 * a "```json" opening (any case) or a bare "```" opening is dropped with its
 * closing "```". Models fence JSON despite being told not to, and the CLI's
 * earlier judge engine accepted such a reply, so the runner does too.
 */
export function stripCodeFence(content: string): string {
  let text = content.trim();
  if (text.slice(0, 7).toLowerCase() === "```json") text = text.slice(7);
  else if (text.startsWith("```")) text = text.slice(3);
  text = text.trim();
  return (text.endsWith("```") ? text.slice(0, -3) : text).trim();
}

function normalizeText(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(stringLeaves);
  }
  return [];
}

/**
 * Refuse output that repeats a span of the transcript: a judgement is stored
 * and shown more widely than the conversation it judged, so it must not carry
 * the conversation's words.
 */
function guardNoTranscriptSpans(output: unknown, transcript: string): void {
  const haystack = normalizeText(transcript);
  for (const leaf of stringLeaves(output)) {
    if (leaf.length > MAX_OUTPUT_LEAF_UNITS) {
      throw new Error("judge output is too long to be a verdict");
    }
    const needle = normalizeText(leaf);
    for (
      let start = 0;
      start + ECHO_GUARD_MIN_SPAN <= needle.length;
      start += 1
    ) {
      if (haystack.includes(needle.slice(start, start + ECHO_GUARD_MIN_SPAN))) {
        throw new Error("judge output echoed a transcript span");
      }
    }
  }
}

/** An LLM judge's reply as a verdict; anything outside the contract throws. */
export function completeLlmVerdict(
  transcript: string,
  output: string,
): JudgeVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(output));
  } catch (error) {
    throw new Error(
      `judge output is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("judge output is not a JSON object");
  }
  guardNoTranscriptSpans(parsed, transcript);
  const record = parsed as Record<string, unknown>;
  if (record.verdict === undefined || record.verdict === null) {
    throw new Error('judge output is missing its "verdict"');
  }
  const verdict = String(record.verdict).trim().toLowerCase();
  if (
    verdict !== "pass" &&
    verdict !== "fail" &&
    verdict !== "not_applicable"
  ) {
    throw new Error(
      `judge output verdict ${JSON.stringify(record.verdict)} is outside the canonical vocabulary`,
    );
  }
  return {
    verdict,
    ...(typeof record.reasoning === "string"
      ? { reasoning: record.reasoning }
      : {}),
  };
}

/**
 * A classifier judge's answers as a verdict: `pass` when every question's
 * probability reaches that question's threshold. A classifier cannot abstain;
 * `not_applicable` comes only from the judge's gate. The reasoning names each
 * question's score against its threshold, since the model wrote none.
 */
export function completeClassifierVerdict(
  questions: Readonly<Record<string, JudgeQuestion>>,
  answers: Readonly<Record<string, unknown>>,
): JudgeVerdict {
  const scores: Record<string, number> = {};
  const parts: string[] = [];
  let pass = true;
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name] as
      { type?: unknown; probability?: unknown } | undefined;
    const probability = answer?.probability;
    if (
      answer?.type !== "bool" ||
      typeof probability !== "number" ||
      !(probability >= 0 && probability <= 1)
    ) {
      throw new Error(`the classifier gave no answer to "${name}"`);
    }
    scores[name] = probability;
    const met = probability >= question.threshold;
    if (!met) pass = false;
    parts.push(
      `${name} ${probability.toFixed(2)} ${met ? ">=" : "<"} ${question.threshold.toFixed(2)}`,
    );
  }
  return {
    verdict: pass ? "pass" : "fail",
    reasoning: parts.join("; "),
    scores,
  };
}
