import type { McpToolCatalogEntry } from "./index.js";

type Schema = Record<string, unknown>;

const MAX_EXAMPLE_ARRAY_ITEMS = 3;
const SAFE_CLI_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const SAFE_SHELL_TOKEN = /^[A-Za-z0-9_./:@+-]+$/;

function record(value: unknown): Schema | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Schema)
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function quoted(value: unknown): string {
  return JSON.stringify(value);
}

function renderSchema(value: unknown): Schema | undefined {
  const schema = record(value);
  if (!schema || !Array.isArray(schema.allOf)) return schema;
  const branches = schema.allOf.map(renderSchema).filter((branch): branch is Schema => Boolean(branch));
  const baseProperties = record(schema.properties) ?? {};
  const objectLike = branches.every(
    (branch) => branch.type === "object" || Boolean(record(branch.properties))
  );
  if (!objectLike) return { ...schema, allOf: branches };
  const properties = Object.assign(
    {},
    baseProperties,
    ...branches.map((branch) => record(branch.properties) ?? {})
  );
  const required = new Set<string>(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : []
  );
  for (const branch of branches) {
    if (!Array.isArray(branch.required)) continue;
    for (const entry of branch.required) {
      if (typeof entry === "string") required.add(entry);
    }
  }
  const { allOf: _allOf, ...rest } = schema;
  return {
    ...rest,
    type: "object",
    properties,
    ...(required.size > 0 ? { required: [...required] } : {}),
  };
}

function constraintSuffix(schema: Schema): string {
  const constraints: string[] = [];
  const minimum = number(schema.minimum);
  const maximum = number(schema.maximum);
  if (minimum !== undefined || maximum !== undefined) {
    constraints.push(`${minimum ?? ""}..${maximum ?? ""}`);
  }
  const minLength = number(schema.minLength);
  const maxLength = number(schema.maxLength);
  if (minLength !== undefined) constraints.push(`minLength=${minLength}`);
  if (maxLength !== undefined) constraints.push(`maxLength=${maxLength}`);
  const minItems = number(schema.minItems);
  const maxItems = number(schema.maxItems);
  if (minItems !== undefined) constraints.push(`minItems=${minItems}`);
  if (maxItems !== undefined) constraints.push(`maxItems=${maxItems}`);
  if (schema.default !== undefined) constraints.push(`default=${quoted(schema.default)}`);
  return constraints.length > 0 ? ` [${constraints.join(", ")}]` : "";
}

export function compactSchemaType(value: unknown): string {
  const schema = renderSchema(value);
  if (!schema) return "unknown";
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.map(compactSchemaType).join(" & ");
  }
  if (schema.const !== undefined) return quoted(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(quoted).join(" | ");
  const union = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (union) return union.map(compactSchemaType).join(" | ");
  if (schema.type === "array") {
    return `${compactSchemaType(schema.items)}[]${constraintSuffix(schema)}`;
  }
  if (schema.type === "object" || record(schema.properties)) {
    const properties = record(schema.properties);
    if (!properties || Object.keys(properties).length === 0) return "object";
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === "string")
        : []
    );
    const fields = Object.entries(properties).map(
      ([name, descriptor]) =>
        `${name}${required.has(name) ? "" : "?"}: ${compactSchemaType(descriptor)}`
    );
    return `{${fields.join(", ")}}`;
  }
  const type = schema.type === "number" ? "number" : schema.type;
  return `${typeof type === "string" ? type : "unknown"}${constraintSuffix(schema)}`;
}

function descriptionText(value: unknown, verbose: boolean): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const normalized = value.trim().replace(/\s+/g, " ");
  if (verbose || normalized.length <= 160) return normalized;
  return `${normalized.slice(0, 159).trimEnd()}…`;
}

function hasLongDescription(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasLongDescription);
  const object = record(value);
  if (!object) return false;
  if (
    typeof object.description === "string" &&
    object.description.trim().replace(/\s+/g, " ").length > 160
  ) {
    return true;
  }
  return Object.entries(object).some(
    ([key, nested]) => key !== "description" && hasLongDescription(nested)
  );
}

function schemaLines(
  value: unknown,
  indent: string,
  options: { verboseDescriptions?: boolean } = {}
): string[] {
  const schema = renderSchema(value);
  if (!schema) return [`${indent}unknown`];
  const properties = record(schema.properties);
  if (!properties) return [`${indent}${compactSchemaType(schema)}`];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : []
  );
  const lines: string[] = [];
  for (const [name, descriptorValue] of Object.entries(properties)) {
    const descriptor = record(descriptorValue) ?? {};
    const optional = required.has(name) ? "" : "?";
    const compactDescription = descriptionText(
      descriptor.description,
      options.verboseDescriptions === true
    );
    const description = compactDescription ? ` — ${compactDescription}` : "";
    const nested = record(descriptor.properties);
    if (nested) {
      lines.push(`${indent}${name}${optional}: {`);
      lines.push(...schemaLines(descriptor, `${indent}  `, options));
      lines.push(`${indent}}${description}`);
    } else {
      lines.push(`${indent}${name}${optional}: ${compactSchemaType(descriptor)}${description}`);
    }
  }
  return lines.length > 0 ? lines : [`${indent}{}`];
}

