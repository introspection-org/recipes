import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Services, startServices } from "../src/index.js";
import {
  changedEntities,
  loadManifests,
  piToolNames,
  type WriteMap,
  writeAttempts,
} from "../src/verify.js";
import { callTool } from "./client.js";
import { fakes } from "./fixtures/fakes/mcp/index.js";
import { type World, world } from "./fixtures/fakes/scenarios/index.js";

// The cases introspection-harbor's tests/test_fakes.py runs too, so both runners score alike.
const SHARED = path.join(import.meta.dirname, "../../testdata/fakes");
const cases = JSON.parse(fs.readFileSync(path.join(SHARED, "cases.json"), "utf8")) as {
  stateChanges: {
    name: string;
    fakes?: string[];
    manifests?: Record<string, WriteMap>;
    initial: Record<string, object>;
    final: Record<string, object>;
    changed?: string[];
    error?: string;
  }[];
  writeAttempts: {
    name: string;
    fakes?: string[];
    manifests?: Record<string, WriteMap>;
    calls: { name: string; is_error: boolean }[];
    attempts?: [string, string][];
    error?: string;
  }[];
  loadManifests: { name: string; directory: string; fakes?: string[]; error?: string }[];
  piToolNames: [string, string, string][];
};
const sharedManifests = loadManifests(path.join(SHARED, "mcp"));
const scoped = (fakes?: string[], manifests = sharedManifests) =>
  Object.fromEntries(
    Object.entries(manifests).filter(([fake]) => !fakes || fakes.includes(fake)),
  );

describe("the shared cases", () => {
  it.each(cases.loadManifests)("loadManifests: $name", ({ directory, fakes, error }) => {
    const load = () => loadManifests(path.join(SHARED, directory));
    if (error) expect(load).toThrow(error);
    else expect(Object.keys(load())).toEqual(fakes);
  });

  it.each(cases.stateChanges)(
    "changedEntities: $name",
    ({ fakes, manifests, initial, final, changed, error }) => {
      const check = () => changedEntities({ initial, final }, scoped(fakes, manifests));
      if (error) expect(check).toThrow(error);
      else expect(check()).toEqual(changed);
    },
  );

  it.each(cases.writeAttempts)(
    "writeAttempts: $name",
    ({ fakes, manifests, calls, attempts, error }) => {
      if (error) {
        expect(() => writeAttempts(calls, scoped(fakes, manifests))).toThrow(error);
        return;
      }
      const found = writeAttempts(calls, scoped(fakes, manifests));
      expect(found.map((attempt) => [attempt.server, attempt.tool])).toEqual(attempts);
      // An attempt keeps the call it was.
      for (const attempt of found) expect(attempt).toHaveProperty("is_error");
    },
  );

  it.each(cases.piToolNames)("piToolNames: %s.%s", (server, tool, name) => {
    expect(piToolNames(server, tool)).toContain(name);
  });

  it("says which fake a state is missing for", () => {
    expect(() => changedEntities({ initial: {}, final: {} }, sharedManifests)).toThrow(
      "no state for the fake crm",
    );
  });
});

describe("the checks on running fakes", () => {
  const manifests = loadManifests(path.join(import.meta.dirname, "fixtures/fakes/mcp"));
  const running: Services<World>[] = [];
  afterEach(async () => {
    for (const services of running.splice(0)) await services.close();
  });
  const start = async () => {
    const services = await startServices(fakes, { world });
    running.push(services);
    return services;
  };
  const [createNote] = piToolNames("notes", "create-note");

  it("score a write as a change and an attempt", async () => {
    const services = await start();
    await callTool(services.url("notes"), "create-note", { title: "Renewal" });

    const states = { initial: services.initial, final: structuredClone(services.states) };
    expect(changedEntities(states, manifests)).toEqual(["notes.notes"]);
    const calls = [{ name: "mcp_notes_list-notes" }, { name: createNote }];
    expect(writeAttempts(calls, manifests)).toEqual([
      { name: createNote, server: "notes", tool: "create-note" },
    ]);
  });

  it("score a read as neither", async () => {
    const services = await start();
    await callTool(services.url("notes"), "list-notes", {});

    expect(changedEntities({ initial: services.initial, final: services.states }, manifests)).toEqual(
      [],
    );
    expect(writeAttempts([{ name: piToolNames("notes", "list-notes")[0] }], manifests)).toEqual([]);
  });
});

describe("the verify entry point", () => {
  it("imports only Node built-ins, so a judge needs neither the MCP SDK nor a test runner", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "../src/verify.ts"), "utf8");
    const imported = [...source.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+"([^"]+)"/gm)].map(
      (match) => match[1],
    );
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.filter((specifier) => !specifier.startsWith("node:"))).toEqual([]);
  });
});
