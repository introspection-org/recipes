import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  createBashToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
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
import { registerWebSearchTool } from "../src/search/index.js";
import { type RecipeSessionHandle } from "../src/session.js";
import { writeFixtureRecipe } from "../src/test-utils.js";
import {
  lastToolResult,
  modelView,
  openRecipeSession,
} from "./helpers/mcp-session.js";
import searchProviders from "../packages/search/src/index.js";

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

function issuesRecipe(
  toolsBlock: string[],
  manifestPi: Record<string, unknown> = {},
) {
  const fixture = writeFixtureRecipe({
    toolsBlock,
    dependencies: { "@acme/issues": "1.0.0" },
    manifestPi: {
      issues: [
        { provider: "acme", package: "@acme/issues" },
        { provider: "introspection", enabled: false },
      ],
      ...manifestPi,
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

  it("refuses what an MCP server refuses, and cli without bash", () => {
    expect(one(block("mode: cli"))).toContain(
      "tools.mode cli runs the tools command from bash; select bash",
    );
    expect(
      messages(["tools:", "  mode: cli", "  include: [read, bash, issues]"]),
    ).toEqual([]);
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
      productivity: [
        { provider: "google", tools: { mail: [], calendar: ["list"] } },
      ],
    });
    expect(declared.tools).toEqual(
      expect.arrayContaining(["my_tool", "issues", "calendar"]),
    );
    expect(declared.tools).not.toContain("mail");
    expect(declared.wildcard).not.toContain("my_tool");
  });

  it("selects a productivity tool whose allowlist the declaration omits", () => {
    const { wildcard } = selectedAgentTools(["*"], undefined, {
      productivity: [{ provider: "google", tools: { mail: ["search"] } }],
    });
    expect(wildcard).toEqual(
      expect.arrayContaining(["mail", "calendar", "drive"]),
    );
  });

  it("selects issues when pi.issues leaves a provider, the implicit fallback included", () => {
    const wildcard = (issues: Array<{ provider: string; enabled?: boolean }>) =>
      selectedAgentTools(["*"], undefined, { issues }).tools;
    expect(wildcard([])).toContain("issues");
    expect(wildcard([{ provider: "linear", enabled: false }])).toContain(
      "issues",
    );
    expect(
      wildcard([{ provider: "introspection", enabled: false }]),
    ).not.toContain("issues");
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

  async function run(
    toolsBlock: string[],
    responses: FauxResponseStep[],
    host: {
      search?: boolean;
      webSearch?: boolean;
      customWebSearch?: boolean;
    } = {},
  ) {
    const fixture = issuesRecipe(
      toolsBlock,
      host.search ? { search: [{ provider: "brave" }] } : {},
    );
    cleanups.push(fixture.cleanup);
    const handle = await openRecipeSession({
      ...fixture,
      responses,
      bindings: [],
      ...(host.webSearch ? { extensionFactories: [webSearchExtension] } : {}),
      ...(host.customWebSearch ? { customTools: [webSearchDefinition()] } : {}),
    });
    handles.push(handle);
    await handle.session.prompt("go");
    return handle;
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

  for (const [how, command] of [
    ["--json", `tools call issues.search --json '{"query":"found"}'`],
    ["stdin", `echo '{"query":"found"}' | tools call issues.search --json -`],
    ["flags", `issues search --query found`],
  ])
    it(`serves the tool to bash's tools command in cli, undeclared (${how})`, async () => {
      let tools: string[] = [];
      let output = "";
      let prompt = "";
      await run(
        ["tools:", "  mode: cli", "  include: [read, bash, issues]"],
        [
          (context) => {
            tools = declared(context);
            prompt = JSON.stringify(modelView(context).tools);
            return fauxAssistantMessage([fauxToolCall("bash", { command })], {
              stopReason: "toolUse",
            });
          },
          (context) => {
            output = lastToolResult(context);
            return fauxAssistantMessage("done");
          },
        ],
      );
      expect(tools).toContain("bash");
      expect(tools).not.toContain("issues");
      expect(tools).not.toContain("codemode");
      expect(output).toContain("acme:A-1");
      expect(prompt).toContain(
        "are not tools you call directly: each is a command in bash",
      );
    });

  it("refuses cli when the host supplies its own bash", async () => {
    const fixture = issuesRecipe([
      "tools:",
      "  mode: cli",
      "  include: [read, bash, issues]",
    ]);
    cleanups.push(fixture.cleanup);
    await expect(
      openRecipeSession({
        ...fixture,
        bindings: [],
        customTools: [
          createBashToolDefinition(fixture.workspaceDir) as ToolDefinition,
        ],
      }),
    ).rejects.toThrow("the host supplies its own bash");
  });

  it("leaves out a tool * selects that the host does not offer", async () => {
    let tools: string[] = [];
    await run(
      ["tools:", '  include: ["*"]'],
      [
        (context) => {
          tools = declared(context);
          return fauxAssistantMessage("done");
        },
      ],
      { search: true },
    );
    expect(tools).toContain("issues");
    expect(tools).not.toContain("web_search");
  });

  it("keeps a host's web_search to codemode scripts in codemode", async () => {
    let tools: string[] = [];
    let output = "";
    await run(
      ["tools:", "  mode: codemode", "  include: [read, web_search]"],
      [
        (context) => {
          tools = declared(context);
          return fauxAssistantMessage(
            [
              fauxToolCall("codemode", {
                code: 'return await tools.web_search({ query: "agents", content: "context" });',
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
      { webSearch: true },
    );
    expect(tools).toContain("codemode");
    expect(tools).not.toContain("web_search");
    expect(output).toContain("Agents that search");
  });

  it("defers a host's web_search to tool search", async () => {
    let tools: string[] = [];
    await run(
      ["tools:", "  include: [read, web_search]", "  defer: [web_search]"],
      [
        (context) => {
          tools = declared(context);
          return fauxAssistantMessage("done");
        },
      ],
      { webSearch: true },
    );
    expect(tools).not.toContain("web_search");
    expect(tools).toContain("tool_search");
  });

  it("defers a web_search the host supplies as a custom tool, which tool search finds", async () => {
    let tools: string[] = [];
    let found = "";
    const handle = await run(
      ["tools:", "  include: [read, web_search]", "  defer: [web_search]"],
      [
        (context) => {
          tools = declared(context);
          return fauxAssistantMessage(
            [fauxToolCall("tool_search", { query: "web_search" })],
            { stopReason: "toolUse" },
          );
        },
        (context) => {
          found = lastToolResult(context);
          return fauxAssistantMessage("done");
        },
      ],
      { customWebSearch: true },
    );
    expect(tools).not.toContain("web_search");
    expect(tools).toContain("tool_search");
    expect(
      handle.session.getAllTools().find((tool) => tool.name === "web_search")
        ?.exposure,
    ).toBe("deferred");
    expect(found).toContain("web_search");
  });

  it("serves a host's web_search to bash's tools command in cli", async () => {
    let tools: string[] = [];
    let output = "";
    await run(
      ["tools:", "  mode: cli", "  include: [read, bash, web_search]"],
      [
        (context) => {
          tools = declared(context);
          return fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command: `tools call web_search --json '{"query":"agents","content":"context"}'`,
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
      { webSearch: true },
    );
    expect(tools).not.toContain("web_search");
    expect(output).toContain("Agents that search");
  });
});

/** A host's extension registering `web_search`, which sets no exposure of its own. */
function webSearchExtension(pi: Parameters<typeof registerWebSearchTool>[0]) {
  registerWebSearchTool(pi, {
    bound: ["brave"],
    providers: searchProviders.providers,
    env: { INTROSPECTION_EGRESS_PROXY_NATIVE: "1" },
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => BRAVE_ANSWER,
      text: async () => JSON.stringify(BRAVE_ANSWER),
    }),
  });
}

/** The `web_search` definition a host passes as a custom tool, with no exposure of its own. */
function webSearchDefinition(): ToolDefinition {
  let definition: ToolDefinition | undefined;
  webSearchExtension({
    registerTool: (tool: ToolDefinition) => {
      definition = tool;
    },
  } as unknown as Parameters<typeof registerWebSearchTool>[0]);
  return definition!;
}

const BRAVE_ANSWER = {
  grounding: {
    generic: [
      {
        url: "https://example.com/agents",
        title: "Agents that search",
        snippets: ["About agents."],
      },
    ],
    map: [],
  },
  sources: {},
};
