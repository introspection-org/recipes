import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { mcpToolName } from "../src/mcp/pi-client.js";
import { type RecipeSessionHandle } from "../src/session.js";
import { writeFixtureRecipe } from "../src/test-utils.js";
import { startHelloMcp, type HelloMcp } from "./helpers/hello-mcp.js";
import { lastToolResult, openRecipeSession } from "./helpers/mcp-session.js";

const TAVILY = mcpToolName("tavily", "tavily_search");
const REFUSED =
  "MCP server 'tavily' is reachable only through the web_search tool; call web_search instead.";
const SEARCH_MODULE = join(
  import.meta.dirname,
  "..",
  "src",
  "search",
  "index.ts",
);

/** tavily-mcp's `tavily_search`, answering in its older text format, which the adapter still reads. */
function fakeTavilyMcp(): Promise<HelloMcp> {
  return startHelloMcp({
    tools: [
      {
        name: "tavily_search",
        description: "Search the web with Tavily.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        answer: (args) =>
          [
            "Detailed Results:",
            "",
            `Title: About ${String(args.query)}`,
            "URL: https://example.org/a",
            "Content: A page.",
          ].join("\n"),
      },
    ],
  });
}

describe("web_search with its MCP server behind it", () => {
  const handles: RecipeSessionHandle[] = [];
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const handle of handles.splice(0))
      await handle.dispose().catch(() => {});
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function open(
    mode: "cli" | "tools" | "codemode",
    responses: FauxResponseStep[],
  ) {
    const server = await fakeTavilyMcp();
    cleanups.push(() => server.close());
    const fixture = writeFixtureRecipe({
      tools: ["read", "web_search"],
      manifestPi: {
        extensions: ["extensions/*.ts"],
        mcp: {
          servers: [
            { id: "tavily", required: true, tools: { include: ["*"] } },
          ],
        },
      },
      agentExtras: [
        "mcp:",
        `  mode: ${mode}`,
        "  servers:",
        "    tavily:",
        '      include: ["tavily_search"]',
        "      behind: [web_search]",
      ],
    });
    cleanups.push(fixture.cleanup);
    mkdirSync(join(fixture.recipeDir, "extensions"));
    writeFileSync(
      join(fixture.recipeDir, "extensions", "search.ts"),
      [
        `import { registerWebSearchTool } from ${JSON.stringify(SEARCH_MODULE)};`,
        "export default (pi) => {",
        '  registerWebSearchTool(pi, { bound: [], mcpServers: { tavily: "tavily" } });',
        "};",
        "",
      ].join("\n"),
    );
    const handle = await openRecipeSession({
      ...fixture,
      responses,
      bindings: [{ id: "tavily", url: server.url }],
    });
    handles.push(handle);
    return { handle, server };
  }

  for (const mode of ["cli", "tools", "codemode"] as const) {
    it(`serves web_search over the server and refuses the model's own call in mode ${mode}`, async () => {
      const results: string[] = [];
      const { handle, server } = await open(mode, [
        fauxAssistantMessage([fauxToolCall("web_search", { query: "pi" })], {
          stopReason: "toolUse",
        }),
        (step) => {
          results.push(lastToolResult(step));
          return fauxAssistantMessage(
            [fauxToolCall(TAVILY, { query: "direct" })],
            { stopReason: "toolUse" },
          );
        },
        (step) => {
          results.push(lastToolResult(step));
          return fauxAssistantMessage("done");
        },
      ]);

      expect(
        handle.session.getAllTools().find((tool) => tool.name === TAVILY)
          ?.exposure,
      ).toBe("deferred");

      await handle.session.prompt("go");

      expect(results[0]).toBe(
        ["[1] About pi — example.org", "https://example.org/a", "A page."].join(
          "\n",
        ),
      );
      expect(results[1]).toMatch(/not found|not available|unknown/i);
      expect(server.calls).toEqual([
        {
          name: "tavily_search",
          arguments: {
            query: "pi",
            search_depth: "basic",
            max_results: 5,
            include_published_date: true,
          },
        },
      ]);
    });
  }

  it("refuses a codemode script's call to the server and serves it through web_search", async () => {
    let output = "";
    const { handle, server } = await open("codemode", [
      fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: [
              `let direct;`,
              `try { await tools.${TAVILY}({ query: "direct" }); direct = "reached"; }`,
              `catch (error) { direct = String(error.message ?? error); }`,
              `const wrapped = await tools.web_search({ query: "wrapped" });`,
              `return { direct, wrapped };`,
            ].join("\n"),
          }),
        ],
        { stopReason: "toolUse" },
      ),
      (step) => {
        output = lastToolResult(step);
        return fauxAssistantMessage("done");
      },
    ]);

    await handle.session.prompt("go");

    expect(output).toContain(REFUSED);
    expect(output).toContain("About wrapped");
    expect(server.calls.map((call) => call.arguments.query)).toEqual([
      "wrapped",
    ]);
  });
});
