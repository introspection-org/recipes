import type { BuilderOptions } from "./builder.js";
import { PromptError } from "./fit.js";
import { promptBuilder } from "./registry.js";

/**
 * An agent's or a judge's `input:`: the builder that turns a raw input into
 * its prompt, by `name@version`, alone or with whatever options it reads.
 * The budget comes from the same file's `ai:` models.
 */
export type InputSpec = string | { builder: string; options?: BuilderOptions };

/** The builder and options an `input:` names; the builder must exist in this release. */
export function parseInputSpec(spec: InputSpec): {
  builder: string;
  options?: BuilderOptions;
} {
  const parsed = typeof spec === "string" ? { builder: spec } : spec;
  if (typeof parsed?.builder !== "string") {
    throw new PromptError(
      "input must name a builder, such as conversation_synthesis@1",
    );
  }
  promptBuilder(parsed.builder);
  return parsed;
}
