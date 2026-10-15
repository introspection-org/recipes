import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type ServiceOptions, type Services, startServices } from "../src/index.js";
import { callTool, rpc, VALIDATION } from "./client.js";
import { fakes } from "./fixtures/fakes/mcp/index.js";
import { type World, world } from "./fixtures/fakes/scenarios/index.js";
import notesTools from "./fixtures/fakes/mcp/notes/tools.json" with { type: "json" };

const running: Services<World>[] = [];
afterEach(async () => {
  for (const services of running.splice(0)) await services.close();
});

async function start(options: Partial<ServiceOptions<World>> = {}) {
  const services = await startServices(fakes, { world, ...options });
  running.push(services);
  return services;
}

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fakes-"));

describe("the contract", () => {
  test("serves the allowed tools as captured, in captured order", async () => {
    const { url } = await start();
    const { tools } = (await rpc(url("notes"), "tools/list")).result;
    expect(tools).toEqual(notesTools.tools.filter((tool) => tool.name !== "search-everything"));
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
      "list-notes",
      "create-note",
      "get-note",
    ]);
  });

  test("answers initialize with the manifest's server", async () => {
    const { url } = await start();
    const init = await rpc(url("notes"), "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.result.serverInfo).toEqual({ name: "notes", version: "1.2.3" });
  });

  test("validates arguments against the captured schema before a handler runs", async () => {
    const { url, states } = await start();
    const invalid = async (id: string, name: string, args: unknown) => {
      const result = await callTool(url(id), name, args);
      expect(result.isError).toBe(true);
      expect(result.text.startsWith(VALIDATION(name))).toBe(true);
      return result.text.slice(VALIDATION(name).length);
    };
    expect(await invalid("notes", "create-note", {})).toBe(
      "data must have required property 'title'",
    );
    expect(await invalid("notes", "list-notes", { limit: 51, page: 2 })).toMatch(
      /must NOT have additional properties|data\/limit must be <= 50/,
    );
    // Formats are enforced, in each schema's own draft.
    expect(await invalid("notes", "create-note", { title: "x", owner: "nope" })).toBe(
      'data/owner must match format "uuid"',
    );
    expect(await invalid("mail", "send-email", { to: ["not-an-address"], subject: "Hi" })).toBe(
      'data/to/0 must match format "email"',
    );
    expect(states.notes.notes).toHaveLength(3);
    expect(states.mail.emails).toHaveLength(0);
  });

  test("fills the defaults a schema states on top-level arguments", async () => {
    const { url } = await start();
    const result = await callTool(url("notes"), "list-notes", {});
    expect(result.isError).toBe(false);
    expect(result.text.split("\n").slice(0, 3)).toEqual([
      "limit: 10",
      "order: asc",
      "note-1: Kickoff",
    ]);
    const given = await callTool(url("notes"), "list-notes", { limit: 1, order: "desc" });
    expect(given.text).toBe("limit: 1\norder: desc\nnote-3: Pricing follow-up");
  });

  test("ignores an argument the handler does not read", async () => {
    const { url } = await start();
    const plain = await callTool(url("notes"), "list-notes", {});
    const archived = await callTool(url("notes"), "list-notes", { include_archived: true });
    expect(archived).toEqual(plain);
  });

  test("refuses a behaviour-selecting value the handler does not implement, as a tool error", async () => {
    const { url } = await start();
    const contains = await callTool(url("notes"), "list-notes", {
      filter: { op: "contains", value: "Pricing" },
    });
    expect(contains.text).toMatch(/note-2: Pricing call\nnote-3: Pricing follow-up$/);
    const refused = await callTool(url("notes"), "list-notes", {
      filter: { op: "gt", value: "K" },
    });
    expect(refused).toEqual({
      text: "This fake does not implement the filter op gt.",
      isError: true,
      structuredContent: undefined,
    });
  });

  test("answers a tool outside the allow-list with a protocol error", async () => {
    const { url } = await start();
    const allowedElsewhere = await rpc(url("notes"), "tools/call", {
      name: "search-everything",
      arguments: {},
    });
    expect(allowedElsewhere.error).toEqual({
      code: -32602,
      message: "Tool search-everything not found",
    });
    // Each fake serves only its own tools.
    const ofAnotherFake = await rpc(url("notes"), "tools/call", {
      name: "send-email",
      arguments: {},
    });
    expect(ofAnotherFake.error.code).toBe(-32602);
  });

  test("returns structured content where the tool declares an output schema", async () => {
    const { url } = await start();
    const read = await callTool(url("notes"), "get-note", { id: "note-2" });
    expect(read).toEqual({
      text: '{"id":"note-2","title":"Pricing call"}',
      isError: false,
      structuredContent: { id: "note-2", title: "Pricing call" },
    });
  });

  test("refuses a result without the structured content its output schema requires", async () => {
    const { url } = await start({ scenario: "broken" });
    const read = await callTool(url("notes"), "get-note", { id: "note-1" });
    expect(read.isError).toBe(true);
    expect(read.text).toMatch(/structured content/i);
  });
});

