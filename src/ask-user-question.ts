/**
 * The first-party `ask_user_question` tool. An agent gets it by listing
 * `ask_user_question` in its `tools`; the inputs mirror Claude Code's
 * AskUserQuestion so models use it without extra prompting.
 *
 * The tool is a thin layer over `askUserQuestion()` from `./interactions.ts`,
 * which picks the channel (headless, local dialog, pause/resume host, or the
 * plain-chat fallback). This module adds only what that helper leaves to the
 * tool: the schema and usage guidance, a numbered terminal walk with a typed-
 * answer option, several questions per call, and the per-question summary.
 */

import type {
  ExtensionContext,
  ExtensionFactory,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type { RecipeExtensionRegistrationRegistry } from "./extensions.js";
import {
  askUserQuestion,
  formatInteractionOutcome,
  type AskUserOption,
  type AskUserOutcome,
  type AskUserResult,
} from "./interactions.js";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

/** The terminal option that opens a text input for the user's own answer. */
export const ASK_USER_TYPED_ANSWER_OPTION = "Something else — I'll type it";

const DONE_OPTION = "Done";
const BUILTIN_OWNER = "<builtin:ask_user_question>";

const MAX_QUESTIONS = 4;

const description = [
  "Ask the user one to four multiple-choice questions and wait for the answers.",
  "Prefer this over asking in plain text whenever you need the user to decide something.",
  "Each question gets 2 to 4 options; the user can always give their own answer instead, so never add an \"Other\" option.",
  "",
  "How to ask well:",
  "- One decision per question.",
  "- Keep each question short enough to read aloud in about 30 seconds.",
  "- Give enough context in the question that a bare option label still makes sense.",
  "- Don't list the options inside the question text; put them in `options`.",
  "- Option labels are short and unnumbered (the tool numbers them); use `description` for the trade-off.",
  "- For an approval, offer the approval itself; don't add a \"change it\" option, the user can type the changes.",
  "- Set `multiSelect` only when several options can be true at once.",
].join("\n");

/** Extra guidance when each pause can only carry one question per call. */
const PAUSE_HOST_NOTE =
  "In this session each call carries one question: to ask several, make one call per question in the same turn, and the user answers them together.";

function parametersSchema(maxQuestions: number) {
  return Type.Object(
    {
      questions: Type.Array(
        Type.Object(
          {
            question: Type.String({
              description:
                'The complete question, ending in "?". One decision, with enough context that a bare option still makes sense.',
            }),
            header: Type.String({
              description:
                'A very short label shown as a chip or title, at most 12 characters (e.g. "Auth method").',
            }),
            options: Type.Array(
              Type.Object(
                {
                  label: Type.String({
                    description:
                      "The choice as the user sees it: one to five words, without numbering.",
                  }),
                  description: Type.Optional(
                    Type.String({
                      description:
                        "What picking this option means, or its trade-off.",
                    })
                  ),
                },
                { additionalProperties: false }
              ),
              {
                minItems: 2,
                maxItems: 4,
                description:
                  'Two to four choices. Do not add an "Other" option; the user can always type their own answer.',
              }
            ),
            multiSelect: Type.Optional(
              Type.Boolean({
                description:
                  "Allow the user to pick several options. Defaults to false.",
              })
            ),
          },
          { additionalProperties: false }
        ),
        {
          minItems: 1,
          maxItems: maxQuestions,
          description:
            maxQuestions === 1
              ? "Exactly one question per call in this session."
              : "One to four questions, asked in order.",
        }
      ),
    },
    { additionalProperties: false }
  );
}

export type AskUserQuestionToolParams = Static<
  ReturnType<typeof parametersSchema>
>;
export type AskUserQuestionInput = AskUserQuestionToolParams["questions"][number];

/** How one question settled. */
export interface AskUserQuestionAnswer {
  question: string;
  header: string;
  multiSelect: boolean;
  outcome: "answered" | "declined";
  /** The chosen labels or typed text; empty when declined. */
  answers: string[];
}

/** Structured `details` of a finished `ask_user_question` result. */
export interface AskUserQuestionDetails {
  questions: AskUserQuestionAnswer[];
  /** Claude Code-style map from question text to its answer (several joined with ", "). */
  answers: Record<string, string>;
}

export interface AskUserQuestionToolOptions {
  /**
   * The session's environment, read for `PI_INTERRUPT_RESUME` (schema and
   * channel) and `PI_ASK_USER_AUTO_APPROVE`. Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

// Options are numbered by the tool, so strip numbering the model added:
// "1. Yes", "2) No", "(3) Maybe", "a. Fast", "b) Slow". "1.5x speed" is kept.
const MODEL_NUMBERING = /^\s*[([]?(?:\d{1,2}|[a-d])(?:[.:]\s+|[)\]]\s*)/i;

/** Remove numbering or lettering the model put at the start of an option label. */
export function stripOptionNumbering(label: string): string {
  const trimmed = label.trim();
  const stripped = trimmed.replace(MODEL_NUMBERING, "").trim();
  return stripped || trimmed;
}

function flagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

function questionOptions(input: AskUserQuestionInput): AskUserOption[] {
  return input.options.flatMap((option) => {
    const label = stripOptionNumbering(option.label);
    if (!label) return [];
    const optionDescription = option.description?.trim();
    return [
      {
        label,
        ...(optionDescription ? { description: optionDescription } : {}),
      },
    ];
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("User interaction aborted");
}

function numbered(index: number, option: AskUserOption): string {
  return option.description
    ? `${index + 1}. ${option.label} — ${option.description}`
    : `${index + 1}. ${option.label}`;
}

async function typedAnswer(
  question: string,
  ui: ExtensionUIContext,
  dialog: ExtensionUIDialogOptions,
  signal: AbortSignal | undefined
): Promise<string | undefined> {
  const text = await ui.input(question, "Type your answer", dialog);
  throwIfAborted(signal);
  return text?.trim() || undefined;
}

/**
 * The terminal and RPC walk: numbered options, then a last numbered option
 * that opens a text input. Returns the helper's outcome shape.
 */
export async function askInTerminal(
  question: string,
  options: readonly AskUserOption[],
  multiSelect: boolean,
  ui: ExtensionUIContext,
  dialog: ExtensionUIDialogOptions,
  signal: AbortSignal | undefined,
  preferCustomTui: boolean
): Promise<AskUserOutcome> {
  const typedIndex = options.length;
  if (!multiSelect) {
    const choices = [
      ...options.map((option, index) => numbered(index, option)),
      `${typedIndex + 1}. ${ASK_USER_TYPED_ANSWER_OPTION}`,
    ];
    const choice = await ui.select(question, choices, dialog);
    throwIfAborted(signal);
    const index = choice === undefined ? -1 : choices.indexOf(choice);
    if (index < 0) return { type: "declined" };
    if (index === typedIndex) {
      const answer = await typedAnswer(question, ui, dialog, signal);
      return answer ? { type: "answered", answer } : { type: "declined" };
    }
    return { type: "answered", answer: options[index]!.label };
  }

  const finish = async (
    selected: ReadonlySet<number>,
    typed: boolean
  ): Promise<AskUserOutcome> => {
    const answers = options
      .filter((_, index) => selected.has(index))
      .map((option) => option.label);
    if (typed) {
      const answer = await typedAnswer(question, ui, dialog, signal);
      if (answer && !answers.includes(answer)) answers.push(answer);
    }
    return answers.length > 0
      ? { type: "answered", answers }
      : { type: "declined" };
  };

  if (preferCustomTui && typeof ui.custom === "function") {
    const { showMultiSelectTui } = await import("./interaction-tui.js");
    const result = await showMultiSelectTui(
      question,
      options,
      ui,
      signal,
      `${typedIndex + 1}. ${ASK_USER_TYPED_ANSWER_OPTION}`
    );
    throwIfAborted(signal);
    if (!result) return { type: "declined" };
    return finish(new Set(result.selected), Boolean(result.custom));
  }

  // Portable loop for RPC clients: toggle options, then Done.
  const selected = new Set<number>();
  while (true) {
    const choices = [
      ...options.map(
        (option, index) =>
          `${selected.has(index) ? "[x]" : "[ ]"} ${numbered(index, option)}`
      ),
      `${typedIndex + 1}. ${ASK_USER_TYPED_ANSWER_OPTION}`,
      DONE_OPTION,
    ];
    const choice = await ui.select(question, choices, dialog);
    throwIfAborted(signal);
    const index = choice === undefined ? -1 : choices.indexOf(choice);
    if (index < 0) return { type: "declined" };
    if (index === typedIndex + 1) return finish(selected, false);
    if (index === typedIndex) return finish(selected, true);
    if (selected.has(index)) selected.delete(index);
    else selected.add(index);
  }
}

function answerLine(answer: AskUserQuestionAnswer): string {
  return answer.outcome === "answered"
    ? `${answer.header}: ${answer.answers.join(", ")}`
    : `${answer.header}: (no answer)`;
}

/** The text summary the model sees for finished answers. */
export function formatAskUserQuestionAnswers(
  answers: readonly AskUserQuestionAnswer[]
): string {
  const lines = answers.map(answerLine);
  if (answers.some((answer) => answer.outcome === "declined")) {
    lines.push(
      "",
      answers.length === 1
        ? formatInteractionOutcome({ type: "declined" })
        : "The user did not answer every question. Proceed with your best judgment for those."
    );
  }
  return lines.join("\n");
}

function answerFrom(
  input: AskUserQuestionInput,
  outcome: AskUserOutcome
): AskUserQuestionAnswer {
  const answers =
    outcome.type === "answered"
      ? (outcome.answers ?? [outcome.answer]).filter(Boolean)
      : [];
  return {
    question: input.question.trim(),
    header: input.header.trim() || "Answer",
    multiSelect: input.multiSelect === true,
    outcome: answers.length > 0 ? "answered" : "declined",
    answers,
  };
}

/**
 * Build the tool. Registration-time options only shape the description: on a
 * pause/resume host (`PI_INTERRUPT_RESUME`) the schema asks for one question
 * per call, since a host pause carries one interrupt per tool call.
 */
export function createAskUserQuestionTool(
  options: AskUserQuestionToolOptions = {}
): ToolDefinition {
  const env = () => options.env ?? process.env;
  const pauseHost = flagEnabled(env().PI_INTERRUPT_RESUME);
  const parameters = parametersSchema(pauseHost ? 1 : MAX_QUESTIONS);
  const tool: ToolDefinition<typeof parameters> = {
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: "Ask the user",
    description: pauseHost ? `${description}\n\n${PAUSE_HOST_NOTE}` : description,
    promptSnippet:
      "Ask the user multiple-choice questions and wait for their answers",
    promptGuidelines: [
      "When you need the user to decide something, use ask_user_question instead of asking in plain text.",
    ],
    parameters,
    // Interactions must not race other tools: a host pause would strand
    // half-finished parallel calls.
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return runAskUserQuestion(params, {
        toolCallId,
        ctx,
        signal,
        env: options.env,
      });
    },
  };
  return tool as unknown as ToolDefinition;
}

interface RunOptions {
  toolCallId: string;
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
  env?: NodeJS.ProcessEnv;
}

async function runAskUserQuestion(
  params: AskUserQuestionToolParams,
  opts: RunOptions
): Promise<AskUserResult | {
  content: Array<{ type: "text"; text: string }>;
  details: AskUserQuestionDetails;
}> {
  const questions = params.questions.slice(0, MAX_QUESTIONS);
  const collected: AskUserQuestionAnswer[] = [];

  for (const input of questions) {
    const options = questionOptions(input);
    const multiSelect = input.multiSelect === true && options.length > 0;
    const result = await askUserQuestion(
      {
        question: input.question.trim(),
        header: input.header.trim(),
        // Bare labels with descriptions: a pause/resume host renders them as
        // its own option list and always offers free text.
        options,
        selection: multiSelect ? "multiple" : "single",
      },
      {
        toolCallId: opts.toolCallId,
        ctx: opts.ctx,
        signal: opts.signal,
        ...(opts.env ? { env: opts.env } : {}),
        interactive: (ui, dialog) =>
          askInTerminal(
            input.question.trim(),
            options,
            multiSelect,
            ui,
            dialog,
            opts.signal,
            opts.ctx.mode === "tui"
          ),
      }
    );

    if (result.outcome.type === "awaiting_user") {
      // The host pauses on this result and rewrites it with the answer.
      if (questions.length === 1) return result;
      // One pause carries one interrupt per tool call, so a call with several
      // questions cannot be answered as one; nothing has been shown yet.
      return {
        content: [
          {
            type: "text",
            text:
              "Nothing was shown to the user. This session asks one question per ask_user_question call: " +
              `call it ${questions.length} times in the same turn, one question each, and the user answers them together.`,
          },
        ],
        details: { questions: [], answers: {} },
      };
    }
    // No channel at all: the helper's text tells the model to ask in chat.
    // The channel is the same for every question, so this is the first one.
    if (result.outcome.type === "unavailable") return result;
    collected.push(answerFrom(input, result.outcome));
  }

  return {
    content: [{ type: "text", text: formatAskUserQuestionAnswers(collected) }],
    details: detailsFor(collected),
  };
}

function detailsFor(
  answers: readonly AskUserQuestionAnswer[]
): AskUserQuestionDetails {
  return {
    questions: [...answers],
    answers: Object.fromEntries(
      answers
        .filter((answer) => answer.outcome === "answered")
        .map((answer) => [answer.question, answer.answers.join(", ")])
    ),
  };
}

/**
 * An extension factory registering the built-in tool, unless a Recipe or host
 * extension already registered a tool with the same name (a Recipe that ships
 * its own `ask_user_question` keeps it). Callers add it only when the agent
 * lists `ask_user_question` in `tools`, after the Recipe's own extensions.
 * `env` is the session's environment: its `PI_INTERRUPT_RESUME` and
 * `PI_ASK_USER_AUTO_APPROVE` shape the schema and pick the channel, so an
 * embedded host can set them per session without touching `process.env`.
 */
export function askUserQuestionExtension(
  registrations?: RecipeExtensionRegistrationRegistry,
  env?: NodeJS.ProcessEnv
): ExtensionFactory {
  return (pi) => {
    if (registrations?.owner("tool", ASK_USER_QUESTION_TOOL_NAME)) return;
    registrations?.claim("tool", ASK_USER_QUESTION_TOOL_NAME, BUILTIN_OWNER);
    pi.registerTool(createAskUserQuestionTool(env ? { env } : {}));
  };
}

/** Whether the agent opted into the built-in tool. */
export function wantsAskUserQuestion(agentTools: readonly string[]): boolean {
  return agentTools.includes(ASK_USER_QUESTION_TOOL_NAME);
}
