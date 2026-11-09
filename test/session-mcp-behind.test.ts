import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { afterEach, describe, expect, it } from "vitest";

import { mcpToolName } from "../src/mcp/pi-client.js";
import { type RecipeSessionHandle } from "../src/session.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";
import { startHelloMcp, type HelloMcp } from "./helpers/hello-mcp.js";
import {
  lastToolResult,
  mcpCallingToolsExtension,
  openRecipeSession,
} from "./helpers/mcp-session.js";

const ECHO = mcpToolName("hello-mcp", "echo");
const refused = (id: string) =>
  `MCP server '${id}' is reachable only through the mail tool; call mail instead.`;
const REFUSED = refused("hello-mcp");
// 60 characters: every tool name Pi gives this server is shortened with a hash.
const LONG_ID = `hello-mcp-${"x".repeat(50)}`;

type Mode = "cli" | "tools" | "codemode";

describe("MCP servers behind a tool", () => {
  const handles: RecipeSessionHandle[] = [];
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const handle of handles.splice(0))
      await handle.dispose().catch(() => {});
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function hello(options?: Parameters<typeof startHelloMcp>[0]) {
    const server = await startHelloMcp(options);
    cleanups.push(() => server.close());
    return server;
  }

  async function open(options: {
    mode: Mode;
    server: HelloMcp;
    /** The id of the server behind `mail`. */
    id?: string;
    plain?: HelloMcp;
    plainId?: string;
    plainSelection?: string[];
    required?: boolean;
    env?: NodeJS.ProcessEnv;
    responses?: FauxResponseStep[];
    toolsMode?: Mode;
  }) {
    const id = options.id ?? "hello-mcp";
    const plainId = options.plainId ?? "plain";
    const fixture = writeFixtureRecipe({
      tools: ["read", "bash", "mail", "other"],
      ...(options.toolsMode
        ? {
            toolsBlock: [
              "tools:",
              `  mode: ${options.toolsMode}`,
              "  include: [read, bash, mail, other]",
            ],
          }
        : {}),
      manifestPi: {
        extensions: ["extensions/*.ts"],
        mcp: {
          servers: [
            {
              id,
              required: options.required ?? true,
              tools: { include: ["*"] },
            },
            ...(options.plain
              ? [{ id: plainId, tools: { include: ["*"] } }]
              : []),
          ],
        },
      },
      agentExtras: [
        "mcp:",
        `  mode: ${options.mode}`,
        "  servers:",
        `    ${id}:`,
        '      include: ["echo"]',
        "      behind: [mail]",
        ...(options.plain
          ? [
              `    ${plainId}:`,
              ...(options.plainSelection ?? ['      include: ["*"]']),
            ]
          : []),
      ],
    });
    cleanups.push(fixture.cleanup);
    mkdirSync(join(fixture.recipeDir, "extensions"));
    // `mail` fronts the hello server; `other` is any other tool trying to reach it.
    writeFileSync(
      join(fixture.recipeDir, "extensions", "wrappers.ts"),
      mcpCallingToolsExtension(mcpToolName(id, "echo"), ["mail", "other"]),
    );
    const env = options.env ?? cleanEnv();
    const handle = await openRecipeSession({
      ...fixture,
      env,
      ...(options.responses ? { responses: options.responses } : {}),
      bindings: [
        { id, url: options.server.url },
        ...(options.plain ? [{ id: plainId, url: options.plain.url }] : []),
      ],
    });
    handles.push(handle);
    return { handle, env };
  }

  for (const mode of ["cli", "tools"] as const) {
    it(`registers codemode for tools.mode codemode beside mcp.mode ${mode}`, async () => {
      const server = await hello();
      const { handle } = await open({ mode, toolsMode: "codemode", server });
      expect(handle.session.getAllTools().map((tool) => tool.name)).toContain(
        "codemode",
      );
    });
  }

  for (const mode of ["cli", "tools", "codemode"] as const) {
    it(`lets only the wrapper reach the server in mode ${mode}`, async () => {
      const server = await hello();
      const results: string[] = [];
      let context: TranscriptContext | undefined;
      const record = (step: TranscriptContext) => {
        results.push(lastToolResult(step));
        context = step;
      };
      const { handle } = await open({
        mode,
        server,
        responses: [
          fauxAssistantMessage([fauxToolCall("mail", { message: "hi" })], {
            stopReason: "toolUse",
          }),
          (step) => {
            record(step);
            return fauxAssistantMessage(
              [fauxToolCall("other", { message: "sneak" })],
              { stopReason: "toolUse" },
            );
          },
          (step) => {
            record(step);
            return fauxAssistantMessage(
              [fauxToolCall(ECHO, { message: "x" })],
              {
                stopReason: "toolUse",
              },
            );
          },
          (step) => {
            record(step);
            return fauxAssistantMessage("done");
          },
        ],
      });

      const echo = handle.session
        .getAllTools()
        .find((tool) => tool.name === ECHO);
      expect(echo?.exposure).toBe("deferred");
      expect(handle.session.getActiveToolNames()).not.toContain(ECHO);
      expect(handle.session.getActiveToolNames().includes("codemode")).toBe(
        mode === "codemode",
      );

      await handle.session.prompt("go");

      expect(results[0]).toBe("Echo: hi");
      expect(results[1]).toBe(`refused: ${REFUSED}`);
      // The model never sees the tool, so Pi refuses its call before any hook.
      expect(results[2]).toMatch(/not found|not available|unknown/i);
      expect(server.calls).toEqual([
        { name: "echo", arguments: { message: "hi" } },
      ]);
      // Everything the session declares; tool calls and results are the script's own.
      const declared = JSON.stringify({
        ...context!,
        messages: context!.messages.filter(
          (message) => message.role === "system" || message.role === "user",
        ),
      });
      expect(declared).toContain("mail");
      expect(declared).not.toContain("hello_mcp");
    });
  }

  it("refuses a codemode script and lets it go through the wrapper", async () => {
    const server = await hello();
    let output = "";
    const { handle } = await open({
      mode: "codemode",
      server,
      responses: [
        fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: [
                `let direct;`,
                `try { await tools.${ECHO}({ message: "direct" }); direct = "reached"; }`,
                `catch (error) { direct = String(error.message ?? error); }`,
                `const wrapped = await tools.mail({ message: "wrapped" });`,
                `return { direct, wrapped };`,
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

    await handle.session.prompt("go");

    expect(output).toContain("reachable only through the mail tool");
    expect(output).toContain('"wrapped":"Echo: wrapped"');
    expect(server.calls).toEqual([
      { name: "echo", arguments: { message: "wrapped" } },
    ]);
  });

  it("keeps a server with a long id behind its tool, off the prompt and tool_search", async () => {
    const server = await hello();
    const plain = await hello();
    const echo = mcpToolName(LONG_ID, "echo");
    const results: string[] = [];
    let declared = "";
    const { handle } = await open({
      mode: "tools",
      id: LONG_ID,
      server,
      plain,
      plainSelection: ['      include: ["*"]', '      defer: ["*"]'],
      responses: [
        fauxAssistantMessage([fauxToolCall("mail", { message: "hi" })], {
          stopReason: "toolUse",
        }),
        (step) => {
          results.push(lastToolResult(step));
          return fauxAssistantMessage(
            [fauxToolCall("other", { message: "sneak" })],
            { stopReason: "toolUse" },
          );
        },
        (step) => {
          results.push(lastToolResult(step));
          return fauxAssistantMessage(
            [fauxToolCall("tool_search", { query: "echo" })],
            { stopReason: "toolUse" },
          );
        },
        (step) => {
          results.push(lastToolResult(step));
          declared = JSON.stringify(
            step.messages.filter((message) => message.role === "system"),
          );
          return fauxAssistantMessage("done");
        },
      ],
    });

    expect(echo).toHaveLength(64);
    expect(
      handle.session.getAllTools().find((tool) => tool.name === echo)?.exposure,
    ).toBe("deferred");

    await handle.session.prompt("go");

    expect(results.slice(0, 2)).toEqual([
      "Echo: hi",
      `refused: ${refused(LONG_ID)}`,
    ]);
    // tool_search finds the plain server's echo, never the one behind mail.
    expect(results[2]).toContain("echo");
    expect(results[2]).not.toContain(echo);
    expect(handle.session.getActiveToolNames()).not.toContain(echo);
    expect(declared).not.toContain("hello_mcp_x");
    expect(server.calls).toEqual([
      { name: "echo", arguments: { message: "hi" } },
    ]);
  });

  it("tells servers a and a__b apart, keeping only a behind its tool", async () => {
    const server = await hello();
    const plain = await hello();
    let output = "";
    const { handle } = await open({
      mode: "codemode",
      id: "a",
      server,
      plain,
      plainId: "a__b",
      responses: [
        fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: [
                `const out = {};`,
                `for (const name of ${JSON.stringify([mcpToolName("a", "echo"), mcpToolName("a__b", "echo")])}) {`,
                `  try { out[name] = (await tools[name]({ message: "hi" })).content[0].text; }`,
                `  catch { out[name] = "refused"; }`,
                `}`,
                `return out;`,
              ].join("\n"),
            }),
          ],
          { stopReason: "toolUse" },
        ),
        (step) => {
          output = lastToolResult(step);
          return fauxAssistantMessage("done");
        },
      ],
    });

    await handle.session.prompt("go");

    expect(output).toContain('"mcp__a__echo":"refused"');
    expect(output).toContain('"mcp__a__b__echo":"Echo: hi"');
    expect(server.calls).toEqual([]);
    expect(plain.calls).toEqual([
      { name: "echo", arguments: { message: "hi" } },
    ]);
  });

  it("keeps the nested calls on the session record, out of the provider request", async () => {
    const server = await hello();
    let context: TranscriptContext | undefined;
    const { handle } = await open({
      mode: "cli",
      server,
      responses: [
        fauxAssistantMessage([fauxToolCall("mail", { message: "hi" })], {
          stopReason: "toolUse",
        }),
        (step) => {
          context = step;
          return fauxAssistantMessage("done");
        },
      ],
    });

    await handle.session.prompt("go");

    const result = context!.messages.find(
      (message) => message.role === "toolResult",
    );
    expect(result?.role === "toolResult" && result.nestedCalls?.calls).toEqual([
      expect.objectContaining({ name: ECHO }),
    ]);
    // What a real provider is sent for the same context.
    let payload: unknown;
    const controller = new AbortController();
    const response = stream(
      getModel("anthropic", "claude-sonnet-4-5"),
      context!,
      {
        apiKey: "test-key",
        signal: controller.signal,
        onPayload: (body) => {
          payload = body;
          controller.abort();
          return undefined;
        },
      },
    );
    // The aborted request ends the stream.
    await response.result();
    const sent = JSON.stringify(payload);
    expect(sent).toContain("Echo: hi");
    expect(sent).not.toContain(ECHO);
    expect(sent).not.toContain("nestedCalls");
  });

  it("keeps the server out of the mcp command beside a plain server", async () => {
    const server = await hello();
    const plain = await hello();
    const { env } = await open({ mode: "cli", server, plain });

    const session = readFileSync(env.PI_RECIPES_MCP_SESSION!, "utf8");
    expect(session).toContain('"plain"');
    expect(session).not.toContain("hello-mcp");
  });

  it("holds the wrapper's call until a slow server has connected", async () => {
    const server = await hello({ initializeDelayMs: 400 });
    let output = "";
    const { handle } = await open({
      mode: "tools",
      server,
      required: false,
      responses: [
        fauxAssistantMessage([fauxToolCall("mail", { message: "late" })], {
          stopReason: "toolUse",
        }),
        (context) => {
          output = lastToolResult(context);
          return fauxAssistantMessage("done");
        },
      ],
    });

    await handle.session.prompt("go");

    expect(output).toBe("Echo: late");
  });

  it("fails the session when a required server never connects", async () => {
    const server = await hello({ bearer: "nobody-has-this" });
    await expect(
      open({
        mode: "cli",
        server,
        env: { ...cleanEnv(), PI_RECIPES_MCP_CONNECT_TIMEOUT_MS: "300" },
      }),
    ).rejects.toThrow(
      /Required MCP server\(s\) did not connect within 300 ms: hello-mcp/,
    );
  });
});
