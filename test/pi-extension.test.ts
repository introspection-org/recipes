import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRecipesExtension } from "../src/pi-extension.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";
import {
  installSlackRecipeConnector,
  SLACK_RECIPE_CHANNEL_PACKAGE,
} from "./helpers/recipe-connectors.js";

beforeEach(() => {
});

function extensionContext(cwd: string, notify = vi.fn()) {
  return {
    cwd,
    hasUI: true,
    ui: { notify },
    modelRegistry: {
      find: vi.fn((provider: string, id: string) => ({ provider, id })),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key" })),
    },
  } as any;
}

function writeRecipe(root: string) {
  const recipeDir = join(root, "recipe");
  mkdirSync(join(recipeDir, "defs"), { recursive: true });
  mkdirSync(join(recipeDir, "skills", "repo-index"), { recursive: true });
  mkdirSync(join(recipeDir, "prompts"), { recursive: true });
  writeFileSync(
    join(recipeDir, "package.json"),
    `${JSON.stringify(
      {
        name: "demo",
        version: "1.0.0",
        pi: {
          agents: ["defs/*.yaml"],
          skills: ["skills/**/SKILL.md"],
          prompts: ["prompts"],
        },
      },
      null,
      2
    )}\n`
  );
  writeFileSync(join(recipeDir, "SYSTEM.md"), "Base recipe prompt");
  writeFileSync(
    join(recipeDir, "defs", "main.yaml"),
    [
      "name: main",
      "model:",
      "  name: openai/gpt-4.1",
      "  thinking_level: low",
      "tools:",
      "  - read",
      "  - bash",
      "skills:",
      "  - repo-index",
      "subagents:",
      "  - explorer",
      "system_instructions:",
      "  mode: append",
      "  content: Agent-specific prompt",
    ].join("\n")
  );
  writeFileSync(
    join(recipeDir, "defs", "explorer.yaml"),
    [
      "name: explorer",
      "model:",
      "  name: openai/gpt-4.1",
      "  thinking_level: low",
      "tools: []",
      "system_instructions:",
      "  mode: append",
      "  content: Explorer prompt",
      "",
    ].join("\n")
  );
  writeFileSync(join(recipeDir, "skills", "repo-index", "SKILL.md"), "---\ndescription: Index repo\n---\n");
  writeFileSync(join(recipeDir, "prompts", "review.md"), "Review this\n");
  return recipeDir;
}

