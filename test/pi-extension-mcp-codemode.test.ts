import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { mcpToolName } from "../src/mcp/pi-client.js";
import { createRecipesExtension } from "../src/pi-extension.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";
import { startHelloMcp } from "./helpers/hello-mcp.js";

const ECHO = mcpToolName("hello-mcp", "echo");
const GREETING = mcpToolName("hello-mcp", "get_greeting");

// The Pi CLI host: the recipes extension beside the built-in codemode,
// tool_search and MCP extensions the `pi` command loads.
describe("Pi extension MCP codemode", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("registers the Recipe's servers with Pi's MCP support and runs a script", async () => {
    const server = await startHelloMcp();
    cleanups.push(() => server.close());
    const fixture = writeFixtureRecipe({
      tools: ["read"],
      manifestPi: {
        mcp: {
          servers: [{ id: "hello-mcp", required: true, tools: { include: ["*"] } }],
        },
      },
      agentExtras: [
        "mcp:",
        "  mode: codemode",
        "  servers:",
        "    hello-mcp:",
        '      include: ["echo"]',
      ],
    });
    cleanups.push(fixture.cleanup);
    const agentPath = join(fixture.recipeDir, "agents", "agent.yaml");
    writeFileSync(
      agentPath,
      readFileSync(agentPath, "utf8").replace("anthropic/claude-sonnet-4-5", "faux/faux-1")
    );
    writeFileSync(
      join(fixture.recipeDir, ".pi-bindings.json"),
      JSON.stringify({
        servers: [{ id: "hello-mcp", transport: "streamable_http", url: server.url }],
      })
    );
    const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
    cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));

    let output = "";
    const faux = fauxProvider();
    faux.setResponses([
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
        { stopReason: "toolUse" }
      ),
      (context) => {
        const result = [...context.messages]
          .reverse()
          .find((message) => (message as { role?: string }).role === "toolResult") as
          | { content: Array<{ text?: string }> }
          | undefined;
        output = result?.content.map((part) => part.text ?? "").join("\n") ?? "";
        return fauxAssistantMessage("done");
      },
    ]);
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("faux", async () => ({ type: "api_key", key: "test-key" }));
    const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
    modelRuntime.registerNativeProvider(faux.provider);

    const env = {
      ...cleanEnv(),
      PI_RECIPE_DIR: fixture.recipeDir,
      PI_RECIPES_MCP_LOCAL_CONFIG: join(fixture.recipeDir, ".pi-bindings.json"),
    };
    const resourceLoader = new DefaultResourceLoader({
      cwd: fixture.workspaceDir,
      agentDir,
      noExtensions: true,
      extensionFactories: [
        createCodemodeExtension({ models: false }),
        createToolSearchExtension(),
        createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) }),
        createRecipesExtension({ env }),
      ],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: fixture.workspaceDir,
      agentDir,
      model: faux.getModel(),
      modelRuntime,
      resourceLoader,
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(),
    });
    cleanups.push(() => (session as AgentSession).dispose());
    await session.bindExtensions({});

    expect(session.getActiveToolNames()).toContain("codemode");
    expect(session.getActiveToolNames()).not.toContain(ECHO);
    expect(session.getAllTools().find((tool) => tool.name === GREETING)?.exposure).toBe(
      "hidden"
    );

    await session.prompt("go");

    expect(output).toContain('"echoed":"Echo: hello from the public MCP"');
    expect(output).toContain('"hidden":"unreachable"');
    expect(server.calls).toEqual([
      { name: "echo", arguments: { message: "hello from the public MCP" } },
    ]);
  });
});
