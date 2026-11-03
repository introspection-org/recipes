import { writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { createRecipesExtension } from "../src/pi-extension.js";
import {
  prepareRecipePython,
  RecipePythonOutdatedError,
} from "../src/recipe/python.js";
import { resolveRecipe } from "../src/recipe/resolve.js";
import {
  createAgentSession,
  createAgentSessionInternal,
  type RecipeSessionHandle,
} from "../src/session.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";
import { fakeUv, pythonProject, scratch } from "./helpers/fake-uv.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const IS_WINDOWS = process.platform === "win32";

function pythonRecipe(tools = ["read", "bash"]) {
  const fixture = writeFixtureRecipe({
    tools,
    manifestPi: { runtime: { python: { project: "python", lockfile: "python/uv.lock" } } },
  });
  pythonProject(fixture.recipeDir);
  return fixture;
}

function hostEnv(extra: Record<string, string> = {}) {
  const uv = fakeUv();
  const root = scratch("recipe-python-host-root-");
  const env: NodeJS.ProcessEnv = {
    ...cleanEnv(),
    PATH: `${uv.bin}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_UV_LOG: uv.log,
    PI_RECIPES_PYTHON_ROOT: root,
    ...extra,
  };
  return { uv, root, env };
}

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

describe.skipIf(IS_WINDOWS)("Pi extension: Recipe Python", () => {
  it("installs on load, says so on a first build, activates the shell environment and restores it", async () => {
    const { recipeDir, workspaceDir, cleanup } = pythonRecipe();
    try {
      const { uv, root, env } = hostEnv({ PYTHONHOME: "/elsewhere" });
      const originalPath = env.PATH;
      env.PI_RECIPE_DIR = recipeDir;
      const pi = createMockExtensionAPI();
      const notify = vi.fn();
      createRecipesExtension({ env })(pi);
      await pi.emitExtensionEvent({ type: "session_start", reason: "startup" } as any, extensionContext(workspaceDir, notify));

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Python: downloading packages for conformance-fixture"), "info");
      const shell = join(root, "python");
      expect(env.VIRTUAL_ENV).toBe(shell);
      expect(env.UV_PROJECT_ENVIRONMENT).toBe(shell);
      expect(env.PATH?.split(delimiter)[0]).toBe(join(shell, "bin"));
      expect(env.PYTHONHOME).toBeUndefined();
      const syncs = uv.calls().filter((call) => call.args.includes("--compile-bytecode"));
      // Downloads are allowed when Pi loads a Recipe.
      expect(syncs).toHaveLength(1);
      expect(syncs[0]!.args).not.toContain("--no-python-downloads");
      expect(pi.activeTools).toContain("bash");

      await pi.emitExtensionEvent({ type: "session_shutdown" } as any, extensionContext(workspaceDir));
      expect(env.VIRTUAL_ENV).toBeUndefined();
      expect(env.UV_PROJECT_ENVIRONMENT).toBeUndefined();
      expect(env.PYTHONHOME).toBe("/elsewhere");
      expect(env.PATH).toBe(originalPath);
    } finally {
      cleanup();
    }
  });

  it("refuses to start when the environment cannot be prepared", async () => {
    const { recipeDir, workspaceDir, cleanup } = pythonRecipe();
    try {
      const { env } = hostEnv({ FAKE_UV_SYNC_EXIT: "1", FAKE_UV_SYNC_STDERR: "error: synthetic network failure" });
      env.PI_RECIPE_DIR = recipeDir;
      const pi = createMockExtensionAPI();
      const notify = vi.fn();
      createRecipesExtension({ env })(pi);
      await pi.emitExtensionEvent({ type: "session_start", reason: "startup" } as any, extensionContext(workspaceDir, notify));

      expect(notify).toHaveBeenCalledWith(
        expect.stringMatching(/Recipe session cannot start: Python environment could not be prepared[\s\S]*synthetic network failure/),
        "warning"
      );
      expect(pi.activeTools).toEqual([]);
      expect(env.VIRTUAL_ENV).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe.skipIf(IS_WINDOWS)("session API: Recipe Python", () => {
  async function credentials() {
    const store = new InMemoryCredentialStore();
    await store.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
    return store;
  }

  it("never installs: an unprepared environment fails construction", async () => {
    const { recipeDir, workspaceDir, cleanup } = pythonRecipe();
    try {
      const { uv, env } = hostEnv();
      await expect(
        createAgentSession({ recipe: resolveRecipe({ recipeDir }), cwd: workspaceDir, env, credentials: await credentials() })
      ).rejects.toBeInstanceOf(RecipePythonOutdatedError);
      expect(uv.calls().some((call) => call.args[0] === "sync" && !call.args.includes("--check"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("checks a prepared environment and runs bash inside it", async () => {
    const { recipeDir, workspaceDir, cleanup } = pythonRecipe();
    try {
      const { uv, root, env } = hostEnv({ PYTHONHOME: "/elsewhere" });
      await prepareRecipePython(recipeDir, { mode: "sync", env, environmentRoot: root });
      const before = uv.calls().length;
      const handle = await createAgentSession({
        recipe: resolveRecipe({ recipeDir }),
        cwd: workspaceDir,
        env,
        credentials: await credentials(),
      });
      try {
        const calls = uv.calls().slice(before).filter((call) => call.args[0] === "sync");
        expect(calls.every((call) => call.args.includes("--check"))).toBe(true);
        const bash = handle.session.agent.state.tools.find((tool) => tool.name === "bash");
        const result = await bash!.execute(
          "call-1",
          { command: 'printf "%s|%s|%s" "$VIRTUAL_ENV" "${PYTHONHOME-unset}" "$(command -v python)"' } as never,
          undefined,
          undefined
        );
        const text = (result.content[0] as { text: string }).text.trim();
        const shell = join(root, "python");
        expect(text).toBe(`${shell}|unset|${join(shell, "bin", "python")}`);
      } finally {
        await handle.dispose();
      }
    } finally {
      cleanup();
    }
  });

  /** Reply `text` to every prompt without a provider. */
  function scriptReply(handle: RecipeSessionHandle, text: string): void {
    const message = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    } as const;
    handle.session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } } as never);
        stream.push({ type: "done", reason: "stop", message } as never);
      });
      return stream;
    };
  }

  it("checks every in-process subagent, nested ones too, against the root the host passed", async () => {
    // agent -> background -> explorer, each checking the Recipe environment.
    const fixture = writeFixtureRecipe({
      tools: ["read"],
      subagents: ["background", "explorer"],
      manifestPi: { runtime: { python: { project: "python", lockfile: "python/uv.lock" } } },
    });
    pythonProject(fixture.recipeDir);
    writeFileSync(
      join(fixture.recipeDir, "agents", "background.yaml"),
      ["name: background", "model:", "  name: anthropic/claude-sonnet-4-5", "tools: [read]", "subagents: [explorer]", ""].join("\n")
    );
    try {
      const { uv, root, env } = hostEnv();
      await prepareRecipePython(fixture.recipeDir, { mode: "sync", env, environmentRoot: root });
      // Only the explicit option names the root; the shared cache is unprepared.
      delete env.PI_RECIPES_PYTHON_ROOT;
      const store = await credentials();
      const children = new Map<string, RecipeSessionHandle>();
      const handle = await createAgentSessionInternal({
        recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
        cwd: fixture.workspaceDir,
        env,
        credentials: store,
        pythonEnvironmentRoot: root,
        sessionFactory: async (options) => {
          const child = await createAgentSessionInternal({ ...options, credentials: store });
          scriptReply(child, `${options.agentName} done`);
          children.set(options.agentName!, child);
          return child;
        },
      });
      try {
        const background = await handle.agentRuns.start({ name: "background", prompt: "plan" });
        expect(await handle.agentRuns.wait(background.agent_run_id)).toMatchObject({ status: "completed" });
        const nested = children.get("background")!.agentRuns;
        const explorer = await nested.start({ name: "explorer", prompt: "find" });
        expect(await nested.wait(explorer.agent_run_id)).toMatchObject({ status: "completed" });
        const checks = uv.calls().filter((call) => call.args.includes("--check"));
        expect(checks.length).toBeGreaterThanOrEqual(3);
        expect(checks.every((call) => call.project === join(root, "python"))).toBe(true);
      } finally {
        await handle.dispose();
      }
    } finally {
      fixture.cleanup();
    }
  });
});
