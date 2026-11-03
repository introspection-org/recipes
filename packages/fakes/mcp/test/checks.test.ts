import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRecipeFakes, type RecipeFakesOptions } from "@introspection-ai/mcp-fakes/checks";
import { describe, expect, test, vi } from "vitest";
import {
  type Fake,
  type Fakes,
  type ListedTool,
  type McpServer,
  text,
  toolConfig,
} from "../src/index.js";
import { differences } from "../src/observed.js";
import { callTool, withFakes } from "../src/testing.js";
import { fakes } from "./fixtures/fakes/mcp/index.js";
import { SCENARIOS, type World, world } from "./fixtures/fakes/scenarios/index.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const RECIPE = path.join(FIXTURES, "recipe-package.json");

const noteIds = (state: World) => new Set(state.notes.notes.map((note) => note.id));
const consistent = (state: World) => {
  if (state.notes.brokenId && !noteIds(state).has(state.notes.brokenId))
    throw new Error("brokenId names a missing note");
};

// The fixture Recipe as a Recipe's own test file uses it, under vitest.
describe("a Recipe's checks under vitest", () => {
  checkRecipeFakes({
    test,
    recipe: RECIPE,
    fakes,
    world,
    scenarios: SCENARIOS,
    consistent,
  });
});

const base: Omit<RecipeFakesOptions<World>, "test"> = {
  recipe: RECIPE,
  fakes,
  world,
  scenarios: SCENARIOS,
  consistent,
};

// Runs the checks a call registers and names the ones that fail, with their message.
async function failing(options: Omit<RecipeFakesOptions<World>, "test">) {
  const registered: { name: string; fn: () => unknown }[] = [];
  checkRecipeFakes({ ...options, test: (name, _options, fn) => registered.push({ name, fn }) });
  const failed: Record<string, string> = {};
  for (const { name, fn } of registered)
    try {
      await fn();
    } catch (error) {
      failed[name] = (error as Error).message;
    }
  return { names: registered.map((item) => item.name), failed };
}

function recipe(
  change: (servers: { id: string; tools: { include?: string[]; exclude?: string[] } }[]) => void,
) {
  const parsed = JSON.parse(fs.readFileSync(RECIPE, "utf8"));
  change(parsed.pi.mcp.servers);
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fakes-recipe-")),
    "package.json",
  );
  fs.writeFileSync(file, JSON.stringify(parsed));
  return file;
}

// The notes fake with its manifest's entity map changed.
function notes(
  change: (tools: Record<string, { kind: string; reads: string[]; writes: string[] }>) => void,
): Fakes {
  const manifest = structuredClone(fakes.notes.manifest);
  change(manifest.tools as never);
  return { ...fakes, notes: { ...fakes.notes, manifest } as Fake };
}

