/**
 * A command line from a JSON Schema, whoever wrote it: a first-party tool's
 * generated schema or an MCP tool's `inputSchema`. Each top-level property
 * that a flag can carry (a scalar, an enum, an array of scalars, or one with
 * no `type`) is a `--flag`; anything else (an object, an `anyOf` of shapes, a
 * `$ref`) is reachable through `--json`, which takes every argument as one
 * object. `--help` is written from the same schema. A flag's text is only
 * decoded to its property's type: what the values must be is checked by
 * whoever runs the call, so a flag and the same value in `--json` fail alike.
 */

import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

/** A JSON Schema as data; keywords this adapter does not read are ignored. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** One command: the words that invoke it, what it does, and its arguments' schema. */
export interface SchemaCommand {
  /** `["issues", "create"]`, `["github", "create_issue"]`, `["web_search"]`. */
  path: readonly string[];
  description: string;
  /** An object schema; only its `properties` and `required` are read. */
  schema: JsonSchema;
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

const SCALAR = new Set(["string", "number", "integer", "boolean"]);

type Property = Record<string, unknown>;

function record(value: unknown): Property {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Property)
    : {};
}

/** How a command is typed: `issues create`. */
export function usageOf(command: Pick<SchemaCommand, "path">): string {
  return command.path.join(" ");
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

/** A property's scalar type, `null` set aside; `undefined` when it has none. */
function scalarOf(property: Property): string | undefined {
  const { type } = property;
  const types = (Array.isArray(type) ? type : [type]).filter(
    (entry) => entry !== undefined && entry !== "null",
  );
  if (types.length === 1 && SCALAR.has(String(types[0])))
    return String(types[0]);
  const values = enumOf(property);
  if (types.length === 0 && values?.length) {
    const kinds = new Set(values.map((value) => typeof value));
    if (kinds.size === 1) {
      const [kind] = kinds;
      if (kind === "number")
        return values.every(Number.isInteger) ? "integer" : "number";
      if (kind === "string" || kind === "boolean") return kind;
    }
  }
  return undefined;
}

/** No `type` and nothing that shapes it: a string flag, decoded leniently. */
function untyped(property: Property): boolean {
  return (
    property.type === undefined &&
    enumOf(property) === undefined &&
    !["$ref", "anyOf", "oneOf", "allOf", "properties", "items"].some(
      (key) => key in property,
    )
  );
}

/** What a flag carries: one scalar, scalars repeated, or nothing (`--json` only). */
type Shape =
  | { kind: "scalar"; type: string | undefined }
  | { kind: "array"; items: Property; type: string | undefined }
  | { kind: "json" };

function shapeOf(property: Property): Shape {
  const type = scalarOf(property);
  if (type || untyped(property)) return { kind: "scalar", type };
  if (property.type === "array") {
    const items = record(property.items);
    const itemType = scalarOf(items);
    // A repeated boolean flag has no value to repeat, so it takes --json.
    if ((itemType && itemType !== "boolean") || (items && untyped(items)))
      return { kind: "array", items, type: itemType };
  }
  return { kind: "json" };
}

interface Field {
  name: string;
  property: Property;
  shape: Shape;
  required: boolean;
}

/** A command's top-level properties, each with what a flag can carry of it. */
function fields(command: SchemaCommand): Field[] {
  const required = new Set(
    Array.isArray(command.schema.required)
      ? command.schema.required.map(String)
      : [],
  );
  return Object.entries(record(command.schema.properties)).map(
    ([name, value]) => {
      const property = record(value);
      return {
        name,
        property,
        shape: RESERVED.has(name) ? { kind: "json" } : shapeOf(property),
        required: required.has(name),
      };
    },
  );
}

const flagged = (field: Field) => field.shape.kind !== "json";

/** Booleans are boolean options, an array of scalars repeats, and the rest are strings. */
function options(command: SchemaCommand): ParseArgsOptionsConfig {
  const config: ParseArgsOptionsConfig = {
    help: { type: "boolean", short: "h" },
    json: { type: "string" },
  };
  for (const field of fields(command).filter(flagged))
    config[field.name] =
      field.shape.kind === "scalar" && field.shape.type === "boolean"
        ? { type: "boolean" }
        : { type: "string", multiple: field.shape.kind === "array" };
  return config;
}

/** A flag's text as `type`, or the text itself for whoever runs the call to judge. */
function decode(type: string | undefined, text: string): unknown {
  if (type === "string") return text;
  if (type === "number" || type === "integer") {
    const value = Number(text);
    return text.trim() && Number.isFinite(value) ? value : text;
  }
  // No type: a number or boolean as such, anything else the text.
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "number" || typeof value === "boolean"
      ? value
      : text;
  } catch {
    return text;
  }
}

function valueOf(
  shape: Shape,
  raw: string | boolean | Array<string | boolean>,
): unknown {
  if (typeof raw === "boolean") return raw;
  if (shape.kind !== "array")
    return decode(
      shape.kind === "scalar" ? shape.type : undefined,
      String(Array.isArray(raw) ? raw.at(-1) : raw),
    );
  const texts = (Array.isArray(raw) ? raw : [raw]).map(String);
  // One value that reads as a JSON array is the whole array.
  if (texts.length === 1 && texts[0]!.trimStart().startsWith("[")) {
    try {
      const whole = JSON.parse(texts[0]!) as unknown;
      if (Array.isArray(whole)) return whole;
    } catch {
      // Not JSON: one value of the array.
    }
  }
  return texts.map((text) => decode(shape.type, text));
}

