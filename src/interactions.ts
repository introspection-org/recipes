/**
 * Interaction mechanics for recipe tools: ask the user a question or request
 * approval with one contract that works on every pi host.
 *
 * This module registers no tools. Recipes own their interaction tools and call
 * `askUserQuestion()` or `askUserApproval()` from the tool's `execute()`;
 * raw `askUser()` is the lower-level escape hatch. The module resolves the
 * best available interaction channel and always returns a finished tool result:
 *
 *   1. `PI_ASK_USER_AUTO_APPROVE` — headless/CI: confirmations approve,
 *      questions decline. Deterministic, never blocks.
 *   2. `ctx.hasUI` (TUI and RPC modes) — walk the built-in dialogs, or the
 *      caller's `interactive` override.
 *   3. `PI_INTERRUPT_RESUME` (host capability flag) — return an "Awaiting
 *      user response." result carrying a `details.interrupt` pause
 *      descriptor; the host pauses the run and later resumes it by rewriting
 *      this tool result with the user's response envelope.
 *   4. Otherwise — report that interaction is unavailable so the model asks
 *      in its plain chat reply instead. An unrendered question is never
 *      treated as declined.
 *
 * The response envelopes are a frozen wire contract shared with interrupt-
 * capable hosts (see `docs/interactions.md`): both sides must synthesize
 * byte-identical text for the same outcome so recipes cannot tell whether an
 * answer arrived through a local dialog or a remote resume.
 *
 * A `details.interrupt` with `outcome.type === "awaiting_user"` is the pause
 * signal. Runtime hosts may adapt it to their own pause/resume state.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ExtensionContext,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";

/** Well-known `reason` for a question the model needs answered. */
export const ASK_USER_REASON_INPUT_REQUIRED = "input_required";
/** Well-known `reason` for an approve/request-changes decision. */
export const ASK_USER_REASON_CONFIRMATION = "confirmation";
/** Well-known `reason` for a decision bound to a specific tool call. */
export const ASK_USER_REASON_TOOL_CALL = "tool_call";

/**
 * Default dialog timeout applied in RPC mode only. RPC clients may never
 * render a dialog, so an unanswered one must not wedge the session; the TUI
 * gets no default timeout (a visible dialog can wait for the user).
 */
export const DEFAULT_RPC_DIALOG_TIMEOUT_MS = 120_000;

const APPROVE_OPTION = "Approve";
const REQUEST_CHANGES_OPTION = "Request changes";
const CUSTOM_ANSWER_OPTION = "Other";
const COMPLETE_SELECTION_OPTION = "Done";

/** Whether a question accepts one answer or several. */
export type AskUserSelection = "single" | "multiple";

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

/** Optional structured rendering hints for hosts with richer UI. */
export interface AskUserDisplay {
  /** Renderer kind, e.g. `search_proposal`. */
  kind: string;
  /** Short title for local dialogs and rich cards. */
  title?: string;
  /** Main body copy. Plain text or markdown-style text. */
  body?: string;
  /** Optional grouped content for clients that render rows or sections. */
  sections?: Array<{
    title: string;
    body?: string;
    items?: string[];
  }>;
}

/** A selectable answer option. `value` is what the tool receives. */
export interface AskUserOption {
  label: string;
  value?: string;
  description?: string;
}

/** What the recipe tool wants from the user. */
export interface AskUserRequest {
  /**
   * Why the run needs the user. Open string; well-known values are
   * `input_required` (a question) and `confirmation` (approve / request
   * changes). Unknown reasons follow the question flow.
   */
  reason: string;
  /** The human-readable prompt shown to the user. */
  message: string;
  /** Optional choices for a question. Hosts may also allow a custom answer. */
  options?: readonly (string | AskUserOption)[];
  /** Answer cardinality. Defaults to `single`. `multiple` requires options. */
  selection?: AskUserSelection;
  /**
   * Native renderer or tool hints for hosts that can render richer UI.
   */
  metadata?: Record<string, unknown>;
  /**
   * Structured display copy. Local pi dialogs format this for readability;
   * remote hosts can adapt it into their own UI.
   */
  display?: AskUserDisplay;
  /** Optional ISO-8601 instant after which a host may auto-decline. */
  expiresAt?: string;
}

