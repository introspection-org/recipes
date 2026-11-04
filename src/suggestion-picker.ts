/**
 * The first-run picker: a new Recipe session in the terminal asks once
 * "What would you like to do?" with up to three of the Recipe's prompt
 * templates marked `suggest: true`, through the same terminal helper
 * `ask_user_question` uses. With none marked, it does not ask.
 * Picking one sends it as the first message; typing an answer sends that;
 * Esc leaves the empty prompt. An initial message given on the command line
 * dismisses the picker before it can send anything.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { askInTerminal } from "./ask-user-question.js";
import type { AskUserOption, AskUserOutcome } from "./interactions.js";
import {
  expandWithoutArguments,
  fillSuggestion,
  pickSuggestions,
  readRecipeSuggestions,
  seededRandom,
  type RecipeSuggestion,
  type SuggestionValues,
} from "./recipe/suggestions.js";

export const SUGGESTIONS_QUESTION = "What would you like to do?";
/** Pins which three suggestions show, for tests and evals. */
export const SUGGESTIONS_SEED_ENV = "PI_RECIPES_SUGGESTIONS_SEED";

function hasMessages(ctx: ExtensionContext): boolean {
  const entries = ctx.sessionManager?.getEntries?.() ?? [];
  return entries.some((entry) => entry.type === "message");
}

function localDate(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** What Pi can fill locally: today's date and the git author name. */
async function localValues(pi: ExtensionAPI): Promise<SuggestionValues> {
  const values: SuggestionValues = { today: localDate() };
  try {
    const result = await pi.exec("git", ["config", "user.name"], { timeout: 2000 });
    const name = result.code === 0 ? result.stdout.trim() : "";
    if (name) values["member.name"] = name;
  } catch {
    // No git, or no name configured: leave {{member.name}} as written.
  }
  return values;
}

function suggestionOptions(suggestions: readonly RecipeSuggestion[]): AskUserOption[] {
  const seen = new Set<string>();
  return suggestions.map((suggestion) => {
    const command = `/${suggestion.name}`;
    const label =
      suggestion.description && !seen.has(suggestion.description)
        ? suggestion.description
        : command;
    seen.add(label);
    return label === command ? { label } : { label, description: command };
  });
}

/** Ask once and send the answer; resolves when the picker has settled. */
export async function offerRecipeSuggestions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  suggestions: readonly RecipeSuggestion[],
  signal?: AbortSignal
): Promise<void> {
  const options = suggestionOptions(suggestions);
  let outcome: AskUserOutcome;
  try {
    outcome = await askInTerminal(
      SUGGESTIONS_QUESTION,
      options,
      false,
      ctx.ui,
      signal ? { signal } : {},
      signal,
      true
    );
  } catch {
    return; // Dismissed by an initial message.
  }
  const answer = outcome.type === "answered" ? outcome.answer : undefined;
  if (!answer) return;
  const picked = suggestions[options.findIndex((option) => option.label === answer)];
  if (!picked) {
    // A typed answer behaves like text typed in the editor.
    pi.sendUserMessage(answer, { expandPromptTemplates: true });
    return;
  }
  if (picked.argumentHint?.includes("<")) {
    // A required argument: put the command in the editor for the user to finish.
    ctx.ui.setEditorText(`/${picked.name} `);
    return;
  }
  const values = picked.placeholders.length > 0 ? await localValues(pi) : {};
  pi.sendUserMessage(fillSuggestion(expandWithoutArguments(picked.text), values));
}

export interface RecipeSuggestionPicker {
  /** Call at the end of a successful recipe `session_start`. */
  sessionStarted(
    event: { reason: string },
    ctx: ExtensionContext,
    promptPaths: readonly string[]
  ): void;
  /** Dismiss a picker that is waiting or open. */
  cancel(): void;
}

/**
 * Create the picker and register the `input` handler that lets a
 * command-line or typed message dismiss it.
 */
export function createRecipeSuggestionPicker(
  pi: ExtensionAPI,
  env: NodeJS.ProcessEnv
): RecipeSuggestionPicker {
  let pending: AbortController | undefined;
  const cancel = () => {
    pending?.abort();
    pending = undefined;
  };

  pi.on("input", (event) => {
    if (event.source !== "extension") cancel();
    return { action: "continue" };
  });

  return {
    cancel,
    sessionStarted(event, ctx, promptPaths) {
      cancel();
      if (ctx.mode !== "tui") return;
      if (event.reason !== "startup" && event.reason !== "new") return;
      if (promptPaths.length === 0 || hasMessages(ctx)) return;
      const seed = env[SUGGESTIONS_SEED_ENV]?.trim();
      const suggestions = pickSuggestions(
        readRecipeSuggestions(promptPaths),
        3,
        seed ? seededRandom(seed) : Math.random
      );
      if (suggestions.length === 0) return;
      const controller = new AbortController();
      pending = controller;
      // Pi sends a command-line message only after session_start returns, so
      // ask on the next tick; that message's input event dismisses the picker.
      setTimeout(() => {
        if (controller.signal.aborted) return;
        if (hasMessages(ctx) || ctx.isIdle?.() === false) return;
        void offerRecipeSuggestions(pi, ctx, suggestions, controller.signal).finally(() => {
          if (pending === controller) pending = undefined;
        });
      }, 0);
    },
  };
}
