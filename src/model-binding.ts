import {
  InMemoryCredentialStore,
  type Api,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
} from "@earendil-works/pi-ai";
import {
  getEnvApiKey,
  getModel,
  type Model,
} from "@earendil-works/pi-ai/compat";
import type {
  ModelRegistry,
  ModelRoute,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { expectedProviderEnvVars } from "./provider-env.js";

const AMBIENT_CREDENTIAL_SENTINEL = "<authenticated>";

/**
 * Providers that serve the same model ids on a subscription. A Recipe names
 * `openai/<model>`; on a host logged in to ChatGPT, the model runs as
 * `openai-codex/<model>` when `openai` has no credential there.
 */
const PROVIDER_ALIASES: Record<string, readonly string[]> = {
  openai: ["openai-codex"],
};

/** How long a token read through the parent stays valid for the child: past Pi's five-minute refresh window, so the child never refreshes it itself. */
const PARENT_OAUTH_VALIDITY_MS = 10 * 60_000;

/**
 * A child session's credential for a provider the host's Pi signs in to with
 * OAuth (`openai-codex`, a Claude subscription). Each read asks the parent's
 * registry for a current token, so the parent's Pi refreshes it and the child
 * never does. Pi's Codex provider accepts only an OAuth credential.
 */
class ParentOAuthCredentialStore implements CredentialStore {
  constructor(
    private readonly provider: string,
    private readonly model: Model<Api>,
    private readonly registry: ModelRegistry,
  ) {}

  async read(providerId: string): Promise<Credential | undefined> {
    if (providerId !== this.provider) return undefined;
    const auth = await this.registry.getApiKeyAndHeaders(this.model);
    if (!auth.ok || !auth.apiKey) return undefined;
    return {
      type: "oauth",
      access: auth.apiKey,
      refresh: "",
      expires: Date.now() + PARENT_OAUTH_VALIDITY_MS,
    };
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [{ providerId: this.provider, type: "oauth" }];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return fn(await this.read(providerId));
  }

  async delete(): Promise<void> {}
}

/** One store per provider, for a session whose models span providers. */
class ProviderCredentialStores implements CredentialStore {
  constructor(private readonly stores: ReadonlyMap<string, CredentialStore>) {}

  read(providerId: string): Promise<Credential | undefined> {
    return (
      this.stores.get(providerId)?.read(providerId) ??
      Promise.resolve(undefined)
    );
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const lists = await Promise.all(
      [...this.stores].map(async ([provider, store]) =>
        (await store.list()).filter((info) => info.providerId === provider),
      ),
    );
    return lists.flat();
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const store = this.stores.get(providerId);
    return store ? store.modify(providerId, fn) : fn(undefined);
  }

  async delete(providerId: string): Promise<void> {
    await this.stores.get(providerId)?.delete(providerId);
  }
}

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

function servesSpec(model: Model<Api>, spec: string): boolean {
  const { lookupProvider, modelId } = parseRecipeModelSpec(spec);
  return (
    model.id === modelId &&
    (model.provider === lookupProvider ||
      (PROVIDER_ALIASES[lookupProvider]?.includes(model.provider) ?? false))
  );
}

export function assertRecipeModelTransport(
  modelSpec: string,
  model: Model<Api> | undefined,
  fallbacks: readonly string[] = [],
): RecipeModelIdentity {
  const identity = parseRecipeModelSpec(modelSpec);
  if (
    model &&
    ![modelSpec, ...fallbacks].some((spec) => servesSpec(model, spec))
  ) {
    throw new RecipeModelTransportError(modelSpec, model.provider, model.id);
  }
  return identity;
}

function resolveRecipeModel(
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

async function hasCredential(
  model: Model<Api>,
  env: NodeJS.ProcessEnv,
  modelRegistry: ModelRegistry,
): Promise<boolean> {
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (auth.ok && (auth.apiKey || auth.env)) return true;
  return Boolean(
    getEnvApiKey(model.provider, env as Record<string, string>) ??
    env[`${model.provider.toUpperCase().replace(/-/g, "_")}_API_KEY`],
  );
}

/**
 * The model a Recipe agent runs on this host: the one it names, or the same
 * model id under an alias provider (`openai` -> `openai-codex`) when the named
 * provider has no credential here and the alias has one. The alias is a copy,
 * so the registry's own models are never changed.
 */
export async function resolveRecipeAgentModel(
  modelSpec: string,
  env: NodeJS.ProcessEnv,
  modelRegistry?: ModelRegistry,
): Promise<Model<Api>> {
  const model = resolveRecipeModel(modelSpec, modelRegistry);
  if (!modelRegistry || (await hasCredential(model, env, modelRegistry)))
    return model;
  for (const provider of PROVIDER_ALIASES[model.provider] ?? []) {
    const alias = modelRegistry.find(provider, model.id);
    if (alias && (await hasCredential(alias, env, modelRegistry)))
      return { ...alias, headers: { ...(alias.headers ?? {}) } };
  }
  return model;
}

/** The models a Recipe agent can run here, in order, and one store holding their credentials. */
export interface RecipeAgentModels {
  models: Model<Api>[];
  credentials: CredentialStore;
}

/**
 * Resolve an agent's model and its `ai.fallbacks`, keeping each that this host
 * has a credential for (an alias counts, as `resolveRecipeAgentModel` says).
 * The first is the model the session starts on. Fallbacks and the alias need a
 * Pi host and no store from the caller: a host that passes its own store bills
 * the model the Recipe names, so it gets that model or its credential error.
 */
export async function resolveRecipeAgentModels(opts: {
  modelSpec: string;
  fallbacks?: readonly string[];
  env: NodeJS.ProcessEnv;
  credentials?: CredentialStore;
  modelRegistry?: ModelRegistry;
}): Promise<RecipeAgentModels> {
  const specs =
    opts.modelRegistry && !opts.credentials
      ? [opts.modelSpec, ...(opts.fallbacks ?? [])]
      : [opts.modelSpec];
  const found: { model: Model<Api>; credentials: CredentialStore }[] = [];
  let firstError: unknown;
  for (const spec of specs) {
    try {
      const model = opts.credentials
        ? resolveRecipeModel(spec, opts.modelRegistry)
        : await resolveRecipeAgentModel(spec, opts.env, opts.modelRegistry);
      const credentials = await resolveRecipeCredentials({
        provider: model.provider,
        env: opts.env,
        model,
        ...(opts.credentials ? { credentials: opts.credentials } : {}),
        ...(opts.modelRegistry ? { modelRegistry: opts.modelRegistry } : {}),
      });
      // An alias can resolve two entries to one model, which a retry would never move past.
      if (!found.some((entry) => sameModel(entry.model, model)))
        found.push({ model, credentials });
    } catch (error) {
      if (
        !(error instanceof RecipeCredentialError) &&
        !(error instanceof RecipeModelError)
      )
        throw error;
      firstError ??= error;
    }
  }
  if (found.length === 0) throw firstError;
  if (found.length === 1)
    return { models: [found[0]!.model], credentials: found[0]!.credentials };
  return {
    models: found.map(({ model }) => model),
    credentials: new ProviderCredentialStores(
      new Map(
        found.map(({ model, credentials }) => [model.provider, credentials]),
      ),
    ),
  };
}

function sameModel(a: Model<Api>, b: Model<Api>): boolean {
  return a.provider === b.provider && a.id === b.id;
}

/**
 * Route one request of a session with fallbacks: a retry after a failed
 * request moves to the next model, and every other request stays on the model
 * that last answered, so its prompt cache keeps working.
 */
export function routeRecipeFallbacks(
  models: readonly Model<Api>[],
  request: ModelRouteRequest,
): ModelRoute {
  const after = request.reason === "retry" ? request.failed : undefined;
  const model = after
    ? models[
        Math.min(
          models.findIndex((candidate) => sameModel(candidate, after.model)) +
            1,
          models.length - 1,
        )
      ]!
    : (models.find(
        (candidate) =>
          request.previous && sameModel(candidate, request.previous.model),
      ) ?? models[0]!);
  return { model, thinkingLevel: request.thinkingLevel };
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
      if (auth.apiKey && opts.modelRegistry.isUsingOAuth?.(opts.model))
        return new ParentOAuthCredentialStore(
          opts.provider,
          opts.model,
          opts.modelRegistry,
        );
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