export interface AskUserQuestionRequest {
  /** The concise question shown to the user. */
  question: string;
  /** Optional short UI heading for hosts that render one. */
  header?: string;
  /** Optional answer suggestions. Hosts may also allow a custom answer. */
  options?: readonly (string | AskUserOption)[];
  /** Answer cardinality. Defaults to `single`. `multiple` requires options. */
  selection?: AskUserSelection;
  /** Additional renderer or tool hints. */
  metadata?: Record<string, unknown>;
  /** Optional structured display copy. */
  display?: AskUserDisplay;
  /** Optional ISO-8601 instant after which a host may auto-decline. */
  expiresAt?: string;
}

export interface AskUserApprovalRequest {
  /** Short renderer kind, e.g. `plan_search`; defaults to `approval`. */
  kind?: string;
  /** Concise approval prompt. Defaults to `Approve <title>?` when possible. */
  message?: string;
  /** Approval card title for local and remote UI. */
  title?: string;
  /** Main approval card body. Plain text or markdown-style text. */
  body?: string;
  /** Optional grouped content for clients that render rows or sections. */
  sections?: AskUserDisplay["sections"];
  /** Additional renderer or tool hints. */
  metadata?: Record<string, unknown>;
  /** Optional ISO-8601 instant after which a host may auto-decline. */
  expiresAt?: string;
}

/** Per-call plumbing from the owning tool's `execute()`. */
export interface AskUserOptions {
  /** The executing tool call id (first `execute()` argument). */
  toolCallId: string;
  /** The extension context (last `execute()` argument). */
  ctx: ExtensionContext;
  /**
   * The tool's own abort signal (third `execute()` argument) — NOT
   * `ctx.signal`, which may already be undefined while the tool settles.
   * Threaded into every dialog so an aborted turn dismisses them.
   */
  signal: AbortSignal | undefined;
  /**
   * Optional custom interactive walk replacing the built-in dialogs (a pure
   * TUI/RPC enhancement — the contract is unchanged). Return an outcome, or
   * undefined to fall through to the built-in walk.
   */
  interactive?: (
    ui: ExtensionUIContext,
    dialog: ExtensionUIDialogOptions
  ) => Promise<AskUserOutcome | undefined>;
  /** Dialog timeout override in milliseconds (defaults: TUI none, RPC 120s). */
  timeoutMs?: number;
  /** Environment override for tests. */
  env?: NodeJS.ProcessEnv;
}

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

/** The Recipes interrupt request stored in Pi's arbitrary details field. */
export interface AskUserInterrupt {
  reason: string;
  message: string;
  options?: AskUserOption[];
  selection?: AskUserSelection;
  metadata?: Record<string, unknown>;
  display?: AskUserDisplay;
  expiresAt?: string;
  outcome: AskUserOutcome;
}

/** Structured details attached to every askUser tool result. */
export interface AskUserDetails {
  interrupt: AskUserInterrupt;
}

/**
 * A finished tool result: return it (or spread it) from the owning tool's
 * `execute()`. The envelope text in `content` is what the model sees.
 */
export interface AskUserResult {
  outcome: AskUserOutcome;
  content: Array<{ type: "text"; text: string }>;
  details: AskUserDetails;
}

// Recipe extensions and their host may resolve separate physical copies of
// Recipes (for example, one under the recipe and one under runtime-worker).
// Keep the async context process-global so either copy can establish the child
// boundary and every current copy observes it.
const INTERACTION_AUTO_RESOLUTION_KEY = Symbol.for(
  "@introspection-ai/recipes/interaction-auto-resolution"
);
const interactionGlobals = globalThis as typeof globalThis & {
  [key: symbol]: AsyncLocalStorage<boolean> | undefined;
};
const interactionAutoResolution =
  interactionGlobals[INTERACTION_AUTO_RESOLUTION_KEY] ??
  new AsyncLocalStorage<boolean>();
interactionGlobals[INTERACTION_AUTO_RESOLUTION_KEY] = interactionAutoResolution;

/**
 * Run `fn` with interaction requests resolved without prompting the user.
 *
 * Child sessions cannot own the root session's user interaction lifecycle.
 * Approval requests are approved and questions are declined so the child can
 * make progress without surfacing a UI dialog or an interrupt.
 */
export function autoResolveInteractions<T>(fn: () => Promise<T>): Promise<T> {
  return interactionAutoResolution.run(true, fn);
}

