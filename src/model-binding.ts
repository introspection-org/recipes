import {
  InMemoryCredentialStore,
  type Api,
  type CredentialStore,
} from "@earendil-works/pi-ai";
import {
  getEnvApiKey,
  getModel,
  type Model,
} from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { expectedProviderEnvVars } from "./provider-env.js";

const AMBIENT_CREDENTIAL_SENTINEL = "<authenticated>";

export interface RecipeModelIdentity {
  provider: string;
  modelId: string;
  lookupProvider: string;
}

export class RecipeCredentialError extends Error {
  override readonly name = "RecipeCredentialError";

  constructor(
    readonly provider: string,
    readonly expectedEnvVars: readonly string[],
  ) {
    super(
      `No credential for model provider "${provider}": set ${expectedEnvVars.join(" or ")}, or pass a CredentialStore via credentials`,
    );
  }
}

export class RecipeModelError extends Error {
  override readonly name = "RecipeModelError";

  constructor(readonly modelSpec: string) {
    super(`Recipe model is not available: ${modelSpec}`);
  }
}

export class RecipeModelTransportError extends Error {
  override readonly name = "RecipeModelTransportError";

  constructor(recipeModel: string, provider: string, modelId: string) {
    super(
      `Host model transport "${provider}/${modelId}" does not match Recipe model "${recipeModel}"`,
    );
  }
}

function parseRecipeModelSpec(spec: string): RecipeModelIdentity {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(
      `Invalid recipe model "${spec}" - expected "<provider>/<model_id>"`,
    );
  }
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  const lookupProvider = provider === "gemini" ? "google" : provider;
  return { provider, modelId, lookupProvider };
}

export function assertRecipeModelTransport(
  modelSpec: string,
  model: Model<Api> | undefined,
): RecipeModelIdentity {
  const identity = parseRecipeModelSpec(modelSpec);
  if (
    model &&
    (model.provider !== identity.lookupProvider ||
      model.id !== identity.modelId)
  ) {
    throw new RecipeModelTransportError(modelSpec, model.provider, model.id);
  }
  return identity;
}

export function resolveRecipeModel(
  modelSpec: string,
  modelRegistry?: ModelRegistry,
): Model<Api> {
  const { modelId, lookupProvider } = parseRecipeModelSpec(modelSpec);
  const model =
    modelRegistry?.find(lookupProvider, modelId) ??
    getModel(lookupProvider as never, modelId as never);
  if (!model) throw new RecipeModelError(modelSpec);
  return model;
}

/**
 * Resolve credentials against the supplied environment and optional Pi model
 * registry. Explicit stores, Pi-managed auth, provider env keys, and ambient
 * provider chains all pass through this one fail-closed boundary.
 */
export async function resolveRecipeCredentials(opts: {
  provider: string;
  env: NodeJS.ProcessEnv;
  credentials?: CredentialStore;
  model?: Model<Api>;
  modelRegistry?: ModelRegistry;
}): Promise<CredentialStore> {
  if (opts.credentials) {
    const stored = await opts.credentials.read(opts.provider);
    if (!stored) {
      throw new RecipeCredentialError(
        opts.provider,
        expectedProviderEnvVars(opts.provider),
      );
    }
    return opts.credentials;
  }

  const store = new InMemoryCredentialStore();
  let apiKey: string | undefined;
  let credentialEnv: Record<string, string> | undefined;
  if (opts.model && opts.modelRegistry) {
    const auth = await opts.modelRegistry.getApiKeyAndHeaders(opts.model);
    if (auth.ok) {
      apiKey = auth.apiKey;
      credentialEnv = auth.env;
      if (auth.headers) {
        const headers = { ...(opts.model.headers ?? {}) };
        for (const [name, value] of Object.entries(auth.headers)) {
          if (value === null) delete headers[name];
          else headers[name] = value;
        }
        opts.model.headers = headers;
      }
    }
  }

  apiKey ??=
    getEnvApiKey(opts.provider, opts.env as Record<string, string>) ??
    opts.env[`${opts.provider.toUpperCase().replace(/-/g, "_")}_API_KEY`];
  const hasTransportHeaders =
    opts.model && Object.keys(opts.model.headers ?? {}).length > 0;
  if (!apiKey && !hasTransportHeaders) {
    throw new RecipeCredentialError(
      opts.provider,
      expectedProviderEnvVars(opts.provider),
    );
  }
  if ((apiKey && apiKey !== AMBIENT_CREDENTIAL_SENTINEL) || credentialEnv) {
    await store.modify(opts.provider, async () => ({
      type: "api_key",
      ...(apiKey && apiKey !== AMBIENT_CREDENTIAL_SENTINEL
        ? { key: apiKey }
        : {}),
      ...(credentialEnv ? { env: credentialEnv } : {}),
    }));
  }
  return store;
}
