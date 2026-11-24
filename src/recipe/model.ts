import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  Api,
  CacheRetention,
  Model,
  OpenRouterRouting,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import Type, { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Pi request options a Recipe may not set: the host owns them. */
const HOST_OWNED_OPTIONS = [
  "api_key",
  "azure_api_version",
  "azure_base_url",
  "azure_deployment_name",
  "azure_resource_name",
  "bearer_token",
  "client",
  "env",
  "fetch",
  "headers",
  "location",
  "on_payload",
  "on_response",
  "profile",
  "project",
  "reasoning",
  "region",
  "session_id",
  "signal",
  "telemetry_context",
  "transform_headers",
];

const SNAKE_CASE_KEY = "^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$";

/** `<provider>/<model_id>`, surrounding space allowed. */
const MODEL_SPEC = "^\\s*[^\\s/][^/]*/.*\\S\\s*$";

const strict = { additionalProperties: false } as const;
const openMap = Type.Record(Type.String(), Type.Unknown());

const AnthropicSchema = Type.Object(
  {
    betas: Type.Optional(Type.Array(Type.String({ pattern: "\\S" }))),
    context_management: Type.Optional(openMap),
  },
  strict,
);

/**
 * An agent's or a judge's `ai:` block. Provider-owned payloads (`options`,
 * the routing maps) are open, so a provider's new field needs no release.
 */
const AiConfigSchema = Type.Object(
  {
    /** `<provider>/<model_id>`. */
    model: Type.Optional(Type.String()),
    models: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object(
          {
            provider: Type.String({ pattern: "^[^\\s/:]+$" }),
            model: Type.String({ pattern: "^[^\\s/]+(?:/[^\\s/]+)*$" }),
            thinking_level: Type.Optional(Type.Enum([...THINKING_LEVELS])),
          },
          strict,
        ),
        { minProperties: 1 },
      ),
    ),
    default_model: Type.Optional(Type.String()),
    /** Models tried in order when `model` fails, each `<provider>/<model_id>`. */
    fallbacks: Type.Optional(Type.Array(Type.String({ pattern: MODEL_SPEC }))),
    thinking_level: Type.Optional(Type.Enum([...THINKING_LEVELS])),
    /** Pi request options, in snake_case; host-owned ones are refused. */
    options: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        propertyNames: {
          pattern: SNAKE_CASE_KEY,
          not: { enum: HOST_OWNED_OPTIONS },
        },
      }),
    ),
    providers: Type.Optional(
      Type.Object(
        {
          openrouter: Type.Optional(
            Type.Object({ routing: Type.Optional(openMap) }, strict),
          ),
          anthropic: Type.Optional(AnthropicSchema),
          vercel_ai_gateway: Type.Optional(
            Type.Object(
              {
                routing: Type.Optional(
                  Type.Record(Type.String(), Type.Unknown(), {
                    propertyNames: { not: { enum: ["byok"] } },
                  }),
                ),
              },
              strict,
            ),
          ),
        },
        strict,
      ),
    ),
  },
  strict,
);

/** An `ai:` block as authored. */
type AiConfig = Static<typeof AiConfigSchema>;

/**
 * The older agent `model:` block. It is read as an `ai:` block
 * ({@link legacyModelAsAi}) and stays strict, OpenRouter routing included, so
 * a typo in a published Recipe still fails.
 */
const LegacyModelSchema = Type.Object(
  {
    name: Type.Optional(Type.String()),
    thinking_level: Type.Optional(Type.Enum([...THINKING_LEVELS])),
    temperature: Type.Optional(Type.Number({ minimum: 0 })),
    max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
    cache_retention: Type.Optional(Type.Enum(["none", "short", "long"])),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 1 })),
    max_retries: Type.Optional(Type.Integer({ minimum: 0 })),
    max_retry_delay_ms: Type.Optional(Type.Integer({ minimum: 0 })),
    providers: Type.Optional(
      Type.Object(
        {
          openrouter: Type.Optional(
            Type.Object(
              {
                routing: Type.Optional(
                  Type.Object(
                    {
                      allow_fallbacks: Type.Optional(Type.Unknown()),
                      require_parameters: Type.Optional(Type.Unknown()),
                      data_collection: Type.Optional(Type.Unknown()),
                      zdr: Type.Optional(Type.Unknown()),
                      enforce_distillable_text: Type.Optional(Type.Unknown()),
                      order: Type.Optional(Type.Unknown()),
                      only: Type.Optional(Type.Unknown()),
                      ignore: Type.Optional(Type.Unknown()),
                      quantizations: Type.Optional(Type.Unknown()),
                      sort: Type.Optional(Type.Unknown()),
                      max_price: Type.Optional(Type.Unknown()),
                      preferred_min_throughput: Type.Optional(Type.Unknown()),
                      preferred_max_latency: Type.Optional(Type.Unknown()),
                    },
                    strict,
                  ),
                ),
              },
              strict,
            ),
          ),
          anthropic: Type.Optional(AnthropicSchema),
        },
        strict,
      ),
    ),
  },
  strict,
);

