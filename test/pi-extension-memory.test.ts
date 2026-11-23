import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { writeFixtureRecipe } from "../src/test-utils.js";
import {
  lastToolResult,
  modelView,
  openPiCliSession,
} from "./helpers/mcp-session.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("loads the workspace's memories/MEMORY.md in each fresh Recipe session", async () => {
  const fixture = writeFixtureRecipe({ tools: ["read", "write", "edit"] });
  cleanups.push(fixture.cleanup);
  function call(name: string, args: Parameters<typeof fauxToolCall>[1]) {
    return fauxAssistantMessage([fauxToolCall(name, args)], {
      stopReason: "toolUse",
    });
  }
  async function run(workspaceDir: string, steps: FauxResponseStep[]) {
    let prompt = "";
    let result = "";
    const session = await openPiCliSession({
      ...fixture,
      workspaceDir,
      bindings: [],
      cleanups,
      responses: [
        ...steps,
        (context) => {
          prompt = modelView(context).prompt;
          result = lastToolResult(context);
          return fauxAssistantMessage("done");
        },
      ],
    });
    await session.prompt("Run the fixture");
    expect(prompt).toContain("You are a conformance fixture.");
    return { prompt, result };
  }

  const empty = await run(fixture.workspaceDir, []);
  expect(empty.prompt).not.toContain("<memories>");

  await run(fixture.workspaceDir, [
    call("write", { path: "memories/MEMORY.md", content: "alpha <kept>" }),
    call("write", { path: "memories/notes.md", content: "only by tools" }),
  ]);
  const next = await run(fixture.workspaceDir, [
    call("read", { path: "memories/notes.md" }),
  ]);
  expect(next.prompt).toContain("alpha &lt;kept&gt;");
  expect(next.prompt).not.toContain("only by tools");
  expect(next.result).toBe("only by tools");

  const other = join(fixture.workspaceDir, "other");
  mkdirSync(join(other, "memories"), { recursive: true });
  writeFileSync(join(other, "memories", "MEMORY.md"), "beta");
  const separate = await run(other, []);
  expect(separate.prompt).toContain("beta");
  expect(separate.prompt).not.toContain("alpha");
});
