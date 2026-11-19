import { middleCut } from "./fit.js";

/** Whatever a builder accepts to change how it builds; each builder documents its keys. */
export type BuilderOptions = Record<string, unknown>;

/** What a builder made from one input. */
export interface BuiltPrompt<State = undefined> {
  prompt: string;
  /** What it cut, such as `middle_cut` when the prompt was over its budget. */
  applied: string[];
  /** Identity of what was read, taken before any cut. */
  digest?: string;
  /** What the caller needs back, such as where the next pass resumes. */
  state?: State;
}

/**
 * A named, versioned function from one raw input to a prompt that fits
 * `maxUnits` (UTF-16 units). Its version is bumped whenever the same input
 * and options render differently.
 */
export interface PromptBuilder<Input, State = undefined> {
  name: string;
  version: number;
  build(
    input: Input,
    maxUnits: number,
    options?: BuilderOptions,
  ): BuiltPrompt<State>;
}

/** `name@version`, as recipes and results name a builder. */
export function builderId(builder: PromptBuilder<unknown, unknown>): string {
  return `${builder.name}@${builder.version}`;
}

/** A prompt within `maxUnits`: cut in the middle when it is over. */
export function withinBudget(
  prompt: string,
  maxUnits: number,
  applied: string[] = [],
): { prompt: string; applied: string[] } {
  return prompt.length > maxUnits
    ? {
        prompt: middleCut(prompt, maxUnits),
        applied: [...applied, "middle_cut"],
      }
    : { prompt, applied };
}

/** A number option, or `fallback` when it is absent or not a number. */
export function numberOption(
  options: BuilderOptions | undefined,
  key: string,
  fallback: number,
): number {
  const value = options?.[key];
  return typeof value === "number" ? value : fallback;
}
