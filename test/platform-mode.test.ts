import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { validateRecipeAgentDefinitions } from "../src/recipe/agent.js";
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

function issuesRecipe(platform: string[]) {
  const fixture = writeFixtureRecipe({
    tools: ["read", "issues"],
    dependencies: { "@acme/issues": "1.0.0" },
    manifestPi: {
      issues: [
        { provider: "acme", package: "@acme/issues" },
        { provider: "introspection", enabled: false },
      ],
    },
    agentExtras: platform,
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

describe("platform block", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  const messages = (platform: string[], tools = ["read", "issues"]) => {
    const fixture = writeFixtureRecipe({ tools, agentExtras: platform });
    cleanups.push(fixture.cleanup);
    return validateRecipeAgentDefinitions(fixture.recipeDir)
      .filter(
        (finding) => finding.field === "platform" || finding.field === "file",
      )
      .map((finding) => finding.message);
  };

  it("takes a mode and, in codemode, eager selected first-party tools", () => {
    expect(messages([])).toEqual([]);
    expect(messages(["platform:", "  mode: tools"])).toEqual([]);
    expect(messages(["platform:", "  mode: codemode"])).toEqual([]);
    expect(
      messages(["platform:", "  mode: codemode", "  eager: [issues]"]),
    ).toEqual([]);
  });

  it("refuses cli, an unknown mode or key, and eager outside codemode or selection", () => {
    const one = (platform: string[]) => messages(platform)[0] ?? "";
    expect(one(["platform:", "  mode: cli"])).toContain(
      "platform.mode cli needs the tools command",
    );
    expect(one(["platform:", "  mode: direct"])).toContain(
      "platform.mode must be tools or codemode",
    );
    expect(one(["platform:", "  mode: tools", "  eager: [issues]"])).toContain(
      "platform.eager applies only with platform.mode codemode",
    );
    expect(one(["platform:", "  mode: codemode", "  eager: [mail]"])).toContain(
      "not selected first-party tools: mail",
    );
    expect(one(["platform:", "  mode: codemode", "  eager: [read]"])).toContain(
      "not selected first-party tools: read",
    );
    expect(one(["platform:", "  mode: codemode", "  expose: all"])).toContain(
      "unsupported key(s): expose",
    );
  });
});

describe("first-party tools by platform.mode", () => {
  const handles: RecipeSessionHandle[] = [];
  const cleanups: Array<() => void> = [];
  afterEach(async () => {
    for (const handle of handles.splice(0))
      await handle.dispose().catch(() => {});
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  async function run(platform: string[], responses: FauxResponseStep[]) {
    const fixture = issuesRecipe(platform);
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
    await run(
      [],
      [
        (context) => {
          tools = declared(context);
          return fauxAssistantMessage("done");
        },
      ],
    );
    expect(tools).toContain("issues");
    expect(tools).not.toContain("codemode");
  });

  it("keeps the tool to codemode scripts in codemode, which call it", async () => {
    let tools: string[] = [];
    let output = "";
    await run(
      ["platform:", "  mode: codemode"],
      [
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
      ],
    );
    expect(tools).toContain("codemode");
    expect(tools).not.toContain("issues");
    expect(output).toContain("acme:A-1");
  });

  it("declares an eager tool in codemode as well", async () => {
    let tools: string[] = [];
    await run(
      ["platform:", "  mode: codemode", "  eager: [issues]"],
      [
        (context) => {
          tools = declared(context);
          return fauxAssistantMessage("done");
        },
      ],
    );
    expect(tools).toEqual(expect.arrayContaining(["codemode", "issues"]));
  });
});
