import { Type, type TObject, type TSchema } from "typebox";

/**
 * The parameters of a tool whose `command` picks a variant. Providers expect
 * a top-level object, so it has every variant's fields, optional except
 * `command`; the variants are its `anyOf`, so each keeps its required fields.
 */
export function commandParameters(variants: TObject[]) {
  const fields = new Map<string, TSchema[]>();
  for (const variant of variants) {
    for (const [key, schema] of Object.entries(variant.properties)) {
      fields.set(key, [...(fields.get(key) ?? []), schema]);
    }
  }
  const properties = Object.fromEntries(
    [...fields].map(([key, schemas]) => [
      key,
      key === "command"
        ? Type.Union(schemas)
        : Type.Optional(Type.Union(schemas)),
    ]),
  );
  return Type.Object(properties, {
    additionalProperties: false,
    anyOf: variants,
  });
}
