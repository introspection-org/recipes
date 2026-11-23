import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

it("binds Pi file tools and preloads each private index in fresh Recipe sessions", async () => {
  const fixture = writeFixtureRecipe({
    tools: ["read", "write", "edit"],
    manifestPi: { extensions: ["hook.mjs"] },
  });
  writeFileSync(
    join(fixture.recipeDir, "hook.mjs"),
    `export default pi => {
    pi.on("before_agent_start", event => ({systemPrompt: event.systemPrompt + " Authored hook ran"}));
  };`,
  );
  cleanups.push(fixture.cleanup);
  const first = join(fixture.workspaceDir, "one");
  const second = join(fixture.workspaceDir, "two");
  mkdirSync(first);
  mkdirSync(second);
  const index = "/workspace/memories/MEMORY.md";
  function call(name: string, args: Parameters<typeof fauxToolCall>[1]) {
    return fauxAssistantMessage([fauxToolCall(name, args)], {
      stopReason: "toolUse",
    });
  }
  async function run(
    directory: string | undefined,
    steps: FauxResponseStep[],
    flag?: string,
  ) {
    let prompt = "";
    let result = "";
    const session = await openPiCliSession({
      ...fixture,
      bindings: [],
      cleanups,
      flagValues: flag ? { "recipe-memory-dir": flag } : {},
      env: { INTROSPECTION_MEMORY_DIR: directory },
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
    expect(prompt).toContain("Authored hook ran");
    return { prompt, result };
  }
  for (const [dir, value] of [
    [first, "alpha"],
    [second, "beta"],
  ] as const) {
    const { prompt, result } = await run(dir, [
      call("write", { path: index, content: value }),
      call("edit", {
        path: index,
        edits: [{ oldText: value, newText: value + " <saved>" }],
      }),
      call("read", { path: index }),
    ]);
    expect(result).toBe(value + " <saved>");
    expect(prompt).not.toContain("<memories>");
  }
  for (const [dir, value, other] of [
    [first, "alpha", "beta"],
    [second, "beta", "alpha"],
  ] as const) {
    const { prompt } = await run(dir, []);
    expect(prompt).toContain(value + " &lt;saved&gt;");
    expect(prompt).toContain(index);
    expect(prompt).not.toContain(other);
  }
  expect((await run(second, [], first)).prompt).toContain(
    "alpha &lt;saved&gt;",
  );
  const ordinary = "ordinary.md";
  const unbound = await run(undefined, [
    call("write", { path: ordinary, content: "ordinary" }),
  ]);
  expect(unbound.prompt).not.toContain("<memories>");
  expect((await run(first, [call("read", { path: ordinary })])).result).toBe(
    "ordinary",
  );

  const logical = "/workspace/memories/";
  symlinkSync(second, join(first, "linked"), "dir");
  symlinkSync(join(second, "missing"), join(first, "dangling"), "file");
  for (const [name, args] of [
    ["read", { path: logical + "linked/MEMORY.md" }],
    [
      "edit",
      {
        path: logical + "linked/MEMORY.md",
        edits: [{ oldText: "beta", newText: "changed" }],
      },
    ],
    ["write", { path: logical + "dangling", content: "changed" }],
    ["write", { path: logical + "../two/MEMORY.md", content: "changed" }],
  ] satisfies Array<[string, Parameters<typeof fauxToolCall>[1]]>) {
    const { result } = await run(first, [call(name, args)]);
    expect(result).toMatch(/Invalid memory path|symbolic links|Cannot access/);
  }
  expect(existsSync(join(second, "missing"))).toBe(false);
  expect(readFileSync(join(second, "MEMORY.md"), "utf8")).toBe("beta <saved>");
});
