import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { isDefaultExecution, type ListedTool, type ListedTools } from "./config.js";
import { differences, operationOf, successful } from "./observed.js";
import { type Fake, type Fakes, type RecordedCall, startServices } from "./server.js";

/** `test` of `node:test` or of vitest: both take a name, options and the test. */
export type TestFunction = (
  name: string,
  options: { timeout: number },
  fn: () => Promise<void> | void,
) => unknown;

export interface RecipeFakesOptions<W extends object> {
  /** The runner's `test`, from `node:test` or vitest. */
  test: TestFunction;
  /** The Recipe's root `package.json`, which declares its MCP servers under `pi.mcp.servers`. */
  recipe: string | URL;
  /** Every fake, keyed by the server id the Recipe declares: `fakes` of `mcp/index.ts`. */
  fakes: Fakes;
  /** The Recipe's `world(scenario, clock)`. */
  world: (scenario: string | undefined, clock: Date) => W;
  /** Every scenario's name, or the object keyed by them. */
  scenarios: Iterable<string> | Record<string, unknown>;
  /** The Recipe's own invariants of a world, such as no record pointing at a missing one; throws when one fails. */
  consistent?: (world: W, scenario: string) => void;
  /** The clock the worlds are built at; now when omitted. */
  clock?: Date | string;
  /**
   * The JSONL file the Recipe's contract tests record every answer to (`withFakes`' `record`).
   * With it, each fake that exports `observed` is held to it: every observed tool the Recipe allows
   * has a recorded successful answer, and each one reads as the real server's did, a code-mode
   * tool's as the operation its arguments select did. An allowed tool `observed` holds no
   * observation of is named in a warning, since nothing checks its answers.
   */
  recording?: string | URL;
  /** Each test's timeout in milliseconds. */
  timeout?: number;
}

interface DeclaredServer {
  id: string;
  tools?: { include?: string[]; exclude?: string[] };
}

interface MappedTool {
  kind?: unknown;
  reads?: string[];
  writes?: string[];
}

const KINDS = ["stateful", "static"];

// A tool served without `execution` declares the default task support, so the two compare equal.
function withoutDefaultExecution(tool: ListedTool): ListedTool {
  if (!("execution" in tool) || !isDefaultExecution(tool.execution)) return tool;
  const { execution: _, ...rest } = tool;
  return rest;
}

const toPath = (value: string | URL) => (value instanceof URL ? fileURLToPath(value) : value);
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

// One JSON-RPC request to a fake, as an MCP client sends it; the SDK answers over SSE.
async function rpc(url: string, method: string, params?: object) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params && { params }) }),
  });
  const body = await response.text();
  return JSON.parse(body.match(/^data: (.*)$/m)?.[1] ?? body);
}

// A value of each JSON type: 1.5 is a number but no integer.
const PROBES: unknown[] = ["-", { "mcp-fakes": "not a value" }, [], true, 1.5, null];

const ajv = new AjvJsonSchemaValidator();

// Arguments a tool's captured input schema refuses: its required arguments left out, an argument
// it does not declare, or an argument of a value it does not accept. Each candidate is checked
// against the whole schema, so a probe is never valid input; none when the schema refuses every
// one of them.
function outsideInput(schema: object): Record<string, unknown> | undefined {
  const { properties } = schema as { properties?: Record<string, unknown> };
  const candidates: Record<string, unknown>[] = [
    {},
    { "mcp-fakes-undeclared": true },
    ...Object.keys(properties ?? {}).flatMap((name) => PROBES.map((value) => ({ [name]: value }))),
  ];
  const check = ajv.getValidator(schema as JsonSchemaType);
  return candidates.find((args) => !check(args).valid);
}

// The objects two values hold in common, by identity.
function shared(a: unknown, b: unknown): boolean {
  const seen = new Set<object>();
  const walk = (value: unknown, visit: (item: object) => boolean): boolean => {
    if (!value || typeof value !== "object") return false;
    if (visit(value)) return true;
    return Object.values(value).some((child) => walk(child, visit));
  };
  walk(a, (item) => {
    if (seen.has(item)) return true;
    seen.add(item);
    return false;
  });
  return walk(b, (item) => seen.has(item));
}

const tools = (fake: Fake): ListedTools => ({
  tools: Object.values(fake.contract).map((entry) => entry.tool as ListedTool),
});