describe("checkRecipeFakes", () => {
  test("registers one test per fake and rule, and per scenario", async () => {
    const { names, failed } = await failing({ ...base });
    expect(names).toEqual([
      "mail serves the Recipe's allowed tools from its contract, in captured order",
      "mail maps every allowed tool to its entities",
      "mail has no static tool over an entity a tool writes or a world fills",
      "mail refuses a call outside a tool's input schema and changes no state",
      "mail shares no state between two started instances",
      "notes serves the Recipe's allowed tools from its contract, in captured order",
      "notes maps every allowed tool to its entities",
      "notes has no static tool over an entity a tool writes or a world fills",
      "notes refuses a call outside a tool's input schema and changes no state",
      "notes shares no state between two started instances",
      "the quiet world is consistent",
      "the broken world is consistent",
      "an unknown scenario is refused",
    ]);
    expect(failed).toEqual({});
  });

  test("fails a fake that does not serve a tool the Recipe allows", async () => {
    const { failed } = await failing({
      ...base,
      recipe: recipe((servers) => servers[0].tools.include?.push("search-everything")),
    });
    expect(Object.keys(failed)).toEqual([
      "notes serves the Recipe's allowed tools from its contract, in captured order",
      "notes maps every allowed tool to its entities",
    ]);
  });

  test("fails a Recipe allowing a tool its capture does not hold", async () => {
    const { failed } = await failing({
      ...base,
      recipe: recipe((servers) => servers[1].tools.include?.push("send-later")),
    });
    expect(failed["mail maps every allowed tool to its entities"]).toMatch(
      /the Recipe allows tools the mail contract does not hold/,
    );
  });

  test("allows every captured tool for an include of \"*\", less what the Recipe excludes", async () => {
    const mail = await failing({
      ...base,
      recipe: recipe((servers) => {
        servers[1].tools.include = [" * "];
      }),
    });
    expect(mail.failed).toEqual({});
    const notes = await failing({
      ...base,
      recipe: recipe((servers) => {
        servers[0].tools = { include: ["*"], exclude: [" search-everything "] };
      }),
    });
    expect(notes.failed).toEqual({});
    const unexcluded = await failing({
      ...base,
      recipe: recipe((servers) => {
        servers[0].tools.include = ["*"];
      }),
    });
    expect(Object.keys(unexcluded.failed)).toEqual([
      "notes serves the Recipe's allowed tools from its contract, in captured order",
      "notes maps every allowed tool to its entities",
    ]);
  });

  test("allows only the listed tools, less what the Recipe excludes", async () => {
    const { failed } = await failing({
      ...base,
      recipe: recipe((servers) => {
        servers[0].tools = {
          include: ["list-notes", "create-note", "get-note", "search-everything"],
          exclude: ["search-everything"],
        };
      }),
    });
    expect(failed).toEqual({});
  });

  test("fails a Recipe allowing \"*\" and a tool its capture does not hold", async () => {
    const { failed } = await failing({
      ...base,
      recipe: recipe((servers) => {
        servers[1].tools.include = ["*", "send-later"];
      }),
    });
    expect(failed["mail maps every allowed tool to its entities"]).toMatch(
      /the Recipe allows tools the mail contract does not hold/,
    );
  });

  test("allows every captured tool where the Recipe declares no include", async () => {
    const { failed } = await failing({
      ...base,
      recipe: recipe((servers) => {
        delete servers[1].tools.include;
        delete servers[0].tools.include;
      }),
    });
    expect(Object.keys(failed)).toEqual([
      "notes serves the Recipe's allowed tools from its contract, in captured order",
      "notes maps every allowed tool to its entities",
    ]);
  });

  test("fails a fake whose id the Recipe does not declare", async () => {
    const { failed } = await failing({
      ...base,
      recipe: recipe((servers) => servers.splice(1, 1)),
    });
    expect(failed["mail maps every allowed tool to its entities"]).toBe(
      "the Recipe declares no MCP server mail, the id of the fake mcp/mail",
    );
  });

  test("fails an entity map that contradicts readOnlyHint or names an unknown entity", async () => {
    const contradicts = await failing({
      ...base,
      fakes: notes((tools) => {
        tools["list-notes"].writes = ["notes"];
      }),
    });
    expect(contradicts.failed["notes maps every allowed tool to its entities"]).toMatch(
      /list-notes is read-only by its contract/,
    );
    const unknown = await failing({
      ...base,
      fakes: notes((tools) => {
        tools["get-note"].reads = ["drafts"];
      }),
    });
    expect(unknown.failed["notes maps every allowed tool to its entities"]).toMatch(
      /get-note: drafts is not an entity/,
    );
  });

  test("fails a static tool over an entity a tool writes or a world fills", async () => {
    const written = await failing({
      ...base,
      fakes: notes((tools) => {
        tools["get-note"].kind = "static";
      }),
    });
    expect(
      written.failed["notes has no static tool over an entity a tool writes or a world fills"],
    ).toMatch(/get-note is static, and notes is written/);
    const filled = await failing({
      ...base,
      fakes: notes((tools) => {
        tools["get-note"].kind = "static";
        tools["create-note"].writes = [];
      }),
    });
    expect(
      filled.failed["notes has no static tool over an entity a tool writes or a world fills"],
    ).toMatch(/get-note is static, and a world fills notes/);
  });

  test("fails a world the Recipe's invariants refuse, and a world that takes any name", async () => {
    const { failed } = await failing({
      ...base,
      world: (scenario, clock) => {
        const built = world(scenario === "no-such-scenario" ? "quiet" : scenario, clock);
        if (scenario === "broken") built.notes.brokenId = "note-9";
        return built;
      },
    });
    expect(failed).toEqual({
      "the broken world is consistent": "brokenId names a missing note",
      "an unknown scenario is refused": expect.stringMatching(/Missing expected exception/),
    });
  });
});

