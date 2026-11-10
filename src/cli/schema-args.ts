/**
 * A command line from a tool's own parameter schema: each top-level property
 * is a typed `--flag`, its `--help` is written from the same schema, and
 * `--json` still takes every argument as one object. The schema a tool
 * declares (TypeBox or plain JSON Schema) is the only definition, so a
 * command's flags cannot drift from what the tool accepts.
 */

import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

/** How a flag's text becomes the property's value. */
export type FlagKind = "string" | "integer" | "number" | "boolean" | "json";

export interface SchemaFlag {
  /** The property name, which is also the flag: `--max_results`. */
  name: string;
  kind: FlagKind;
  /** An array of `kind`: the flag repeats, or takes a JSON array. */
  array: boolean;
  required: boolean;
  description: string;
  enum?: readonly unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

/** A command made from a schema: what `--help` prints and what a call parses. */
export interface SchemaCommand {
  /** How the command is invoked: `issues list`, `mcp call linear.list_issues`. */
  usage: string;
  description: string;
  flags: SchemaFlag[];
}

/** Arguments that do not fit the schema; the message says what to change. */
export class SchemaArgsError extends Error {}

/** Flags every schema command takes, whatever its properties are named. */
const RESERVED = new Set(["help", "json"]);

const SCALARS = new Set(["string", "integer", "number", "boolean"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A property's own type, `null` set aside: `["string", "null"]` is a string. */
function typeOf(property: Record<string, unknown>): string | undefined {
  const type = property.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    const types = type.filter((entry) => entry !== "null");
    return types.length === 1 ? String(types[0]) : undefined;
  }
  return undefined;
}

/** The enum a property allows: `enum`, or a union of `const`s. */
function enumOf(property: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(property.enum)) return property.enum;
  const variants = property.anyOf ?? property.oneOf;
  if (!Array.isArray(variants)) return undefined;
  const consts = variants
    .map(record)
    .filter((variant) => typeOf(variant) !== "null");
  return consts.length > 0 && consts.every((variant) => "const" in variant)
    ? consts.map((variant) => variant.const)
    : undefined;
}

function scalarKind(property: Record<string, unknown>): FlagKind | undefined {
  const type = typeOf(property);
  if (type && SCALARS.has(type)) return type as FlagKind;
  const values =
    enumOf(property) ?? ("const" in property ? [property.const] : undefined);
  if (values?.length) {
    const types = new Set(values.map((value) => typeof value));
    if (types.size === 1) {
      const [only] = types;
      if (only === "string" || only === "boolean") return only;
      if (only === "number")
        return values.every(Number.isInteger) ? "integer" : "number";
    }
  }
  return undefined;
}

function flagOf(
  name: string,
  property: Record<string, unknown>,
  required: boolean,
): SchemaFlag {
  const base = {
    name,
    required,
    description: String(property.description ?? property.title ?? ""),
    ...("default" in property ? { default: property.default } : {}),
  };
  const kind = scalarKind(property);
  if (kind) {
    const values = enumOf(property);
    return {
      ...base,
      kind,
      array: false,
      ...(values ? { enum: values } : {}),
      ...(typeof property.minimum === "number"
        ? { minimum: property.minimum }
        : {}),
      ...(typeof property.maximum === "number"
        ? { maximum: property.maximum }
        : {}),
    };
  }
  if (typeOf(property) === "array") {
    const items = record(property.items);
    const itemKind = scalarKind(items);
    // A repeated boolean flag has no value to repeat, so it takes JSON.
    if (itemKind && itemKind !== "boolean") {
      const values = enumOf(items);
      return {
        ...base,
        kind: itemKind,
        array: true,
        ...(values ? { enum: values } : {}),
      };
    }
  }
  return { ...base, kind: "json", array: false };
}

/**
 * The flags an object schema's top-level properties make. A property named
 * by `omit` (a command's `command`, which its name carries) is left out, as
 * are `help` and `json`, which every command reserves: those stay reachable
 * through `--json`.
 */
export function schemaFlags(
  schema: unknown,
  omit: readonly string[] = [],
): SchemaFlag[] {
  const object = record(schema);
  const properties = record(object.properties);
  const required = new Set(
    Array.isArray(object.required) ? object.required.map(String) : [],
  );
  return Object.entries(properties)
    .filter(([name]) => !omit.includes(name) && !RESERVED.has(name))
    .map(([name, property]) =>
      flagOf(name, record(property), required.has(name)),
    );
}

export function schemaCommand(
  usage: string,
  description: string,
  schema: unknown,
  omit: readonly string[] = [],
): SchemaCommand {
  return { usage, description, flags: schemaFlags(schema, omit) };
}

/** The `parseArgs` options a command's flags declare, with `--json` and `--help`. */
export function parseArgsOptions(
  flags: readonly SchemaFlag[],
): ParseArgsOptionsConfig {
  const options: ParseArgsOptionsConfig = {
    help: { type: "boolean", short: "h" },
    json: { type: "string" },
  };
  for (const flag of flags)
    options[flag.name] =
      flag.kind === "boolean"
        ? { type: "boolean" }
        : { type: "string", multiple: flag.array };
  return options;
}

/** `from 1 to 10`, `at least 0`, or `at most 50`. */
function rangeOf(flag: SchemaFlag): string | undefined {
  if (flag.minimum !== undefined && flag.maximum !== undefined)
    return `from ${flag.minimum} to ${flag.maximum}`;
  if (flag.minimum !== undefined) return `at least ${flag.minimum}`;
  if (flag.maximum !== undefined) return `at most ${flag.maximum}`;
  return undefined;
}

function placeholder(flag: SchemaFlag): string {
  if (flag.kind === "boolean") return "";
  const type =
    flag.enum && flag.enum.length <= 6
      ? flag.enum.map(String).join("|")
      : flag.kind;
  return ` <${type}>${flag.array ? "..." : ""}`;
}

function note(flag: SchemaFlag): string {
  const parts: string[] = [];
  if (flag.required) parts.push("Required.");
  const description = flag.description.split("\n")[0]!.trim();
  if (description)
    parts.push(/[.!?]$/.test(description) ? description : `${description}.`);
  if (flag.enum && flag.enum.length > 6)
    parts.push(`One of: ${flag.enum.map(String).join(", ")}.`);
  const range = rangeOf(flag);
  if (range) parts.push(`${range[0].toUpperCase()}${range.slice(1)}.`);
  if (flag.default !== undefined)
    parts.push(`Default: ${JSON.stringify(flag.default)}.`);
  if (flag.array) parts.push("Repeat it for each value, or pass a JSON array.");
  if (flag.kind === "boolean") parts.push(`--no-${flag.name} for false.`);
  if (flag.kind === "json") parts.push("A JSON value.");
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

/** `--help` for a schema command, written from its flags. */
export function schemaHelp(command: SchemaCommand): string {
  const required = command.flags.filter((flag) => flag.required);
  const call = [
    command.usage,
    ...required.map((flag) => `--${flag.name}${placeholder(flag)}`),
  ];
  if (command.flags.length > required.length)
    call.push("[--<argument> <value> ...]");
  const lines = [
    `Usage: ${call.join(" ")}`,
    `       ${command.usage} --json '{...}'    (--json - reads the object from stdin)`,
  ];
  const description = command.description.trim().split("\n")[0];
  if (description) lines.push("", description);
  if (command.flags.length)
    lines.push(
      "",
      "Arguments:",
      ...columns(
        command.flags.map((flag) => [
          `--${flag.name}${placeholder(flag)}`,
          note(flag),
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

function convert(flag: SchemaFlag, text: string): unknown {
  switch (flag.kind) {
    case "integer":
    case "number": {
      const value = Number(text);
      if (
        !text.trim() ||
        !Number.isFinite(value) ||
        (flag.kind === "integer" && !Number.isInteger(value))
      )
        throw new SchemaArgsError(
          `--${flag.name} takes ${flag.kind === "integer" ? "an integer" : "a number"}, not '${text}'`,
        );
      if (
        (flag.minimum !== undefined && value < flag.minimum) ||
        (flag.maximum !== undefined && value > flag.maximum)
      )
        throw new SchemaArgsError(
          `--${flag.name} must be ${rangeOf(flag)}, not ${value}`,
        );
      return checked(flag, value);
    }
    case "json":
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new SchemaArgsError(
          `--${flag.name} takes a JSON value, not '${text}'`,
        );
      }
    default:
      return checked(flag, text);
  }
}

function checked(flag: SchemaFlag, value: unknown): unknown {
  if (flag.enum && !flag.enum.includes(value))
    throw new SchemaArgsError(
      `--${flag.name} must be one of ${flag.enum.map(String).join(", ")}, not '${String(value)}'`,
    );
  return value;
}

function valueOf(
  flag: SchemaFlag,
  raw: string | boolean | Array<string | boolean>,
): unknown {
  if (flag.kind === "boolean") return raw;
  const texts = (Array.isArray(raw) ? raw : [raw]).map(String);
  if (!flag.array) return convert(flag, texts.at(-1)!);
  // One value that reads as a JSON array is the whole array.
  if (texts.length === 1 && texts[0]!.trimStart().startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(texts[0]!);
    } catch {
      parsed = undefined;
    }
    if (Array.isArray(parsed))
      return parsed.map((item) =>
        flag.kind === "string"
          ? checked(flag, item)
          : convert(flag, String(item)),
      );
  }
  return texts.map((text) => convert(flag, text));
}

export interface ParsedSchemaArgs {
  /** `--help` was asked for: print {@link schemaHelp} instead of calling. */
  help: boolean;
  args: Record<string, unknown>;
}

/**
 * A call's arguments from its command line: the `--json` object, if any,
 * with each flag's typed value over it. Fails before any call on an unknown
 * flag, a value of the wrong type, or a required argument missing.
 */
export function parseSchemaArgs(
  command: SchemaCommand,
  argv: readonly string[],
  stdin?: () => string,
): ParsedSchemaArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: parseArgsOptions(command.flags),
      strict: true,
      allowPositionals: false,
      allowNegative: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SchemaArgsError(`${command.usage}: ${message.split("\n")[0]}`);
  }
  const values = parsed.values as Record<
    string,
    string | boolean | Array<string | boolean>
  >;
  if (values.help === true) return { help: true, args: {} };
  let args: Record<string, unknown> = {};
  if (typeof values.json === "string") {
    const text = values.json === "-" ? (stdin?.() ?? "") : values.json;
    let body: unknown = {};
    if (text.trim())
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new SchemaArgsError(`${command.usage}: --json is not valid JSON`);
      }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new SchemaArgsError(`${command.usage}: --json must be an object`);
    args = { ...(body as Record<string, unknown>) };
  }
  for (const flag of command.flags) {
    const raw = values[flag.name];
    if (raw !== undefined) args[flag.name] = valueOf(flag, raw);
  }
  const missing = command.flags.filter(
    (flag) => flag.required && args[flag.name] === undefined,
  );
  if (missing.length)
    throw new SchemaArgsError(
      `${command.usage}: missing ${missing.map((flag) => `--${flag.name}`).join(", ")}`,
    );
  return { help: false, args };
}
