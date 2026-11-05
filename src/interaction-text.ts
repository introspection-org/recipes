/**
 * The text a Recipe tool's result carries for each interaction outcome, and
 * the resume a pause/resume host converts into it. Pure: no Node, Pi or
 * renderer imports, so a browser host renders the same bytes the terminal does.
 */

// Frozen envelope literals — the interaction wire contract. Interrupt-capable
// hosts synthesize the same literals when resuming a paused run, so recipes
// see identical tool results in every mode. Do not reword without a
// coordinated protocol change (see docs/interactions.md).
const DECLINED_ENVELOPE =
  "User declined to answer. Proceed with your best judgment.";
const AWAITING_USER_ENVELOPE = "Awaiting user response.";
const UNAVAILABLE_ENVELOPE =
  "User interaction is unavailable in this session; nothing was shown to the user. " +
  "Ask the user in your normal assistant reply instead, and continue after they respond.";

/** What the model sees when the user dismissed a question to reply in the chat. */
export const DISMISSED_TEXT =
  "The user dismissed the question to reply in the chat. Stop here and wait for their message; don't proceed on your own judgment.";

/** How the interaction settled. */
export type AskUserOutcome =
  | { type: "answered"; answer: string; answers?: never }
  | { type: "answered"; answers: string[]; answer?: never }
  | { type: "approved"; feedback?: string }
  | { type: "revision_requested"; feedback?: string }
  | { type: "declined" }
  /** Interrupt emitted — the host pauses the run and rewrites this result. */
  | { type: "awaiting_user" }
  /** No interaction channel — the model should ask in plain chat. */
  | { type: "unavailable" };

/**
 * Render the byte-exact text a Recipe tool receives for an interaction
 * outcome. Hosts use this when replacing a paused tool result on resume.
 */
export function formatInteractionOutcome(outcome: AskUserOutcome): string {
  switch (outcome.type) {
    case "answered":
      return outcome.answers
        ? `Answers: ${JSON.stringify(outcome.answers)}`
        : `Answer: ${outcome.answer}`;
    case "approved":
      return outcome.feedback
        ? `Approved. Feedback: ${outcome.feedback}`
        : "Approved.";
    case "revision_requested":
      return outcome.feedback
        ? `Revision requested. Feedback: ${outcome.feedback}`
        : "Revision requested.";
    case "declined":
      return DECLINED_ENVELOPE;
    case "awaiting_user":
      return AWAITING_USER_ENVELOPE;
    case "unavailable":
      return UNAVAILABLE_ENVELOPE;
  }
}

/**
 * Host-neutral shape for a response to a paused Recipe interaction.
 * Protocol adapters can pass their resume record without depending on AG-UI
 * or another transport package.
 */
export interface InteractionResumeResponse {
  status?: string;
  payload?: unknown;
}

/**
 * Convert a host resume response into the frozen Recipe interaction envelope.
 */
export function formatInteractionResume(
  response: InteractionResumeResponse,
): string {
  const payload =
    response.payload &&
    typeof response.payload === "object" &&
    !Array.isArray(response.payload)
      ? (response.payload as Record<string, unknown>)
      : undefined;
  if (response.status === "cancelled") {
    return payload?.dismissed === true
      ? DISMISSED_TEXT
      : formatInteractionOutcome({ type: "declined" });
  }

  const answer =
    typeof payload?.answer === "string" ? payload.answer.trim() : "";
  if (answer) {
    return formatInteractionOutcome({ type: "answered", answer });
  }

  const answers = normalizeAnswers(payload?.answers);
  if (answers.length > 0) {
    return formatInteractionOutcome({ type: "answered", answers });
  }

  if (typeof payload?.approved === "boolean") {
    const feedback =
      typeof payload.feedback === "string" ? payload.feedback.trim() : "";
    return formatInteractionOutcome(
      payload.approved
        ? {
            type: "approved",
            ...(feedback ? { feedback } : {}),
          }
        : {
            type: "revision_requested",
            ...(feedback ? { feedback } : {}),
          },
    );
  }

  return response.status
    ? `Interrupt response: ${response.status}`
    : "Interrupt response received.";
}

/** Trimmed, non-empty, de-duplicated answers. */
export function normalizeAnswers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((answer) => {
        if (typeof answer !== "string") return [];
        const trimmed = answer.trim();
        return trimmed ? [trimmed] : [];
      }),
    ),
  ];
}
