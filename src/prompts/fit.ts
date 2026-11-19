import { prefix, suffix } from "./text.js";

/** How much a prompt may hold, in UTF-16 units. */
export interface FitBudget {
  maxUnits: number;
}

/** A step that trims a builder's material, by name, with its typed parameters. */
export type FitStep = string | Record<string, Record<string, unknown>>;

/**
 * How a prompt is trimmed towards its budget: `always` runs on every input,
 * `until_fit` in order until the prompt fits, and `last_resort` once more if
 * it still does not. A builder names the steps it supports.
 */
export interface FitSteps {
  always?: FitStep[];
  until_fit?: FitStep[];
  last_resort?: FitStep;
}

export class FitError extends Error {
  override name = "FitError";
}

/** A step's name and parameters. */
export function fitStepName(step: FitStep): [string, Record<string, unknown>] {
  if (typeof step === "string") return [step, {}];
  const entries = Object.entries(step);
  if (entries.length !== 1) {
    throw new FitError("a fit step names exactly one step");
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
