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
import {
  resolveRecipe,
} from "../src/recipe/resolve.js";
import {
  createAgentSession,
  materializeRecipeSessionMcp,
  type RecipeSessionHandle,
} from "../src/session.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";

async function credentials(): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: "test-key",
  }));
  return store;
}

describe("canonical Recipe session MCP tools mode", () => {
  const handles: RecipeSessionHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      await handle.dispose().catch(() => {});
    }
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.clearAllMocks();
  });

  it("registers deferred MCP tools through createAgentSession", async () => {
    const fixture = writeFixtureRecipe({
      manifestPi: {
        mcp: {
          servers: [
            {
              id: "contacts",
              required: true,
              tools: { include: ["search_contacts", "get_contact"] },
            },
          ],
        },
      },
      agentExtras: [
        "mcp:",
        "  mode: tools",
        "  servers:",
        "    contacts:",
        '      include: ["search_contacts", "get_contact"]',
        '      defer: ["*"]',
      ],
    });
    cleanups.push(fixture.cleanup);
    mocks.preloadMcpCatalogs.mockResolvedValue([
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
          {
            name: "get_contact",
            description: "Read one contact.",
            input_schema: { type: "object", properties: {} },
          },
        ],
      },
    ]);

    const env = cleanEnv();
    const handle = await createAgentSession({
      recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
      cwd: fixture.workspaceDir,
      env,
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
    handles.push(handle);

    const registered = new Set(
      handle.session.getAllTools().map((tool) => tool.name)
    );
    expect(registered).toContain(
      piMcpToolName("contacts", "search_contacts")
    );
    expect(registered).toContain(piMcpToolName("contacts", "get_contact"));
    expect(registered).toContain("tool_search");
    expect(registered).toContain("mcp_search");
    expect(handle.session.getActiveToolNames()).toContain("tool_search");
    expect(handle.session.getActiveToolNames()).toContain("mcp_search");
    expect(handle.session.getActiveToolNames()).not.toContain(
      piMcpToolName("contacts", "search_contacts")
    );

    // Tools mode owns an isolated MCP runtime instead of mutating the host env.
    expect(env.PI_RECIPES_MCP_SESSION).toBeUndefined();
    expect(env.MCPORTER_CONFIG).toBeUndefined();
  });

  it("applies a private CLI MCP environment to the session bash tool", async () => {
    const fixture = writeFixtureRecipe({
      tools: ["read", "bash"],
      manifestPi: {
        mcp: {
          servers: [
            {
              id: "contacts",
              tools: { include: ["search_contacts"] },
            },
          ],
        },
      },
      agentExtras: [
        "mcp:",
        "  mode: cli",
        "  servers:",
        "    contacts:",
        "      include: [search_contacts]",
      ],
    });
    cleanups.push(fixture.cleanup);
    const env = { ...cleanEnv(), RECIPE_CHILD_MARKER: "isolated" };
    const handle = await createAgentSession({
      recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
      cwd: fixture.workspaceDir,
      env,
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
    handles.push(handle);

    const bash = handle.session.agent.state.tools.find(
      (tool) => tool.name === "bash"
    );
    expect(bash).toBeDefined();
    const result = await (bash!.execute as any)(
      "call-env",
      {
        command:
          'test -n "$PI_RECIPES_MCP_SESSION" && test "$RECIPE_CHILD_MARKER" = isolated && printf private-cli-env',
      },
      undefined,
      undefined
    );
    expect(result.content[0]?.text).toContain("private-cli-env");
  });

  it("applies a host-provisioned CLI MCP environment to the session bash tool", async () => {
    const fixture = writeFixtureRecipe({
      tools: ["read", "bash"],
      manifestPi: {
        mcp: {
          servers: [
            {
              id: "contacts",
              tools: { include: ["search_contacts"] },
            },
          ],
        },
      },
      agentExtras: [
        "mcp:",
        "  mode: cli",
        "  servers:",
        "    contacts:",
        "      include: [search_contacts]",
      ],
    });
    cleanups.push(fixture.cleanup);
    const env = { ...cleanEnv(), HOST_MCP_MARKER: "host-owned" };
    const mcpBindings = {
      servers: [
        {
          id: "contacts",
          transport: "streamable_http" as const,
          url: "http://127.0.0.1:9/mcp",
        },
      ],
    };
    await materializeRecipeSessionMcp(
      resolveRecipe({ recipeDir: fixture.recipeDir }).selectAgent(),
      fixture.workspaceDir,
      env,
      { mcpBindings }
    );
    const handle = await createAgentSession({
      recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
      cwd: fixture.workspaceDir,
      env,
      credentials: await credentials(),
      mcpProvisioning: "host",
    });
    handles.push(handle);

    const bash = handle.session.agent.state.tools.find(
      (tool) => tool.name === "bash"
    );
    expect(bash).toBeDefined();
    const result = await (bash!.execute as any)(
      "call-host-env",
      {
        command:
          'test -n "$PI_RECIPES_MCP_SESSION" && test "$HOST_MCP_MARKER" = host-owned && printf host-cli-env',
      },
      undefined,
      undefined
    );
    expect(result.content[0]?.text).toContain("host-cli-env");
  });
});
