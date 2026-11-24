import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { resolveRecipe } from "../src/recipe/resolve.js";
import {
  createAgentSession,
  createAgentSessionInternal,
  type CreateAgentSessionInternalOptions,
  type RecipeSessionHandle,
} from "../src/session.js";
import { writeFixtureRecipe, cleanEnv } from "../src/test-utils.js";

it("restores the SDK provider and effort for the root and its nested runs", async () => {
  const { recipeDir, workspaceDir: cwd, cleanup } = writeFixtureRecipe();
  const handles: RecipeSessionHandle[] = [];
  try {
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "subagents: [worker]",
        "ai:",
        "  default_model: primary",
        "  models:",
        "    primary: { provider: openai, model: gpt-5, thinking_level: high }",
        "    other: { provider: anthropic, model: claude-sonnet-4-5, thinking_level: low }",
      ].join("\n"),
    );
    writeFileSync(
      join(recipeDir, "agents", "worker.yaml"),
      "name: worker\nfrom: agent\nsubagents: [leaf]\n",
    );
    writeFileSync(
      join(recipeDir, "agents", "leaf.yaml"),
      "name: leaf\nfrom: agent\nsubagents: []\n",
    );
    const children = new Map<string, RecipeSessionHandle>();
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("anthropic", async () => ({
      type: "api_key",
      key: "test-key",
    }));
    const opts = {
      recipe: resolveRecipe({ recipeDir }),
      cwd,
      async sessionFactory(options: CreateAgentSessionInternalOptions) {
        const child = await createAgentSessionInternal(options);
        children.set(child.agent.name, child);
        vi.spyOn(child.session, "prompt").mockResolvedValue(undefined);
        return child;
      },
      env: cleanEnv(),
      credentials,
      sessionManager: SessionManager.inMemory(cwd),
    };
    const first = await createAgentSession({
      ...opts,
      recipeProvider: "anthropic",
    });
    handles.push(first);
    expect(first.session.model?.provider).toBe("anthropic");
    const resumed = await createAgentSession(opts);
    handles.push(resumed);
    expect(resumed.session.model?.id).toBe("claude-sonnet-4-5");
    expect(resumed.session.thinkingLevel).toBe("low");
    let parent = resumed;
    for (const name of ["worker", "leaf"]) {
      const run = await parent.agentRuns.start({ name, prompt: "check" });
      expect((await parent.agentRuns.wait(run.agent_run_id)).status).toBe(
        "completed",
      );
      parent = children.get(name)!;
      expect(parent.session.model?.provider).toBe("anthropic");
      expect(parent.session.thinkingLevel).toBe("low");
    }
  } finally {
    for (const handle of handles) await handle.dispose();
    cleanup();
  }
});
