import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { type Read, readAnswer, readResult } from "../src/answers.js";
import type { Answer, Entry } from "../src/contract.js";

// The cases introspection-harbor's tests/test_answers.py runs too, so both read answers alike.
const SHARED = path.join(import.meta.dirname, "../../testdata");
type Case = {
  name: string;
  answer: Answer & { structured?: boolean };
  text: string;
  structured?: unknown;
  value?: unknown;
  paths?: string[];
};
const cases = JSON.parse(fs.readFileSync(path.join(SHARED, "answers.json"), "utf8")) as {
  readAnswer: Case[];
  readResult: Case[];
};

// A read as a case states it: its value, or the paths of its issues.
function expectRead(result: Read, expected: Case) {
  if (expected.value !== undefined) expect(result).toEqual({ ok: true, value: expected.value });
  else {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.path)).toEqual(expected.paths);
  }
}

describe("readAnswer", () => {
  test.each(cases.readAnswer)("$name", (expected) => {
    expectRead(readAnswer(expected.answer, expected.text), expected);
  });
});

describe("readResult", () => {
  test.each(cases.readResult)("$name", (expected) => {
    const { structured, ...answer } = expected.answer;
    const tool = { name: "t", inputSchema: {}, ...(structured && { outputSchema: answer.schema }) };
    const entry = { tool, args: {}, defaults: {}, answer } as unknown as Entry;
    expectRead(readResult(entry, { text: expected.text, structured: expected.structured }), expected);
  });
});
