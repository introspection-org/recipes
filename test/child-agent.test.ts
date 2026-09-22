import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRecipe } from "../src/recipe/resolve.js";

const mocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  getModel: vi.fn(() => ({ provider: "openai", id: "test-model" })),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  getEnvApiKey: vi.fn(() => "test-key"),
  getModel: mocks.getModel,
}));

vi.mock("../src/session.js", () => ({
  createAgentSessionInternal: mocks.createAgentSession,
}));

import { createRecipeChildAgentRunner } from "../src/child/agent.js";

function writeRecipe(
  root: string,
  extras: string[] = []
): { recipeDir: string; workspaceDir: string } {
  const recipeDir = join(root, "recipe");
  const workspaceDir = join(root, "workspace");
  mkdirSync(join(recipeDir, "agents"), { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(recipeDir, "package.json"),
    JSON.stringify({
      name: "child-test",
      version: "0.1.0",
      pi: {
        agents: ["agents/*.yaml"],
        mcp: {
          servers: [
            {
              id: "contacts",
              tools: { include: ["search_contacts"] },
            },
          ],
        },
      },
    })
  );
  writeFileSync(
    join(recipeDir, "agents", "worker.yaml"),
    [
      "name: worker",
      "model:",
      "  name: openai/test-model",
      "  thinking_level: low",
      "tools: []",
      "skills: []",
      "subagents: []",
      ...extras,
      "system_instructions:",
      "  mode: append",
      "  content: Test worker",
      "",
    ].join("\n")
  );
  return { recipeDir, workspaceDir };
}

function mockHandle(
  messages: any[] = [{ role: "assistant", content: "done" }]
) {
  const listeners: Array<(event: any) => void> = [];
  const session = {
    messages,
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
  const handle = {
    session,
    dispose: vi.fn(async () => undefined),
  };
  mocks.createAgentSession.mockImplementation(
    async (options: { onEvent?: (event: any) => void }) => {
      if (options.onEvent) listeners.push(options.onEvent);
      return handle;
    }
  );
  return {
    handle,
    emit(event: any) {
      for (const listener of listeners) listener(event);
    },
  };
}

describe("Recipe child agent runner", () => {
  const roots: string[] = [];

  afterEach(() => {
    mocks.createAgentSession.mockReset();
    mocks.getModel.mockClear();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("constructs delegated agents through canonical Recipe sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-child-session-"));
    roots.push(root);
    const { recipeDir, workspaceDir } = writeRecipe(root);
    const recipe = resolveRecipe({ recipeDir });
    const resolved = recipe.selectAgent("worker");
    const { handle } = mockHandle();

    const runner = createRecipeChildAgentRunner({
      recipe,
      workspaceDir,
      agentName: "worker",
      env: {},
    });
    await runner.start();

    const sessionOptions = mocks.createAgentSession.mock.calls[0]?.[0];
    expect(mocks.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe,
        agentName: "worker",
        cwd: workspaceDir,
        env: {},
        modelOverride: expect.objectContaining({
          provider: "openai",
          id: "test-model",
        }),
        credentialsResolved: true,
        runController: null,
        sessionRole: "subagent",
      })
    );
    expect(sessionOptions.mcpRuntimeDir).not.toBe(workspaceDir);
    expect(existsSync(sessionOptions.mcpRuntimeDir)).toBe(true);

    expect(await runner.prompt("inspect")).toBe("done");
    expect(handle.session.prompt).toHaveBeenCalledWith("inspect");
    await runner.shutdown();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(existsSync(sessionOptions.mcpRuntimeDir)).toBe(false);
  });

  it("rejects terminal provider errors instead of returning empty success", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-child-provider-error-"));
    roots.push(root);
    const { recipeDir, workspaceDir } = writeRecipe(root);
    const recipe = resolveRecipe({ recipeDir });
    mockHandle([
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "413 Payload Too Large",
      },
    ]);

    const runner = createRecipeChildAgentRunner({
      recipe,
      workspaceDir,
      agentName: "worker",
      env: {},
    });

    await expect(runner.prompt("inspect")).rejects.toThrow(
      "413 Payload Too Large"
    );
    await runner.shutdown();
  });

  it("uses each resolved child's own MCP mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-child-mode-"));
    roots.push(root);
    const { recipeDir, workspaceDir } = writeRecipe(root, [
      "mcp:",
      "  mode: tools",
      "  servers:",
      "    contacts:",
      '      include: ["search_contacts"]',
      '      defer: ["*"]',
      '      eager: [" search_contacts "]',
    ]);
    const recipe = resolveRecipe({ recipeDir });
    const resolved = recipe.selectAgent("worker");
    mockHandle();

    const runner = createRecipeChildAgentRunner({
      recipe,
      workspaceDir,
      agentName: "worker",
      env: {},
    });
    await runner.start();

    expect(resolved.mcp?.mode).toBe("tools");
    expect(resolved.mcp?.servers.contacts).toMatchObject({
      defer: ["*"],
      eager: ["search_contacts"],
    });
    const sessionOptions = mocks.createAgentSession.mock.calls[0]?.[0];
    expect(sessionOptions?.recipe).toBe(recipe);
    expect(sessionOptions?.agentName).toBe("worker");
    expect(sessionOptions).not.toHaveProperty(
      "mcpProvisioning"
    );
    await runner.shutdown();
  });

  it("forwards canonical session events to the parent UI", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-child-events-"));
    roots.push(root);
    const { recipeDir, workspaceDir } = writeRecipe(root);
    const recipe = resolveRecipe({ recipeDir });
    const { emit } = mockHandle();
    const onToolEvent = vi.fn();
    const onAssistantMessage = vi.fn();
    const onEvent = vi.fn();

    const runner = createRecipeChildAgentRunner({
      recipe,
      workspaceDir,
      agentName: "worker",
      env: {},
      onEvent,
      onToolEvent,
      onAssistantMessage,
    });
    await runner.start();
    emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "working" },
    });

    expect(onToolEvent).toHaveBeenCalledWith({
      type: "start",
      id: "call-1",
      name: "read",
      args: { path: "README.md" },
    });
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "tool_execution_start" })
    );
    expect(onAssistantMessage).toHaveBeenCalledWith("working", "delta");
    await runner.shutdown();
  });
});
