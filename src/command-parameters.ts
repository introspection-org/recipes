/** A JSON Schema, as plain data. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** The JSON Schema of a command's arguments, an object of named fields. */
export interface ObjectSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly description?: string;
}

/**
 * The generated schema of the arguments type `A`
 * (scripts/generate-tool-schemas.mjs), which `A` only names.
 */
export type ArgumentsSchema<A> = ObjectSchema & { readonly __arguments?: A };

/** A command's arguments, with `command` fixed to its name. */
export function commandVariant(
  command: string,
  schema: ObjectSchema,
  description: string,
): ObjectSchema {
  return {
    type: "object",
    properties: { command: { const: command }, ...schema.properties },
    required: ["command", ...(schema.required ?? [])],
    additionalProperties: false,
    description,
  };
}

/**
 * The parameters of a tool whose `command` picks a variant. Providers expect
 * a top-level object, so it has every variant's fields, optional except
 * `command`, each once with every distinct schema it takes; the variants are
 * its `anyOf`, so each keeps its required fields.
 */
export function commandParameters(variants: readonly ObjectSchema[]) {
  const commands: unknown[] = [];
  const fields = new Map<string, Map<string, JsonSchema>>();
  for (const variant of variants) {
    for (const [key, schema] of Object.entries(variant.properties)) {
      if (key === "command") {
        commands.push(schema.const);
        continue;
      }
      const distinct = fields.get(key) ?? new Map<string, JsonSchema>();
      distinct.set(JSON.stringify(schema), schema);
      fields.set(key, distinct);
    }
  }
  const properties: Record<string, JsonSchema> = {
    command: { type: "string", enum: commands },
  };
  for (const [key, distinct] of fields) {
    const schemas = [...distinct.values()];
    properties[key] = schemas.length === 1 ? schemas[0]! : { anyOf: schemas };
  }
  return {
    type: "object" as const,
    properties,
    required: ["command"],
    additionalProperties: false,
    anyOf: variants,
  };
}

/**
 * A command's call shape for its line in the tool description, required
 * fields first and `?` marking the optional: `draft { to, subject, cc? }`.
 */
export function commandSignature(command: string, schema: ObjectSchema) {
  const required = new Set(schema.required);
  const fields = Object.keys(schema.properties).filter(
    (key) => key !== "command",
  );
  if (fields.length === 0) return command;
  const ordered = [
    ...fields.filter((key) => required.has(key)),
    ...fields.filter((key) => !required.has(key)).map((key) => `${key}?`),
  ];
  return `${command} { ${ordered.join(", ")} }`;
}

/** `schema` with `{word}` in its fields' descriptions replaced from `words`. */
export function withWords(
  schema: ObjectSchema,
  words: Readonly<Record<string, string>>,
): ObjectSchema {
  const fill = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(fill);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        key === "description" && typeof inner === "string"
          ? inner.replace(/\{(\w+)\}/g, (match, word: string) =>
              word in words ? words[word]! : match,
            )
          : fill(inner),
      ]),
    );
  };
  return fill(schema) as ObjectSchema;
}

/** `schema` without the fields `keys` names. */
export function withoutFields(
  schema: ObjectSchema,
  keys: readonly string[],
): ObjectSchema {
  const properties = Object.fromEntries(
    Object.entries(schema.properties).filter(([key]) => !keys.includes(key)),
  );
  const required = schema.required?.filter((key) => !keys.includes(key));
  return {
    ...schema,
    properties,
    ...(required ? { required } : {}),
  };
}
