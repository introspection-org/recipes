// Reading answers: an answer's text decoded by its format and checked against its schema, for a
// fake's declared answers and for the observed ones alike. A Recipe's contract tests check every
// answer with it, and its eval checks read the agent's tool results with it. Not imported by a
// handler.
import type { TSchema } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import type { Answer, Answered, Contract, Entry } from "./contract.js";
import { decode } from "./formats.js";

const validators = new Map<TSchema, Validator>();

/** Where a decoded answer differs from its schema. */
export type Issue = { path: string; keyword: string; message: string };
export type Read = { ok: true; value: unknown } | { ok: false; error: string; issues: Issue[] };

/** A successful answer's text, decoded and checked. A text answer is its text. */
export function readAnswer(answer: Answer, text: string): Read {
  if (answer.format === "text") return { ok: true, value: text };
  let value: unknown;
  try {
    value = decode(answer, text);
  } catch (error) {
    const message = `not ${answer.format}: ${(error as Error).message}`;
    return { ok: false, error: message, issues: [] };
  }
  return checked(answer, value);
}

/** A tool result as an MCP client gets it: its text items, joined, and its structuredContent. */
export type ToolResult = { text: string; structured?: unknown };

/**
 * A successful result of one tool of a contract, read where its answer is: the structuredContent
 * of a tool that states an outputSchema, whose text may hold anything beside it, as the Recipes
 * MCP wrapper and `observe` read it; the text of any other.
 */
export function readResult(entry: Entry, result: ToolResult): Read {
  if (!entry.tool.outputSchema) return readAnswer(entry.answer, result.text);
  if (result.structured === undefined)
    return {
      ok: false,
      error: "no structuredContent; the tool states an outputSchema",
      issues: [],
    };
  return checked(entry.answer, result.structured);
}

// A decoded value against its answer's schema.
function checked(answer: Answer, value: unknown): Read {
  if (!answer.schema) return { ok: true, value };
  let validator = validators.get(answer.schema);
  if (!validator) {
    validator = Compile(answer.schema);
    validators.set(answer.schema, validator);
  }
  if (validator.Check(value)) return { ok: true, value };
  const issues = validator.Errors(value).map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message,
  }));
  const error = issues.map((issue) => `${issue.path} ${issue.message}`).join(", ");
  return { ok: false, error, issues };
}

/** What reading a fake's answers needs of its module. */
export type Readable<C extends Contract = Contract> = {
  manifest: { server: { name: string } };
  contract: C;
};

/** One tool call of a run, as an eval reads it. */
export type Call = {
  name: string;
  args: unknown;
  isError: boolean;
  response: string;
  structured?: unknown;
};

/**
 * The calls a fake answered, typed by its contract: a call it answered passed its captured input
 * schema, so the arguments are the contract's. A call it rejected is left out. A successful
 * answer that is not the declared one is the fake's fault, not the agent's, so it throws: the
 * measurement is invalid.
 */
export function answered<C extends Contract>(fake: Readable<C>, calls: Call[]): Answered<C>[] {
  return calls.flatMap((call) => {
    if (call.isError) return [];
    const entry = fake.contract[call.name];
    const read = entry
      ? readResult(entry, { text: call.response, structured: call.structured })
      : ({ ok: false, error: "not in its contract", issues: [] } as const);
    if (!read.ok)
      throw new Error(
        `${fake.manifest.server.name} answered ${call.name} outside its contract: ${read.error}`,
      );
    return [{ name: call.name, args: call.args, result: read.value } as Answered<C>];
  });
}