describe("checkRecipeFakes' host-behaviour checks", () => {
  const REFUSES = "notes refuses a call outside a tool's input schema and changes no state";
  const SHARES = "notes shares no state between two started instances";

  // The notes fake with create-note served from a capture whose input schema is `inputSchema`,
  // writing a note with an id from `nextId`; with `captured`, its contract holds that schema too.
  const serving = (nextId: () => string, inputSchema: object, captured = false): Fakes => {
    const tools = Object.values(fakes.notes.contract).map((entry) =>
      entry.tool.name === "create-note" ? { ...entry.tool, inputSchema } : entry.tool,
    );
    const config = toolConfig({ tools: tools as ListedTool[] }) as (name: string) => never;
    const register = (server: McpServer, state: World["notes"]) => {
      server.registerTool("list-notes", config("list-notes"), async () => text("listed"));
      server.registerTool("create-note", config("create-note"), async () => {
        state.notes.push({ id: nextId(), title: "Untitled" });
        return text("created");
      });
      server.registerTool("get-note", config("get-note"), async () => text("read"));
    };
    const contract = { ...fakes.notes.contract };
    if (captured) contract["create-note"] = { ...contract["create-note"], args: inputSchema as never };
    return { ...fakes, notes: { ...fakes.notes, contract, register } as Fake };
  };
  const titled = (title: object) => ({ type: "object", properties: { title } });
  // Served from a looser capture than its contract states.
  const loose = (nextId: () => string) => serving(nextId, titled({ type: "string" }));

  test("fails a fake that answers a call its input schema refuses", async () => {
    const { failed } = await failing({ ...base, fakes: loose(() => "note-9") });
    expect(failed[REFUSES]).toMatch(/^create-note answered \{\}, which its input schema refuses/);
  });

  test("probes an argument with a type none of its schema's types accepts", async () => {
    // A string or number title: a number probe is valid, so the probe must be neither.
    const union = await failing({
      ...base,
      fakes: serving(() => "note-9", titled({ type: ["string", "number"] }), true),
    });
    expect(union.failed[REFUSES]).toBeUndefined();
    const every = { type: ["string", "number", "integer", "boolean", "object", "array", "null"] };
    const open = await failing({ ...base, fakes: serving(() => "note-9", titled(every), true) });
    expect(open.failed[REFUSES]).toBeUndefined();
  });

  test("sends no probe the whole input schema accepts", async () => {
    // Every property is a boolean by its pattern, so an undeclared boolean one is valid input.
    const patterned = {
      type: "object",
      patternProperties: { ".*": { type: "boolean" } },
      additionalProperties: false,
    };
    const { failed } = await failing({ ...base, fakes: serving(() => "note-9", patterned, true) });
    expect(failed[REFUSES]).toBeUndefined();
  });

  test("fails a fake whose instances share state, replaying the recording", async () => {
    let next = 0;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fakes-")), "rec.jsonl");
    const line = { server: "notes", tool: "create-note", args: { title: "A" }, result: {} };
    fs.writeFileSync(file, `${JSON.stringify(line)}\n`);
    const shared = loose(() => `note-${++next}`);
    expect((await failing({ ...base, fakes: shared })).failed[SHARES]).toBeUndefined();
    const { failed } = await failing({ ...base, fakes: shared, recording: file });
    expect(failed[SHARES]).toMatch(/^the same calls left two instances of notes in different states/);
  });
});