type LegacyModel = Static<typeof LegacyModelSchema>;

const LEGACY_OPTION_KEYS = [
  "temperature",
  "max_tokens",
  "cache_retention",
  "timeout_ms",
  "max_retries",
  "max_retry_delay_ms",
] as const;

interface RecipeAgentModelStreamOptions extends Record<string, unknown> {
  temperature?: number;
  maxTokens?: number;
  cacheRetention?: CacheRetention;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
}

interface RecipeAgentModelAnthropicOptions {
  betas?: string[];
  contextManagement?: unknown;
}

type RecipeAgentVercelAiGatewayRouting = Record<string, unknown>;

export interface RecipeAgentModelConfig {
  name?: string;
  models?: NonNullable<AiConfig["models"]>;
  defaultModel?: string;
  /** Models to move to, in order, when `name` has no credential or a request to it fails and Pi retries. */
  fallbacks?: string[];
  thinkingLevel?: ThinkingLevel;
  streamOptions?: RecipeAgentModelStreamOptions;
  openrouter?: OpenRouterRouting;
  anthropic?: RecipeAgentModelAnthropicOptions;
  vercelAiGateway?: RecipeAgentVercelAiGatewayRouting;
}

export class RecipeModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeModelConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasKeys(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, character: string) =>
    character.toUpperCase(),
  );
}

