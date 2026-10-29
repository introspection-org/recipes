import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearMcpCatalogPreload: vi.fn(),
  preloadMcpCatalogs: vi.fn(),
}));

vi.mock("../src/mcp/catalog.js", () => ({
  clearMcpCatalogPreload: mocks.clearMcpCatalogPreload,
  preloadMcpCatalogs: mocks.preloadMcpCatalogs,
}));

import { piMcpToolName } from "../src/mcp/tools.js";
import { resolveRecipe } from "../src/recipe/resolve.js";
import { createAgentSession, type RecipeSessionHandle } from "../src/session.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";

async function credentials(): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: "test-key",
  }));
  return store;
}

const catalog = [
  {
    id: "contacts",
    name: "Contacts",
    tools: [
      {
        name: "search_contacts",
        description: "Search contacts.",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ],
  },
];

async function session(codemode: boolean | undefined) {
  const fixture = writeFixtureRecipe({
    manifestPi: {
      mcp: {
        servers: [{ id: "contacts", tools: { include: ["search_contacts"] } }],
      },
    },
    agentExtras: [
      "mcp:",
      "  mode: tools",
      ...(codemode === undefined ? [] : [`  codemode: ${codemode}`]),
      "  servers:",
      "    contacts:",
      '      include: ["search_contacts"]',
      '      defer: ["*"]',
    ],
  });
  mocks.preloadMcpCatalogs.mockResolvedValue(catalog);
  const handle = await createAgentSession({
    recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
    cwd: fixture.workspaceDir,
    env: cleanEnv(),
    credentials: await credentials(),
    mcpBindings: {
      servers: [
        {
          id: "contacts",
          transport: "streamable_http",
          url: "http://127.0.0.1:9/mcp",
        },
      ],
    },
  });
  return { fixture, handle };
}

describe("Recipe session MCP codemode", () => {
  const handles: RecipeSessionHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      await handle.dispose().catch(() => {});
    }
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.clearAllMocks();
  });

  it("adds an active codemode tool beside the deferred MCP tools", async () => {
    const { fixture, handle } = await session(true);
    cleanups.push(fixture.cleanup);
    handles.push(handle);

    expect(handle.session.getActiveToolNames()).toContain("codemode");
    expect(handle.session.getActiveToolNames()).not.toContain(
      piMcpToolName("contacts", "search_contacts")
    );

    // Pi's codemode reaches every deferred tool, through the agent loop's
    // tool pipeline, so the agent's hooks apply to nested calls too.
    expect(
      handle.session.getAllTools().map((tool) => tool.name)
    ).toContain(piMcpToolName("contacts", "search_contacts"));
  });

  it("leaves codemode out unless the agent asks for it", async () => {
    const { fixture, handle } = await session(undefined);
    cleanups.push(fixture.cleanup);
    handles.push(handle);
    expect(
      handle.session.getAllTools().map((tool) => tool.name)
    ).not.toContain("codemode");
  });
});
