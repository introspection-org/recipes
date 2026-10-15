import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_DEFAULTS, type BundleOptions, isCurrent } from "./bundle.js";
import type { ListedTools } from "./config.js";
import { type Fakes, startServices } from "./server.js";

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
  /** The fakes' directory; `fakes/` beside the Recipe's `package.json` when omitted. */
  fakesDir?: string | URL;
  /** The bundle's sources and output, relative to the fakes' directory; `false` skips the check. */
  bundle?: (BundleOptions & { out?: string }) | false;
  /** Each test's timeout in milliseconds. */
  timeout?: number;
}

interface DeclaredServer {
  id: string;
  tools?: { include?: string[] };
}

interface MappedTool {
  kind?: unknown;
  reads?: string[];
  writes?: string[];
}

const KINDS = ["stateful", "static"];

const toPath = (value: string | URL) => (value instanceof URL ? fileURLToPath(value) : value);
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

/**
 * Registers the tests every Recipe keeps about its own fakes (fake-server.md "The tests a
 * Recipe keeps"), with the runner's `test`:
 *
 * - each fake serves the Recipe's allowed tools from `tools.json`, in captured order;
 * - every allowed tool is in the manifest's entity map, its entities exist, and the map does
 *   not contradict `readOnlyHint`;
 * - no static tool reads an entity a tool writes or a world fills;
 * - every scenario builds a world holding every fake's state, which `consistent` accepts, and
 *   an unknown scenario is refused;
 * - the committed sidecar bundle is current.
 *
 * A fake's id is its directory under `mcp/` and the server id the Recipe declares.
 */
export function checkRecipeFakes<W extends object>(options: RecipeFakesOptions<W>): void {
  const { test, fakes, world, consistent, timeout = 60_000 } = options;
  const recipeFile = toPath(options.recipe);
  const fakesDir = options.fakesDir
    ? toPath(options.fakesDir)
    : path.join(path.dirname(recipeFile), "fakes");
  const clock = new Date(options.clock ?? Date.now());
  const scenarios = [
    ...(Symbol.iterator in Object(options.scenarios)
      ? (options.scenarios as Iterable<string>)
      : Object.keys(options.scenarios)),
  ];
  const declared = (): DeclaredServer[] => readJson(recipeFile).pi?.mcp?.servers ?? [];
  const captured = (id: string): ListedTools =>
    readJson(path.join(fakesDir, "mcp", id, "tools.json"));
  const worlds = () =>
    scenarios.map((scenario) => world(scenario, clock) as Record<string, unknown>);
  const run = (name: string, fn: () => Promise<void> | void) => test(name, { timeout }, fn);

  // The Recipe's allow-list for a fake, or every captured tool where the Recipe declares none.
  const allowed = (id: string) => {
    const server = declared().find((item) => item.id === id);
    assert.ok(server, `the Recipe declares no MCP server ${id}, the id of the fake mcp/${id}`);
    const { tools } = captured(id);
    const include = server.tools?.include ?? tools.map((tool) => tool.name);
    const missing = include.filter((name) => !tools.some((tool) => tool.name === name));
    assert.deepEqual(missing, [], `the Recipe allows tools ${id}/tools.json does not hold`);
    return include;
  };

  for (const [id, fake] of Object.entries(fakes)) {
    const manifest = fake.manifest as typeof fake.manifest & { entities?: string[] };
    const map = manifest.tools as Record<string, MappedTool>;

    run(`${id} serves the Recipe's allowed tools from tools.json, in captured order`, async () => {
      const include = allowed(id);
      const services = await startServices(fakes, { world, clock });
      try {
        const response = await fetch(services.url(id), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        const body = await response.text();
        const served = JSON.parse(body.match(/^data: (.*)$/m)?.[1] ?? body).result.tools;
        const expected = captured(id).tools.filter((tool) => include.includes(tool.name));
        assert.deepEqual(served, expected);
      } finally {
        await services.close();
      }
    });

    run(`${id} maps every allowed tool to its entities`, () => {
      const include = allowed(id);
      assert.deepEqual(Object.keys(map).sort(), [...include].sort(), `${id}/manifest.json tools`);
      const entities = manifest.entities ?? [];
      const { tools } = captured(id);
      for (const [name, tool] of Object.entries(map)) {
        assert.ok(KINDS.includes(tool.kind as string), `${name}: kind is stateful or static`);
        for (const entity of [...(tool.reads ?? []), ...(tool.writes ?? [])])
          assert.ok(entities.includes(entity), `${name}: ${entity} is not an entity`);
        const annotations = tools.find((item) => item.name === name)?.annotations as
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

  if (options.bundle !== false) {
    const sources = options.bundle || {};
    const at = (file: string) => path.resolve(fakesDir, file);
    run("the committed sidecar bundle is current", async () => {
      const out = at(sources.out ?? BUNDLE_DEFAULTS.out);
      const current = await isCurrent(out, {
        fakes: at(sources.fakes ?? BUNDLE_DEFAULTS.fakes),
        scenarios: at(sources.scenarios ?? BUNDLE_DEFAULTS.scenarios),
      });
      assert.ok(current, `${out} is stale: run npx mcp-fakes bundle in ${fakesDir}`);
    });
  }
}
