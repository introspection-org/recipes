// A fake's contract: one entry per tool, built from the `tools.ts` the CLI writes and the answers
// the fake declares, and the handler-side helpers typed by it.
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Static, TSchema } from "typebox";
import { structured, type ToolConfig, text, toolConfig } from "./config.js";
import { encode } from "./formats.js";

/**
 * What a tool answers when it succeeds: the format the server answers in (`json`, `toon`,
 * `prefixed_json` or `text`), the prefix before and the suffix after the JSON of a
 * `prefixed_json` answer, and the schema of the decoded value; a `text` answer has none. A fake
 * declares it for each tool, `observed.ts` records it, and a server's outputSchema states it.
 */
export type Answer = { format: string; prefix?: string; suffix?: string; schema?: TSchema };

type Tool = { name: string; inputSchema: TSchema; outputSchema?: TSchema };
type Tools = { readonly tools: readonly Tool[] };
type Named<T extends Tools, N> = Extract<T["tools"][number], { name: N }>;

// The tools that state an outputSchema, which is their answer.
type Stated<T extends Tools> = Extract<T["tools"][number], { outputSchema: TSchema }>["name"];

// The answers a fake declares: one for each tool that states no outputSchema, and none for a tool
// that does.
type Declared<T extends Tools> = {
  [N in Exclude<T["tools"][number]["name"], Stated<T>>]: Answer;
} & { [N in Stated<T>]?: never };

// The arguments an input schema states a default for, which the host fills.
type Defaulted<S> = S extends { properties: infer P }
  ? { [K in keyof P]: P[K] extends { default: unknown } ? K : never }[keyof P]
  : never;

/**
 * One tool of a contract: the captured tool, served as it is; its input schema; the defaults it
 * states; and its answer.
 */
export type Entry<T extends Tool = Tool, A extends Answer = Answer> = {
  tool: T;
  args: T["inputSchema"];
  defaults: Record<Defaulted<T["inputSchema"]>, unknown>;
  answer: A;
};

/** Every tool's entry, by name, as `contractOf` gives them, in captured order. */
export type Contract = Record<string, Entry>;

/**
 * Each tool's entry, by name, from a fake's `tools.ts` and its declared answers. Throws for a
 * declared answer of a tool the fake does not capture, and for any answer declared for a tool
 * that states an outputSchema, whose answer is `{ format: "json", schema: outputSchema }`.
 */
export function contractOf<T extends Tools, A extends Declared<T>>(tools: T, answers: A) {
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const name of Object.keys(answers))
    if (!names.has(name))
      throw new Error(`an answer is declared for ${name}, which is not captured`);
  return Object.fromEntries(
    tools.tools.map((tool) => {
      const declared = (answers as Record<string, Answer>)[tool.name];
      if (tool.outputSchema && declared)
        throw new Error(`${tool.name} states an outputSchema, its answer; declare none`);
      if (!tool.outputSchema && !declared)
        throw new Error(`no answer is declared for ${tool.name}`);
      // A property schema may be a boolean, which holds no default.
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
      const defaults = Object.entries(properties ?? {}).flatMap(([key, property]) =>
        typeof property === "object" && property !== null && "default" in property
          ? [[key, property.default]]
          : [],
      );
      const answer = tool.outputSchema ? { format: "json", schema: tool.outputSchema } : declared;
      return [
        tool.name,
        { tool, args: tool.inputSchema, defaults: Object.fromEntries(defaults), answer },
      ];
    }),
  ) as {
    [N in T["tools"][number]["name"]]: Entry<
      Named<T, N>,
      N extends keyof A ? A[N] : { format: "json"; schema: Named<T, N>["outputSchema"] & TSchema }
    >;
  };
}

/**
 * An observed answer: an `Answer`, with the other prefixes and suffixes observed when they varied,
 * and for `toon`, `canonical` when every observed result was written exactly as the TOON encoder
 * writes it. The prefixes of a `text` answer are its observed first lines.
 */
export type ObservedAnswer = Answer & {
  canonical?: boolean;
  prefixes?: string[];
  suffixes?: string[];
};