/** Ask the user, resolving the best available interaction channel. */
export async function askUser(
  request: AskUserRequest,
  opts: AskUserOptions
): Promise<AskUserResult> {
  const env = opts.env ?? process.env;

  if (
    request.selection === "multiple" &&
    normalizeOptions(request.options).length === 0
  ) {
    throw new Error("Multiple selection requires at least one option");
  }

  if (interactionAutoResolution.getStore() === true) {
    return finishedResult(
      request,
      isApprovalReason(request.reason)
        ? { type: "approved" }
        : { type: "declined" }
    );
  }

  if (flagEnabled(env.PI_ASK_USER_AUTO_APPROVE)) {
    return finishedResult(
      request,
      isApprovalReason(request.reason)
        ? { type: "approved" }
        : { type: "declined" }
    );
  }

  if (opts.ctx.hasUI) {
    const timeout =
      opts.timeoutMs ??
      (opts.ctx.mode === "rpc" ? DEFAULT_RPC_DIALOG_TIMEOUT_MS : undefined);
    const dialog: ExtensionUIDialogOptions = {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
    const custom = opts.interactive
      ? await opts.interactive(opts.ctx.ui, dialog)
      : undefined;
    throwIfAborted(opts.signal);
    const outcome =
      custom ??
      (await dialogWalk(
        request,
        opts.ctx.ui,
        dialog,
        opts.signal,
        opts.ctx.mode === "tui"
      ));
    return finishedResult(request, outcome);
  }

  if (flagEnabled(env.PI_INTERRUPT_RESUME)) {
    return awaitingUserResult(request, opts.toolCallId);
  }

  return finishedResult(request, { type: "unavailable" });
}

/** Ask a blocking clarification question without hand-authoring interrupt details. */
export async function askUserQuestion(
  request: AskUserQuestionRequest,
  opts: AskUserOptions
): Promise<AskUserResult> {
  const metadata = compactRecord({
    kind: "ask_user_question",
    ...(request.header ? { header: request.header } : {}),
    question: request.question,
    ...(request.metadata ?? {}),
  });
  return askUser(
    {
      reason: ASK_USER_REASON_INPUT_REQUIRED,
      message: request.question,
      options: request.options,
      ...(request.selection ? { selection: request.selection } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...(request.display ? { display: request.display } : {}),
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    },
    opts
  );
}

/** Request approval without hand-authoring interrupt details or display data. */
export async function askUserApproval(
  request: AskUserApprovalRequest,
  opts: AskUserOptions
): Promise<AskUserResult> {
  const kind = request.kind?.trim() || "approval";
  const title = request.title?.trim();
  const body = request.body?.trim();
  const message =
    request.message?.trim() || (title ? `Approve ${title}?` : "Approve?");
  const display = compactDisplay({
    kind,
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
    ...(request.sections?.length ? { sections: request.sections } : {}),
  });
  const metadata = compactRecord({
    kind,
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
    ...(display?.sections?.length ? { sections: display.sections } : {}),
    ...(request.metadata ?? {}),
  });
  return askUser(
    {
      reason: ASK_USER_REASON_CONFIRMATION,
      message,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...(display ? { display } : {}),
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    },
    opts
  );
}

function flagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

function isApprovalReason(reason: string): boolean {
  return (
    reason === ASK_USER_REASON_CONFIRMATION ||
    reason === ASK_USER_REASON_TOOL_CALL
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  // Dialogs resolve undefined for both a user dismissal and a turn abort;
  // only the signal distinguishes them. A dismissal is a decline, an abort
  // must not fabricate an outcome.
  if (signal?.aborted) {
    throw new Error("User interaction aborted");
  }
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([, value]) =>
        value !== undefined &&
        value !== null &&
        (!Array.isArray(value) || value.length > 0)
    )
  );
}

function compactDisplay(display: AskUserDisplay): AskUserDisplay | undefined {
  const title = display.title?.trim();
  const body = display.body?.trim();
  const sections = (display.sections ?? [])
    .map((section) => {
      const sectionTitle = section.title.trim();
      const sectionBody = section.body?.trim();
      const items = section.items?.map((item) => item.trim()).filter(Boolean);
      if (!sectionTitle && !sectionBody && (!items || items.length === 0)) {
        return null;
      }
      return {
        title: sectionTitle,
        ...(sectionBody ? { body: sectionBody } : {}),
        ...(items && items.length > 0 ? { items } : {}),
      };
    })
    .filter((section): section is NonNullable<typeof section> => Boolean(section));
  if (!title && !body && sections.length === 0) return undefined;
  return {
    kind: display.kind,
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
    ...(sections.length > 0 ? { sections } : {}),
  };
}

/**
 * Built-in dialog walk. Deliberately minimal: a select for fixed choices or
 * approvals, a text input otherwise. Empty and dismissed answers decline —
 * the user saw the question and chose not to answer it.
 */
async function dialogWalk(
  request: AskUserRequest,
  ui: ExtensionUIContext,
  dialog: ExtensionUIDialogOptions,
  signal: AbortSignal | undefined,
  preferCustomTui: boolean
): Promise<AskUserOutcome> {
  if (isApprovalReason(request.reason)) {
    // ui.confirm() cannot carry per-option labels, so approvals use a select.
    const choice = await ui.select(
      localDialogMessage(request),
      [APPROVE_OPTION, REQUEST_CHANGES_OPTION],
      dialog
    );
    throwIfAborted(signal);
    if (choice === undefined) return { type: "declined" };
    if (choice === APPROVE_OPTION) return { type: "approved" };
    const feedback = await ui.input(
      "Feedback",
      "Describe the changes you want (optional)",
      dialog
    );
    throwIfAborted(signal);
    const trimmed = feedback?.trim();
    return trimmed
      ? { type: "revision_requested", feedback: trimmed }
      : { type: "revision_requested" };
  }

  if (request.options && request.options.length > 0) {
    const options = normalizeOptions(request.options);
    if (request.selection === "multiple") {
      return multiSelectDialogWalk(
        request,
        options,
        ui,
        dialog,
        signal,
        preferCustomTui
      );
    }
    const selectOptions = [...options.map((option) => option.label)];
    if (!selectOptions.includes(CUSTOM_ANSWER_OPTION)) {
      selectOptions.push(CUSTOM_ANSWER_OPTION);
    }
    const choice = await ui.select(
      localDialogMessage(request),
      selectOptions,
      dialog
    );
    throwIfAborted(signal);
    if (choice === undefined) return { type: "declined" };
    if (choice === CUSTOM_ANSWER_OPTION) {
      const text = await ui.input(
        "Answer",
        "Type your own answer",
        dialog
      );
      throwIfAborted(signal);
      const trimmed = text?.trim();
      return trimmed
        ? { type: "answered", answer: trimmed }
        : { type: "declined" };
    }
    const selected = options.find((option) => option.label === choice);
    return {
      type: "answered",
      answer: selected?.value?.trim() || selected?.label || choice,
    };
  }

  const text = await ui.input(localDialogMessage(request), undefined, dialog);
  throwIfAborted(signal);
  const trimmed = text?.trim();
  return trimmed
    ? { type: "answered", answer: trimmed }
    : { type: "declined" };
}

async function multiSelectDialogWalk(
  request: AskUserRequest,
  options: AskUserOption[],
  ui: ExtensionUIContext,
  dialog: ExtensionUIDialogOptions,
  signal: AbortSignal | undefined,
  preferCustomTui: boolean
): Promise<AskUserOutcome> {
  if (preferCustomTui && typeof ui.custom === "function") {
    const { showMultiSelectTui } = await import("./interaction-tui.js");
    const result = await showMultiSelectTui(
      localDialogMessage(request),
      options,
      ui,
      signal
    );
    throwIfAborted(signal);
    if (!result) return { type: "declined" };
    const answers = selectedAnswers(options, new Set(result.selected));
    if (result.typed) {
      if (!answers.includes(result.typed)) answers.push(result.typed);
      return { type: "answered", answers };
    }
    if (result.custom) {
      const text = await ui.input("Answer", "Type another answer", dialog);
      throwIfAborted(signal);
      const customAnswer = text?.trim();
      if (!customAnswer) {
        return answers.length > 0
          ? { type: "answered", answers }
          : { type: "declined" };
      }
      return {
        type: "answered",
        answers: normalizeAnswers([...answers, customAnswer]),
      };
    }
    return answers.length > 0
      ? { type: "answered", answers }
      : { type: "declined" };
  }

  return multiSelectFallback(request, options, ui, dialog, signal);
}

async function multiSelectFallback(
  request: AskUserRequest,
  options: AskUserOption[],
  ui: ExtensionUIContext,
  dialog: ExtensionUIDialogOptions,
  signal: AbortSignal | undefined
): Promise<AskUserOutcome> {
  const selected = new Set<number>();

  while (true) {
    const choices = options.map(
      (option, index) => `${selected.has(index) ? "[x]" : "[ ]"} ${option.label}`
    );
    choices.push(CUSTOM_ANSWER_OPTION, COMPLETE_SELECTION_OPTION);

    const choice = await ui.select(localDialogMessage(request), choices, dialog);
    throwIfAborted(signal);
    if (choice === undefined) return { type: "declined" };

    if (choice === COMPLETE_SELECTION_OPTION) {
      const answers = selectedAnswers(options, selected);
      return answers.length > 0
        ? { type: "answered", answers }
        : { type: "declined" };
    }

    if (choice === CUSTOM_ANSWER_OPTION) {
      const text = await ui.input("Answer", "Type another answer", dialog);
      throwIfAborted(signal);
      const customAnswer = text?.trim();
      if (!customAnswer) continue;
      return {
        type: "answered",
        answers: normalizeAnswers([
          ...selectedAnswers(options, selected),
          customAnswer,
        ]),
      };
    }

    const optionIndex = choices.indexOf(choice);
    if (optionIndex < 0 || optionIndex >= options.length) continue;
    if (selected.has(optionIndex)) {
      selected.delete(optionIndex);
    } else {
      selected.add(optionIndex);
    }
  }
}

function selectedAnswers(
  options: AskUserOption[],
  selected: ReadonlySet<number>
): string[] {
  return [
    ...new Set(
      options.flatMap((option, index) =>
        selected.has(index) ? [option.value?.trim() || option.label] : []
      )
    ),
  ];
}

function localDialogMessage(request: AskUserRequest): string {
  const display = request.display;
  if (!display) return request.message;

  const lines: string[] = [];
  const title = display.title?.trim();
  if (title) {
    lines.push(title);
  } else {
    lines.push(request.message);
  }

  const body = display.body?.trim();
  if (body) {
    lines.push("", body);
  }

  for (const section of display.sections ?? []) {
    const sectionTitle = section.title.trim();
    const sectionBody = section.body?.trim();
    const items = section.items?.map((item) => item.trim()).filter(Boolean) ?? [];

    if (!sectionTitle && !sectionBody && items.length === 0) continue;
    lines.push("");
    if (sectionTitle) lines.push(`${sectionTitle}:`);
    if (sectionBody) lines.push(sectionBody);
    for (const item of items) {
      lines.push(`- ${item}`);
    }
  }

  return lines.join("\n");
}

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
  response: InteractionResumeResponse
): string {
  if (response.status === "cancelled") {
    return formatInteractionOutcome({ type: "declined" });
  }

  const payload =
    response.payload &&
    typeof response.payload === "object" &&
    !Array.isArray(response.payload)
      ? (response.payload as Record<string, unknown>)
      : undefined;
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
          }
    );
  }

  return response.status
    ? `Interrupt response: ${response.status}`
    : "Interrupt response received.";
}

