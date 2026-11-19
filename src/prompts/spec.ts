import { FitError, stepName, type PromptStep } from "./fit.js";
import { promptBuilder } from "./registry.js";
import { templatePlaceholders } from "./template.js";

/**
 * How a prompt is built from a raw input: an agent's or a judge's `prompt:`.
 * The budget is never part of it; it comes from the same agent's `ai:` models,
 * and a prompt still over it loses its middle.
 */
export interface PromptSpec {
  /** `name@version`, such as `conversation_case@1`. */
  builder: string;
  /** Run in order; the builder's own when absent. */
  steps?: PromptStep[];
  template?: string;
  options?: Record<string, unknown>;
}

const SPEC_KEYS = new Set(["builder", "steps", "template", "options"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Check a `prompt:` block against the builders this release holds; every problem is named. */
export function validatePromptSpec(
  value: unknown,
  where = "prompt",
): PromptSpec {
  if (!isRecord(value)) throw new FitError(`${where} must be an object`);
  const problems: string[] = [];
  const unknown = Object.keys(value).filter((key) => !SPEC_KEYS.has(key));
  if (unknown.length > 0) problems.push(`unknown key(s) ${unknown.join(", ")}`);
  if (typeof value.builder !== "string") {
    throw new FitError(
      `${where}.builder must name a builder, such as conversation_case@1`,
    );
  }
  const builder = promptBuilder(value.builder);
  if (value.template !== undefined) {
    if (typeof value.template !== "string")
      problems.push("template must be a string");
    else templatePlaceholders(value.template);
  }
  if (value.options !== undefined && !isRecord(value.options)) {
    problems.push("options must be an object");
  }
  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps)) {
      problems.push("steps must be a list");
    } else {
      for (const step of value.steps) {
        try {
          const [name, params] = stepName(step as PromptStep);
          if (!isRecord(params))
            problems.push(`step ${name} takes an object of parameters`);
          if (!builder.supportedSteps.has(name)) {
            problems.push(`${value.builder} has no step "${name}"`);
          }
        } catch (error) {
          problems.push((error as Error).message);
        }
      }
    }
  }
  if (problems.length > 0)
    throw new FitError(`${where}: ${problems.join("; ")}`);
  return value as unknown as PromptSpec;
}
