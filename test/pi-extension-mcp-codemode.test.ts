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
const GREETING = mcpToolName("hello-mcp", "get_greeting");

describe("Pi extension MCP codemode", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function fixture(mode: string, server: string[], tools = ["read"]) {
    const recipe = writeFixtureRecipe({
      tools,
      manifestPi: {
        ...(tools.includes("mail") ? { extensions: ["extensions/*.ts"] } : {}),
        mcp: {
          servers: [
            { id: "hello-mcp", required: true, tools: { include: ["*"] } },
          ],
        },
      },
      agentExtras: [
        "mcp:",
        `  mode: ${mode}`,
        "  servers:",
        "    hello-mcp:",
        '      include: ["echo"]',
        ...server,
      ],
    });
    cleanups.push(recipe.cleanup);
    const hello = await startHelloMcp();
    cleanups.push(() => hello.close());
    return { ...recipe, hello };
  }

  it("registers the Recipe's servers with Pi's MCP support and runs a script", async () => {
    const { recipeDir, workspaceDir, hello } = await fixture("codemode", []);
    let output = "";
    const session = await openPiCliSession({
      recipeDir,
      workspaceDir,
      bindings: [{ id: "hello-mcp", url: hello.url }],
      cleanups,
      responses: [
        fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: [
                `const a = await tools.${ECHO}({ message: "hello from the public MCP" });`,
                `let hidden = "reachable";`,
                `try { await tools.${GREETING}({}); } catch { hidden = "unreachable"; }`,
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
    expect(session.getActiveToolNames()).not.toContain(ECHO);
    expect(
      session.getAllTools().find((tool) => tool.name === GREETING)?.exposure,
    ).toBe("hidden");

    await session.prompt("go");

    expect(output).toContain('"echoed":"Echo: hello from the public MCP"');
    expect(output).toContain('"hidden":"unreachable"');
    expect(hello.calls).toEqual([
      { name: "echo", arguments: { message: "hello from the public MCP" } },
    ]);
  });

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
