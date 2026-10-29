import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RecipeResolutionError,
  resolveRecipe,
} from "../src/recipe/resolve.js";

const roots: string[] = [];

function makeRecipe(): string {
  const recipeDir = mkdtempSync(join(tmpdir(), "pi-recipe-session-"));
  roots.push(recipeDir);
  mkdirSync(join(recipeDir, "agents"));
  mkdirSync(join(recipeDir, "extensions", "operator"), { recursive: true });
  mkdirSync(join(recipeDir, "extensions", "unused"), { recursive: true });
  mkdirSync(join(recipeDir, "skills", "research"), { recursive: true });
  mkdirSync(join(recipeDir, "prompts"));
  writeFileSync(
    join(recipeDir, "package.json"),
    JSON.stringify({
      name: "fixture-recipe",
      version: "1.0.0",
      pi: {
        agents: ["agents"],
        extensions: ["extensions/operator/index.ts", "extensions/unused/index.ts"],
        skills: ["skills"],
        prompts: ["prompts"],
      },
    })
  );
  writeFileSync(
    join(recipeDir, "agents", "base.yaml"),
    [
      "name: base",
      "description: Base",
      "model:",
      "  name: openai/gpt-5",
      "  thinking_level: high",
      "tools: [read, mcp__search]",
      "skills: [research]",
      "subagents: []",
      "system_instructions:",
      "  mode: append",
      "  content: Base instructions",
    ].join("\n")
  );
  writeFileSync(
    join(recipeDir, "agents", "agent.yaml"),
    [
      "name: agent",
      "from: base",
      "description: Researcher",
    ].join("\n")
  );
  writeFileSync(join(recipeDir, "extensions", "operator", "index.ts"), "export default () => {};\n");
  writeFileSync(join(recipeDir, "extensions", "unused", "index.ts"), "export default () => {};\n");
  writeFileSync(join(recipeDir, "skills", "research", "SKILL.md"), "---\ndescription: Research\n---\n");
  writeFileSync(join(recipeDir, "prompts", "review.md"), "Review\n");
  writeFileSync(join(recipeDir, "SYSTEM.md"), "Recipe system prompt\n");
  return recipeDir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolved Recipe agents", () => {
  it("returns inputs that map directly to a Pi session", () => {
    const recipeDir = makeRecipe();
    const resolved = resolveRecipe({ recipeDir }).selectAgent();

    expect(resolved.name).toBe("agent");
    expect(resolved.modelSpec).toBe("openai/gpt-5");
    expect(resolved.thinkingLevel).toBe("high");
    expect(resolved.tools).toEqual(["read", "mcp__search"]);
    expect(resolved.extensionPaths).toEqual([
      join(recipeDir, "extensions", "operator", "index.ts"),
      join(recipeDir, "extensions", "unused", "index.ts"),
    ]);
    expect(resolved.skillPaths).toEqual([
      join(recipeDir, "skills", "research", "SKILL.md"),
    ]);
    expect(resolved.promptPaths).toEqual([join(recipeDir, "prompts")]);
    expect(resolved.systemPromptOverride("Pi base prompt")).toBe(
      "Recipe system prompt\n\nBase instructions"
    );
  });

  it("does not use filenames as agent aliases", () => {
    const recipeDir = makeRecipe();
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      "name: researcher\nfrom: base\n"
    );

    expect(() =>
      resolveRecipe({ recipeDir }).selectAgent("agent")
    ).toThrow('Recipe agent "agent" was not found');
    expect(resolveRecipe({ recipeDir }).selectAgent("researcher").name).toBe(
      "researcher"
    );
  });

  it("allows a derived agent to contain only from", () => {
    const recipeDir = makeRecipe();
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      "name: agent\nfrom: base\n"
    );

    const resolved = resolveRecipe({ recipeDir }).selectAgent();

    expect(resolved.name).toBe("agent");
    expect(resolved.modelSpec).toBe("openai/gpt-5");
  });

  it("composes appended instructions along the from chain", () => {
    const recipeDir = makeRecipe();
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "from: base",
        "system_instructions:",
        "  mode: append",
        "  content: Child instructions",
      ].join("\n")
    );

    expect(
      resolveRecipe({ recipeDir }).selectAgent().systemPromptOverride("Pi base prompt")
    ).toBe(
      "Recipe system prompt\n\nBase instructions\n\nChild instructions"
    );
  });

  it("resolves the Recipe once for root and child sessions", () => {
    const recipeDir = makeRecipe();
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "from: base",
        "description: Researcher",
        "subagents: [base]",
      ].join("\n")
    );

    const recipe = resolveRecipe({ recipeDir });
    const root = recipe.selectAgent();
    const selected = recipe.selectAgent("agent");
    const child = recipe.selectAgent("base");

    expect(selected).toBe(root);
    expect(root.name).toBe("agent");
    expect(root.subagents.get("base")).toBe(child.definition);
    expect(child.name).toBe("base");
    expect(child.extensionPaths).toEqual(root.extensionPaths);
    expect(child.tools).not.toContain("agent");
  });

  it("exposes an immutable resolved agent graph", () => {
    const recipeDir = makeRecipe();
    const recipe = resolveRecipe({ recipeDir });
    const agent = recipe.selectAgent();

    expect(Object.isFrozen(recipe)).toBe(true);
    expect(Object.isFrozen(agent)).toBe(true);
    expect(Object.isFrozen(agent.definition)).toBe(true);
    expect(Object.isFrozen(agent.tools)).toBe(true);
    expect(() =>
      (recipe.agents as Map<string, typeof agent>).set("other", agent)
    ).toThrow("Resolved Recipe maps are immutable");
    recipe.agents.forEach((_value, _key, map) => {
      expect(map).toBe(recipe.agents);
      expect(() =>
        (map as Map<string, typeof agent>).clear()
      ).toThrow("Resolved Recipe maps are immutable");
    });
    expect(() => (agent.tools as string[]).push("write")).toThrow();
    expect(() => agent.definition.tools.push("write")).toThrow();
  });

  it("uses safe defaults for omitted optional agent fields", () => {
    const recipeDir = makeRecipe();
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      ["name: agent", "model:", "  name: openai/gpt-5", ""].join("\n")
    );
    rmSync(join(recipeDir, "agents", "base.yaml"));

    const resolved = resolveRecipe({ recipeDir }).selectAgent();

    expect(resolved.name).toBe("agent");
    expect(resolved.thinkingLevel).toBeUndefined();
    expect(resolved.tools).toEqual([]);
    expect(resolved.systemPromptOverride("Pi base prompt")).toBe(
      "Recipe system prompt"
    );
  });

  it("keeps session-generated delegation out of authored resolved tools", () => {
    const recipeDir = makeRecipe();
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "from: base",
        "description: Researcher",
        "subagents: [base]",
      ].join("\n")
    );

    const resolved = resolveRecipe({ recipeDir }).selectAgent();

    expect([...resolved.subagents.keys()]).toEqual(["base"]);
    expect(resolved.tools).toEqual(["read", "mcp__search"]);
  });

  it("replaces inherited MCP policy when the child declares mcp", () => {
    const recipeDir = makeRecipe();
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "fixture-recipe",
        version: "1.0.0",
        pi: {
          agents: ["agents"],
          mcp: {
            servers: [{ id: "contacts", tools: { include: ["*"] } }],
          },
        },
      })
    );
    writeFileSync(
      join(recipeDir, "agents", "base.yaml"),
      [
        "name: base",
        "model:",
        "  name: openai/gpt-5",
        "tools: []",
        "mcp:",
        "  mode: tools",
        "  servers:",
        "    contacts:",
        '      include: ["*"]',
        '      defer: ["*"]',
        "system_instructions:",
        "  content: Base",
      ].join("\n")
    );
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "from: base",
        "mcp:",
        "  mode: tools",
        "  servers:",
        "    contacts:",
        '      include: ["*"]',
        '      defer: ["*"]',
        "      eager: [search_contacts]",
      ].join("\n")
    );

    const resolved = resolveRecipe({ recipeDir }).selectAgent();

    expect(resolved.mcp).toEqual({
      mode: "tools",
      codemode: true,
      servers: {
        contacts: {
          include: ["*"],
          defer: ["*"],
          eager: ["search_contacts"],
        },
      },
    });
  });

  it("defaults to tools mode with codemode, and refuses codemode in cli mode", () => {
    const agent = (mcp: string[]) => {
      const recipeDir = makeRecipe();
      writeFileSync(
        join(recipeDir, "package.json"),
        JSON.stringify({
          name: "fixture-recipe",
          version: "1.0.0",
          pi: {
            agents: ["agents"],
            mcp: {
              servers: [{ id: "contacts", tools: { include: ["*"] } }],
            },
          },
        })
      );
      writeFileSync(
        join(recipeDir, "agents", "agent.yaml"),
        [
          "name: agent",
          "model:",
          "  name: openai/gpt-5",
          "tools: []",
          "mcp:",
          ...mcp,
          "  servers:",
          "    contacts:",
          '      include: ["*"]',
          "system_instructions:",
          "  content: Test",
        ].join("\n")
      );
      return () => resolveRecipe({ recipeDir }).selectAgent();
    };

    expect(agent(["  mode: tools", "  codemode: true"])().mcp?.codemode).toBe(
      true
    );
    expect(agent(["  mode: cli"])().mcp?.codemode).toBe(false);
    // An omitted mode is tools, and tools mode brings codemode unless refused.
    expect(agent([])().mcp).toMatchObject({ mode: "tools", codemode: true });
    expect(
      agent(["  mode: tools", "  codemode: false"])().mcp?.codemode
    ).toBe(false);
    expect(agent(["  codemode: true"])().mcp?.codemode).toBe(true);
    expect(agent(["  mode: cli", "  codemode: true"])).toThrow(
      "has an invalid MCP policy"
    );
    expect(agent(["  mode: tools", "  codemode: sometimes"])).toThrow(
      "has an invalid MCP policy"
    );
  });

  it("rejects defer and eager selectors outside tools mode", () => {
    const recipeDir = makeRecipe();
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "model:",
        "  name: openai/gpt-5",
        "tools: []",
        "mcp:",
        "  mode: cli",
        "  servers:",
        "    contacts:",
        '      defer: ["*"]',
        "system_instructions:",
        "  content: Test",
      ].join("\n")
    );

    expect(() => resolveRecipe({ recipeDir }).selectAgent()).toThrow(
      "has an invalid MCP policy"
    );
  });

  it("fails before returning a partial session configuration", () => {
    const recipeDir = makeRecipe();
    expect(() =>
      resolveRecipe({ recipeDir }).selectAgent("missing")
    ).toThrow(RecipeResolutionError);
  });
});