function at(value: unknown, pointer: string): unknown {
  return pointer
    .split("/")
    .slice(1)
    .reduce<unknown>(
      (node, key) =>
        isRecord(node) || Array.isArray(node)
          ? (node as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}

/** `/providers/anthropic/betas/0` under `ai` → `ai.providers.anthropic.betas[0]`. */
function dotted(prefix: string, pointer: string): string {
  return pointer
    .split("/")
    .slice(1)
    .reduce(
      (path, key) => (/^\d+$/.test(key) ? `${path}[${key}]` : `${path}.${key}`),
      prefix,
    );
}

/**
 * Check `value` against `schema`, refusing it with one message that names the
 * field: the schema decides what is valid, this only words the first problem.
 */
function check<T extends TSchema>(
  schema: T,
  context: string,
  prefix: string,
  value: unknown,
): Static<T> {
  if (Value.Check(schema, value)) return value as Static<T>;
  // A refused key also fails its own subschema; the key-level error says more.
  const errors = [...Value.Errors(schema, value)].filter(
    (error) => error.keyword !== "boolean" && error.keyword !== "not",
  );
  const error =
    errors.find(
      (candidate) =>
        candidate.keyword === "additionalProperties" ||
        candidate.keyword === "propertyNames",
    ) ?? errors[0];
  if (!error) {
    throw new RecipeModelConfigError(`${context} has invalid ${prefix}`);
  }
  const path = dotted(prefix, error.instancePath);
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "additionalProperties":
      throw new RecipeModelConfigError(
        `${context} has unsupported ${path} key(s): ${(params.additionalProperties as string[]).join(", ")}`,
      );
    case "propertyNames": {
      const names = params.propertyNames as string[];
      const malformed = names.find(
        (name) => !new RegExp(SNAKE_CASE_KEY).test(name),
      );
      throw new RecipeModelConfigError(
        malformed !== undefined && path.endsWith(".options")
          ? `${context} ${path} has non-snake_case key "${malformed}"`
          : `${context} cannot configure host-owned ${path} field(s): ${names.join(", ")}`,
      );
    }
    case "enum":
      throw new RecipeModelConfigError(
        `${context} has unsupported ${path} ${JSON.stringify(String(at(value, error.instancePath)))}`,
      );
    case "pattern":
      throw new RecipeModelConfigError(
        params.pattern === MODEL_SPEC
          ? `${context} has invalid ${path.replace(/\[\d+\]$/, " entry")} ${JSON.stringify(at(value, error.instancePath))}: expected "<provider>/<model_id>"`
          : `${context} has invalid ${path}: expected a non-blank string`,
      );
    case "type":
      throw new RecipeModelConfigError(
        `${context} has invalid ${path}: expected ${String(params.type)}`,
      );
    case "minimum":
      throw new RecipeModelConfigError(
        `${context} has invalid ${path}: expected number >= ${String(params.limit)}`,
      );
    default:
      throw new RecipeModelConfigError(
        `${context} has invalid ${path}: ${error.message}`,
      );
  }
}

/** Choose the model and effort as one entry, using the authored default to break ties. */
export function selectRecipeModelEntry(
  context: string,
  entries: NonNullable<AiConfig["models"]>,
  defaultKey: string,
  provider?: string,
) {
  const preferred = entries[defaultKey]!;
  if (provider === undefined || preferred.provider === provider)
    return preferred;
  const matches = Object.values(entries).filter(
    (entry) => entry.provider === provider,
  );
  if (matches.length === 1) return matches[0]!;
  const choices = Object.entries(entries)
    .map(([key, entry]) => `${key} (${entry.provider})`)
    .join(", ");
  throw new RecipeModelConfigError(
    `${context} has ${matches.length ? "ambiguous models" : "no model"} for provider "${provider}". Entries: ${choices}. ${matches.length ? "Set ai.default_model to a matching entry or keep one match." : "Declare a matching model or choose another provider."}`,
  );
}

/** A checked `ai:` block as the settings Pi applies. */
function toModelConfig(ai: AiConfig, context: string): RecipeAgentModelConfig {
  let name = ai.model?.trim();
  let thinkingLevel = ai.thinking_level;
  let defaultModel = ai.default_model;
  if (ai.models) {
    if (ai.model !== undefined || thinkingLevel !== undefined)
      throw new RecipeModelConfigError(
        `${context}: use ai.model with ai.thinking_level or ai.models with per-entry thinking_level`,
      );
    const keys = Object.keys(ai.models);
    for (const [key, entry] of Object.entries(ai.models)) {
      if (!key.trim() || entry.model.startsWith(entry.provider + "/"))
        throw new RecipeModelConfigError(
          `${context}: ai.models entry "${key}" requires a name and a model ID without its provider prefix`,
        );
    }
    defaultModel ??= keys.length === 1 ? keys[0] : undefined;
    if (!defaultModel || !Object.hasOwn(ai.models, defaultModel))
      throw new RecipeModelConfigError(
        `${context}: ai.default_model must name one of ${keys.join(", ")}`,
      );
    const entry = selectRecipeModelEntry(context, ai.models, defaultModel);
    name = `${entry.provider}/${entry.model}`;
    thinkingLevel = entry.thinking_level;
  } else if (defaultModel !== undefined) {
    throw new RecipeModelConfigError(
      `${context}: ai.default_model requires ai.models`,
    );
  }
  const fallbacks = ai.fallbacks?.map((spec) => spec.trim());
  const streamOptions = ai.options
    ? Object.fromEntries(
        Object.entries(ai.options).map(([key, value]) => [
          snakeToCamel(key),
          value,
        ]),
      )
    : undefined;
  const openrouter = ai.providers?.openrouter?.routing;
  const anthropic = ai.providers?.anthropic;
  const vercelAiGateway = ai.providers?.vercel_ai_gateway?.routing;
  return {
    ...(name ? { name } : {}),
    ...(fallbacks?.length ? { fallbacks } : {}),
    ...(ai.models ? { models: ai.models, defaultModel } : {}),
    ...(thinkingLevel ? { thinkingLevel: thinkingLevel as ThinkingLevel } : {}),
    ...(streamOptions && hasKeys(streamOptions) ? { streamOptions } : {}),
    ...(openrouter
      ? { openrouter: { ...openrouter } as OpenRouterRouting }
      : {}),
    ...(anthropic
      ? {
          anthropic: {
            ...(anthropic.betas
              ? { betas: anthropic.betas.map((beta) => beta.trim()) }
              : {}),
            ...(anthropic.context_management !== undefined
              ? { contextManagement: anthropic.context_management }
              : {}),
          },
        }
      : {}),
    ...(vercelAiGateway ? { vercelAiGateway: { ...vercelAiGateway } } : {}),
  };
}

/** An older `model:` block as the `ai:` block it means. */
function legacyModelAsAi(model: LegacyModel): AiConfig {
  const options = Object.fromEntries(
    LEGACY_OPTION_KEYS.flatMap((key) =>
      model[key] === undefined ? [] : [[key, model[key]]],
    ),
  );
  return {
    ...(model.name !== undefined ? { model: model.name } : {}),
    ...(model.thinking_level ? { thinking_level: model.thinking_level } : {}),
    ...(hasKeys(options) ? { options } : {}),
    ...(model.providers ? { providers: model.providers } : {}),
  };
}

/**
 * Parse an agent's or a judge's `ai:` block against {@link AiConfigSchema}.
 * A block outside the schema throws {@link RecipeModelConfigError} naming the
 * field, so a typo fails loudly instead of silently changing the model.
 */
export function parseRecipeAgentAiConfig(
  context: string,
  value: unknown,
): RecipeAgentModelConfig | undefined {
  if (value === undefined) return undefined;
  return toModelConfig(check(AiConfigSchema, context, "ai", value), context);
}

/** Parse the older agent `model:` block, read as the `ai:` block it means. */
export function parseRecipeAgentModelConfig(
  context: string,
  value: unknown,
): RecipeAgentModelConfig | undefined {
  if (value === undefined) return undefined;
  return toModelConfig(
    legacyModelAsAi(check(LegacyModelSchema, context, "model", value)),
    context,
  );
}

/**
 * Merge a child agent's model config over its `from:` base. Sections
 * (`streamOptions`, `openrouter`, `anthropic`, `vercelAiGateway`) merge by key
 * so a child can override one option without restating the base's.
 */
export function mergeRecipeAgentModelConfig(
  base: RecipeAgentModelConfig | undefined,
  overlay: RecipeAgentModelConfig | undefined,
): RecipeAgentModelConfig | undefined {
  if (!base) return overlay;
  if (!overlay) return base;
  if (overlay.name !== undefined) {
    return overlay;
  }
  const streamOptions = {
    ...(base.streamOptions ?? {}),
    ...(overlay.streamOptions ?? {}),
  };
  const openrouter = {
    ...(base.openrouter ?? {}),
    ...(overlay.openrouter ?? {}),
  };
  const anthropic = {
    ...(base.anthropic ?? {}),
    ...(overlay.anthropic ?? {}),
  };
  const vercelAiGateway = {
    ...(base.vercelAiGateway ?? {}),
    ...(overlay.vercelAiGateway ?? {}),
  };
  return {
    ...base,
    ...overlay,
    ...(base.models && base.defaultModel && overlay.thinkingLevel
      ? {
          models: {
            ...base.models,
            [base.defaultModel]: {
              ...base.models[base.defaultModel]!,
              thinking_level: overlay.thinkingLevel,
            },
          },
        }
      : {}),
    ...(hasKeys(streamOptions) ? { streamOptions } : {}),
    ...(hasKeys(openrouter) ? { openrouter } : {}),
    ...(hasKeys(anthropic) ? { anthropic } : {}),
    ...(hasKeys(vercelAiGateway) ? { vercelAiGateway } : {}),
  };
}

/** Clone mutable model metadata before applying Recipe-local configuration. */
export function cloneModelForRecipe<T extends Model<Api>>(model: T): T {
  return {
    ...model,
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.compat ? { compat: { ...model.compat } } : {}),
  };
}