export interface ParsedSchemaArgs {
  /** `--help` was asked for: print {@link schemaHelp} instead of calling. */
  help: boolean;
  args: Record<string, unknown>;
}

/**
 * A call's arguments from its command line: the `--json` object, if any,
 * with each flag's decoded value over it. Only a line that cannot be read
 * fails here (an unknown flag, `--json` that is not an object).
 */
export function parseSchemaArgs(
  command: SchemaCommand,
  argv: readonly string[],
  stdin?: () => string,
): ParsedSchemaArgs {
  const usage = usageOf(command);
  const fail = (message: string) =>
    new SchemaArgsError(usage, `${usage}: ${message}`);
  let values: Record<string, string | boolean | Array<string | boolean>>;
  try {
    values = parseArgs({
      args: [...argv],
      options: options(command),
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
  for (const field of fields(command).filter(flagged)) {
    const raw = values[field.name];
    if (raw !== undefined) args[field.name] = valueOf(field.shape, raw);
  }
  return { help: false, args };
}

function placeholder(field: Field): string {
  const { shape, property } = field;
  if (shape.kind === "json") return "";
  if (shape.kind === "scalar" && shape.type === "boolean") return "";
  const values = enumOf(shape.kind === "array" ? shape.items : property);
  const name =
    values && values.length <= 6
      ? values.map(String).join("|")
      : (shape.type ?? "value");
  return ` <${name}>${shape.kind === "array" ? "..." : ""}`;
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

function note(field: Field): string {
  const { name, property, shape } = field;
  const parts: string[] = [];
  if (field.required) parts.push("Required.");
  const description = String(property.description ?? property.title ?? "")
    .split("\n")[0]!
    .trim();
  if (description)
    parts.push(/[.!?]$/.test(description) ? description : `${description}.`);
  const values = enumOf(shape.kind === "array" ? shape.items : property);
  if (shape.kind !== "json" && values && values.length > 6)
    parts.push(`One of: ${values.map(String).join(", ")}.`);
  const bounds = range(property);
  if (bounds) parts.push(bounds);
  if ("default" in property)
    parts.push(`Default: ${JSON.stringify(property.default)}.`);
  if (shape.kind === "array")
    parts.push("Repeat it for each value, or pass a JSON array.");
  if (shape.kind === "scalar" && shape.type === "boolean")
    parts.push(`--no-${name} for false.`);
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

/** A description's first sentence, for a one-line listing. */
function firstSentence(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line;
}

/** `--help` for one command, read from its schema; `schemaPointer` is the command that prints its JSON Schema. */
export function schemaHelp(
  command: SchemaCommand,
  schemaPointer: string,
): string {
  const usage = usageOf(command);
  const all = fields(command);
  const flags = all.filter(flagged);
  const jsonOnly = all.filter((field) => !flagged(field));
  const call = [
    usage,
    ...flags
      .filter((field) => field.required)
      .map((field) => `--${field.name}${placeholder(field)}`),
  ];
  if (flags.some((field) => !field.required))
    call.push("[--<argument> <value> ...]");
  const lines = [
    `Usage: ${call.join(" ")}`,
    `       ${usage} --json '{...}'    (--json - reads the object from stdin)`,
  ];
  const description = command.description.trim().split("\n")[0];
  if (description) lines.push("", description);
  if (flags.length)
    lines.push(
      "",
      "Arguments:",
      ...columns(
        flags.map((field) => [
          `--${field.name}${placeholder(field)}`,
          note(field),
        ]),
      ),
    );
  if (jsonOnly.length)
    lines.push(
      "",
      "Only through --json:",
      ...columns(jsonOnly.map((field) => [field.name, note(field)])),
    );
  lines.push(
    "",
    ...columns([
      [
        "--json <object|->",
        `Every argument as one JSON object (\`${schemaPointer}\` prints its schema); flags given beside it override its keys.`,
      ],
      ["--help", "This help."],
    ]),
  );
  return lines.join("\n");
}

/**
 * `--help` for a group of commands under `path`: each one's name and first
 * sentence. `schemaPointer` is the command that prints their JSON Schemas.
 */
export function schemaGroupHelp(
  path: readonly string[],
  description: string,
  commands: readonly SchemaCommand[],
  schemaPointer: string,
): string {
  const usage = path.join(" ");
  const names = commands.map((command) => command.path.at(-1) ?? "");
  const width = Math.max(0, ...names.map((name) => name.length)) + 2;
  return [
    `Usage: ${usage} <command> [--<argument> <value> ...]`,
    ...(description.trim() ? ["", firstSentence(description)] : []),
    "",
    "Commands:",
    ...commands.map(
      (command, index) =>
        `  ${names[index]!.padEnd(width)}${firstSentence(command.description)}`,
    ),
    "",
    `Run \`${usage} <command> --help\` for a command's arguments, or \`${schemaPointer}\` for the JSON each takes.`,
  ].join("\n");
}