function normalizeAnswers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((answer) => {
        if (typeof answer !== "string") return [];
        const trimmed = answer.trim();
        return trimmed ? [trimmed] : [];
      })
    ),
  ];
}

function normalizeOptions(
  options: readonly (string | AskUserOption)[] | undefined
): AskUserOption[] {
  return (options ?? []).flatMap((option) => {
    if (typeof option === "string") {
      const label = option.trim();
      return label ? [{ label }] : [];
    }
    const label = option.label.trim();
    if (!label) return [];
    const value = option.value?.trim();
    const description = option.description?.trim();
    return [
      {
        label,
        ...(value ? { value } : {}),
        ...(description ? { description } : {}),
      },
    ];
  });
}

function interruptDetails(
  request: AskUserRequest,
  outcome: AskUserOutcome
): AskUserDetails {
  const options = normalizeOptions(request.options);
  return {
    interrupt: {
      reason: request.reason,
      message: request.message,
      ...(options.length > 0 ? { options } : {}),
      ...(request.selection ? { selection: request.selection } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
      ...(request.display ? { display: request.display } : {}),
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
      outcome,
    },
  };
}

function finishedResult(
  request: AskUserRequest,
  outcome: AskUserOutcome
): AskUserResult {
  return {
    outcome,
    content: [{ type: "text", text: formatInteractionOutcome(outcome) }],
    details: interruptDetails(request, outcome),
  };
}

function awaitingUserResult(
  request: AskUserRequest,
  _toolCallId: string
): AskUserResult {
  const outcome: AskUserOutcome = { type: "awaiting_user" };
  return {
    outcome,
    content: [{ type: "text", text: formatInteractionOutcome(outcome) }],
    details: interruptDetails(request, outcome),
  };
}
