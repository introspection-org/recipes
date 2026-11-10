/**
 * A command line from a tool's own parameter schema: each top-level property
 * is a `--flag`, its `--help` is written from the same schema, and `--json`
 * still takes every argument as one object. A flag's text is only decoded to
 * its property's type here; the call's arguments are validated against the
 * schema by the tool pipeline, as any other call's are, so a flag and the same
 * value in `--json` fail the same way.
 */

import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

/** An object schema: the properties a command takes, and those it requires. */
export interface CommandSchema {
  properties: Record<string, unknown>;
  required?: readonly string[];
}

/** A command made from a schema: what `--help` prints and what a call parses. */
export interface SchemaCommand {
  /** How the command is invoked: `issues list`, `web_search`. */
  usage: string;
  description: string;
  schema: CommandSchema;
}

/** A command line that cannot be read; `usage` names the command for its `--help`. */
export class SchemaArgsError extends Error {
  constructor(
    readonly usage: string,
    message: string,
  ) {
    super(message);
  }
}

/** Flags every schema command takes, whatever its properties are named. */
const RESERVED = new Set(["help", "json"]);

type Property = Record<string, unknown>;

function record(value: unknown): Property {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Property)
    : {};
}

/** A property's own type, `null` set aside: `["string", "null"]` is a string. */
function typeOf(property: Property): string | undefined {
  const type = property.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    const types = type.filter((entry) => entry !== "null");
    return types.length === 1 ? String(types[0]) : undefined;
  }
  const values = enumOf(property);
  if (values?.length) {
    const kinds = new Set(values.map((value) => typeof value));
    if (kinds.size === 1) return [...kinds][0];
  }
  return undefined;
}

/** The values a property allows: `enum`, a `const`, or a union of `const`s. */
function enumOf(property: Property): unknown[] | undefined {
  if (Array.isArray(property.enum)) return property.enum;
  if ("const" in property) return [property.const];
  const variants = property.anyOf ?? property.oneOf;
  if (!Array.isArray(variants)) return undefined;
  const consts = variants
    .map(record)
    .filter((variant) => variant.type !== "null");
  return consts.length > 0 && consts.every((variant) => "const" in variant)
    ? consts.map((variant) => variant.const)
    : undefined;
}

const SCALAR = new Set(["string", "number", "integer", "boolean"]);

/** The items of an array a flag repeats: scalars other than booleans. */
function repeated(property: Property): Property | undefined {
  if (typeOf(property) !== "array") return undefined;
  const items = record(property.items);
  const type = typeOf(items);
  return type && SCALAR.has(type) && type !== "boolean" ? items : undefined;
}

/** The command's flags: its top-level properties but the reserved names. */
function flags(schema: CommandSchema): Array<[string, Property]> {
  return Object.entries(schema.properties)
    .filter(([name]) => !RESERVED.has(name))
    .map(([name, property]) => [name, record(property)]);
}

/** Booleans are boolean options, an array of scalars repeats, and the rest are strings. */
function options(schema: CommandSchema): ParseArgsOptionsConfig {
  const config: ParseArgsOptionsConfig = {
    help: { type: "boolean", short: "h" },
    json: { type: "string" },
  };
  for (const [name, property] of flags(schema))
    config[name] =
      typeOf(property) === "boolean"
        ? { type: "boolean" }
        : { type: "string", multiple: repeated(property) !== undefined };
  return config;
}

/** A flag's text as its property's type, or the text itself for the pipeline to judge. */
function decode(property: Property, text: string): unknown {
  switch (typeOf(property)) {
    case "string":
      return text;
    case "number":
    case "integer": {
      const value = Number(text);
      return text.trim() && Number.isFinite(value) ? value : text;
    }
    default:
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
  }
}

function valueOf(
  property: Property,
  raw: string | boolean | Array<string | boolean>,
): unknown {
  if (typeof raw === "boolean") return raw;
  const items = repeated(property);
  if (!items)
    return decode(property, String(Array.isArray(raw) ? raw.at(-1) : raw));
  const texts = (Array.isArray(raw) ? raw : [raw]).map(String);
  // One value that reads as a JSON array is the whole array.
  if (texts.length === 1 && texts[0]!.trimStart().startsWith("[")) {
    const whole = decode(property, texts[0]!);
    if (Array.isArray(whole)) return whole;
  }
  return texts.map((text) => decode(items, text));
}

export interface ParsedSchemaArgs {
  /** `--help` was asked for: print {@link schemaHelp} instead of calling. */
  help: boolean;
  args: Record<string, unknown>;
}

/**
 * A call's arguments from its command line: the `--json` object, if any,
 * with each flag's decoded value over it. Only a line that cannot be read
 * fails here (an unknown flag, `--json` that is not an object); what the
 * values must be is the schema's, checked when the call runs.
 */
