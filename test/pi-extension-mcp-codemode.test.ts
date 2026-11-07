import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { mcpToolName } from "../src/mcp/pi-client.js";
import { writeFixtureRecipe } from "../src/test-utils.js";
import { startHelloMcp } from "./helpers/hello-mcp.js";
import {
  lastToolResult,
  mcpCallingToolsExtension,
  openPiCliSession,
} from "./helpers/mcp-session.js";

const ECHO = mcpToolName("hello-mcp", "echo");
// 60 characters: every tool name Pi gives this server is shortened with a hash.
const LONG_ID = `hello-mcp-${"x".repeat(50)}`;

describe("Pi extension MCP codemode", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function fixture(
    mode: string,
    server: string[],
    tools = ["read"],
    id = "hello-mcp",
  ) {
    const recipe = writeFixtureRecipe({
      tools,
      manifestPi: {
        ...(tools.includes("mail") ? { extensions: ["extensions/*.ts"] } : {}),
        mcp: {
          servers: [{ id, required: true, tools: { include: ["*"] } }],
        },
      },
      agentExtras: [
        "mcp:",
        `  mode: ${mode}`,
        "  servers:",
        `    ${id}:`,
        '      include: ["echo"]',
        ...server,
      ],
    });
    cleanups.push(recipe.cleanup);
    const hello = await startHelloMcp();
    cleanups.push(() => hello.close());
    return { ...recipe, hello };
  }

  it.each([
    { id: "hello-mcp", eager: false },
    { id: LONG_ID, eager: true },
  ])(
    "registers the Recipe's servers with Pi's MCP support and runs a script (server $id, eager $eager)",
    async ({ id, eager }) => {
      const echo = mcpToolName(id, "echo");
      const greeting = mcpToolName(id, "get_greeting");
      const { recipeDir, workspaceDir, hello } = await fixture(
        "codemode",
        eager ? ["      eager: [echo]"] : [],
        ["read"],
        id,
      );
      let output = "";
      const session = await openPiCliSession({
        recipeDir,
        workspaceDir,
        bindings: [{ id, url: hello.url }],
        cleanups,
        responses: [
          fauxAssistantMessage(
            [
              fauxToolCall("codemode", {
                code: [
                  `const a = await tools.${echo}({ message: "hello from the public MCP" });`,
                  `let hidden = "reachable";`,
                  `try { await tools.${greeting}({}); } catch { hidden = "unreachable"; }`,
                  `return { echoed: a.content[0].text, hidden };`,
                ].join("\n"),
              }),
            ],
            { stopReason: "toolUse" },
          ),
          (context) => {
            output = lastToolResult(context);
            return fauxAssistantMessage("done");
          },
        ],
      });

      expect(session.getActiveToolNames()).toContain("codemode");
      // Eager tools are activated, matched to their server by Pi's namespace.
      expect(session.getActiveToolNames().includes(echo)).toBe(eager);
      expect(
        session.getAllTools().find((tool) => tool.name === greeting)?.exposure,
      ).toBe("hidden");

      await session.prompt("go");

      expect(output).toContain('"echoed":"Echo: hello from the public MCP"');
      expect(output).toContain('"hidden":"unreachable"');
      expect(hello.calls).toEqual([
        { name: "echo", arguments: { message: "hello from the public MCP" } },
      ]);
    },
  );

  for (const mode of ["cli", "codemode"]) {
    it(`keeps a server behind its tool in mode ${mode}`, async () => {
      const { recipeDir, workspaceDir, hello } = await fixture(
        mode,
        ["      behind: [mail]"],
        ["read", "mail", "other"],
      );
      mkdirSync(join(recipeDir, "extensions"));
      writeFileSync(
        join(recipeDir, "extensions", "wrappers.ts"),
        mcpCallingToolsExtension(ECHO, ["mail", "other"]),
      );
      const results: string[] = [];
      let declared = "";
      const session = await openPiCliSession({
        recipeDir,
        workspaceDir,
        bindings: [{ id: "hello-mcp", url: hello.url }],
        cleanups,
        responses: [
          fauxAssistantMessage([fauxToolCall("mail", { message: "hi" })], {
            stopReason: "toolUse",
          }),
          (context) => {
            results.push(lastToolResult(context));
            return fauxAssistantMessage(
              [fauxToolCall("other", { message: "sneak" })],
              { stopReason: "toolUse" },
            );
          },
          (context) => {
            results.push(lastToolResult(context));
            declared = JSON.stringify(
              context.messages.filter((message) => message.role === "system"),
            );
            return fauxAssistantMessage("done");
          },
        ],
      });

      expect(
        session.getAllTools().find((tool) => tool.name === ECHO)?.exposure,
      ).toBe("deferred");

      await session.prompt("go");

      expect(results).toEqual([
        "Echo: hi",
        "refused: MCP server 'hello-mcp' is reachable only through the mail tool; call mail instead.",
      ]);
      expect(hello.calls).toEqual([
        { name: "echo", arguments: { message: "hi" } },
      ]);
      expect(declared).toContain("mail");
      expect(declared).not.toContain("hello_mcp");
    });
  }
});