/** The Anthropic betas pi-ai adds from a model's own compat flags when no `anthropic-beta` header is set. */
function modelBetas(model: Model<Api>): string[] {
  const compat = (model.compat ?? {}) as {
    supportsMidConvoEffort?: boolean;
    supportsMidConvoSystemMessages?: boolean;
    supportsMidConvoToolChanges?: boolean;
    allowedFallbackModels?: unknown[];
  };
  return [
    ...(compat.supportsMidConvoEffort === true
      ? [
          "mid-conversation-output-config-2026-07-01",
          "thinking-binding-controls-2026-08-01",
        ]
      : []),
    ...(compat.supportsMidConvoSystemMessages === true &&
    compat.supportsMidConvoToolChanges === true
      ? ["inline-tools-2026-09-15"]
      : []),
    ...((compat.allowedFallbackModels?.length ?? 0) > 0
      ? ["server-side-fallback-2026-07-01"]
      : []),
  ];
}

/** Apply provider routing and header options onto a pi-ai model instance. */
export function applyRecipeAgentModelConfigToModel<T extends Model<Api>>(
  model: T,
  config: RecipeAgentModelConfig | undefined,
): T {
  if (!config) return model;
  if (config.openrouter) {
    model.compat = {
      ...(model.compat ?? {}),
      openRouterRouting: config.openrouter,
    };
  }
  if (config.anthropic?.betas?.length) {
    const existing = model.headers?.["anthropic-beta"]
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    // pi-ai sends exactly the betas an `anthropic-beta` header names, so a header without them would drop the ones
    // pi-ai adds for the model itself.
    const betas = [
      ...new Set([
        ...(existing ?? modelBetas(model)),
        ...config.anthropic.betas,
      ]),
    ];
    model.headers = {
      ...(model.headers ?? {}),
      "anthropic-beta": betas.join(","),
    };
  }
  return model;
}

