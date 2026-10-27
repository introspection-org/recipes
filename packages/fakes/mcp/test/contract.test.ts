import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { answered, readAnswer, readResult } from "../src/answers.js";
import {
  type Answered,
  contractOf,
  decode,
  encode,
  observedOf,
  type Result,
  toolsOf,
} from "../src/index.js";

// A synthetic contract: `note` answers in text, `send` states an outputSchema, its answer, and
// `list` answers in a declared format with a schema.
const tools = {
  tools: [
    { name: "note", inputSchema: { type: "object", properties: {} } },
    {
      name: "send",
      inputSchema: {
        type: "object",
        properties: { to: { type: "string" }, retries: { type: "number", default: 2 } },
        required: ["to"],
      },
      outputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    { name: "list", inputSchema: { type: "object", properties: {} } },
  ],
} as const;

const answers = {
  note: { format: "text" },
  list: {
    format: "prefixed_json",
    prefix: "Found: ",
    schema: Type.Object({ ids: Type.Array(Type.String()) }, { additionalProperties: false }),
  },
};

const contract = contractOf(tools, answers);
const fake = { manifest: { server: { name: "mail" } }, contract };

describe("contractOf", () => {
  test("gives each tool its captured entry, its defaults and its answer, in captured order", () => {
    expect(Object.keys(contract)).toEqual(["note", "send", "list"]);
    expect(contract.send.tool).toBe(tools.tools[1]);
    expect(contract.send.args).toBe(tools.tools[1].inputSchema);
    expect(contract.send.defaults).toEqual({ retries: 2 });
    expect(contract.send.answer).toEqual({ format: "json", schema: tools.tools[1].outputSchema });
    expect(contract.list.answer).toBe(answers.list);
  });

  test("types each answer by its schema, or as text", () => {
    const sent: Result<typeof contract, "send"> = { id: "e1" };
    const listed: Result<typeof contract, "list"> = { ids: ["a"] };
    const noted: Result<typeof contract, "note"> = "a note";
    expect([sent, listed, noted]).toHaveLength(3);
  });

  test("reads no default from a boolean property schema", () => {
    const loose = {
      tools: [
        {
          name: "note",
          inputSchema: { type: "object", properties: { payload: true, n: { default: 1 } } },
        },
      ],
    } as const;
    expect(contractOf(loose, { note: { format: "text" } }).note.defaults).toEqual({ n: 1 });
  });

  test("throws for an answer of a tool it does not capture", () => {
    // A key the type does not know is allowed by `extends`, so this one is the run time's.
    expect(() => contractOf(tools, { ...answers, missing: { format: "text" } })).toThrow("an answer is declared for missing, which is not captured");
  });

  test("throws for any answer declared for a tool that states an outputSchema", () => {
    expect(() =>
      // @ts-expect-error: `send` states its answer.
      contractOf(tools, { ...answers, send: { format: "json" } }),
    ).toThrow("send states an outputSchema, its answer; declare none");
  });

  test("throws for a tool with neither an outputSchema nor a declared answer", () => {
    // @ts-expect-error: `list` needs an answer.
    expect(() => contractOf(tools, { note: { format: "text" } })).toThrow(
      "no answer is declared for list",
    );
  });
});

describe("toolsOf", () => {
  const { config, answer } = toolsOf(contract);

  test("answers in the declared format, and with structuredContent for an outputSchema", () => {
    expect(answer("note", "hi")).toEqual({ content: [{ type: "text", text: "hi" }] });
    expect(answer("list", { ids: ["a"] })).toEqual({
      content: [{ type: "text", text: 'Found: {"ids":["a"]}' }],
    });
    expect(answer("send", { id: "e1" })).toEqual({
      content: [{ type: "text", text: '{"id":"e1"}' }],
      structuredContent: { id: "e1" },
    });
  });

  test("registers a tool as captured", () => {
    expect(config("send").description).toBeUndefined();
    expect(config("send").outputSchema).toBeDefined();
  });
});

describe("formats", () => {
  test.each([
    [{ format: "json" }, { a: [1, "b"] }],
    [{ format: "toon" }, { records: [{ id: "r1", name: "Acme" }], has_more: false }],
    [{ format: "prefixed_json", prefix: "Sent! " }, { id: "e1" }],
    [{ format: "prefixed_json", prefix: "Found: ", suffix: " Done." }, { id: 1 }],
    [{ format: "text" }, "plain"],
  ])("decodes what it encodes as %j", (answer, value) => {
    expect(decode(answer, encode(answer, value))).toEqual(value);
  });

  test("refuses a prefixed answer without its prefix or suffix, and an unknown format", () => {
    expect(() => decode({ format: "prefixed_json", prefix: "Sent! " }, '{"id":1}')).toThrow(
      'the answer does not start with "Sent! "',
    );
    expect(() =>
      decode({ format: "prefixed_json", prefix: "Found: ", suffix: " Done." }, 'Found: {"id":1}'),
    ).toThrow('the answer does not end with " Done."');
    expect(() => encode({ format: "xml" }, {})).toThrow("no format xml");
  });
});

describe("reading answers", () => {
  test("decodes an answer's text and checks it against its schema", () => {
    expect(readAnswer(answers.list, 'Found: {"ids":["a"]}')).toEqual({
      ok: true,
      value: { ids: ["a"] },
    });
    const wrong = readAnswer(answers.list, 'Found: {"ids":[1]}');
    expect(wrong).toMatchObject({ ok: false, issues: [{ path: "/ids/0" }] });
    expect(readAnswer(answers.list, '{"ids":[]}')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^not prefixed_json: /),
    });
  });

  test("reads a tool with an outputSchema from its structuredContent, not its text", () => {
    expect(readResult(contract.send, { text: "Sent! On its way.", structured: { id: "e1" } })).toEqual(
      { ok: true, value: { id: "e1" } },
    );
    expect(readResult(contract.send, { text: '{"id":"e1"}' }).ok).toBe(false);
    expect(readResult(contract.send, { text: "", structured: { id: 1 } }).ok).toBe(false);
    expect(readResult(contract.note, { text: "a note" })).toEqual({ ok: true, value: "a note" });
  });

  test("answered types the successful calls, leaves out refused ones, and throws for one outside the contract", () => {
    const call = { name: "send", args: { to: "a@b.test" }, isError: false, response: "Sent!" };
    const calls: Answered<typeof contract>[] = answered(fake, [
      { ...call, structured: { id: "e1" } },
      { ...call, isError: true },
    ]);
    expect(calls).toEqual([{ name: "send", args: { to: "a@b.test" }, result: { id: "e1" } }]);
    expect(() => answered(fake, [call])).toThrow(
      "mail answered send outside its contract: no structuredContent; the tool states an outputSchema",
    );
    expect(() => answered(fake, [{ ...call, name: "other" }])).toThrow(/not in its contract/);
  });
});

test("observedOf gives each observed tool its samples and its answer, and each operation's own", () => {
  const observed = observedOf({
    tools: {
      send: { sampled: 3, result: { format: "prefixed_json", prefix: "Sent! ", lines: [1, 1] } },
      fail: { sampled: 0 },
      call: {
        sampled: 2,
        result: { format: "json", lines: [1, 1] },
        operations: {
          "GET /users/{id}": { sampled: 2, result: { format: "json", lines: [1, 1] } },
          "<unmatched>": { sampled: 0 },
        },
      },
    },
  } as const);
  expect(observed).toEqual({
    send: { sampled: 3, answer: { format: "prefixed_json", prefix: "Sent! " } },
    fail: { sampled: 0 },
    call: {
      sampled: 2,
      answer: { format: "json" },
      operations: {
        "GET /users/{id}": { sampled: 2, answer: { format: "json" } },
        "<unmatched>": { sampled: 0 },
      },
    },
  });
});
