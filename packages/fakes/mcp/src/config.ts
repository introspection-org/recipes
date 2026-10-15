import { createHash } from "node:crypto";
import {
  type CallToolResult,
  fromJsonSchema,
  type Icon,
  type JsonSchemaType,
  type jsonSchemaValidator,
  type McpServer,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";

/** One tool of a captured `tools/list` payload, as `tools.json` holds it. */
export interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: object;
  outputSchema?: object;
  annotations?: object;
  icons?: object[];
  execution?: object;
  _meta?: object;
}

/** A captured `tools.json`: the `tools/list` result. */
export interface ListedTools {
  tools: ListedTool[];
}

/** What `contract.ts` generates for one tool. */
export interface ContractEntry {
  args: object;
  result?: object;
  defaults?: object;
}

// The config of registerTool's current overload (the second is deprecated), with its input
// schema typed as the arguments the callback is given.
type RegisterConfig = McpServer["registerTool"] extends {
  (name: string, config: infer Config, ...rest: never[]): unknown;
  (...args: never[]): unknown;
}
  ? Config
  : never;

export type ToolConfig<Args> = Omit<RegisterConfig, "inputSchema"> & {
  inputSchema: StandardSchemaWithJSON<Args, Args>;
};

/** Where a config came from, so the host can tell a tool registered from `tools.json`. */
export interface Configured {
  name: string;
  index: number;
}

// A registry symbol rather than a module-local map, so a config built by one loaded copy of
// this package is recognised by another (a linked install loads two).
export const CONFIGURED = Symbol.for("@introspection-ai/mcp-fakes/config");

export function configuredBy(config: object): Configured | undefined {
  return (config as { [CONFIGURED]?: Configured })[CONFIGURED];
}

// The SDK's validator picks the engine by a schema's `$schema` and enforces formats, but does
// not fill defaults, so a valid call gets the defaults its schema states on top-level
// properties, and a handler receives every defaulted argument.
const ajv = new AjvJsonSchemaValidator();
const withDefaults: jsonSchemaValidator = {
  getValidator<T>(schema: JsonSchemaType) {
    const check = ajv.getValidator<T>(schema);
    const properties = Object.entries(schema.properties ?? {}) as [string, { default?: unknown }][];
    return (input: unknown) => {
      const result = check(input);
      if (result.valid)
        for (const [key, property] of properties)
          if (property && typeof property === "object" && "default" in property)
            if (!(key in (result.data as object)))
              (result.data as Record<string, unknown>)[key] = structuredClone(property.default);
      return result;
    };
  },
};

const MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const LISTS = ["allOf", "anyOf", "oneOf", "prefixItems", "items"];
const SUBSCHEMAS = ["items", "additionalProperties", "not", "if", "then", "else", "contains"];

/** The paths of every default in an input schema that the host would not fill. */
export function unfilledDefaults(schema: unknown, path = "", filled = false): string[] {
  if (!schema || typeof schema !== "object") return [];
  const node = schema as Record<string, unknown>;
  const top = path === "";
  return [
    ...("default" in node && !filled ? [path || "/"] : []),
    ...MAPS.flatMap((key) =>
      Object.entries((node[key] as Record<string, unknown>) ?? {}).flatMap(([name, child]) =>
        unfilledDefaults(child, `${path}/${key}/${name}`, top && key === "properties"),
      ),
    ),
    ...LISTS.filter((key) => Array.isArray(node[key])).flatMap((key) =>
      (node[key] as unknown[]).flatMap((child, i) =>
        unfilledDefaults(child, `${path}/${key}/${i}`),
      ),
    ),
    ...SUBSCHEMAS.filter((key) => !Array.isArray(node[key])).flatMap((key) =>
      unfilledDefaults(node[key], `${path}/${key}`),
    ),
  ];
}

/**
 * Binds a fake's captured `tools.json` and its generated `Contract`, and returns its `config`:
 * `server.registerTool(name, config(name), callback)`.
 */
export function toolConfig<C extends { [N in keyof C]: ContractEntry }>(listed: ListedTools) {
  return function config<N extends keyof C & string>(name: N): ToolConfig<C[N]["args"]> {
    const index = listed.tools.findIndex((item) => item.name === name);
    if (index < 0) throw new Error(`${name} is not in tools.json`);
    const tool = listed.tools[index];
    // registerTool in the SDK 2.3.1 drops `execution`; serving the tool without it would change
    // the contract.
    if (tool.execution) throw new Error(`${name} declares execution, which the SDK cannot serve`);
    const unfilled = unfilledDefaults(tool.inputSchema);
    if (unfilled.length)
      throw new Error(
        `${name} states a default below the top level of its input schema, which the host does not fill: ${unfilled.join(", ")}`,
      );
    const output = tool.outputSchema as JsonSchemaType | undefined;
    const registration: ToolConfig<C[N]["args"]> = {
      title: tool.title,
      description: tool.description,
      inputSchema: fromJsonSchema<C[N]["args"]>(tool.inputSchema as JsonSchemaType, withDefaults),
      ...(output ? { outputSchema: fromJsonSchema(output) } : {}),
      annotations: tool.annotations as ToolAnnotations | undefined,
      icons: tool.icons as Icon[] | undefined,
      _meta: tool._meta as Record<string, unknown> | undefined,
    };
    Object.defineProperty(registration, CONFIGURED, { value: { name, index } });
    return registration;
  };
}

/** A text result, the shape most captured servers answer in. */
export function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) };
}

/**
 * The result of a tool that declares an output schema: the structured content, and its JSON
 * as the text item. Type it with the result `contract.ts` generated:
 * `structured<Contract['get-deal']['result']>({ ... })`.
 */
export function structured<T extends object>(value: T): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

/**
 * The tool error a handler answers with when an argument selects a behaviour it does not
 * implement, such as a filter operator: `notImplemented('the filter op gt on stage')`.
 */
export function notImplemented(what: string): CallToolResult {
  return text(`This fake does not implement ${what}.`, true);
}

/** A stable UUID for a readable label, so a world's ids are the same from run to run. */
export function labelId(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
