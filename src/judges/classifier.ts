import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import type { JudgeClassifier } from "./controller.js";

const PROVIDERS = { openai: openaiProvider, typesafe: typesafeProvider };

/**
 * A classifier model's catalog entry, `<provider>/<model>`, or undefined when
 * Pi has none: judges size a classifier's prompt to its window.
 */
export function findClassifierModel(
  spec: string,
): { contextWindow: number; maxTokens: number } | undefined {
  const slash = spec.indexOf("/");
  const create = PROVIDERS[spec.slice(0, slash) as keyof typeof PROVIDERS];
  if (slash < 0 || !create) return undefined;
  const models = createModels();
  models.setProvider(create());
  const model = models.getModelOfType(
    "classifier",
    spec.slice(0, slash),
    spec.slice(slash + 1),
  );
  if (!model?.contextWindow) return undefined;
  // A classifier answers its questions only, so its reply needs little room.
  return { contextWindow: model.contextWindow, maxTokens: 1_024 };
}

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
