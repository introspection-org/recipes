import {
  FitError,
  middleCut,
  stepName,
  type FitBudget,
  type PromptStep,
} from "./fit.js";
import { renderTemplate } from "./template.js";

/** What a builder made from one input, before the template renders it. */
export interface Built<State = undefined> {
  /** Finished, escaped text per placeholder. */
  slots: Record<string, string>;
  /** The fit steps that changed the material. */
  applied: string[];
  /** Identity of what was read, taken before fitting. */
  digest?: string;
  /** What the caller needs back, such as the next resume state. */
  state?: State;
}

/**
 * A named, versioned function from raw material to template slots. Its
 * version is bumped whenever the same input renders differently.
 */
export interface PromptBuilder<Input, State = undefined, Options = undefined> {
  name: string;
  version: number;
  defaultTemplate: string;
  /** Its steps for the model that reads the prompt, when a spec names none. */
  strategy: Strategy;
  /** Every step it can run, by name. */
  supportedSteps: ReadonlySet<string>;
  /** Fill the slots from `input`, running `steps` in order. */
  build(
    input: Input,
    steps: readonly PromptStep[],
    options?: Options,
  ): Built<State>;
}

/** The model that reads a prompt, as far as a strategy needs to know it. */
export interface ReaderModel {
  /** A classifier decides from far less than a chat model reads. */
  kind: "chat" | "classifier";
  /** Tokens, when the catalog knows it. */
  contextWindow?: number;
}

/** A builder's default steps for the model that reads its prompt. */
export type Strategy = (model: ReaderModel) => readonly PromptStep[];

/** How one prompt is built: its budget and reader, and any override of the builder's steps, template and options. */
export interface BuildOptions<Options = undefined> {
  budget: FitBudget;
  /** The model that reads it, which picks the builder's steps. Default: a chat model. */
  model?: ReaderModel;
  steps?: readonly PromptStep[];
  template?: string;
  options?: Options;
}

export interface BuiltPrompt<State = undefined> {
  prompt: string;
  builder: string;
  applied: string[];
  digest?: string;
  state?: State;
}

/**
 * Build one prompt: the builder runs its steps in order and fills its slots,
 * the template renders them, and a prompt still over the budget loses its
 * middle. Steps a builder does not run are refused.
 */
export function buildPrompt<Input, State = undefined, Options = undefined>(
  builder: PromptBuilder<Input, State, Options>,
  input: Input,
  options: BuildOptions<Options>,
): BuiltPrompt<State> {
  const steps =
    options.steps ?? builder.strategy(options.model ?? { kind: "chat" });
  for (const step of steps) {
    const [name] = stepName(step);
    if (!builder.supportedSteps.has(name)) {
      throw new FitError(
        `${builder.name}@${builder.version} has no step "${name}"`,
      );
    }
  }
  const built = builder.build(input, steps, options.options);
  let prompt = renderTemplate(
    options.template ?? builder.defaultTemplate,
    built.slots,
  );
  const applied = [...built.applied];
  if (prompt.length > options.budget.maxUnits) {
    prompt = middleCut(prompt, options.budget.maxUnits);
    applied.push("middle_cut");
  }
  return {
    prompt,
    builder: `${builder.name}@${builder.version}`,
    applied,
    ...(built.digest === undefined ? {} : { digest: built.digest }),
    ...(built.state === undefined ? {} : { state: built.state }),
  };
}
