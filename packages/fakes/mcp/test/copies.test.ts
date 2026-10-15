import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Fake, type McpServer, startServices, text } from "../src/index.js";
import { callTool } from "./client.js";
import { world } from "./fixtures/fakes/scenarios/index.js";
import type { Contract } from "./fixtures/fakes/mcp/notes/contract.js";
import manifest from "./fixtures/fakes/mcp/notes/manifest.json" with { type: "json" };
import tools from "./fixtures/fakes/mcp/notes/tools.json" with { type: "json" };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let copy: string;

// A second, separately loaded copy of the package as built by the global setup, as a linked install gives an eval
// and its fakes. It sits under the package root so it resolves the same SDK.
beforeAll(() => {
  copy = fs.mkdtempSync(path.join(ROOT, ".copy-"));
  fs.cpSync(path.join(ROOT, "dist"), path.join(copy, "dist"), { recursive: true });
  fs.writeFileSync(path.join(copy, "package.json"), JSON.stringify({ type: "module" }));
});

afterAll(() => {
  if (copy) fs.rmSync(copy, { recursive: true, force: true });
});

test("the start-up check accepts configs built by another loaded copy of the package", async () => {
  const other = (await import(
    pathToFileURL(path.join(copy, "dist", "index.js")).href
  )) as typeof import("../src/index.js");
  expect(other.toolConfig).not.toBe((await import("../src/index.js")).toolConfig);
  const config = other.toolConfig<Contract>(tools);
  const fake: Fake = {
    manifest,
    register: (server: McpServer) => {
      server.registerTool("list-notes", config("list-notes"), async () => text("listed"));
      server.registerTool("create-note", config("create-note"), async () => text("created"));
      server.registerTool("get-note", config("get-note"), async ({ id }) =>
        other.structured({ id, title: "Kickoff" }),
      );
    },
  };
  const services = await startServices({ notes: fake }, { world: (scenario) => world(scenario) });
  try {
    expect(await callTool(services.url("notes"), "list-notes", {})).toMatchObject({
      text: "listed",
      isError: false,
    });
  } finally {
    await services.close();
  }
});
