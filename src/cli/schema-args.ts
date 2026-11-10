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

import { readFileSync } from "node:fs";
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
  /** The flag help shows: the name in kebab-case, unless that would collide. */
  flag: string;
  property: Property;
  shape: Shape;
  required: boolean;
}

/** `multipleBlocks` and `max_results` as `multiple-blocks` and `max-results`. */
function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

const isBoolean = (shape: Shape) =>
  shape.kind === "scalar" && shape.type === "boolean";

/** A command's top-level properties, each with what a flag can carry of it. */
function fields(command: SchemaCommand): Field[] {
  const required = new Set(
    Array.isArray(command.schema.required)
      ? command.schema.required.map(String)
      : [],
  );
  const all = Object.entries(record(command.schema.properties)).map(
    ([name, value]) => {
      const property = record(value);
      const shape: Shape = RESERVED.has(name)
        ? { kind: "json" }
        : shapeOf(property);
      return { name, property, shape, required: required.has(name) };
    },
  );
  // Every name a flag of each property answers to, negations included.
  const spellings = (name: string, shape: Shape) => {
    const forms = [name, kebab(name)];
    return isBoolean(shape)
      ? [...forms, ...forms.map((form) => `no-${form}`)]
      : forms;
  };
  const counts = new Map<string, number>();
  for (const field of all)
    for (const form of new Set(spellings(field.name, field.shape)))
      counts.set(form, (counts.get(form) ?? 0) + 1);
  // A kebab name another property also answers to stays the exact name.
  return all.map((field) => ({
    ...field,
    flag: spellings(field.name, field.shape).every(
      (form) => counts.get(form) === 1,
    )
      ? kebab(field.name)
      : field.name,
  }));
}

const flagged = (field: Field) => field.shape.kind !== "json";

/** Booleans are boolean options, an array of scalars repeats, and the rest are strings. */
function options(command: SchemaCommand): ParseArgsOptionsConfig {
  const config: ParseArgsOptionsConfig = {
    help: { type: "boolean", short: "h" },
    json: { type: "string" },
  };
  for (const field of fields(command).filter(flagged))
    for (const name of new Set([field.flag, field.name]))
      config[name] = isBoolean(field.shape)
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

export interface SchemaArgsOptions {
  /**
   * Also take `name=value` words, as a flag of that name or, for an argument
   * only `--json` reaches, as its JSON value. `name=@path` reads the file as
   * UTF-8 text, `name=@@x` is the literal `@x`, and `name="x"` is the string `x`.
   */
  assignments?: boolean;
  /** Take an argument the schema does not name, untyped, rather than refuse it. */
  unknown?: boolean;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_.-]*)=([\s\S]*)$/;

/** `command` with each argument the line names that its schema does not, untyped. */
function withNamed(
  command: SchemaCommand,
  argv: readonly string[],
  reserved: ReadonlySet<string>,
): SchemaCommand {
  const properties = { ...record(command.schema.properties) };
  for (const word of argv) {
    const name = /^--([^=]+)/.exec(word)?.[1] ?? ASSIGNMENT.exec(word)?.[1];
    if (name && !reserved.has(name) && !(name in properties))
      properties[name] = {};
  }
  return { ...command, schema: { ...command.schema, properties } };
}

/**
 * An assignment's text, and whether it is a string as given: a file's text for
 * `@path` and a quoted JSON string's own text are, so neither is decoded
 * further; `@x` for `@@x` and anything else is decoded by its property's type.
 */