function schemaObject(value: unknown): Schema | undefined {
  return record(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shellToken(value: string): string {
  return SAFE_SHELL_TOKEN.test(value) ? value : shellQuote(value);
}

function toolSelector(server: string, tool: string): string {
  return shellToken(`${server}.${tool}`);
}

function exampleValue(value: unknown, name: string): unknown {
  const schema = renderSchema(value) ?? {};
  const union = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (union?.length) return exampleValue(union[0], name);
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === "boolean") return true;
  if (schema.type === "number" || schema.type === "integer") {
    return number(schema.minimum) ?? 1;
  }
  if (schema.type === "array") {
    const count = Math.min(
      MAX_EXAMPLE_ARRAY_ITEMS,
      Math.max(1, number(schema.minItems) ?? 1)
    );
    return Array.from({ length: count }, () => exampleValue(schema.items, "value"));
  }
  if (schema.type === "object" || record(schema.properties)) {
    const properties = record(schema.properties) ?? {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [];
    return Object.fromEntries(
      required.map((field) => [field, exampleValue(properties[field], field)])
    );
  }
  return `<${name}>`;
}

function callValue(value: unknown, name: string): string {
  const example = exampleValue(value, name);
  return typeof example === "string"
    ? shellQuote(example)
    : typeof example === "object"
      ? shellQuote(JSON.stringify(example))
      : String(example);
}

function callExample(server: string, tool: ContractTool): string {
  const schema = renderSchema(tool.inputSchema);
  const properties = record(schema?.properties) ?? {};
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (
    required.some(
      (name) =>
        !SAFE_CLI_KEY.test(name) ||
        Boolean(
          structuredBranch(properties[name], "object") ??
            structuredBranch(properties[name], "array")
        )
    )
  ) {
    const json = JSON.stringify(
      Object.fromEntries(required.map((name) => [name, exampleValue(properties[name], name)]))
    );
    return `mcp call ${toolSelector(server, tool.name)} --json ${shellQuote(json)}`;
  }
  const args = required.map((name) => {
    const descriptor = record(properties[name]) ?? {};
    return `${name}=${callValue(descriptor, name)}`;
  });
  return `mcp call ${toolSelector(server, tool.name)}${args.length > 0 ? ` ${args.join(" ")}` : ""}`;
}

function structuredBranch(value: unknown, kind: "object" | "array"): Schema | undefined {
  const schema = renderSchema(value);
  if (!schema) return undefined;
  if (
    (kind === "array" && schema.type === "array") ||
    (kind === "object" && (schema.type === "object" || record(schema.properties)))
  ) {
    return schema;
  }
  const union = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : [];
  return union.map((branch) => structuredBranch(branch, kind)).find(Boolean);
}

function structuredCallExample(server: string, tool: ContractTool): string | undefined {
  const schema = renderSchema(tool.inputSchema);
  const properties = record(schema?.properties) ?? {};
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : []
  );
  const requiredValues = Object.fromEntries(
    [...required].map((name) => [name, exampleValue(properties[name], name)])
  );
  for (const kind of ["object", "array"] as const) {
    for (const [name, descriptor] of Object.entries(properties)) {
      const branch = structuredBranch(descriptor, kind);
      if (!branch) continue;
      const json = JSON.stringify({
        ...requiredValues,
        ...(!required.has(name) ? { [name]: exampleValue(branch, name) } : {}),
      });
      return `mcp call ${toolSelector(server, tool.name)} --json ${shellQuote(json)}`;
    }
  }
  return undefined;
}

export interface ContractTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export function renderToolContract(
  server: string,
  tool: ContractTool,
  options: { verboseDescriptions?: boolean } = {}
): string {
  const lines = [`${server}.${tool.name}`];
  const description = descriptionText(
    tool.description,
    options.verboseDescriptions === true
  );
  if (description) {
    lines.push(description);
  }
  if (
    !options.verboseDescriptions &&
    (descriptionText(tool.description, true).length > 160 ||
      hasLongDescription(tool.inputSchema) ||
      hasLongDescription(tool.outputSchema))
  ) {
    lines.push("Descriptions shortened; use --verbose for full text.");
  }
  lines.push("", "input", ...schemaLines(tool.inputSchema, "  ", options));
  lines.push(
    "",
    "output",
    ...(schemaObject(tool.outputSchema)
      ? schemaLines(tool.outputSchema, "  ", options)
      : ["  unspecified"])
  );
  lines.push("", "call", `  ${callExample(server, tool)}`);
  const structured = structuredCallExample(server, tool);
  if (structured) lines.push(`  structured: ${structured}`);
  return `${lines.join("\n")}\n`;
}

export function renderToolSignature(
  server: string,
  tool: ContractTool,
  options: { allParameters?: boolean } = {}
): string {
  const schema = renderSchema(tool.inputSchema);
  const properties = record(schema?.properties) ?? {};
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : []
  );
  const entries = Object.entries(properties);
  const included = new Set(
    entries.filter(([name]) => required.has(name)).map(([name]) => name)
  );
  if (!options.allParameters) {
    for (const [name] of entries) {
      if (included.size >= 5) break;
      included.add(name);
    }
  }
  const visible = options.allParameters
    ? entries
    : entries.filter(([name]) => included.has(name));
  const parameters = visible.map(([name, descriptor]) => {
    const optional = required.has(name) ? "" : "?";
    return `${name}${optional}: ${compactSchemaType(descriptor)}`;
  });
  const hidden = entries.length - visible.length;
  if (hidden > 0) parameters.push(`… +${hidden} optional`);
  return `${server}.${tool.name}(${parameters.join(", ")})`;
}

export function catalogOutputSchema(tool: McpToolCatalogEntry | undefined): unknown {
  return tool?.output_schema;
}