export function parseSchemaArgs(
  command: SchemaCommand,
  argv: readonly string[],
  stdin?: () => string,
): ParsedSchemaArgs {
  const fail = (message: string) =>
    new SchemaArgsError(command.usage, `${command.usage}: ${message}`);
  let values: Record<string, string | boolean | Array<string | boolean>>;
  try {
    values = parseArgs({
      args: [...argv],
      options: options(command.schema),
      strict: true,
      allowPositionals: false,
      allowNegative: true,
    }).values as typeof values;
  } catch (error) {
    throw fail(
      (error instanceof Error ? error.message : String(error)).split("\n")[0]!,
    );
  }
  if (values.help === true) return { help: true, args: {} };
  let args: Record<string, unknown> = {};
  if (typeof values.json === "string") {
    const text = values.json === "-" ? (stdin?.() ?? "") : values.json;
    let body: unknown = {};
    if (text.trim())
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw fail("--json is not valid JSON");
      }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw fail("--json must be an object");
    args = { ...(body as Record<string, unknown>) };
  }
  for (const [name, property] of flags(command.schema)) {
    const raw = values[name];
    if (raw !== undefined) args[name] = valueOf(property, raw);
  }
  return { help: false, args };
}

function placeholder(property: Property): string {
  const type = typeOf(property);
  if (type === "boolean") return "";
  const items = repeated(property);
  const shown = items ?? property;
  const values = enumOf(shown);
  const name =
    values && values.length <= 6
      ? values.map(String).join("|")
      : items
        ? (typeOf(items) ?? "value")
        : type && SCALAR.has(type)
          ? type
          : "json";
  return ` <${name}>${items ? "..." : ""}`;
}

/** `From 1 to 10.`, `At least 0.`, or `At most 50.` */
function range(property: Property): string | undefined {
  const { minimum, maximum } = property;
  if (typeof minimum === "number" && typeof maximum === "number")
    return `From ${minimum} to ${maximum}.`;
  if (typeof minimum === "number") return `At least ${minimum}.`;
  if (typeof maximum === "number") return `At most ${maximum}.`;
  return undefined;
}

function note(name: string, property: Property, required: boolean): string {
  const parts: string[] = [];
  if (required) parts.push("Required.");
  const description = String(property.description ?? property.title ?? "")
    .split("\n")[0]!
    .trim();
  if (description)
    parts.push(/[.!?]$/.test(description) ? description : `${description}.`);
  const items = repeated(property);
  const values = enumOf(items ?? property);
  if (values && values.length > 6)
    parts.push(`One of: ${values.map(String).join(", ")}.`);
  const bounds = range(property);
  if (bounds) parts.push(bounds);
  if ("default" in property)
    parts.push(`Default: ${JSON.stringify(property.default)}.`);
  if (items) parts.push("Repeat it for each value, or pass a JSON array.");
  const type = typeOf(property);
  if (type === "boolean") parts.push(`--no-${name} for false.`);
  else if (!items && !(type && SCALAR.has(type))) parts.push("A JSON value.");
  return parts.join(" ");
}

/** Two columns: what to type, then what it means; a long left column wraps. */
function columns(rows: Array<[string, string]>): string[] {
  const width = Math.min(
    30,
    Math.max(0, ...rows.map(([left]) => left.length)) + 2,
  );
  return rows.map(([left, right]) =>
    !right
      ? `  ${left}`
      : left.length + 2 > width
        ? `  ${left}\n  ${" ".repeat(width)}${right}`
        : `  ${left.padEnd(width)}${right}`,
  );
}

/** `--help` for a schema command, read from its schema. */
export function schemaHelp(command: SchemaCommand): string {
  const required = new Set(command.schema.required ?? []);
  const all = flags(command.schema);
  const call = [
    command.usage,
    ...all
      .filter(([name]) => required.has(name))
      .map(([name, property]) => `--${name}${placeholder(property)}`),
  ];
  if (all.some(([name]) => !required.has(name)))
    call.push("[--<argument> <value> ...]");
  const lines = [
    `Usage: ${call.join(" ")}`,
    `       ${command.usage} --json '{...}'    (--json - reads the object from stdin)`,
  ];
  const description = command.description.trim().split("\n")[0];
  if (description) lines.push("", description);
  if (all.length)
    lines.push(
      "",
      "Arguments:",
      ...columns(
        all.map(([name, property]) => [
          `--${name}${placeholder(property)}`,
          note(name, property, required.has(name)),
        ]),
      ),
    );
  lines.push(
    "",
    ...columns([
      [
        "--json <object|->",
        "Every argument as one JSON object; flags given beside it override its keys.",
      ],
      ["--help", "This help."],
    ]),
  );
  return lines.join("\n");
}