function assignedText(
  usage: string,
  name: string,
  text: string,
): { text: string; exact: boolean } {
  if (text.startsWith('"'))
    try {
      const unquoted = JSON.parse(text) as unknown;
      if (typeof unquoted === "string") return { text: unquoted, exact: true };
    } catch {
      // Not a JSON string: the text as written.
    }
  if (text.startsWith("@@")) return { text: text.slice(1), exact: false };
  if (!text.startsWith("@")) return { text, exact: false };
  const path = text.slice(1);
  const fail = (message: string) =>
    new SchemaArgsError(usage, `${usage}: ${message}`);
  if (!path)
    throw fail(`${name}=@ needs a path; use @@ for a literal leading @`);
  let contents: Buffer;
  try {
    contents = readFileSync(path);
  } catch (error) {
    throw fail(
      `cannot read ${path} for ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(contents),
      exact: true,
    };
  } catch {
    throw fail(`${path} for ${name} is not UTF-8 text`);
  }
}

/**
 * A call's arguments from its command line: the `--json` object, if any,
 * then each flag's decoded value, then each `name=value` when
 * {@link SchemaArgsOptions.assignments} takes them. Only a line that cannot
 * be read fails here (an unknown flag or name, `--json` that is not an object).
 */
export function parseSchemaArgs(
  command: SchemaCommand,
  argv: readonly string[],
  stdin?: () => string,
  { assignments = false, unknown = false }: SchemaArgsOptions = {},
): ParsedSchemaArgs {
  if (unknown) command = withNamed(command, argv, RESERVED);
  const usage = usageOf(command);
  const fail = (message: string) =>
    new SchemaArgsError(usage, `${usage}: ${message}`);
  let values: Record<string, string | boolean | Array<string | boolean>>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      options: options(command),
      strict: true,
      allowPositionals: assignments,
      allowNegative: true,
    }) as { values: typeof values; positionals: string[] });
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
  const all = fields(command);
  for (const field of all.filter(flagged)) {
    // The kebab flag and the exact name (its alias) are one argument.
    const given = [...new Set([field.flag, field.name])].flatMap((name) => {
      const raw = values[name];
      return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    });
    if (given.length > 0)
      args[field.name] = valueOf(
        field.shape,
        field.shape.kind === "array" ? given : given.at(-1)!,
      );
  }
  for (const word of positionals) {
    const match = ASSIGNMENT.exec(word);
    if (!match) throw fail(`'${word}' is not name=value or a --flag`);
    const [, name, raw] = match as unknown as [string, string, string];
    const field = all.find((entry) => entry.name === name);
    if (!field) throw fail(`unknown argument '${name}'`);
    const { text, exact } = assignedText(usage, name, raw);
    if (exact) args[name] = text;
    else if (flagged(field)) args[name] = valueOf(field.shape, text);
    else
      try {
        args[name] = JSON.parse(text) as unknown;
      } catch {
        args[name] = text;
      }
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
  const { property, shape } = field;
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
    parts.push(`--no-${field.flag} for false.`);
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
      .map((field) => `--${field.flag}${placeholder(field)}`),
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
          `--${field.flag}${placeholder(field)}`,
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

/**
 * The caller's own options taken out of `argv` without reading the rest:
 * `--name value` or `--name=value` for a string, `--name` for a boolean. Every
 * other word stays, in order, for {@link parseSchemaArgs}. A named option is
 * the caller's wherever it stands, since no flag takes a value that starts
 * with `--`; nothing after `--` is read.
 */
export function takeOptions(
  argv: readonly string[],
  names: Readonly<Record<string, "string" | "boolean">>,
): { options: Record<string, string | true>; rest: string[] } {
  const options: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!;
    if (word === "--") {
      rest.push(...argv.slice(index));
      break;
    }
    const [flag, inline] = word.startsWith("--")
      ? [
          word.slice(2).split("=")[0]!,
          word.includes("=") ? word.slice(word.indexOf("=") + 1) : undefined,
        ]
      : [undefined, undefined];
    const type = flag === undefined ? undefined : names[flag];
    if (!type) {
      rest.push(word);
      continue;
    }
    if (type === "boolean") options[flag!] = true;
    else {
      const value = inline ?? argv[index + 1];
      if (
        value === undefined ||
        (inline === undefined && value.startsWith("--"))
      )
        throw new Error(`Flag '--${flag}' requires a value.`);
      if (inline === undefined) index += 1;
      options[flag!] = value;
    }
  }
  return { options, rest };
}
