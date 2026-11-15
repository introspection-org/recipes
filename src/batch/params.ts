import { Type, type Static } from "typebox";
import { Check, Default, Errors } from "typebox/value";

export const DEFAULT_BATCH_CONCURRENCY = 8;
export const MAX_BATCH_CONCURRENCY = 32;
/** Times a `json` answer that does not parse is sent back to its session before the line fails. */
export const MAX_JSON_REPAIRS = 2;

const BatchParamsSchema = Type.Object(
  {
    /** The Recipe agent each input line runs as, in a fresh session of its own. */
    agent: Type.String({ minLength: 1 }),
    /** The results' file name: letters, digits, `-` and `_`, ending `.jsonl`. */
    output_name: Type.String({
      pattern: "^[A-Za-z0-9_-]+\\.jsonl$",
      default: "results.jsonl",
    }),
    concurrency: Type.Integer({
      minimum: 1,
      maximum: MAX_BATCH_CONCURRENCY,
      default: DEFAULT_BATCH_CONCURRENCY,
    }),
    /** Attempts per line when the provider rate-limits it; any other failure is final. */
    max_attempts: Type.Integer({ minimum: 1, maximum: 5, default: 3 }),
    /** Stop starting new lines after this long; the rest are left for the next run. */
    deadline_ms: Type.Optional(Type.Integer({ minimum: 1 })),
    /**
     * `json`: an answer that does not parse is sent back to the same session
     * with the parse error, up to MAX_JSON_REPAIRS times, before the line
     * fails. The schema stays the caller's to check. Unset means `text`.
     */
    output_format: Type.Optional(
      Type.Union([Type.Literal("text"), Type.Literal("json")]),
    ),
  },
  { additionalProperties: false },
);

/** A batch run's settings, defaults filled. */
export type BatchParams = Static<typeof BatchParamsSchema>;

/** Validate a batch's settings and fill their defaults; an unknown key or a bad value throws. */
export function parseBatchParams(input: unknown): BatchParams {
  const value =
    input !== null && typeof input === "object"
      ? Default(BatchParamsSchema, structuredClone(input))
      : input;
  if (!Check(BatchParamsSchema, value)) {
    const problems = [...Errors(BatchParamsSchema, value)]
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`invalid batch params: ${problems}`);
  }
  return value;
}

/** `results.jsonl` → `results`, the stem its shards are named from. */
export function resultsStem(outputName: string): string {
  return outputName.slice(0, -".jsonl".length);
}
