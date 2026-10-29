import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
  type FauxResponseStep,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertPiSupportsMcpCodemode,
  mcpToolName,
} from "../src/mcp/pi-client.js";
import { resolveRecipe } from "../src/recipe/resolve.js";
import { createAgentSession, type RecipeSessionHandle } from "../src/session.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";
import { startHelloMcp, type HelloMcp } from "./helpers/hello-mcp.js";

const ECHO = mcpToolName("hello-mcp", "echo");
const GREETING = mcpToolName("hello-mcp", "get_greeting");

const lastToolResult = (context: { messages: readonly unknown[] }): string => {
  const message = [...context.messages]
    .reverse()
    .find((entry) => (entry as { role?: string }).role === "toolResult") as
    | { content: Array<{ text?: string }> }
    | undefined;
  return message ? message.content.map((part) => part.text ?? "").join("\n") : "";
};

describe("Recipe session MCP codemode on Pi's client", () => {
  const handles: RecipeSessionHandle[] = [];
  const cleanups: Array<() => void | Promise<void>> = [];
  let faux: FauxProviderHandle;

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.dispose().catch(() => {});
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function open(options: {
    server: HelloMcp;
    servers?: string[];
    required?: boolean;
    headers?: Record<string, string>;
    env?: NodeJS.ProcessEnv;
    extension?: string;
    tools?: string[];
    responses?: FauxResponseStep[];
  }) {
    const fixture = writeFixtureRecipe({
      tools: options.tools ?? ["read"],
      manifestPi: {
        ...(options.extension ? { extensions: ["extensions/*.ts"] } : {}),
        mcp: {
          servers: [
            {
              id: "hello-mcp",
              required: options.required ?? true,
              tools: { include: ["*"] },
            },
          ],
        },
      },
      agentExtras: [
        "mcp:",
        "  mode: codemode",
        "  servers:",
        "    hello-mcp:",
        ...(options.servers ?? ['      include: ["echo"]']),
      ],
    });
    cleanups.push(fixture.cleanup);
    // The scripted model stands in for the one the fixture's agent names.
    const agentPath = join(fixture.recipeDir, "agents", "agent.yaml");
    writeFileSync(
      agentPath,
      readFileSync(agentPath, "utf8").replace(
        "anthropic/claude-sonnet-4-5",
        "faux/faux-1"
      )
    );
    if (options.extension) {
      mkdirSync(join(fixture.recipeDir, "extensions"));
      writeFileSync(join(fixture.recipeDir, "extensions", "probe.ts"), options.extension);
    }
    faux = fauxProvider();
    faux.setResponses(options.responses ?? []);
    const model = faux.getModel();
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(model.provider, async () => ({ type: "api_key", key: "test-key" }));
    const handle = await createAgentSession({
      recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
      cwd: fixture.workspaceDir,
      env: options.env ?? cleanEnv(),
      credentials,
      modelOverride: model,
      extensionFactories: [(pi) => pi.registerProvider(faux.provider)],
      mcpBindings: {
        servers: [
          {
            id: "hello-mcp",
            transport: "streamable_http",
            url: options.server.url,
            ...(options.headers ? { headers: options.headers } : {}),
          },
        ],
      },
    });
    handles.push(handle);
    return { handle, fixture };
  }

  async function hello(options?: Parameters<typeof startHelloMcp>[0]) {
    const server = await startHelloMcp(options);
    cleanups.push(() => server.close());
    return server;
  }

  it("keeps policy-allowed tools reachable from scripts only, and the rest hidden", async () => {
    const server = await hello();
    const { handle } = await open({ server });

    const tools = new Map(handle.session.getAllTools().map((tool) => [tool.name, tool]));
    // Pi lists a script-only MCP tool as deferred: declared to no model request.
    expect(tools.get(ECHO)?.exposure).toBe("deferred");
    expect(tools.get(GREETING)?.exposure).toBe("hidden");
    expect(handle.session.getActiveToolNames()).toContain("codemode");
    expect(handle.session.getActiveToolNames()).not.toContain(ECHO);
    expect([...tools.keys()]).not.toContain("list_mcp_resources");
  });

  it("declares eager tools to the model as well", async () => {
    const server = await hello();
    const { handle } = await open({
      server,
      servers: ['      include: ["*"]', "      eager: [echo]"],
    });

    expect(handle.session.getActiveToolNames()).toEqual(
      expect.arrayContaining(["codemode", ECHO])
    );
    expect(
      handle.session.getAllTools().find((tool) => tool.name === GREETING)?.exposure
    ).toBe("deferred");
  });

  it("runs the Harbor task through a script: parallel calls, a hidden tool refused", async () => {
    const server = await hello();
    let output = "";
    const { handle, fixture } = await open({
      server,
      tools: ["read", "write"],
      responses: [
        fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: [
                `const [a, b] = await Promise.all([`,
                `  tools.${ECHO}({ message: "hello from the public MCP" }),`,
                `  tools.${ECHO}({ message: "two" }),`,
                `]);`,
                `let hidden = "reachable";`,
                `try { await tools.${GREETING}({}); } catch { hidden = "unreachable"; }`,
                `await tools.write({ path: "greeting.txt", content: a.content[0].text });`,
                `return { b: b.structuredContent.result, hidden };`,
              ].join("\n"),
            }),
          ],
          { stopReason: "toolUse" }
        ),
        (context) => {
          output = lastToolResult(context);
          return fauxAssistantMessage("done");
        },
      ],
    });

    await handle.session.prompt("go");

    expect(output).toContain('"b":"Echo: two"');
    expect(output).toContain('"hidden":"unreachable"');
    expect(server.calls.map((call) => call.name)).toEqual(["echo", "echo"]);
    expect(readFileSync(join(fixture.workspaceDir, "greeting.txt"), "utf8")).toBe(
      "Echo: hello from the public MCP"
    );
  });

  it("holds a Recipe extension tool's MCP call until a slow server has connected", async () => {
    const server = await hello({ initializeDelayMs: 400 });
    let output = "";
    const { handle } = await open({
      server,
      required: false,
      tools: ["read", "greet"],
      extension: [
        "export default (pi) => {",
        "  pi.registerTool({",
        '    name: "greet",',
        '    label: "Greet",',
        '    description: "Greets through the hello MCP",',
        '    parameters: { type: "object", properties: { who: { type: "string" } }, required: ["who"] },',
        "    async execute(_id, params, signal, _update, ctx) {",
        `      const call = await ctx.executeTool("${ECHO}", { message: "hi " + params.who }, { signal });`,
        '      return { content: [{ type: "text", text: JSON.stringify(call.result.content) }], details: {} };',
        "    },",
        "  });",
        "};",
        "",
      ].join("\n"),
      responses: [
        fauxAssistantMessage([fauxToolCall("greet", { who: "ark" })], {
          stopReason: "toolUse",
        }),
        (context) => {
          output = lastToolResult(context);
          return fauxAssistantMessage("done");
        },
      ],
    });

    await handle.session.prompt("go");

    expect(output).toContain("Echo: hi ark");
  });

  it("sends a binding's headers with ${VAR} resolved from the session env", async () => {
    const server = await hello({ bearer: "secret-token" });
    const env = { ...cleanEnv(), HELLO_MCP_TOKEN: "secret-token" };
    const { handle } = await open({
      server,
      env,
      headers: { Authorization: "Bearer ${HELLO_MCP_TOKEN}" },
    });

    expect(handle.session.getAllTools().map((tool) => tool.name)).toContain(ECHO);
  });

  it("fails the session when a required server never connects", async () => {
    const server = await hello({ bearer: "nobody-has-this" });
    await expect(
      open({ server, env: { ...cleanEnv(), PI_RECIPES_MCP_CONNECT_TIMEOUT_MS: "300" } })
    ).rejects.toThrow(/Required MCP server\(s\) did not connect within 300 ms: hello-mcp/);
  });

  it("refuses a Pi too old to hold calls for servers still connecting", () => {
    expect(() => assertPiSupportsMcpCodemode("1.2.9")).toThrow(
      /needs Pi 1\.3\.0 or newer.*runs Pi 1\.2\.9/
    );
    expect(() => assertPiSupportsMcpCodemode("1.3.0")).not.toThrow();
    expect(() => assertPiSupportsMcpCodemode("2.0.0")).not.toThrow();
  });
});