describe("checkRecipeFakes' observed answers", () => {
  const OBSERVED = "notes answers every observed tool as the real server did";
  const recordingOf = async (calls: [string, object][]) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fakes-")), "rec.jsonl");
    await withFakes(
      fakes,
      world,
      undefined,
      async ({ notes }) => {
        for (const [name, args] of calls) await callTool(notes, name, args);
      },
      { record: file },
    );
    return file;
  };
  // The notes fake with get-note observed as answering `schema` over `sampled` samples.
  const observing = (sampled: number, schema: object): Fakes => {
    const observed = { ...fakes.notes.observed, "get-note": { sampled, answer: { format: "json", schema } } };
    return { ...fakes, notes: { ...fakes.notes, observed } as Fake };
  };
  const NOTE = {
    type: "object",
    properties: { id: { type: "string" }, title: { type: "string" }, owner: { type: "string" } },
    required: ["id", "title", "owner"],
  };

  test("passes a fake whose recorded answers read as the observed ones", async () => {
    const recording = await recordingOf([
      ["list-notes", {}],
      ["get-note", { id: "note-1" }],
    ]);
    const { names, failed } = await failing({ ...base, recording });
    expect(names).toContain(OBSERVED);
    expect(names).not.toContain("mail answers every observed tool as the real server did");
    expect(failed).toEqual({});
  });

  test("holds only the tools the Recipe allows to their observed answers", async () => {
    // get-note is observed but excluded, so no answer of it is needed.
    const recording = await recordingOf([["list-notes", {}]]);
    const excluded = recipe((servers) => {
      servers[0].tools.exclude = ["get-note"];
    });
    const { failed } = await failing({ ...base, recipe: excluded, recording });
    expect(failed[OBSERVED]).toBeUndefined();
    expect((await failing({ ...base, recording })).failed[OBSERVED]).toMatch(
      /get-note: no recorded successful answer/,
    );
  });

  test("fails an observed tool with no recorded successful answer", async () => {
    const recording = await recordingOf([
      ["list-notes", {}],
      ["get-note", { id: "note-9" }],
    ]);
    const { failed } = await failing({ ...base, recording });
    expect(failed[OBSERVED]).toMatch(/get-note: no recorded successful answer/);
  });

  test("fails a key every sample held only once the tool was sampled three times", async () => {
    const recording = await recordingOf([
      ["list-notes", {}],
      ["get-note", { id: "note-1" }],
    ]);
    const firm = await failing({ ...base, fakes: observing(3, NOTE), recording });
    expect(firm.failed[OBSERVED]).toMatch(/get-note \$\.owner: missing, observed in every sample/);
    const loose = await failing({ ...base, fakes: observing(2, NOTE), recording });
    expect(loose.failed[OBSERVED]).toBeUndefined();
  });

  test("fails a wrong type", async () => {
    const recording = await recordingOf([
      ["list-notes", {}],
      ["get-note", { id: "note-1" }],
    ]);
    const typed = { type: "object", properties: { id: { type: "integer" } } };
    const wrong = await failing({ ...base, fakes: observing(1, typed), recording });
    expect(wrong.failed[OBSERVED]).toMatch(/get-note \$\.id: type string, observed integer/);
  });

  // A json answer `observe` sampled `sampled` times, its keys masked into `x-masked-values`.
  const maskedAs = (sampled: number, values: object) => ({
    sampled,
    answer: { format: "json", schema: { type: "object", "x-masked-values": values } },
  });
  const UUID_KEY = "0f8e2b9c-1d3a-4c5e-9f7a-2b4c6d8e0f1a";

  test("holds a key observe would have masked to x-masked-values", () => {
    const text = JSON.stringify({ [UUID_KEY]: "note" });
    const uuid = maskedAs(3, { type: "string", format: "uuid" });
    expect(differences(uuid, undefined, { text })).toEqual([
      "$.<masked>: format none, observed uuid",
    ]);
  });

  test("holds masked keys to x-masked-values only once the tool was sampled three times", () => {
    // One sampled row can mask keys whose values differ in type.
    const text = JSON.stringify({ [UUID_KEY]: "note" });
    expect(differences(maskedAs(1, { type: "array" }), undefined, { text })).toEqual([]);
    expect(differences(maskedAs(3, { type: "array" }), undefined, { text })).toEqual([
      "$.<masked>: type string, observed array",
    ]);
  });

  test("allows a plain word key the samples lacked, as observe keeps such a key by name", async () => {
    // `email_addresses` was in no sample; `observe` would have kept it by name, not masked it.
    const text = JSON.stringify({ email_addresses: "a", Zebracorp: "b", [UUID_KEY]: "c" });
    expect(differences(maskedAs(3, { type: "array" }), undefined, { text })).toEqual([
      "$.<masked>: type string, observed array",
      "$.<masked>: type string, observed array",
    ]);
    const recording = await recordingOf([
      ["list-notes", {}],
      ["get-note", { id: "note-1" }],
    ]);
    const masked = { type: "object", "x-masked-values": { type: "array" } };
    const { failed } = await failing({ ...base, fakes: observing(3, masked), recording });
    expect(failed[OBSERVED]).toBeUndefined();
  });

  test("holds a text answer to its observed first line", async () => {
    const recording = await recordingOf([
      ["list-notes", {}],
      ["get-note", { id: "note-1" }],
    ]);
    // list-notes answers "limit: 10" first; the notes fake is observed with "limit: <int>".
    const firstLine = (prefix: string, prefixes?: string[]): Fakes => {
      const answer = { format: "text", prefix, ...(prefixes && { prefixes }) };
      const observed = { ...fakes.notes.observed, "list-notes": { sampled: 2, answer } };
      return { ...fakes, notes: { ...fakes.notes, observed } as Fake };
    };
    const other = await failing({ ...base, fakes: firstLine("count: <int>"), recording });
    expect(other.failed[OBSERVED]).toMatch(/list-notes first line differs, observed count: <int>/);
    const alternative = firstLine("count: <int>", ["limit: <int>"]);
    expect((await failing({ ...base, fakes: alternative, recording })).failed[OBSERVED]).toBeUndefined();
  });

  test("holds a code-mode tool's call to the operation its method and path select", async () => {
    // get-note as a code-mode tool serving two operations: users always answer an email, tasks
    // an id, so the merged tool-level schema requires neither.
    const schema = (key: string) => ({
      type: "object",
      properties: { [key]: { type: "string" } },
      required: [key],
    });
    const observed = {
      "get-note": {
        sampled: 6,
        answer: { format: "json", schema: { type: "object" } },
        operations: {
          "GET /users/{id}": { sampled: 3, answer: { format: "json", schema: schema("email") } },
          "GET /tasks/{id}": { sampled: 3, answer: { format: "json", schema: schema("id") } },
          "<unmatched>": { sampled: 1 },
        },
      },
    };
    const codeModeOf = { "get-note": { method: "method", path: "path" } };
    const manifest = { ...fakes.notes.manifest, codeMode: codeModeOf };
    const codeMode: Fakes = { ...fakes, notes: { ...fakes.notes, manifest, observed } as Fake };
    const task = { id: "t-1" };
    const recordingOf = (calls: [string, string][]) => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fakes-")), "rec.jsonl");
      const lines = calls.map(([method, sent]) =>
        JSON.stringify({
          server: "notes",
          tool: "get-note",
          args: { method, path: sent },
          result: {
            content: [{ type: "text", text: JSON.stringify(task) }],
            structuredContent: task,
          },
        }),
      );
      fs.writeFileSync(file, `${lines.join("\n")}\n`);
      return file;
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const right = recordingOf([
        ["get", "/api/tasks/7?x=1"],
        ["DELETE", "/users/7"],
        ["GET", "/other/7"],
      ]);
      // A task's path, a method no operation was observed with, and a path matching none.
      const passed = await failing({ ...base, fakes: codeMode, recording: right });
      expect(passed.failed[OBSERVED]).toBeUndefined();
      const wrong = recordingOf([["GET", "/api/users/7"]]);
      const { failed } = await failing({ ...base, fakes: codeMode, recording: wrong });
      expect(failed[OBSERVED]).toMatch(/get-note \$\.email: missing, observed in every sample/);
    } finally {
      warn.mockRestore();
    }
  });

  test("warns of an allowed tool observed.ts holds no observation of, without failing", async () => {
    const recording = await recordingOf([
      ["list-notes", {}],
      ["get-note", { id: "note-1" }],
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { failed } = await failing({ ...base, recording });
      expect(failed[OBSERVED]).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "notes: not observed, so nothing checks their answers: create-note",
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("differences of a toon answer", () => {
  const observed = (canonical?: boolean) => ({
    sampled: 3,
    answer: {
      format: "toon",
      ...(canonical !== undefined && { canonical }),
      schema: { type: "object", properties: { id: { type: "integer" } } } as never,
    },
  });
  const read = (text: string, canonical?: boolean) =>
    differences(observed(canonical), undefined, { text });

  test("holds TOON to how the encoder writes it wherever every observed result was", () => {
    expect(read("id: 1\ntitle: A", true)).toEqual([]);
    expect(read('id: 1\ntitle: "A"', true)).toEqual([
      "line 2: not written as the TOON encoder writes it (quoting or layout), which every observed result was",
    ]);
    expect(read('id: 1\ntitle: "A"')).toEqual([]);
    expect(read('id: "1"', true)).toEqual(["$.id: type string, observed integer"]);
  });

  test("holds an empty array to the length form the real server writes", () => {
    expect(read("id: 1\ntags[0]:", true)).toEqual([]);
    expect(read("id: 1\ntags: []", true)).toEqual([
      "line 2: not written as the TOON encoder writes it (quoting or layout), which every observed result was",
    ]);
  });
});

describe("differences of a prefixed_json answer", () => {
  const observed = (prefix: string, suffix?: string) => ({
    sampled: 3,
    answer: {
      format: "prefixed_json",
      prefix,
      ...(suffix !== undefined && { suffix }),
      schema: { type: "object", properties: { id: { type: "integer" } } } as never,
    },
  });
  const read = (text: string, prefix: string, suffix?: string) =>
    differences(observed(prefix, suffix), undefined, { text });

  test("decodes the JSON value apart from the text around it", () => {
    expect(read('Found: {"id":1} Done.', "Found:", "Done.")).toEqual([]);
    expect(read('Sent!  {"id":1,"note":"a } b"}', "Sent!")).toEqual([]);
    expect(read('Found [2] notes: {"id":1}', "Found [<int>] notes:")).toEqual([]);
    expect(read('Found: {"id":"1"}', "Found:")).toEqual(["$.id: type string, observed integer"]);
  });

  test("matches a prefix that ends in a masked placeholder", () => {
    expect(read('Results for acme corp {"id":1}', "Results for <str>")).toEqual([]);
  });

  test("holds the text before and after the JSON to the observed prefix and suffix", () => {
    expect(read('Found: {"id":1} Done.', "Found:")).toEqual(["suffix differs, observed none"]);
    expect(read('Found: {"id":1}', "Found:", "Done.")).toEqual([
      "suffix differs, observed Done.",
    ]);
    expect(read('Lost: {"id":1}', "Found:")).toEqual(["prefix differs, observed Found:"]);
    expect(read("Found: nothing", "Found:")).toEqual([
      "not prefixed_json: no JSON object inside the text",
    ]);
  });

  test("matches any of the observed prefixes and suffixes", () => {
    const varied = observed("Found:", "Done.");
    const answer = { ...varied.answer, prefixes: ["Got <int>:"], suffixes: ["Bye."] };
    const alternatives = { ...varied, answer };
    expect(differences(alternatives, undefined, { text: 'Got 2: {"id":1} Bye.' })).toEqual([]);
    expect(differences(alternatives, undefined, { text: 'Lost: {"id":1} Done.' })).toEqual([
      "prefix differs, observed Found:",
    ]);
  });

  test("matches a prefix or suffix observe cut at 240 characters as the start of the text", () => {
    const long = "Found ".repeat(50).trim();
    const cut = `${long.slice(0, 240)}...`;
    expect(read(`${long}: {"id":1} ${long}`, cut, cut)).toEqual([]);
    expect(read(`Lost ${long}: {"id":1}`, cut)).toEqual([`prefix differs, observed ${cut}`]);
  });

  test("matches a text answer's first line observe cut at 240 characters as its start", () => {
    const line = "Found ".repeat(50).trim();
    const answer = { format: "text", prefix: `${line.slice(0, 240)}...` };
    expect(differences({ sampled: 3, answer }, undefined, { text: `${line}\nmore` })).toEqual([]);
  });

  test("reads an answer with structuredContent as json, which a prefixed_json observation is not", () => {
    const answer = { text: '{"id":1}', structured: { id: 1 } };
    expect(differences(observed("Found:", "Done."), undefined, answer)).toEqual([
      "result format json, observed prefixed_json",
    ]);
    const json = { ...observed(""), answer: { ...observed("").answer, format: "json" } };
    expect(differences(json, undefined, answer)).toEqual([]);
  });
});
