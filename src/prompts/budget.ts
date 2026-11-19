import type { Api, Model } from "@earendil-works/pi-ai";

/** UTF-16 units a token is taken to hold: conservative, so a prompt rarely overruns. */
export const UNITS_PER_TOKEN = 3;
/** Tokens left for the reply, at most: a model's own `maxTokens` when smaller. */
export const OUTPUT_RESERVE_TOKENS = 16_384;
/**
 * The most any prompt holds, whatever the window: past it more transcript
 * stops improving what a reader answers and only adds cost. It is also the
 * budget for a model the catalog does not know.
 */
export const MAX_PROMPT_TOKENS = 300_000;
export const MAX_PROMPT_UNITS = MAX_PROMPT_TOKENS * UNITS_PER_TOKEN;

type Window = Pick<Model<Api>, "contextWindow" | "maxTokens">;

/** What one model can read, in UTF-16 units, after its reply's reserve and within the ceiling. */
export function modelBudgetUnits(model: Window): number {
  const reserve = Math.min(
    model.maxTokens > 0 ? model.maxTokens : OUTPUT_RESERVE_TOKENS,
    OUTPUT_RESERVE_TOKENS,
  );
  return Math.min(
    Math.max(0, model.contextWindow - reserve) * UNITS_PER_TOKEN,
    MAX_PROMPT_UNITS,
  );
}

/**
 * What a prompt may hold to be read by every model that may answer it (an
 * `ai:` model and its fallbacks, from the catalog): the smallest of theirs,
 * since a session cannot be rebuilt when Pi falls back mid-session. A model
 * the catalog does not know takes `ceilingUnits`, so a missing entry never
 * widens it, and no budget passes it.
 */
export function promptBudget(
  models: readonly (Window | undefined)[],
  ceilingUnits: number = MAX_PROMPT_UNITS,
): number {
  const units = models.map((model) =>
    model && model.contextWindow > 0 ? modelBudgetUnits(model) : ceilingUnits,
  );
  return Math.min(ceilingUnits, ...units);
}
