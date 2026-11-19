import {
  FitError,
  fitStepName,
  middleCut,
  type FitBudget,
  type FitSteps,
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
export interface PromptBuilder<Input, State = undefined> {
  name: string;
  version: number;
  defaultTemplate: string;
  defaultFit: FitSteps;
  /** The material-level steps this builder can run, by name. */
  steps: ReadonlySet<string>;
  build(input: Input, fit: FitSteps): Built<State>;
}

export interface BuildOptions {
  budget: FitBudget;
  template?: string;
  fit?: FitSteps;
}

export interface BuiltPrompt<State = undefined> {
  prompt: string;
  builder: string;
  applied: string[];
  digest?: string;
  state?: State;
}

const TEXT_STEPS = new Set(["middle_cut"]);

/**
 * Build one prompt: the builder fills its slots under the fit steps, the
 * template renders them, and a `middle_cut` last resort guarantees the
 * budget. Material steps a builder does not support are refused.
 */
export function buildPrompt<Input, State = undefined>(
  builder: PromptBuilder<Input, State>,
  input: Input,
  options: BuildOptions,
): BuiltPrompt<State> {
  const fit = options.fit ?? builder.defaultFit;
  for (const step of [...(fit.always ?? []), ...(fit.until_fit ?? [])]) {
    const [name] = fitStepName(step);
    if (!builder.steps.has(name)) {
      throw new FitError(
        `${builder.name}@${builder.version} has no fit step "${name}"`,
      );
    }
  }
  const lastResort =
    fit.last_resort === undefined ? undefined : fitStepName(fit.last_resort)[0];
  if (
    lastResort !== undefined &&
    !TEXT_STEPS.has(lastResort) &&
    !builder.steps.has(lastResort)
  ) {
    throw new FitError(
      `${builder.name}@${builder.version} has no fit step "${lastResort}"`,
    );
  }
  const built = builder.build(input, fit);
  let prompt = renderTemplate(
    options.template ?? builder.defaultTemplate,
    built.slots,
  );
  const applied = [...built.applied];
  if (lastResort === "middle_cut" && prompt.length > options.budget.maxUnits) {
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
