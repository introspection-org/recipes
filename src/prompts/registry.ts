import type { PromptBuilder } from "./builder.js";
import { conversationCaseBuilder } from "./builders/conversation-case.js";
import { trajectoryBuilder } from "./builders/trajectory.js";
import { FitError } from "./fit.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a registry holds builders of every input type.
type AnyBuilder = PromptBuilder<any, any, any>;

/** Every builder a recipe or a batch can name, as `name@version`. */
export const PROMPT_BUILDERS: ReadonlyMap<string, AnyBuilder> = new Map<
  string,
  AnyBuilder
>(
  [trajectoryBuilder, conversationCaseBuilder].map((builder) => [
    `${builder.name}@${builder.version}`,
    builder,
  ]),
);

/** The builder a recipe names, such as `conversation_case@1`. */
export function promptBuilder(id: string): AnyBuilder {
  const builder = PROMPT_BUILDERS.get(id);
  if (builder === undefined) {
    throw new FitError(
      `no prompt builder "${id}"; known: ${[...PROMPT_BUILDERS.keys()].join(", ")}`,
    );
  }
  return builder;
}
