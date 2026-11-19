import { prefix, suffix } from "./text.js";

/** How much a prompt may hold, in UTF-16 units. */
export interface FitBudget {
  maxUnits: number;
}

/** A step that shapes a builder's material, by name, with its parameters. */
export type PromptStep = string | Record<string, Record<string, unknown>>;

export class FitError extends Error {
  override name = "FitError";
}

/** A step's name and parameters. */
export function stepName(step: PromptStep): [string, Record<string, unknown>] {
  if (typeof step === "string") return [step, {}];
  const entries = Object.entries(step);
  if (entries.length !== 1) {
    throw new FitError("a step names exactly one step");
  }
  return entries[0]!;
}

const MIDDLE_CUT_MARKER =
  "\n… transcript middle redacted to fit the judge's budget …\n";

/** Keep the head and tail of `text`, cutting its middle to fit `maxUnits`. */
export function middleCut(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  const available = Math.max(0, maxUnits - MIDDLE_CUT_MARKER.length);
  const head = Math.floor(available / 2);
  return `${prefix(text, head)}${MIDDLE_CUT_MARKER}${suffix(text, available - head)}`;
}