describe("Recipes extension for Pi", () => {
  it("registers recipe launch flags", async () => {
    const pi = createMockExtensionAPI();
    createRecipesExtension()(pi);

    expect(pi.commands.has("recipe")).toBe(true);
    expect(pi.commands.has("recipe-resources")).toBe(false);
    expect(pi.flags.has("recipe")).toBe(true);
    expect(pi.flags.has("agent")).toBe(true);

    const results = await pi.emitExtensionEvent(
      { type: "resources_discover", cwd: process.cwd(), reason: "startup" } as any,
      extensionContext(process.cwd())
    );
    expect(results).toEqual([{}]);
    expect(pi.activeTools).toEqual([]);
  });

  it("reports when recipe inspection commands run without an active recipe", async () => {
    const pi = createMockExtensionAPI();
    const notify = vi.fn();
    createRecipesExtension()(pi);

    await pi.commands.get("recipe")?.handler("", extensionContext(process.cwd(), notify));

    expect(notify).toHaveBeenCalledWith(
      "No recipe is active. Launch Pi with --recipe <recipe>.",
      "info"
    );
  });

  it("does not reuse exported resolved values as later launch inputs", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-launch-inputs-"));
    try {
      const recipeDir = writeRecipe(root);
      const env: NodeJS.ProcessEnv = {
        PI_RECIPE_DIR: recipeDir,
        PI_AGENT_NAME: "explorer",
      };
      const pi = createMockExtensionAPI();
      const notify = vi.fn();
      const ctx = extensionContext(root, notify);
      pi.flagValues.set("agent", "main");

      createRecipesExtension({ env })(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );
      expect(env.PI_AGENT_NAME).toBe("main");

      pi.flagValues.delete("agent");
      notify.mockClear();
      await pi.commands.get("recipe")?.handler("", ctx);

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Agent: explorer"), "info");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a friendly message when the selected recipe is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-missing-"));
    try {
      const pi = createMockExtensionAPI();
      const notify = vi.fn();
      const ctx = extensionContext(root, notify);
      pi.flagValues.set("recipe", "missing-recipe");

      createRecipesExtension()(pi);
      await expect(
        pi.emitExtensionEvent({ type: "session_start", reason: "startup" } as any, ctx)
      ).resolves.toEqual([undefined]);

      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining('Recipe "missing-recipe" was not found.'),
        "warning"
      );
      const message = notify.mock.calls[0]?.[0] as string;
      expect(message).toContain("Pass a local Recipe directory");
      expect(message).toContain("pi --recipe <recipe>");
      expect(message).not.toContain("RecipePackageError");
      expect(message).not.toContain("at ");
      expect(pi.activeTools).toEqual([]);

      const abort = vi.fn();
      await pi.emitExtensionEvent(
        { type: "agent_start" } as any,
        { ...ctx, abort }
      );
      expect(abort).toHaveBeenCalledOnce();

      const resourceResults = await pi.emitExtensionEvent(
        { type: "resources_discover", cwd: root, reason: "startup" } as any,
        ctx
      );
      expect(resourceResults).toEqual([{}]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts agents that omit empty skills and subagents", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-invalid-agent-"));
    try {
      const recipeDir = join(root, "recipe");
      mkdirSync(join(recipeDir, "agents"), { recursive: true });
      writeFileSync(
        join(recipeDir, "package.json"),
        `${JSON.stringify(
          {
            name: "invalid-agent-recipe",
            version: "1.0.0",
            pi: {
              agents: ["agents/*.yaml"],
            },
          },
          null,
          2
        )}\n`
      );
      writeFileSync(
        join(recipeDir, "agents", "agent.yaml"),
        [
          "name: agent",
          "model:",
          "  name: openai/gpt-4.1",
          "  thinking_level: low",
          "tools: []",
          "system_instructions:",
          "  mode: append",
          "  content: Main instructions",
          "",
        ].join("\n")
      );
      const pi = createMockExtensionAPI();
      const notify = vi.fn();
      const ctx = extensionContext(root, notify);
      pi.flagValues.set("recipe", recipeDir);

      createRecipesExtension({ env: {} })(pi);
      await pi.emitExtensionEvent({ type: "session_start", reason: "startup" } as any, ctx);

      expect(notify).not.toHaveBeenCalledWith(
        expect.stringContaining("has invalid agents"),
        "warning"
      );
      expect(pi.sessionName).toBe("invalid-agent-recipe@1.0.0 agent:agent");
      expect(pi.activeTools).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not reject an MCP agent that uses a custom shell wrapper", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-mcp-shell-"));
    try {
      const recipeDir = join(root, "recipe");
      mkdirSync(join(recipeDir, "agents"), { recursive: true });
      writeFileSync(
        join(recipeDir, "package.json"),
        `${JSON.stringify({
          name: "mcp-shell-recipe",
          version: "1.0.0",
          pi: {
            agents: ["agents/*.yaml"],
            mcp: {
              servers: [
                { id: "nextplay", tools: { include: ["search"] } },
              ],
            },
          },
        })}\n`
      );
      writeFileSync(
        join(recipeDir, "agents", "agent.yaml"),
        [
          "name: agent",
          "model:",
          "  name: openai/gpt-4.1",
          "  thinking_level: low",
          "tools:",
          "  - shell",
          "mcp:",
          "  mode: cli",
          "  servers:",
          "    nextplay:",
          "      include:",
          "        - search",
          "skills: []",
          "subagents: []",
          "system_instructions:",
          "  mode: append",
          "  content: Main instructions",
          "",
        ].join("\n")
      );
      const pi = createMockExtensionAPI();
      const notify = vi.fn();
      pi.flagValues.set("recipe", recipeDir);
      createRecipesExtension({ env: {} })(pi);

      const promptResults = await pi.emitExtensionEvent(
        {
          type: "before_agent_start",
          prompt: "hello",
          systemPrompt: "Default Pi prompt",
          systemPromptOptions: {},
        } as any,
        extensionContext(root, notify)
      );

      expect(promptResults).toEqual([
        {
          systemPrompt: expect.stringContaining("Main instructions"),
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("configures the launched session from a recipe folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-launch-"));
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      const notify = vi.fn();
      const ctx = extensionContext(projectDir, notify);
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");

      createRecipesExtension()(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );

      expect(pi.sessionName).toBe("demo@1.0.0 agent:main");
      expect(pi.model).toEqual({ provider: "openai", id: "gpt-4.1" });
      expect(pi.thinkingLevel).toBe("low");
      expect(pi.activeTools.sort()).toEqual(["agent", "bash", "read"]);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Recipe: demo@1.0.0"), "info");

      const resourceResults = await pi.emitExtensionEvent(
        { type: "resources_discover", cwd: projectDir, reason: "startup" } as any,
        ctx
      );
      expect(resourceResults).toEqual([
        expect.objectContaining({
          skillPaths: [join(recipeDir, "skills", "repo-index", "SKILL.md")],
          promptPaths: [join(recipeDir, "prompts")],
        }),
      ]);

      const promptResults = await pi.emitExtensionEvent(
        {
          type: "before_agent_start",
          prompt: "hello",
          systemPrompt: "Default Pi prompt",
          systemPromptOptions: {},
        } as any,
        ctx
      );
      expect(promptResults).toEqual([
        {
          systemPrompt: "Base recipe prompt\n\nAgent-specific prompt",
        },
      ]);

      await pi.commands.get("recipe")?.handler("", ctx as any);
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Name: demo@1.0.0"),
        "info"
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Agent: main"),
        "info"
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Active recipe tools:"),
        "info"
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("  - bash"),
        "info"
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("  - read"),
        "info"
      );
      const recipeMessage = notify.mock.calls
        .map((call) => call[0])
        .find((message): message is string =>
          typeof message === "string" && message.includes("Active Recipe")
        );
      expect(recipeMessage).not.toContain(join(recipeDir, "skills", "repo-index", "SKILL.md"));
      expect(recipeMessage).not.toContain(join(recipeDir, "prompts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers declared connector tools without a Recipe extension", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-connectors-"));
    try {
      const recipeDir = writeRecipe(root);
      const pkg = JSON.parse(
        readFileSync(join(recipeDir, "package.json"), "utf8")
      );
      pkg.pi.channels = [{ provider: "slack" }];
      pkg.dependencies = { [SLACK_RECIPE_CHANNEL_PACKAGE]: "0.1.0" };
      writeFileSync(join(recipeDir, "package.json"), JSON.stringify(pkg));
      installSlackRecipeConnector(recipeDir);
      writeFileSync(
        join(recipeDir, "defs", "main.yaml"),
        [
          "name: main",
          "model:",
          "  name: openai/gpt-4.1",
          "tools:",
          "  - channels",
          "",
        ].join("\n")
      );

      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");
      createRecipesExtension({
        env: {
          INTROSPECTION_TASK_CHANNEL_PROVIDER: "slack",
          INTROSPECTION_TASK_CHANNEL_ID: "C_CONFIGURED",
        },
      })(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        extensionContext(root)
      );

      expect([...pi.tools.keys()].sort()).toEqual([
        "agent",
        "channels",
      ]);
      expect(pi.activeTools.sort()).toEqual([
        "channels",
      ]);
      expect(pi.activeTools).toContain("channels");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("aborts instead of falling back when the recipe model has no credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-model-auth-"));
    const previousExitCode = process.exitCode;
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      const notify = vi.fn();
      const abort = vi.fn();
      const ctx = { ...extensionContext(projectDir, notify), abort, mode: "json" };
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");
      (pi as any).setModel = vi.fn().mockResolvedValue(false);

      createRecipesExtension()(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );

      expect(pi.activeTools).toEqual([]);
      expect(notify).toHaveBeenCalledWith(
        "Recipe session cannot start: Recipe model has no configured API key: openai/gpt-4.1",
        "warning"
      );
      expect(process.exitCode).toBe(1);
      await pi.emitExtensionEvent({ type: "agent_start" } as any, ctx);
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      process.exitCode = previousExitCode;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when Pi cannot apply authored request or session configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-unsupported-ai-session-"));
    const previousExitCode = process.exitCode;
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(recipeDir, "defs", "main.yaml"),
        [
          "name: main",
          "ai:",
          "  model: openai/gpt-4.1",
          "  options:",
          "    max_tokens: 4096",
          "session:",
          "  tool_execution: parallel",
          "tools: [read]",
        ].join("\n")
      );
      const notify = vi.fn();
      const abort = vi.fn();
      const ctx = { ...extensionContext(projectDir, notify), abort, mode: "json" };
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");

      createRecipesExtension()(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );

      expect(pi.activeTools).toEqual([]);
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(
          "Pi's extension API cannot apply Recipe ai.options (or legacy model request options) and session"
        ),
        "warning"
      );
      expect(process.exitCode).toBe(1);
      await pi.emitExtensionEvent({ type: "agent_start" } as any, ctx);
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      process.exitCode = previousExitCode;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies Anthropic context management through Pi's payload hook", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "pi-recipe-unsupported-anthropic-context-")
    );
    const previousExitCode = process.exitCode;
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(recipeDir, "defs", "main.yaml"),
        [
          "name: main",
          "ai:",
          "  model: anthropic/claude-sonnet-4-5",
          "  providers:",
          "    anthropic:",
          "      context_management:",
          "        edits: []",
          "tools: [read]",
        ].join("\n")
      );
      const notify = vi.fn();
      const ctx = extensionContext(projectDir, notify);
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");

      createRecipesExtension()(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );

      expect(pi.activeTools).toEqual(["read"]);
      const results = await pi.emitExtensionEvent(
        { type: "before_provider_request", payload: { model: "claude" } } as any,
        {
          ...ctx,
          model: { provider: "anthropic", api: "anthropic-messages" },
        }
      );
      expect(results).toContainEqual({
        model: "claude",
        context_management: { edits: [] },
      });
      expect(process.exitCode).toBe(previousExitCode);
    } finally {
      process.exitCode = previousExitCode;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies Vercel AI Gateway routing through Pi's payload hook", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-vercel-routing-"));
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(recipeDir, "defs", "main.yaml"),
        [
          "name: main",
          "ai:",
          "  model: vercel-ai-gateway/anthropic/claude-sonnet-5",
          "  providers:",
          "    vercel_ai_gateway:",
          "      routing:",
          "        order: [anthropic, bedrock]",
          "        only: [anthropic, bedrock]",
          "        sort: cost",
          "tools: [read]",
        ].join("\n")
      );
      const ctx = extensionContext(projectDir);
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");

      createRecipesExtension()(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );

      expect(pi.activeTools).toEqual(["read"]);
      const results = await pi.emitExtensionEvent(
        {
          type: "before_provider_request",
          payload: {
            providerOptions: { gateway: { caching: "auto" } },
          },
        } as any,
        {
          ...ctx,
          model: {
            provider: "vercel-ai-gateway",
            api: "anthropic-messages",
          },
        }
      );
      expect(results).toContainEqual({
        providerOptions: {
          gateway: {
            caching: "auto",
            order: ["anthropic", "bedrock"],
            only: ["anthropic", "bedrock"],
            sort: "cost",
          },
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats an omitted subagents list as no visible subagents", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-empty-subagents-"));
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(recipeDir, "defs", "main.yaml"),
        [
          "name: main",
          "model:",
          "  name: openai/gpt-4.1",
          "  thinking_level: low",
          "tools:",
          "  - read",
          "system_instructions:",
          "  mode: append",
          "  content: Agent-specific prompt",
        ].join("\n")
      );
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");

      createRecipesExtension()(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        extensionContext(projectDir)
      );

      expect(pi.activeTools).toEqual(["read"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enables declared subagents when a named agent is invoked directly", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-direct-named-agent-"));
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(recipeDir, "defs", "explorer.yaml"),
        [
          "name: explorer",
          "model:",
          "  name: openai/gpt-4.1",
          "  thinking_level: low",
          "tools:",
          "  - read",
          "subagents:",
          "  - researcher",
          "system_instructions:",
          "  mode: append",
          "  content: Explorer prompt",
        ].join("\n")
      );
      writeFileSync(
        join(recipeDir, "defs", "researcher.yaml"),
        [
          "name: researcher",
          "model:",
          "  name: openai/gpt-4.1",
          "  thinking_level: low",
          "tools:",
          "  - read",
          "system_instructions:",
          "  mode: append",
          "  content: Researcher prompt",
        ].join("\n")
      );
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "explorer");

      createRecipesExtension()(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        extensionContext(projectDir)
      );

      expect(pi.activeTools.sort()).toEqual(["agent", "read"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("materializes a static MCP session for CLI-only use", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-mcp-"));
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(recipeDir, "defs", "main.yaml"),
        [
          "name: main",
          "model:",
          "  name: openai/gpt-4.1",
          "  thinking_level: low",
          "tools:",
          "  - bash",
          "mcp:",
          "  mode: cli",
          "  servers:",
          "    partner-mcp:",
          "      include:",
          "        - get_value",
          "skills: []",
          "subagents: []",
          "system_instructions:",
          "  mode: append",
          "  content: Agent-specific prompt",
        ].join("\n")
      );
      writeFileSync(
        join(recipeDir, "mcp.json"),
        JSON.stringify(
          {
            servers: [
              {
                id: "partner-mcp",
                name: "Partner MCP",
                host: "host.docker.internal",
                base_url: "http://host.docker.internal:3200/api/mcp",
                transport: "streamable_http",
                tools: [
                  {
                    name: "get_value",
                    description: "Read a value.",
                    input_schema: {
                      type: "object",
                      properties: { key: { type: "string" } },
                    },
                  },
                  { name: "set_value", description: "Store a value." },
                ],
              },
            ],
          },
          null,
          2
        )
      );
      writeFileSync(
        join(recipeDir, "package.json"),
        `${JSON.stringify(
          {
            name: "demo",
            version: "1.0.0",
            pi: {
              agents: ["defs/*.yaml"],
              mcp: {
                manifests: ["mcp.json"],
                servers: [
                  {
                    id: "partner-mcp",
                    required: true,
                    tools: { include: ["get_value"] },
                  },
                ],
              },
            },
          },
          null,
          2
        )}\n`
      );
      const env: NodeJS.ProcessEnv = {};
      const notify = vi.fn();
      const ctx = extensionContext(projectDir, notify);
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");

      createRecipesExtension({ env })(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );

      expect(pi.activeTools.sort()).toEqual(["bash"]);
      expect(pi.tools.has("mcp")).toBe(false);
      expect(notify).toHaveBeenCalledWith(
        "Recipe MCP: 1 server(s) configured; runtime warming in background",
        "info"
      );
      expect(env.PI_RECIPES_MCP_SESSION).toBe(
        join(projectDir, ".pi", "mcp-session.json")
      );
      expect(env.PI_RECIPES_MCP_BIN_DIR).toBe(join(projectDir, ".pi", "bin"));
      expect(env.PI_RECIPE_DIR).toBe(recipeDir);
      expect(env.PI_AGENT_NAME).toBe("main");
      expect(env.PATH?.split(delimiter)[0]).toBe(join(projectDir, ".pi", "bin"));
      expect(existsSync(join(projectDir, ".pi", "bin", "mcp"))).toBe(true);
      const materialized = JSON.parse(readFileSync(env.PI_RECIPES_MCP_SESSION!, "utf8"));
      expect(materialized.servers[0].catalog.map((tool: { name: string }) => tool.name)).toEqual([
        "get_value",
      ]);
      await pi.emitExtensionEvent(
        { type: "session_shutdown" } as any,
        ctx
      );
      expect(env.PI_RECIPE_DIR).toBeUndefined();
      expect(env.PI_AGENT_NAME).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not grant the root session a visible child's MCP policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-child-mcp-"));
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(recipeDir, "defs", "explorer.yaml"),
        [
          "name: explorer",
          "model:",
          "  name: openai/gpt-4.1",
          "  thinking_level: low",
          "tools:",
          "  - bash",
          "mcp:",
          "  mode: cli",
          "  servers:",
          "    partner-mcp:",
          "      include:",
          "        - get_value",
          "skills: []",
          "subagents: []",
          "system_instructions:",
          "  mode: append",
          "  content: Explorer prompt",
          "",
        ].join("\n")
      );
      writeFileSync(
        join(recipeDir, "mcp.json"),
        JSON.stringify({
          servers: [
            {
              id: "partner-mcp",
              base_url: "http://host.docker.internal:3200/api/mcp",
              tools: [
                { name: "get_value", description: "Read a value." },
                { name: "set_value", description: "Store a value." },
              ],
            },
          ],
        })
      );
      writeFileSync(
        join(recipeDir, "package.json"),
        `${JSON.stringify(
          {
            name: "demo",
            version: "1.0.0",
            pi: {
              agents: ["defs/*.yaml"],
              mcp: {
                manifests: ["mcp.json"],
                servers: [
                  {
                    id: "partner-mcp",
                    required: true,
                    tools: { include: ["get_value"] },
                  },
                ],
              },
            },
          },
          null,
          2
        )}\n`
      );
      const env: NodeJS.ProcessEnv = {};
      const notify = vi.fn();
      const ctx = extensionContext(projectDir, notify);
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");

      createRecipesExtension({ env })(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );

      expect(env.PI_RECIPES_MCP_BIN_DIR).toBeUndefined();
      expect(env.PI_RECIPES_MCP_SESSION).toBeUndefined();
      expect(notify).not.toHaveBeenCalledWith(
        expect.stringContaining("server(s) configured"),
        "info"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips MCP discovery when no active recipe agent opts into MCP", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-no-mcp-"));
    const originalFetch = globalThis.fetch;
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      const staleManifest = join(projectDir, ".pi", "mcp-session.json");
      writeFileSync(staleManifest, JSON.stringify({ version: 1, servers: [] }));
      const env: NodeJS.ProcessEnv = {
        PI_RECIPES_MCP_SESSION: staleManifest,
      };
      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
          headers: { "content-type": "application/json" },
        })
      ) as unknown as typeof fetch;
      globalThis.fetch = fetchImpl;
      const notify = vi.fn();
      const ctx = extensionContext(projectDir, notify);
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");

      createRecipesExtension({ env })(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(env.PI_RECIPES_MCP_SESSION).toBeUndefined();
      expect(existsSync(staleManifest)).toBe(false);
      expect(notify).not.toHaveBeenCalledWith(
        expect.stringContaining("Recipe MCP:"),
        expect.any(String)
      );
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs the session MCP CLI when an optional endpoint is unbound", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-mcp-empty-"));
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(recipeDir, "defs", "main.yaml"),
        [
          "name: main",
          "model:",
          "  name: openai/gpt-4.1",
          "  thinking_level: low",
          "tools:",
          "  - bash",
          "mcp:",
          "  mode: cli",
          "  servers:",
          "    slack:",
          "      include:",
          "        - slack_list_threads",
          "skills: []",
          "subagents: []",
          "system_instructions:",
          "  mode: append",
          "  content: Agent-specific prompt",
        ].join("\n")
      );
      writeFileSync(
        join(recipeDir, "package.json"),
        `${JSON.stringify(
          {
            name: "demo",
            version: "1.0.0",
            pi: {
              agents: ["defs/*.yaml"],
              mcp: {
                servers: [
                  {
                    id: "slack",
                    required: false,
                    tools: { include: ["slack_list_threads"] },
                  },
                ],
              },
            },
          },
          null,
          2
        )}\n`
      );
      const env: NodeJS.ProcessEnv = {};
      const notify = vi.fn();
      const ctx = extensionContext(projectDir, notify);
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");

      createRecipesExtension({ env })(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );

      expect(pi.activeTools.sort()).toEqual(["bash"]);
      expect(env.PI_RECIPES_MCP_BIN_DIR).toBe(join(projectDir, ".pi", "bin"));
      expect(env.PATH?.split(delimiter)[0]).toBe(join(projectDir, ".pi", "bin"));
      expect(existsSync(join(projectDir, ".pi", "bin", "mcp"))).toBe(true);
      expect(env.PI_RECIPES_MCP_SESSION).toBe(
        join(projectDir, ".pi", "mcp-session.json")
      );
      expect(notify).not.toHaveBeenCalledWith(
        expect.stringContaining("Recipe MCP:"),
        "info"
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Recipe MCP: no servers are available"),
        "warning"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reloads recipe state through the recipe command", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-reload-"));
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      const notify = vi.fn();
      const reload = vi.fn();
      const waitForIdle = vi.fn();
      const ctx = {
        ...extensionContext(projectDir, notify),
        reload,
        waitForIdle,
      } as any;
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");

      createRecipesExtension()(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );

      mkdirSync(join(recipeDir, "skills", "new-skill"), { recursive: true });
      writeFileSync(join(recipeDir, "skills", "new-skill", "SKILL.md"), "---\ndescription: New\n---\n");
      writeFileSync(
        join(recipeDir, "package.json"),
        `${JSON.stringify(
          {
            name: "demo",
            version: "1.0.0",
            pi: {
              agents: ["defs/*.yaml"],
              skills: ["skills/new-skill/SKILL.md"],
            },
          },
          null,
          2
        )}\n`
      );
      writeFileSync(
        join(recipeDir, "defs", "main.yaml"),
        [
          "name: main",
          "model:",
          "  name: openai/gpt-4.1",
          "  thinking_level: low",
          "tools:",
          "  - read",
          "  - bash",
          "skills:",
          "  - new-skill",
          "subagents:",
          "  - explorer",
          "system_instructions:",
          "  mode: append",
          "  content: Agent-specific prompt",
        ].join("\n")
      );

      await pi.commands.get("recipe")?.handler("reload", ctx);

      expect(waitForIdle).toHaveBeenCalled();
      expect(reload).toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(
        "Recipe reload requested: demo@1.0.0",
        "info"
      );

      const resourceResults = await pi.emitExtensionEvent(
        { type: "resources_discover", cwd: projectDir, reason: "reload" } as any,
        ctx
      );
      expect(resourceResults).toEqual([
        expect.objectContaining({
          skillPaths: [join(recipeDir, "skills", "new-skill", "SKILL.md")],
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses only agent system instructions when they replace the recipe prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-launch-"));
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(recipeDir, "defs", "main.yaml"),
        [
          "name: main",
          "model:",
          "  name: openai/gpt-4.1",
          "  thinking_level: low",
          "tools: []",
          "skills: []",
          "subagents: []",
          "system_instructions:",
          "  mode: replace",
          "  content: Agent replacement prompt",
        ].join("\n")
      );
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");

      createRecipesExtension()(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        extensionContext(projectDir)
      );

      const promptResults = await pi.emitExtensionEvent(
        {
          type: "before_agent_start",
          prompt: "hello",
          systemPrompt: "Default Pi prompt",
          systemPromptOptions: {},
        } as any,
        extensionContext(projectDir)
      );
      expect(promptResults).toEqual([
        {
          systemPrompt: "Agent replacement prompt",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads recipe extensions before selecting active recipe tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-launch-"));
    try {
      const recipeDir = writeRecipe(root);
      mkdirSync(join(recipeDir, "extensions"), { recursive: true });
      mkdirSync(join(recipeDir, "node_modules", "recipe-test-dep"), { recursive: true });
      writeFileSync(
        join(recipeDir, "defs", "main.yaml"),
        [
          "name: main",
          "model:",
          "  name: openai/gpt-4.1",
          "  thinking_level: low",
          "tools:",
          "  - setup_git",
          "skills: []",
          "subagents: []",
          "system_instructions:",
          "  mode: append",
          "  content: Main instructions",
        ].join("\n")
      );
      writeFileSync(
        join(recipeDir, "extensions", "a-setup-git.ts"),
        [
          "import { defineTool } from '@earendil-works/pi-coding-agent';",
          "import { askUserQuestion } from '@introspection-ai/recipes/interactions';",
          "import { Type } from 'typebox';",
          "import dep from 'recipe-test-dep';",
          "export default (pi) => {",
          "  if (dep.value !== 'loaded') throw new Error('recipe dependency did not load');",
          "  if (typeof defineTool !== 'function') throw new Error('pi-coding-agent did not load');",
          "  if (typeof askUserQuestion !== 'function') throw new Error('recipes interactions did not load');",
          "  if (typeof Type.Object !== 'function') throw new Error('typebox did not load');",
          "  pi.registerTool({",
          "    name: 'setup_git',",
          "    label: 'Setup git',",
          "    description: 'Prepare git auth',",
          "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
          "    async execute() {",
          "      return { content: [{ type: 'text', text: 'ok' }], details: {} };",
          "    },",
          "  });",
          "};",
        ].join("\n")
      );
      writeFileSync(
        join(recipeDir, "extensions", "z-optional-runtime.ts"),
        "export default () => { throw new Error('runtime-only extension unavailable'); };\n"
      );
      writeFileSync(
        join(recipeDir, "node_modules", "recipe-test-dep", "package.json"),
        JSON.stringify({ name: "recipe-test-dep", version: "1.0.0", main: "index.js" })
      );
      writeFileSync(
        join(recipeDir, "node_modules", "recipe-test-dep", "index.js"),
        "module.exports = { value: 'loaded' };\n"
      );
      writeFileSync(
        join(recipeDir, "package.json"),
        `${JSON.stringify(
          {
            name: "demo",
            version: "1.0.0",
            pi: {
              agents: ["defs/*.yaml"],
              extensions: ["extensions/*.ts"],
            },
          },
          null,
          2
        )}\n`
      );
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");
      createRecipesExtension()(pi);
      const notify = vi.fn();

      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        extensionContext(join(root, "project"), notify)
      );

      expect(pi.tools.has("setup_git")).toBe(true);
      expect(pi.activeTools).toEqual([]);
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("extension startup failed"),
        "warning"
      );
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "new" } as any,
        extensionContext(join(root, "project"), notify)
      );
      expect(notify).not.toHaveBeenCalledWith(
        expect.stringContaining('registration "setup_git" conflicts'),
        "warning"
      );
      expect(pi.activeTools).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads the complete ordered package extension closure", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-launch-"));
    try {
      const recipeDir = writeRecipe(root);
      mkdirSync(join(recipeDir, "extensions"), { recursive: true });
      writeFileSync(
        join(recipeDir, "defs", "main.yaml"),
        [
          "name: main",
          "model:",
          "  name: openai/gpt-4.1",
          "  thinking_level: low",
          "tools:",
          "  - setup_git",
          "skills: []",
          "subagents: []",
          "system_instructions:",
          "  mode: append",
          "  content: Main instructions",
        ].join("\n")
      );
      writeFileSync(
        join(recipeDir, "extensions", "setup-git.ts"),
        [
          "export default (pi) => {",
          "  pi.registerTool({",
          "    name: 'setup_git',",
          "    label: 'Setup git',",
          "    description: 'Prepare git auth',",
          "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
          "    async execute() {",
          "      return { content: [{ type: 'text', text: 'ok' }], details: {} };",
          "    },",
          "  });",
          "};",
        ].join("\n")
      );
      writeFileSync(
        join(recipeDir, "extensions", "optional-runtime.ts"),
        "export default () => {};\n"
      );
      writeFileSync(
        join(recipeDir, "package.json"),
        `${JSON.stringify(
          {
            name: "demo",
            version: "1.0.0",
            pi: {
              agents: ["defs/*.yaml"],
              extensions: [
                "extensions/setup-git.ts",
                "extensions/optional-runtime.ts",
              ],
            },
          },
          null,
          2
        )}\n`
      );
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");
      createRecipesExtension()(pi);
      const notify = vi.fn();

      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        extensionContext(join(root, "project"), notify)
      );

      expect(pi.tools.has("setup_git")).toBe(true);
      expect(pi.activeTools.sort()).toEqual(["setup_git"]);
      expect(notify).toHaveBeenCalledWith(
        "Recipe extensions: 2/2 loaded",
        "info"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an agent requests an unavailable tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-launch-"));
    try {
      const recipeDir = writeRecipe(root);
      writeFileSync(
        join(recipeDir, "defs", "main.yaml"),
        [
          "name: main",
          "model:",
          "  name: openai/gpt-4.1",
          "tools: [missing_tool]",
        ].join("\n")
      );
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");
      createRecipesExtension()(pi);
      const notify = vi.fn();

      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        extensionContext(join(root, "project"), notify)
      );

      expect(pi.activeTools).toEqual([]);
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(
          'Recipe agent "main" declares unavailable tool(s): missing_tool'
        ),
        "warning"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("streams recipe agent prompt and output through tool updates", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-launch-"));
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });

      const createChildAgentRunner = vi.fn((opts: any = {}) => {
        return {
          async start() {
            return undefined;
          },
          async prompt() {
            opts.onToolEvent?.({
              type: "start",
              id: "read-a",
              name: "read",
              args: { path: "src/a.ts" },
            });
            opts.onToolEvent?.({
              type: "start",
              id: "read-b",
              name: "read",
              args: { path: "src/b.ts" },
            });
            opts.onToolEvent?.({
              type: "end",
              id: "read-b",
              name: "read",
              args: { path: "src/b.ts" },
              result: { content: [{ type: "text", text: "file b" }], details: undefined },
              isError: false,
            });
            opts.onToolEvent?.({
              type: "end",
              id: "read-a",
              name: "read",
              args: { path: "src/a.ts" },
              result: { content: [{ type: "text", text: "file a" }], details: undefined },
              isError: false,
            });
            opts.onAssistantMessage?.("streamed output", "delta");
            return "streamed output final";
          },
          async steer() {},
          async cancel() {},
          async shutdown() {},
        };
      });
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");
      const ctx = extensionContext(projectDir);

      createRecipesExtension({ createChildAgentRunner })(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );

      const updates: AgentToolResult<any>[] = [];
      const result = await pi.tools.get("agent")?.execute(
        "tool-call-1",
        { name: "explorer", prompt: "inspect auth flow" },
        undefined,
        (update) => updates.push(update),
        ctx
      );
      const completed = await pi.tools.get("agent")?.execute(
        "tool-call-2",
        { action: "wait", id: result?.details?.agent?.agent_run_id },
        undefined,
        undefined,
        ctx
      );

      expect(createChildAgentRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          recipe: expect.objectContaining({ recipeDir }),
          agentName: "explorer",
          workspaceDir: projectDir,
          modelRegistry: ctx.modelRegistry,
        })
      );
      expect(updates[0]?.details?.subtasks?.[0]).toEqual(
        expect.objectContaining({
          task: "inspect auth flow",
        })
      );
      expect(
        updates.some((update) =>
          update.details?.subtasks?.[0]?.nestedTools?.some(
            (tool: { toolName: string }) => tool.toolName === "read"
          )
        )
      ).toBe(true);
      expect(completed?.content[0]).toEqual(
        expect.objectContaining({
          text: expect.stringContaining("streamed output final"),
        })
      );
      expect(completed?.details?.agent).toEqual(
        expect.objectContaining({
          prompt: "inspect auth flow",
          status: "completed",
          nested_tools: [
            expect.objectContaining({
              toolName: "read",
              detail: "file a",
            }),
            expect.objectContaining({
              toolName: "read",
              detail: "file b",
            }),
          ],
        })
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends scoped child events to Pi's canonical session stream", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-events-"));
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      const childEvent = {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "child answer" }],
          usage: { input: 3, output: 2, cacheRead: 1, cost: { total: 0.02 } },
        },
      };
      const droppedChildEvent = { type: "agent_start" };
      const createChildAgentRunner = vi.fn((opts: any = {}) => ({
        async start() {},
        async prompt() {
          opts.onEvent?.(droppedChildEvent);
          opts.onEvent?.(childEvent);
          opts.onAssistantMessage?.("child answer", "final");
          return "child answer";
        },
        async steer() {},
        async cancel() {},
        async shutdown() {},
      }));
      const onAgentRunEvent = vi.fn(async (_event: unknown) => {
        throw new Error("observer rejected");
      });
      const pi = createMockExtensionAPI();
      const appendEntry = pi.appendEntry.bind(pi);
      const appendEntrySpy = vi
        .spyOn(pi, "appendEntry")
        .mockImplementationOnce(() => {
          throw new Error("session persistence failed");
        })
        .mockImplementation(appendEntry);
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");
      const ctx = { ...extensionContext(projectDir), mode: "json" } as any;

      createRecipesExtension({ createChildAgentRunner, onAgentRunEvent })(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );
      const started = await pi.tools.get("agent")?.execute(
        "tool-call-1",
        { name: "explorer", prompt: "inspect" },
        undefined,
        undefined,
        ctx
      );
      const completed = await pi.tools.get("agent")?.execute(
        "tool-call-2",
        { action: "wait", id: started?.details?.agent?.agent_run_id },
        undefined,
        undefined,
        ctx
      );

      expect(completed?.details?.agent?.status).toBe("completed");
      const envelope = expect.objectContaining({
        type: "agent_run_event",
        agent_run_id: started?.details?.agent?.agent_run_id,
        parent_agent_run_id: "root",
        agent_name: "explorer",
        invocation_name: "explorer",
        depth: 1,
        event: childEvent,
      });
      expect(onAgentRunEvent).toHaveBeenCalledWith(envelope);
      expect(appendEntrySpy).toHaveBeenCalledTimes(2);
      expect(pi.entries).toEqual([
        {
          customType: "agent_run_event",
          data: onAgentRunEvent.mock.calls[1]?.[0],
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
