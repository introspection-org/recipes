import type {
  ExtensionAPI,
  ToolDefinition,
  ToolExposure,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { createRecipeToolSearchTools, deferTools } from "../src/tool-search.js";

function tool(
  name: string,
  description: string,
  exposure: ToolExposure = "deferred",
  parameters = Type.Object({})
): ToolDefinition {
  return {
    name,
    label: name,
    description,
    parameters,
    exposure,
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };
}

function session(tools: ToolDefinition[], active: string[]) {
  const state = { active };
  return {
    state,
    getAllTools: () =>
      tools.map((entry) => ({ ...entry, exposure: entry.exposure ?? "direct" })),
    getActiveTools: () => state.active,
    setActiveTools: (names: string[]) => {
      state.active = names;
    },
  } as unknown as ExtensionAPI & { state: { active: string[] } };
}

async function search(definition: ToolDefinition, query: string, limit?: number) {
  return definition.execute(
    "call",
    { query, ...(limit ? { limit } : {}) },
    undefined,
    undefined,
    undefined as never
  );
}

describe("Recipe tool search", () => {
  it("loads deferred matches additively and skips active and direct tools", async () => {
    const tools = [
      tool("channel_react", "Add an emoji reaction to a Slack message."),
      tool("candidate_search", "Find recruiting candidates by role."),
      tool("emoji_lookup", "Look up an emoji reaction by name.", "direct"),
    ];
    const pi = session(tools, ["read", "tool_search"]);
    const [toolSearch] = createRecipeToolSearchTools(pi, false);

    const first = await search(toolSearch!, "emoji reaction");
    expect(first.details).toEqual({ loaded: ["channel_react"] });
    expect(pi.state.active).toEqual(["read", "tool_search", "channel_react"]);

    const second = await search(toolSearch!, "emoji reaction candidates");
    expect(second.details).toEqual({ loaded: ["candidate_search"] });
  });

  it("matches deferred tools by input property names", async () => {
    const pi = session(
      [
        tool(
          "lookup",
          "Look something up.",
          "deferred",
          Type.Object({ ticker: Type.String({ description: "Stock symbol." }) })
        ),
      ],
      []
    );
    const [toolSearch] = createRecipeToolSearchTools(pi, false);
    expect((await search(toolSearch!, "ticker")).details).toEqual({
      loaded: ["lookup"],
    });
  });

  it("adds mcp_search as an alias only when asked", () => {
    const pi = session([], []);
    expect(createRecipeToolSearchTools(pi, false).map((t) => t.name)).toEqual([
      "tool_search",
    ]);
    const tools = createRecipeToolSearchTools(pi, true);
    expect(tools.map((t) => t.name)).toEqual(["tool_search", "mcp_search"]);
    expect(tools.every((t) => t.defaultActive === undefined)).toBe(true);
  });

  it("registers only the named tools as deferred", async () => {
    const registered: ToolDefinition[] = [];
    const pi = {
      registerTool: (definition: ToolDefinition) => registered.push(definition),
    } as unknown as ExtensionAPI;
    await deferTools((api) => {
      api.registerTool(tool("later", "Later.", "direct"));
      api.registerTool(tool("now", "Now.", "direct"));
    }, ["later"])(pi);
    expect(registered.map((t) => [t.name, t.exposure])).toEqual([
      ["later", "deferred"],
      ["now", "direct"],
    ]);
  });
});