/**
 * Registers the tests every Recipe keeps about its own fakes (fake-server.md "The tests a
 * Recipe keeps"), with the runner's `test`:
 *
 * - each fake serves the Recipe's allowed tools from its `contract`, in captured order;
 * - every allowed tool is in the manifest's entity map, its entities exist, and the map does
 *   not contradict `readOnlyHint`;
 * - no static tool reads an entity a tool writes or a world fills;
 * - a call outside a tool's captured input schema is refused and changes no state;
 * - two started instances share no state;
 * - with `recording`, every allowed tool a fake's `observed` holds has a recorded successful answer,
 *   and each one reads as the real server's did; an allowed tool it holds no observation of is
 *   named in a warning, not failed;
 * - every scenario builds a world holding every fake's state, which `consistent` accepts, and
 *   an unknown scenario is refused.
 *
 * A fake's id is its directory under `mcp/` and the server id the Recipe declares.
 */
export function checkRecipeFakes<W extends object>(options: RecipeFakesOptions<W>): void {
  const { test, fakes, world, consistent, timeout = 60_000 } = options;
  const recipeFile = toPath(options.recipe);
  const clock = new Date(options.clock ?? Date.now());
  const scenarios = [
    ...(Symbol.iterator in Object(options.scenarios)
      ? (options.scenarios as Iterable<string>)
      : Object.keys(options.scenarios)),
  ];
  const declared = (): DeclaredServer[] => readJson(recipeFile).pi?.mcp?.servers ?? [];
  const worlds = () =>
    scenarios.map((scenario) => world(scenario, clock) as Record<string, unknown>);
  const run = (name: string, fn: () => Promise<void> | void) => test(name, { timeout }, fn);
  const recorded = (): RecordedCall[] => {
    const file = toPath(options.recording as string | URL);
    assert.ok(fs.existsSync(file), `no recording at ${file}: run the contract tests first`);
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };

  // The captured tools the Recipe's policy allows, in captured order, or every captured tool
  // where the Recipe declares no include. A selector is trimmed; an include of "*" allows every
  // tool, and an exclude names a tool to drop (recipes' `mcpSelectionAllowsTool`).
  const allowed = (id: string) => {
    const server = declared().find((item) => item.id === id);
    assert.ok(server, `the Recipe declares no MCP server ${id}, the id of the fake mcp/${id}`);
    const names = tools(fakes[id]).tools.map((tool) => tool.name);
    const include = server.tools?.include?.map((selector) => selector.trim());
    if (!include) return names;
    const missing = include.filter((name) => name !== "*" && !names.includes(name));
    assert.deepEqual(missing, [], `the Recipe allows tools the ${id} contract does not hold`);
    const exclude = (server.tools?.exclude ?? []).map((selector) => selector.trim());
    return names.filter(
      (name) => (include.includes("*") || include.includes(name)) && !exclude.includes(name),
    );
  };

  for (const [id, fake] of Object.entries(fakes)) {
    const manifest = fake.manifest as typeof fake.manifest & { entities?: string[] };
    const map = manifest.tools as Record<string, MappedTool>;

    run(`${id} serves the Recipe's allowed tools from its contract, in captured order`, async () => {
      const include = allowed(id);
      const services = await startServices(fakes, { world, clock });
      try {
        const served = (await rpc(services.url(id), "tools/list")).result.tools;
        const expected = tools(fake).tools.filter((tool) => include.includes(tool.name));
        assert.deepEqual(served.map(withoutDefaultExecution), expected.map(withoutDefaultExecution));
      } finally {
        await services.close();
      }
    });

    run(`${id} maps every allowed tool to its entities`, () => {
      const include = allowed(id);
      assert.deepEqual(Object.keys(map).sort(), [...include].sort(), `${id}/manifest.json tools`);
      const entities = manifest.entities ?? [];
      for (const [name, tool] of Object.entries(map)) {
        assert.ok(KINDS.includes(tool.kind as string), `${name}: kind is stateful or static`);
        for (const entity of [...(tool.reads ?? []), ...(tool.writes ?? [])])
          assert.ok(entities.includes(entity), `${name}: ${entity} is not an entity`);
        const annotations = (fake.contract[name]?.tool as ListedTool | undefined)?.annotations as
          | { readOnlyHint?: boolean }
          | undefined;
        if (annotations?.readOnlyHint === true)
          assert.deepEqual(tool.writes ?? [], [], `${name} is read-only by its contract`);
        if (annotations?.readOnlyHint === false)
          assert.notEqual((tool.writes ?? []).length, 0, `${name} writes by its contract`);
      }
    });

    run(`${id} has no static tool over an entity a tool writes or a world fills`, () => {
      const written = new Set(Object.values(map).flatMap((tool) => tool.writes ?? []));
      const states = worlds().map((states) => states[id] as Record<string, unknown> | undefined);
      for (const [name, tool] of Object.entries(map)) {
        if (tool.kind !== "static") continue;
        assert.deepEqual(tool.writes ?? [], [], `${name} is static and writes`);
        for (const entity of tool.reads ?? []) {
          assert.ok(!written.has(entity), `${name} is static, and ${entity} is written`);
          for (const state of states) {
            const value = state?.[entity];
            assert.ok(
              !(Array.isArray(value) && value.length),
              `${name} is static, and a world fills ${entity}`,
            );
          }
        }
      }
    });

    run(`${id} refuses a call outside a tool's input schema and changes no state`, async () => {
      const include = allowed(id);
      const services = await startServices(fakes, { world, clock });
      try {
        for (const entry of Object.values(fake.contract)) {
          const args = include.includes(entry.tool.name) && outsideInput(entry.args);
          if (!args) continue;
          const body = await rpc(services.url(id), "tools/call", {
            name: entry.tool.name,
            arguments: args,
          });
          assert.ok(
            body.error || body.result?.isError === true,
            `${entry.tool.name} answered ${JSON.stringify(args)}, which its input schema refuses`,
          );
          assert.deepEqual(
            (services.states as Record<string, unknown>)[id],
            (services.initial as Record<string, unknown>)[id],
            `${entry.tool.name} changed the state on a refused call`,
          );
        }
      } finally {
        await services.close();
      }
    });

    // With a recording, its calls to this fake are replayed on one instance: the other keeps the
    // state it started with, then ends where the first did after the same calls.
    run(`${id} shares no state between two started instances`, async () => {
      const first = await startServices(fakes, { world, clock });
      const second = await startServices(fakes, { world, clock });
      const state = (services: { states: W; initial: W }, key: "states" | "initial") =>
        (services[key] as Record<string, unknown>)[id];
      const replay = async (url: string) => {
        for (const call of options.recording ? recorded().filter((c) => c.server === id) : [])
          await rpc(url, "tools/call", { name: call.tool, arguments: call.args });
      };
      try {
        assert.ok(
          !shared(state(first, "states"), state(second, "states")),
          `two instances of ${id} share state`,
        );
        assert.ok(
          !shared(state(first, "states"), state(first, "initial")),
          `${id}'s state shares objects with the state it started with`,
        );
        await replay(first.url(id));
        assert.deepEqual(
          state(second, "states"),
          state(second, "initial"),
          `calls to one instance of ${id} changed another's state`,
        );
        await replay(second.url(id));
        assert.deepEqual(
          state(second, "states"),
          state(first, "states"),
          `the same calls left two instances of ${id} in different states`,
        );
      } finally {
        await first.close();
        await second.close();
      }
    });

    const observed = fake.observed;
    if (options.recording && observed)
      run(`${id} answers every observed tool as the real server did`, () => {
        const include = allowed(id);
        const unobserved = include.filter((name) => !Object.hasOwn(observed, name));
        if (unobserved.length)
          console.warn(
            `${id}: not observed, so nothing checks their answers: ${unobserved.join(", ")}`,
          );
        const calls = recorded().filter((call) => call.server === id);
        const problems = Object.entries(observed).flatMap(([name, observation]) => {
          if (!observation.answer || !include.includes(name)) return [];
          // A code-mode tool's call is held to the operation its arguments select.
          const answers = calls
            .filter((call) => call.tool === name)
            .flatMap((call) => {
              const answer = successful(call);
              const mode = fake.manifest.codeMode?.[name];
              return answer ? [{ answer, observed: operationOf(observation, mode, call.args) }] : [];
            });
          if (!answers.length) return [`${name}: no recorded successful answer`];
          const found = answers.flatMap(({ answer, observed }) =>
            differences(observed, fake.contract[name], answer),
          );
          return [...new Set(found)].map((difference) => `${name} ${difference}`);
        });
        assert.deepEqual(problems, [], `the ${id} answers differ from the observed ones`);
      });
  }

  for (const scenario of scenarios)
    run(`the ${scenario} world is consistent`, () => {
      const built = world(scenario, clock);
      for (const id of Object.keys(fakes))
        assert.ok(Object.hasOwn(built, id), `the ${scenario} world holds no state for ${id}`);
      consistent?.(built, scenario);
    });

  run("an unknown scenario is refused", () => {
    assert.throws(() => world("no-such-scenario", clock));
  });
}
