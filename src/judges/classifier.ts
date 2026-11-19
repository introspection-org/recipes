import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import type { JudgeClassifier } from "./controller.js";

const PROVIDERS = { openai: openaiProvider, typesafe: typesafeProvider };

/**
 * Answers classifier judges through Pi's own classifier models, with the
 * provider's key read from the environment. A judge's `ai.model` names one as
 * `<provider>/<model>`, for example `typesafe/jev-latest`.
 */
export function piClassifier(): JudgeClassifier {
  const models = createModels();
  const configured = new Set<string>();
  return async ({ model: spec, state, questions, signal }) => {
    const slash = spec.indexOf("/");
    const provider = spec.slice(0, slash);
    const create = PROVIDERS[provider as keyof typeof PROVIDERS];
    if (!create) {
      throw new Error(
        `classifier provider "${provider}" is not one of ${Object.keys(PROVIDERS).join(", ")}`,
      );
    }
    if (!configured.has(provider)) {
      models.setProvider(create());
      configured.add(provider);
    }
    const model = models.getModelOfType(
      "classifier",
      provider,
      spec.slice(slash + 1),
    );
    if (!model) throw new Error(`Pi has no classifier model ${spec}`);
    return models.classify(
      model,
      { state: state as never, questions },
      signal ? { signal } : undefined,
    );
  };
}