type Observation = {
  sampled: number;
  result?: ObservedAnswer;
  operations?: Record<string, Observation>;
};

/**
 * One observed tool: how many answers were sampled, and what they were, as an `ObservedAnswer`. A
 * code-mode tool also holds each API operation's own observation, keyed by `METHOD /template`.
 */
export type Observed = {
  sampled: number;
  answer?: ObservedAnswer;
  operations?: Record<string, Observed>;
};

// One observation as an `Observed`, its operations' too.
function observedFrom({ sampled, result, operations }: Observation): Observed {
  return {
    sampled,
    ...(result && {
      answer: {
        format: result.format,
        ...(result.canonical !== undefined && { canonical: result.canonical }),
        ...(result.prefix !== undefined && { prefix: result.prefix }),
        ...(result.prefixes !== undefined && { prefixes: result.prefixes }),
        ...(result.suffix !== undefined && { suffix: result.suffix }),
        ...(result.suffixes !== undefined && { suffixes: result.suffixes }),
        ...(result.schema !== undefined && { schema: result.schema }),
      },
    }),
    ...(operations && {
      operations: Object.fromEntries(
        Object.entries(operations).map(([key, operation]) => [key, observedFrom(operation)]),
      ),
    }),
  };
}

/**
 * Each observed tool from the `observed.ts` the CLI writes, by name: how many answers were
 * sampled, and what they were, as an `Answer` like the declared one `contractOf` gives, and for a
 * code-mode tool each operation's own. A tool observed with no successful answer has none.
 */
export function observedOf<O extends { tools: Record<string, Observation> }>(observed: O) {
  return Object.fromEntries(
    Object.entries(observed.tools).map(([name, observation]) => [name, observedFrom(observation)]),
  ) as {
    [N in keyof O["tools"]]: {
      sampled: number;
      answer: AnswerOf<O["tools"][N]["result"]>;
      operations?: Record<string, Observed>;
    };
  };
}

// An observed result as an `ObservedAnswer`: its format, and its canonical flag, prefixes,
// suffixes and schema where it has them.
type AnswerOf<R> = { format: R extends { format: infer F } ? F : string } & Pick<
  R,
  Extract<keyof R, "canonical" | "prefix" | "prefixes" | "suffix" | "suffixes" | "schema">
>;

/** A tool's arguments as its handler receives them, with the defaults the host fills required. */
export type Args<C extends Contract, N extends keyof C> = Omit<
  Static<C[N]["args"]>,
  keyof C[N]["defaults"]
> &
  Required<Pick<Static<C[N]["args"]>, keyof C[N]["defaults"] & keyof Static<C[N]["args"]>>>;

/** A tool's arguments as a caller sends them: those with a default may be left out. */
export type SentArgs<C extends Contract, N extends keyof C> = Static<C[N]["args"]>;

/** What a tool answers when it succeeds, decoded: its answer's schema, or the text of a text answer. */
export type Result<C extends Contract, N extends keyof C> = C[N]["answer"] extends {
  schema: infer S extends TSchema;
}
  ? Static<S>
  : string;

/**
 * A call a fake answered: its arguments as sent and its decoded answer, keyed by tool name, so
 * narrowing on `name` types both.
 */
export type Answered<C extends Contract> = {
  [N in keyof C]: { name: N; args: SentArgs<C, N>; result: Result<C, N> };
}[keyof C];

/**
 * A handler's helpers: `config(name)` registers a tool as captured, its arguments typed by its
 * input schema, and `answer(name, value)` answers in its declared format, its value typed by the
 * answer's schema; a tool that states an outputSchema answers with `structured(value)`.
 */
export function toolsOf<C extends Contract>(contract: C) {
  const config = toolConfig({ tools: Object.values(contract).map((entry) => entry.tool) });
  return {
    config: <N extends keyof C & string>(name: N) =>
      config(name as never) as unknown as ToolConfig<Args<C, N>>,
    answer: <N extends keyof C & string>(name: N, value: Result<C, N>): CallToolResult =>
      contract[name].tool.outputSchema
        ? structured(value as object)
        : text(encode(contract[name].answer, value)),
  };
}
