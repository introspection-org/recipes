import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preloadMcpCatalogs: vi.fn(),
}));

vi.mock("../src/mcp-catalog.js", () => ({
  preloadMcpCatalogs: mocks.preloadMcpCatalogs,
  clearMcpCatalogPreload: vi.fn(),
}));

import { createRecipesExtension } from "../src/pi-extension.js";
import { piMcpToolName } from "../src/mcp-tools.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

describe("Pi extension MCP tools mode", () => {
  const roots: string[] = [];

  afterEach(() => {
    mocks.preloadMcpCatalogs.mockReset();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the execute surface when the agent declares no servers", async () => {
    // `servers: {}` is a valid way to declare execute mode before anything is
    // bound. Both hosts returned on the zero-selection check, which runs
    // before the empty-session handling and, in session.ts, before the mode
    // is even read.
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-mcp-execute-noservers-"));
    roots.push(root);
    const recipeDir = join(root, "recipe");
    const workspaceDir = join(root, "workspace");
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "mcp-execute-noservers",
        version: "0.1.0",
        pi: { agents: ["agents/*.yaml"], mcp: { manifests: ["mcp.json"], servers: [] } },
      })
    );
    writeFileSync(join(recipeDir, "mcp.json"), JSON.stringify({ servers: [] }));
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "model:",
        "  name: openai/test-model",
        "  thinking_level: low",
        "tools:",
        "  - bash",
        "skills: []",
        "subagents: []",
        "mcp:",
        "  mode: execute",
        "  servers: {}",
        "system_instructions:",
        "  mode: append",
        "  content: Test agent",
        "",
      ].join("\n")
    );
    mocks.preloadMcpCatalogs.mockResolvedValue([]);
    const pi = createMockExtensionAPI();
    pi.flagValues.set("recipe", recipeDir);
    pi.flagValues.set("agent", "agent");
    createRecipesExtension({ env: { PATH: "/usr/bin:/bin" } })(pi);

    await pi.emitExtensionEvent(
      { type: "session_start", reason: "startup" } as any,
      {
        cwd: workspaceDir,
        mode: "interactive",
        hasUI: true,
        ui: { notify: vi.fn() },
        modelRegistry: {
          find: vi.fn((provider: string, id: string) => ({ provider, id })),
        },
      } as any
    );

    expect(pi.tools.has("execute")).toBe(true);
    expect(pi.tools.has("tool_search")).toBe(true);
  });

  it("keeps the execute surface when no servers are available", async () => {
    // The session API builds the two-tool surface for an empty session; this
    // host returned before ever reaching it, so the same recipe exposed
    // different tools depending on which host launched it.
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-mcp-execute-empty-"));
    roots.push(root);
    const recipeDir = join(root, "recipe");
    const workspaceDir = join(root, "workspace");
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "mcp-execute-empty",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
          mcp: {
            manifests: ["mcp.json"],
            servers: [{ id: "contacts", tools: { include: ["*"] } }],
          },
        },
      })
    );
    // No binding for the declared server, so the session materializes empty.
    writeFileSync(join(recipeDir, "mcp.json"), JSON.stringify({ servers: [] }));
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "model:",
        "  name: openai/test-model",
        "  thinking_level: low",
        "tools:",
        "  - bash",
        "skills: []",
        "subagents: []",
        "mcp:",
        "  mode: execute",
        "  servers:",
        "    contacts:",
        '      include: ["*"]',
        "system_instructions:",
        "  mode: append",
        "  content: Test agent",
        "",
      ].join("\n")
    );
    mocks.preloadMcpCatalogs.mockResolvedValue([]);
    const notify = vi.fn();
    const pi = createMockExtensionAPI();
    pi.flagValues.set("recipe", recipeDir);
    pi.flagValues.set("agent", "agent");
    createRecipesExtension({ env: { PATH: "/usr/bin:/bin" } })(pi);

    await pi.emitExtensionEvent(
      { type: "session_start", reason: "startup" } as any,
      {
        cwd: workspaceDir,
        mode: "interactive",
        hasUI: true,
        ui: { notify },
        modelRegistry: {
          find: vi.fn((provider: string, id: string) => ({ provider, id })),
        },
      } as any
    );

    expect(pi.tools.has("execute")).toBe(true);
    expect(pi.tools.has("tool_search")).toBe(true);
    // The operator is still told the catalog is empty.
    expect(notify).toHaveBeenCalled();
  });

  it("registers authorized tools, exposes only eager tools, and keeps CLI env private", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-mcp-tools-"));
    roots.push(root);
    const recipeDir = join(root, "recipe");
    const workspaceDir = join(root, "workspace");
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "mcp-tools-mode",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
          mcp: {
            manifests: ["mcp.json"],
            servers: [
              {
                id: "contacts",
                tools: { include: ["*"] },
              },
            ],
          },
        },
      })
    );
    writeFileSync(
      join(recipeDir, "mcp.json"),
      JSON.stringify({
        servers: [
          {
            id: "contacts",
            name: "Contacts",
            base_url: "https://example.test/mcp",
            tools: [
              { name: "search_contacts" },
              { name: "get_contact" },
            ],
          },
        ],
      })
    );
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "model:",
        "  name: openai/test-model",
        "  thinking_level: low",
        "tools:",
        "  - bash",
        "skills: []",
        "subagents: []",
        "mcp:",
        "  mode: tools",
        "  servers:",
        "    contacts:",
        "      include: [\"*\"]",
        "      defer: [\"*\"]",
        "      eager:",
        "        - get_contact",
        "system_instructions:",
        "  mode: append",
        "  content: Test agent",
        "",
      ].join("\n")
    );
    mocks.preloadMcpCatalogs.mockResolvedValue([
      {
        id: "contacts",
        name: "Contacts",
        tools: [
          {
            name: "search_contacts",
            description: "Search people and contacts.",
            input_schema: { type: "object" },
          },
          {
            name: "get_contact",
            description: "Read one contact.",
            input_schema: { type: "object" },
          },
        ],
      },
    ]);
    const initialPath = "/usr/bin:/bin";
    const hostMcporterConfig = join(root, "host-mcporter.json");
    writeFileSync(hostMcporterConfig, '{"host":true}\n');
    const env: NodeJS.ProcessEnv = {
      PATH: initialPath,
      MCPORTER_CONFIG: hostMcporterConfig,
    };
    const notify = vi.fn();
    const pi = createMockExtensionAPI();
    pi.flagValues.set("recipe", recipeDir);
    pi.flagValues.set("agent", "agent");
    createRecipesExtension({ env })(pi);

    await pi.emitExtensionEvent(
      { type: "session_start", reason: "startup" } as any,
      {
        cwd: workspaceDir,
        mode: "interactive",
        hasUI: true,
        ui: { notify },
        modelRegistry: {
          find: vi.fn((provider: string, id: string) => ({ provider, id })),
        },
      } as any
    );

    const searchContacts = piMcpToolName("contacts", "search_contacts");
    const getContact = piMcpToolName("contacts", "get_contact");
    expect(pi.tools.has(searchContacts)).toBe(true);
    expect(pi.tools.has(getContact)).toBe(true);
    expect(pi.tools.has("tool_search")).toBe(true);
    expect(pi.tools.has("mcp_search")).toBe(true);
    expect(pi.activeTools).toEqual(
      expect.arrayContaining(["bash", getContact, "tool_search", "mcp_search"])
    );
    expect(pi.activeTools).not.toContain(searchContacts);
    expect(env.PATH).toBe(initialPath);
    expect(env.PI_RECIPES_MCP_BIN_DIR).toBeUndefined();
    expect(env.PI_RECIPES_MCP_SESSION).toBeUndefined();
    expect(env.MCPORTER_CONFIG).toBeUndefined();
    expect(existsSync(hostMcporterConfig)).toBe(true);
    expect(readFileSync(hostMcporterConfig, "utf8")).toBe('{"host":true}\n');

    const search = pi.tools.get("tool_search")!;
    await (search.execute as any)(
      "search-1",
      { query: "find a person", limit: 3 },
      undefined,
      undefined
    );
    expect(pi.activeTools).toContain(searchContacts);

    await pi.emitExtensionEvent(
      { type: "session_start", reason: "resume" } as any,
      {
        cwd: workspaceDir,
        mode: "interactive",
        hasUI: true,
        ui: { notify },
        modelRegistry: {
          find: vi.fn((provider: string, id: string) => ({ provider, id })),
        },
      } as any
    );
    expect(pi.activeTools).not.toContain(searchContacts);
    expect(pi.activeTools).toEqual(
      expect.arrayContaining(["bash", getContact, "tool_search", "mcp_search"])
    );
    expect(notify).not.toHaveBeenCalledWith(
      expect.stringContaining("already in use"),
      "warning"
    );

    await pi.emitExtensionEvent(
      { type: "session_shutdown" } as any,
      {} as any
    );
    expect(env.MCPORTER_CONFIG).toBe(hostMcporterConfig);
  });
});
