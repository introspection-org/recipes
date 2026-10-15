import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRecipeFakes, type RecipeFakesOptions } from "@introspection-ai/mcp-fakes/checks";
import { beforeAll, describe, expect, test } from "vitest";
import { writeBundle } from "../src/bundle.js";
import type { Fake, Fakes } from "../src/index.js";
import { fakes } from "./fixtures/fakes/mcp/index.js";
import { SCENARIOS, type World, world } from "./fixtures/fakes/scenarios/index.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const FAKES = path.join(FIXTURES, "fakes");
const RECIPE = path.join(FIXTURES, "recipe-package.json");
const OUT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fakes-checks-")), "sidecar.js");

const noteIds = (state: World) => new Set(state.notes.notes.map((note) => note.id));
const consistent = (state: World) => {
  if (state.notes.brokenId && !noteIds(state).has(state.notes.brokenId))
    throw new Error("brokenId names a missing note");
};

beforeAll(
  () =>
    writeBundle(OUT, {
      fakes: path.join(FAKES, "mcp/index.ts"),
      scenarios: path.join(FAKES, "scenarios/index.ts"),
    }),
  60_000,
);

// The fixture Recipe as a Recipe's own test file uses it, under vitest.
describe("a Recipe's checks under vitest", () => {
  checkRecipeFakes({
    test,
    recipe: RECIPE,
    fakes,
    world,
    scenarios: SCENARIOS,
    consistent,
    bundle: { out: OUT },
  });
});

const base: Omit<RecipeFakesOptions<World>, "test"> = {
  recipe: RECIPE,
  fakes,
  world,
  scenarios: SCENARIOS,
  consistent,
  bundle: { out: OUT },
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

function recipe(change: (servers: { id: string; tools: { include: string[] } }[]) => void) {
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
  test("registers one test per fake and rule, per scenario, and for the bundle", async () => {
    const { names, failed } = await failing({ ...base, fakesDir: FAKES });
    expect(names).toEqual([
      "mail serves the Recipe's allowed tools from tools.json, in captured order",
      "mail maps every allowed tool to its entities",
      "mail has no static tool over an entity a tool writes or a world fills",
      "notes serves the Recipe's allowed tools from tools.json, in captured order",
      "notes maps every allowed tool to its entities",
      "notes has no static tool over an entity a tool writes or a world fills",
      "the quiet world is consistent",
      "the broken world is consistent",
      "an unknown scenario is refused",
      "the committed sidecar bundle is current",
    ]);
    expect(failed).toEqual({});
  });

  test("fails a fake that does not serve a tool the Recipe allows", async () => {
    const { failed } = await failing({
      ...base,
      recipe: recipe((servers) => servers[0].tools.include.push("search-everything")),
      fakesDir: FAKES,
    });
    expect(Object.keys(failed)).toEqual([
      "notes serves the Recipe's allowed tools from tools.json, in captured order",
      "notes maps every allowed tool to its entities",
    ]);
  });

  test("fails a Recipe allowing a tool its capture does not hold", async () => {
    const { failed } = await failing({
      ...base,
      recipe: recipe((servers) => servers[1].tools.include.push("send-later")),
      fakesDir: FAKES,
    });
    expect(failed["mail maps every allowed tool to its entities"]).toMatch(
      /the Recipe allows tools mail\/tools.json does not hold/,
    );
  });

  test("fails a fake whose id the Recipe does not declare", async () => {
    const { failed } = await failing({
      ...base,
      recipe: recipe((servers) => servers.splice(1, 1)),
      fakesDir: FAKES,
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

  test("fails a stale bundle", async () => {
    const stale = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fakes-stale-")),
      "sidecar.js",
    );
    fs.writeFileSync(stale, "// stale\n");
    const { failed } = await failing({ ...base, bundle: { out: stale } });
    expect(failed["the committed sidecar bundle is current"]).toMatch(
      /is stale: run npx mcp-fakes bundle/,
    );
    expect((await failing({ ...base, bundle: false })).names).not.toContain(
      "the committed sidecar bundle is current",
    );
  });
});
