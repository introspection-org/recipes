const SESSION_KEYS = new Set([
  "steering_mode",
  "follow_up_mode",
  "tool_execution",
  "retry",
  "compaction",
  "images",
]);

const SNAKE_CASE_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export type RecipeQueueMode = "all" | "one-at-a-time";
export type RecipeToolExecutionMode = "parallel" | "sequential";

export interface RecipeAgentSessionConfig {
  steeringMode?: RecipeQueueMode;
  followUpMode?: RecipeQueueMode;
  toolExecution?: RecipeToolExecutionMode;
  settings?: Record<string, unknown>;
}

export class RecipeSessionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeSessionConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(
  context: string,
  value: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new RecipeSessionConfigError(
      `${context} has unsupported key(s): ${unknown.join(", ")}`
    );
  }
}

function sessionObject(
  context: string,
  value: unknown
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RecipeSessionConfigError(`${context}: expected object`);
  }
  for (const key of Object.keys(value)) {
    if (!SNAKE_CASE_KEY.test(key)) {
      throw new RecipeSessionConfigError(`${context} has invalid key "${key}"`);
    }
  }
  return value;
}

function optionalBoolean(
  context: string,
  key: string,
  value: unknown
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new RecipeSessionConfigError(
      `${context}.${key}: expected boolean`
    );
  }
  return value;
}

function optionalInteger(
  context: string,
  key: string,
  value: unknown,
  min: number
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min
  ) {
    throw new RecipeSessionConfigError(
      `${context}.${key}: expected integer >= ${min}`
    );
  }
  return value;
}

function definedObject(
  entries: Record<string, unknown>
): Record<string, unknown> | undefined {
  const defined = Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined)
  );
  return Object.keys(defined).length > 0 ? defined : undefined;
}

function parseProviderRetry(
  context: string,
  value: unknown
): Record<string, unknown> | undefined {
  const data = sessionObject(context, value);
  assertKnownKeys(context, data, [
    "timeout_ms",
    "max_retries",
    "max_retry_delay_ms",
  ]);
  return definedObject({
    timeoutMs: optionalInteger(context, "timeout_ms", data.timeout_ms, 1),
    maxRetries: optionalInteger(context, "max_retries", data.max_retries, 0),
    maxRetryDelayMs: optionalInteger(
      context,
      "max_retry_delay_ms",
      data.max_retry_delay_ms,
      0
    ),
  });
}

function parseRetry(
  context: string,
  value: unknown
): Record<string, unknown> | undefined {
  const data = sessionObject(context, value);
  assertKnownKeys(context, data, [
    "enabled",
    "max_retries",
    "base_delay_ms",
    "provider",
  ]);
  return definedObject({
    enabled: optionalBoolean(context, "enabled", data.enabled),
    maxRetries: optionalInteger(context, "max_retries", data.max_retries, 0),
    baseDelayMs: optionalInteger(
      context,
      "base_delay_ms",
      data.base_delay_ms,
      0
    ),
    provider:
      data.provider === undefined
        ? undefined
        : parseProviderRetry(`${context}.provider`, data.provider),
  });
}

function parseCompaction(
  context: string,
  value: unknown
): Record<string, unknown> | undefined {
  const data = sessionObject(context, value);
  assertKnownKeys(context, data, [
    "enabled",
    "reserve_tokens",
    "keep_recent_tokens",
  ]);
  return definedObject({
    enabled: optionalBoolean(context, "enabled", data.enabled),
    reserveTokens: optionalInteger(
      context,
      "reserve_tokens",
      data.reserve_tokens,
      0
    ),
    keepRecentTokens: optionalInteger(
      context,
      "keep_recent_tokens",
      data.keep_recent_tokens,
      0
    ),
  });
}

function parseImages(
  context: string,
  value: unknown
): Record<string, unknown> | undefined {
  const data = sessionObject(context, value);
  assertKnownKeys(context, data, ["auto_resize", "block_images"]);
  return definedObject({
    autoResize: optionalBoolean(context, "auto_resize", data.auto_resize),
    blockImages: optionalBoolean(context, "block_images", data.block_images),
  });
}

function parseQueueMode(
  context: string,
  key: string,
  value: unknown
): RecipeQueueMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "all" && value !== "one-at-a-time") {
    throw new RecipeSessionConfigError(
      `${context} has invalid session.${key}: expected all or one-at-a-time`
    );
  }
  return value;
}

export function parseRecipeAgentSessionConfig(
  context: string,
  value: unknown
): RecipeAgentSessionConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new RecipeSessionConfigError(
      `${context} has invalid session: expected object`
    );
  }
  const unknown = Object.keys(value).filter((key) => !SESSION_KEYS.has(key));
  if (unknown.length > 0) {
    throw new RecipeSessionConfigError(
      `${context} has unsupported session key(s): ${unknown.join(", ")}`
    );
  }

  const steeringMode = parseQueueMode(
    context,
    "steering_mode",
    value.steering_mode
  );
  const followUpMode = parseQueueMode(
    context,
    "follow_up_mode",
    value.follow_up_mode
  );
  const toolExecution = value.tool_execution;
  if (
    toolExecution !== undefined &&
    toolExecution !== "parallel" &&
    toolExecution !== "sequential"
  ) {
    throw new RecipeSessionConfigError(
      `${context} has invalid session.tool_execution: expected parallel or sequential`
    );
  }
  const parsedToolExecution = toolExecution as
    | RecipeToolExecutionMode
    | undefined;

  const settings: Record<string, unknown> = {
    ...(steeringMode ? { steeringMode } : {}),
    ...(followUpMode ? { followUpMode } : {}),
  };
  const nestedSettings = {
    retry:
      value.retry === undefined
        ? undefined
        : parseRetry(`${context} session.retry`, value.retry),
    compaction:
      value.compaction === undefined
        ? undefined
        : parseCompaction(`${context} session.compaction`, value.compaction),
    images:
      value.images === undefined
        ? undefined
        : parseImages(`${context} session.images`, value.images),
  };
  Object.assign(settings, definedObject(nestedSettings));

  const parsed = {
    ...(steeringMode ? { steeringMode } : {}),
    ...(followUpMode ? { followUpMode } : {}),
    ...(parsedToolExecution ? { toolExecution: parsedToolExecution } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function mergeRecipeAgentSessionConfig(
  base: RecipeAgentSessionConfig | undefined,
  overlay: RecipeAgentSessionConfig | undefined
): RecipeAgentSessionConfig | undefined {
  if (!base) return overlay;
  if (!overlay) return base;
  const settings = mergeObjects(base.settings ?? {}, overlay.settings ?? {});
  return {
    ...base,
    ...overlay,
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
}

function mergeObjects(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = isRecord(merged[key]) && isRecord(value)
      ? mergeObjects(merged[key], value)
      : value;
  }
  return merged;
}
