import {
  FitError,
  fitStepName,
  middleCut,
  type FitBudget,
  type FitStep,
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
export interface PromptBuilder<Input, State = undefined, Options = undefined> {
  name: string;
  version: number;
  defaultTemplate: string;
  defaultFit: FitSteps;
  /** The material-level steps this builder can run, by name. */
  steps: ReadonlySet<string>;
  /** Fill the slots from `input`, running `steps` in order. */
  build(
    input: Input,
    steps: readonly FitStep[],
    options?: Options,
  ): Built<State>;
}

/** How one prompt is built: its budget, and any override of the builder's template, fit and options. */
export interface BuildOptions<Options = undefined> {
  budget: FitBudget;
  template?: string;
  fit?: FitSteps;
  options?: Options;
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
 * Build one prompt. `always` steps run on every input; `until_fit` steps are
 * added one at a time, in order, until the rendered prompt fits the budget;
 * a `middle_cut` last resort then guarantees it. Steps a builder does not
 * support are refused.
 */
export function buildPrompt<Input, State = undefined, Options = undefined>(
  builder: PromptBuilder<Input, State, Options>,
  input: Input,
  options: BuildOptions<Options>,
): BuiltPrompt<State> {
  const fit = options.fit ?? builder.defaultFit;
  const always = fit.always ?? [];
  const untilFit = fit.until_fit ?? [];
  for (const step of [...always, ...untilFit]) {
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
  const template = options.template ?? builder.defaultTemplate;
  const render = (steps: readonly FitStep[]) => {
    const built = builder.build(input, steps, options.options);
    return { built, prompt: renderTemplate(template, built.slots) };
  };
  let { built, prompt } = render(always);
  for (
    let added = 1;
    added <= untilFit.length && prompt.length > options.budget.maxUnits;
    added++
  ) {
    ({ built, prompt } = render([...always, ...untilFit.slice(0, added)]));
  }
  const applied = [...built.applied];
  if (lastResort !== undefined && prompt.length > options.budget.maxUnits) {
    if (lastResort === "middle_cut") {
      prompt = middleCut(prompt, options.budget.maxUnits);
    } else {
      ({ built, prompt } = render([...always, ...untilFit, fit.last_resort!]));
      applied.splice(0, applied.length, ...built.applied);
    }
    applied.push(lastResort);
  }
  return {
    prompt,
    builder: `${builder.name}@${builder.version}`,
    applied,
    ...(built.digest === undefined ? {} : { digest: built.digest }),
    ...(built.state === undefined ? {} : { state: built.state }),
  };
}