describe("state", () => {
  test("each fake keeps its own state, served beside the state it started with", async () => {
    const { url, port, states, initial } = await start({ clock: "2026-09-28T10:00:00Z" });
    const base = `http://127.0.0.1:${port}`;
    const read = async (route: string) => {
      const response = await fetch(`${base}${route}`);
      return response.status === 200 ? response.json() : response.status;
    };
    await callTool(url("notes"), "create-note", { title: "Renewal" });
    await callTool(url("mail"), "send-email", { to: ["a@example.test"], subject: "Hi" });
    expect((await read("/notes/admin/state")).notes.map((note: { id: string }) => note.id)).toEqual(
      ["note-1", "note-2", "note-3", "note-4"],
    );
    expect((await read("/notes/admin/initial-state")).notes).toHaveLength(3);
    expect((await read("/mail/admin/state")).emails).toEqual([
      { to: ["a@example.test"], subject: "Hi" },
    ]);
    expect(await read("/mail/admin/initial-state")).toEqual({
      now: "2026-09-28T10:00:00.000Z",
      emails: [],
    });
    expect(states.notes.notes).toHaveLength(4);
    expect(initial.notes.notes).toHaveLength(3);
    expect(await read("/admin/state")).toBe(404);
    expect(await read("/nobody/admin/state")).toBe(404);
    expect(await read("/health")).toEqual({ ok: true });
  });

  test("writes every fake state to the state file after each MCP request", async () => {
    const stateFile = path.join(scratch(), "nested", "state.json");
    const { url } = await start({ stateFile });
    expect(fs.existsSync(stateFile)).toBe(false);
    await callTool(url("notes"), "create-note", { title: "Renewal" });
    const written = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(Object.keys(written).sort()).toEqual(["mail", "notes"]);
    expect(written.notes.notes).toHaveLength(4);
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
  });

  test("starts from the world it is given, never from an earlier state file", async () => {
    const stateFile = path.join(scratch(), "state.json");
    fs.writeFileSync(stateFile, JSON.stringify({ notes: { now: "", notes: [], brokenId: null } }));
    const { states } = await start({ stateFile });
    expect(states.notes.notes).toHaveLength(3);
  });
});

describe("record", () => {
  test("appends each call as one JSON line, in the shape observe --examples writes", async () => {
    const record = path.join(scratch(), "calls.jsonl");
    const { url } = await start({ record });
    await callTool(url("notes"), "list-notes", { limit: 1 });
    await callTool(url("notes"), "list-notes", { filter: { op: "gt", value: "K" } });
    await callTool(url("notes"), "create-note", {});
    await rpc(url("notes"), "tools/call", { name: "search-everything", arguments: { query: "x" } });
    await rpc(url("notes"), "tools/list");
    await callTool(url("mail"), "send-email", { to: ["a@example.test"], subject: "Hi" });
    const lines = fs
      .readFileSync(record, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      {
        server: "notes",
        tool: "list-notes",
        args: { limit: 1 },
        result: { content: [{ type: "text", text: "limit: 1\norder: asc\nnote-1: Kickoff" }] },
      },
      {
        server: "notes",
        tool: "list-notes",
        args: { filter: { op: "gt", value: "K" } },
        result: {
          content: [{ type: "text", text: "This fake does not implement the filter op gt." }],
          isError: true,
        },
      },
      {
        server: "notes",
        tool: "create-note",
        args: {},
        result: {
          content: [
            {
              type: "text",
              text: `${VALIDATION("create-note")}data must have required property 'title'`,
            },
          ],
          isError: true,
        },
      },
      {
        server: "notes",
        tool: "search-everything",
        args: { query: "x" },
        result: { error: { code: -32602, message: "Tool search-everything not found" } },
      },
      {
        server: "mail",
        tool: "send-email",
        args: { to: ["a@example.test"], subject: "Hi" },
        result: { content: [{ type: "text", text: "Sent email-1" }] },
      },
    ]);
  });

  test("keeps no record unless asked", async () => {
    const dir = scratch();
    const { url } = await start();
    await callTool(url("notes"), "list-notes", {});
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
