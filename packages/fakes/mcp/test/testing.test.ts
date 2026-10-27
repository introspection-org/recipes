import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { call, callTool, recording, withFakes } from "../src/testing.js";
import { fakes } from "./fixtures/fakes/mcp/index.js";
import { world } from "./fixtures/fakes/scenarios/index.js";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fakes-testing-"));

describe("withFakes", () => {
  test("connects a client to every fake and hands the test their states", async () => {
    const created = await withFakes(fakes, world, "quiet", async ({ notes, mail, states }) => {
      expect(await call(notes, "create-note", { title: "Renewal" })).toBe("Created note-4");
      expect(await callTool(mail, "send-email", { to: ["a@b.test"], subject: "Hi" })).toEqual({
        text: "Sent email-1",
        isError: false,
      });
      return states.notes.notes.length;
    });
    expect(created).toBe(4);
  });

  test("gives a tool error as a result, and throws it from call", async () => {
    await withFakes(fakes, world, undefined, async ({ notes }) => {
      expect(await callTool(notes, "get-note", { id: "note-9" })).toEqual({
        text: "Note note-9 not found.",
        isError: true,
      });
      await expect(call(notes, "get-note", { id: "note-9" })).rejects.toThrow(
        "Note note-9 not found.",
      );
    });
  });

  test("reads an outputSchema tool's answer from its structuredContent", async () => {
    await withFakes(fakes, world, undefined, async ({ notes }) => {
      expect(await callTool(notes, "get-note", { id: "note-1" })).toEqual({
        text: '{"id":"note-1","title":"Kickoff"}',
        isError: false,
        structured: { id: "note-1", title: "Kickoff" },
      });
    });
  });

  test("throws for a successful answer outside the fake's contract", async () => {
    // A contract that says list-notes answers in JSON, which the fake does not.
    const { contract } = fakes.notes;
    const json = { ...contract["list-notes"], answer: { format: "json" } };
    const notes = { ...fakes.notes, contract: { ...contract, "list-notes": json } };
    await withFakes({ ...fakes, notes }, world, undefined, async (clients) => {
      await expect(callTool(clients.notes, "list-notes", {})).rejects.toThrow(
        /^list-notes answered outside its contract: not json: /,
      );
    });
  });
});

describe("recording", () => {
  test("is emptied before the run and sorted after", async () => {
    const file = path.join(scratch(), "responses.jsonl");
    fs.writeFileSync(file, "stale\n");
    const { globalSetup, globalTeardown } = recording(file);
    globalSetup();
    expect(fs.existsSync(file)).toBe(false);
    const record = { clock: "2026-10-01T09:00:00.000Z", record: file };
    await withFakes(
      fakes,
      world,
      undefined,
      async ({ notes }) => {
        await call(notes, "list-notes", {});
        await call(notes, "create-note", { title: "Renewal" });
      },
      record,
    );
    globalTeardown();
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line).tool)).toEqual(["create-note", "list-notes"]);
    expect(lines).toEqual([...lines].sort());
  });

  test("leaves no file behind when nothing was recorded", () => {
    const file = path.join(scratch(), "responses.jsonl");
    recording(file).globalTeardown();
    expect(fs.existsSync(file)).toBe(false);
  });
});
