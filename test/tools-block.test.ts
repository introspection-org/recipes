import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadValidatedRecipeAgentDefinitions,
  selectedAgentTools,
  validateRecipeAgentDefinitions,
} from "../src/recipe/agent.js";
import { type RecipeSessionHandle } from "../src/session.js";
import { writeFixtureRecipe } from "../src/test-utils.js";
import { lastToolResult, openRecipeSession } from "./helpers/mcp-session.js";

type Context = Parameters<
  Extract<FauxResponseStep, (...args: never[]) => unknown>
>[0];

/** The tools declared to the model on this turn. */
function declared(context: Context): string[] {
  return (
    context.messages as unknown as Array<{
      role: string;
      toolsAdded?: Array<{ name: string }>;
    }>
  )
    .filter((message) => message.role === "system")
    .flatMap((message) => message.toolsAdded ?? [])
    .map((tool) => tool.name);
}

const FAKE_ISSUES = `export default { kind: "issues", apiVersion: 1, id: "acme",
  capabilities: { commands: { search: {} }, fields: [], hosts: ["acme.test"] },
  createSession: () => ({
    search: async () => ({ issues: [{ ref: "A-1", title: "Found it", status: { name: "Todo", category: "open" } }] }),
  }) };\n`;

function issuesRecipe(toolsBlock: string[]) {
  const fixture = writeFixtureRecipe({
    toolsBlock,
    dependencies: { "@acme/issues": "1.0.0" },
    manifestPi: {
      issues: [
        { provider: "acme", package: "@acme/issues" },
        { provider: "introspection", enabled: false },
      ],
    },
  });
  const write = (path: string, body: string) => {
    const full = join(fixture.recipeDir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };
  write(
    "node_modules/@acme/issues/package.json",
    JSON.stringify({
      name: "@acme/issues",
      version: "1.0.0",
      type: "module",
      main: "index.js",
    }),
  );
  write("node_modules/@acme/issues/index.js", FAKE_ISSUES);
  return fixture;
}

const block = (...lines: string[]) => [
  "tools:",
  "  include: [read, issues]",
  ...lines.map((line) => `  ${line}`),
];

describe("tools block", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  const messages = (toolsBlock: string[]) => {
    const fixture = writeFixtureRecipe({ toolsBlock });
    cleanups.push(fixture.cleanup);
    return validateRecipeAgentDefinitions(fixture.recipeDir)
      .filter(
        (finding) => finding.field === "tools" || finding.field === "file",
      )
      .map((finding) => finding.message);
  };
  const one = (toolsBlock: string[]) => messages(toolsBlock)[0] ?? "";

  it("takes the list, or a mapping with the selectors an MCP server takes", () => {
    expect(messages(["tools: [read, issues]"])).toEqual([]);
    expect(messages(block())).toEqual([]);
    expect(messages(block("mode: tools", "defer: [issues]"))).toEqual([]);
    expect(messages(block("mode: tools", 'defer: ["*"]'))).toEqual([]);
    expect(messages(block("mode: codemode", "eager: [issues]"))).toEqual([]);
    expect(messages(block("exclude: [read]"))).toEqual([]);
    expect(
      messages(["tools:", '  include: ["*"]', "  exclude: [bash]"]),
    ).toEqual([]);
  });

  it("refuses what an MCP server refuses, and cli until the tools command", () => {
    expect(one(block("mode: cli"))).toContain(
      "tools.mode cli needs the tools command",
    );
    expect(one(block("mode: direct"))).toContain(
      "tools.mode must be tools, codemode or cli",
    );
    expect(one(block("mode: codemode", "defer: [issues]"))).toContain(
      "defer is invalid in codemode",
    );
    expect(one(block("eager: [mail]"))).toContain(
      "include does not select: mail",
    );
    expect(one(block("defer: [read]"))).toContain(
      "apply only to first-party tools",
    );
    expect(one(block('exclude: ["*"]'))).toContain('not "*"');
    expect(one(block("defer: [issues, issues]"))).toContain("twice");
    expect(one(block("expose: all"))).toContain("unsupported key(s): expose");
  });

  it("a child's tools replaces its parent's whole block", () => {
    const fixture = writeFixtureRecipe({
      toolsBlock: block("mode: codemode"),
    });
    cleanups.push(fixture.cleanup);
    writeFileSync(
      join(fixture.recipeDir, "agents", "child.yaml"),
      ["name: child", "from: agent", "tools: [read]", ""].join("\n"),
    );
    const { definitions } = loadValidatedRecipeAgentDefinitions(
      fixture.recipeDir,
    );
    expect(definitions.get("agent")?.toolPolicy?.mode).toBe("codemode");
    expect(definitions.get("child")?.toolPolicy).toBeUndefined();
    expect(definitions.get("child")?.tools).toEqual(["read"]);
  });
});

describe('include: ["*"]', () => {
  it("is the built-ins and the first-party tools the Recipe declares, less exclude", () => {
    const none = selectedAgentTools(["*"], { exclude: ["bash"] }, {});
    expect(none.tools).toContain("read");
    expect(none.tools).not.toContain("bash");
    expect(none.tools).not.toContain("issues");
    const declared = selectedAgentTools(["*", "my_tool"], undefined, {
      issues: [{ provider: "linear" }],
      productivity: [{ provider: "google", tools: { mail: [] } }],
    });
    expect(declared.tools).toEqual(
      expect.arrayContaining(["my_tool", "issues", "mail"]),
    );
    expect(declared.tools).not.toContain("calendar");
    expect(declared.wildcard).not.toContain("my_tool");
  });
});

describe("first-party tools by tools.mode", () => {
  const handles: RecipeSessionHandle[] = [];
  const cleanups: Array<() => void> = [];
  afterEach(async () => {
    for (const handle of handles.splice(0))
      await handle.dispose().catch(() => {});
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  async function run(toolsBlock: string[], responses: FauxResponseStep[]) {
    const fixture = issuesRecipe(toolsBlock);
    cleanups.push(fixture.cleanup);
    const handle = await openRecipeSession({
      ...fixture,
      responses,
      bindings: [],
    });
    handles.push(handle);
    await handle.session.prompt("go");
  }

  it("declares the tool in tools mode, with no codemode", async () => {
    let tools: string[] = [];
    await run(block(), [
      (context) => {
        tools = declared(context);
        return fauxAssistantMessage("done");
      },
    ]);
    expect(tools).toContain("issues");
    expect(tools).not.toContain("codemode");
  });

  it("keeps the tool to codemode scripts in codemode, which call it", async () => {
    let tools: string[] = [];
    let output = "";
    await run(block("mode: codemode"), [
      (context) => {
        tools = declared(context);
        return fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: 'return await tools.issues({ command: "search", query: "found" });',
            }),
          ],
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        output = lastToolResult(context);
        return fauxAssistantMessage("done");
      },
    ]);
    expect(tools).toContain("codemode");
    expect(tools).not.toContain("issues");
    expect(output).toContain("acme:A-1");
  });

  it("declares an eager tool in codemode as well", async () => {
    let tools: string[] = [];
    await run(block("mode: codemode", "eager: [issues]"), [
      (context) => {
        tools = declared(context);
        return fauxAssistantMessage("done");
      },
    ]);
    expect(tools).toEqual(expect.arrayContaining(["codemode", "issues"]));
  });

  it("defers a tool to tool search in tools mode", async () => {
    let tools: string[] = [];
    await run(block("defer: [issues]"), [
      (context) => {
        tools = declared(context);
        return fauxAssistantMessage("done");
      },
    ]);
    expect(tools).not.toContain("issues");
    expect(tools).toContain("tool_search");
  });
});
