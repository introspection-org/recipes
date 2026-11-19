import { builderId, type PromptBuilder } from "./builder.js";
import { conversationSynthesis } from "./builders/conversation-synthesis.js";
import {
  trajectoryLlmClassify,
  trajectoryLlmJudge,
} from "./builders/trajectory.js";
import { PromptError } from "./fit.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a registry holds builders of every input type.
type AnyBuilder = PromptBuilder<any, any>;

/** Every builder a recipe or a batch can name, as `name@version`. */
export const PROMPT_BUILDERS: ReadonlyMap<string, AnyBuilder> = new Map(
  [trajectoryLlmJudge, trajectoryLlmClassify, conversationSynthesis].map(
    (builder) => [builderId(builder), builder as AnyBuilder],
  ),
);

/** The builder a recipe names, such as `conversation_synthesis@1`. */
export function promptBuilder(id: string): AnyBuilder {
  const builder = PROMPT_BUILDERS.get(id);
  if (builder === undefined) {
    throw new PromptError(
      `no prompt builder "${id}"; known: ${[...PROMPT_BUILDERS.keys()].join(", ")}`,
    );
  }
  return builder;
}