function mergeStreamOptions(
  current: SimpleStreamOptions | undefined,
  configured: RecipeAgentModelStreamOptions | undefined,
): SimpleStreamOptions | undefined {
  if (!configured || Object.keys(configured).length === 0) return current;
  return {
    ...(current ?? {}),
    ...configured,
  };
}

function withAnthropicContextManagement(
  payload: unknown,
  model: Pick<Model<Api>, "api">,
  config: RecipeAgentModelConfig,
): unknown {
  const contextManagement = config.anthropic?.contextManagement;
  if (contextManagement === undefined) return payload;
  if (model.api !== "anthropic-messages") return payload;
  if (!isRecord(payload)) return payload;
  return {
    ...payload,
    context_management: contextManagement,
  };
}

function withVercelAiGatewayRouting(
  payload: unknown,
  model: Pick<Model<Api>, "provider">,
  config: RecipeAgentModelConfig,
): unknown {
  const routing = config.vercelAiGateway;
  if (
    routing === undefined ||
    model.provider !== "vercel-ai-gateway" ||
    !isRecord(payload)
  ) {
    return payload;
  }
  const providerOptions = isRecord(payload.providerOptions)
    ? payload.providerOptions
    : {};
  const gateway = isRecord(providerOptions.gateway)
    ? providerOptions.gateway
    : {};
  return {
    ...payload,
    providerOptions: {
      ...providerOptions,
      gateway: {
        ...gateway,
        ...routing,
      },
    },
  };
}

/** Apply Recipe-owned provider payload policy after Pi serializes a request. */
export function applyRecipeAgentPayloadPolicy(
  payload: unknown,
  model: Pick<Model<Api>, "provider" | "api">,
  config: RecipeAgentModelConfig | undefined,
): unknown {
  if (!config) return payload;
  const withAnthropicPolicy = withAnthropicContextManagement(
    payload,
    model,
    config,
  );
  return withVercelAiGatewayRouting(withAnthropicPolicy, model, config);
}

/**
 * Apply stream options and provider payload policy onto a live agent session.
 * Wraps the session's stream function and payload hook; safe to call once per
 * session.
 */
export function applyRecipeAgentModelConfigToSession(
  session: AgentSession,
  config: RecipeAgentModelConfig | undefined,
): void {
  if (!config) return;

  if (config.streamOptions) {
    const baseStreamFn = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) =>
      baseStreamFn(
        model,
        context,
        mergeStreamOptions(options, config.streamOptions),
      );
  }

  if (
    config.anthropic?.contextManagement !== undefined ||
    config.vercelAiGateway !== undefined
  ) {
    const previousOnPayload = session.agent.onPayload;
    session.agent.onPayload = async (payload, model) => {
      const nextPayload = applyRecipeAgentPayloadPolicy(payload, model, config);
      const previousResult = previousOnPayload
        ? await previousOnPayload(nextPayload, model)
        : undefined;
      return previousResult === undefined ? nextPayload : previousResult;
    };
  }
}
