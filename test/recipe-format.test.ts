import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  packageResourcePaths,
  readPiPackageManifest,
  validatePiPackageManifest,
} from "../src/recipe-package.js";
import { resolveRecipe } from "../src/recipe/resolve.js";
import { SLACK_RECIPE_CHANNEL_PACKAGE } from "./helpers/recipe-connectors.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "recipe-format-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "agents"), { recursive: true });
  mkdirSync(join(root, "skills", "research"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "complete-agent",
      version: "1.0.0",
      description: "A complete portable Pi agent",
      pi: {
        agents: ["agents/*.yaml"],
        skills: ["skills/**/SKILL.md"],
      },
    })
  );
  writeFileSync(
    join(root, "agents", "agent.yaml"),
    [
      "name: agent",
      "model:",
      "  name: anthropic/claude-sonnet-4-5",
      "  thinking_level: high",
      "tools: [read]",
      "skills: [research]",
      "system_instructions:",
      "  mode: append",
      "  content: Produce a sourced answer.",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(root, "skills", "research", "SKILL.md"),
    "---\nname: research\ndescription: Research with sources.\n---\n"
  );
  return root;
}

describe("Recipe Format", () => {
  it.each([true, false, "true", 1, null])("validates requireReply %s", (requireReply) => {
    const recipeDir = fixture();
    const pkg = JSON.parse(readFileSync(join(recipeDir, "package.json"), "utf8"));
    pkg.pi.channels = [{ provider: "slack", requireReply }];
    pkg.dependencies = { [SLACK_RECIPE_CHANNEL_PACKAGE]: "0.1.0" };
    writeFileSync(join(recipeDir, "package.json"), JSON.stringify(pkg));
    const manifest = readPiPackageManifest(recipeDir);
    expect(validatePiPackageManifest(manifest).valid).toBe(typeof requireReply === "boolean");
    if (typeof requireReply === "boolean") expect(manifest.channels?.[0]?.requireReply).toBe(requireReply);
  });
  it.each([
    { commands: ["read", "reply"], valid: true },
    { commands: [], valid: true },
    { commands: ["read", "read"], valid: false },
    { commands: [""], valid: false },
    { commands: "read", valid: false },
    { commands: [42], valid: false },
  ])("validates connector command allowlist $commands", ({ commands, valid }) => {
    const recipeDir = fixture();
    const pkg = JSON.parse(readFileSync(join(recipeDir, "package.json"), "utf8"));
    pkg.pi.channels = [{ provider: "slack", commands }];
    pkg.dependencies = { [SLACK_RECIPE_CHANNEL_PACKAGE]: "0.1.0" };
    writeFileSync(join(recipeDir, "package.json"), JSON.stringify(pkg));
    const manifest = readPiPackageManifest(recipeDir);
    expect(validatePiPackageManifest(manifest).valid).toBe(valid);
    if (valid) expect(manifest.channels?.[0]?.commands).toEqual(commands);
  });

  it("reads a declarative Slack connector", () => {
    const recipeDir = fixture();
    const pkg = JSON.parse(
      readFileSync(join(recipeDir, "package.json"), "utf8")
    );
    pkg.pi.channels = [{ provider: "slack" }];
    pkg.dependencies = { [SLACK_RECIPE_CHANNEL_PACKAGE]: "0.1.0" };
    writeFileSync(join(recipeDir, "package.json"), JSON.stringify(pkg));

    const manifest = readPiPackageManifest(recipeDir);
    expect(manifest.channels).toEqual([{ provider: "slack" }]);
    expect(validatePiPackageManifest(manifest)).toEqual({
      valid: true,
      findings: [],
    });
  });

  it("rejects connector-wide tool configuration", () => {
    const recipeDir = fixture();
    const pkg = JSON.parse(
      readFileSync(join(recipeDir, "package.json"), "utf8")
    );
    pkg.pi.channels = [
      {
        provider: "slack",
        tools: { include: ["slack_origin"] },
      },
    ];
    pkg.dependencies = { [SLACK_RECIPE_CHANNEL_PACKAGE]: "0.1.0" };
    writeFileSync(join(recipeDir, "package.json"), JSON.stringify(pkg));

    expect(
      validatePiPackageManifest(readPiPackageManifest(recipeDir)).findings
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "package.json#pi.channels[0] contains unknown field(s): tools",
        }),
      ])
    );
  });

  it("derives the connector package from the provider", () => {
    const recipeDir = fixture();
    const pkg = JSON.parse(
      readFileSync(join(recipeDir, "package.json"), "utf8")
    );
    pkg.pi.channels = [{ provider: "discord" }];
    pkg.dependencies = {
      "@introspection-ai/recipe-channel-discord": "0.1.0",
    };
    writeFileSync(join(recipeDir, "package.json"), JSON.stringify(pkg));

    const report = validatePiPackageManifest(
      readPiPackageManifest(recipeDir)
    );
    expect(report).toEqual({ valid: true, findings: [] });
  });

  it("leaves connector tool enforcement to the loaded connector package", () => {
    const recipeDir = fixture();
    const pkg = JSON.parse(
      readFileSync(join(recipeDir, "package.json"), "utf8")
    );
    pkg.pi.channels = [{ provider: "slack" }];
    pkg.dependencies = { [SLACK_RECIPE_CHANNEL_PACKAGE]: "0.1.0" };
    writeFileSync(join(recipeDir, "package.json"), JSON.stringify(pkg));
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "model:",
        "  name: anthropic/claude-sonnet-4-5",
        "tools: [channel_read, channel_reply]",
        "",
      ].join("\n")
    );

    expect(resolveRecipe({ recipeDir }).agents.get("agent")?.tools).toEqual([
      "channel_read",
      "channel_reply",
    ]);
  });

  it("does not reserve unrecognized tools that share the Slack prefix", () => {
    const recipeDir = fixture();
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "model:",
        "  name: anthropic/claude-sonnet-4-5",
        "tools: [slack_custom_report]",
        "",
      ].join("\n")
    );

    expect(resolveRecipe({ recipeDir }).agents.get("agent")?.tools).toEqual([
      "slack_custom_report",
    ]);
  });

  it("requires the Slack connector package when Slack is declared", () => {
    const recipeDir = fixture();
    const pkg = JSON.parse(
      readFileSync(join(recipeDir, "package.json"), "utf8")
    );
    pkg.pi.channels = [{ provider: "slack" }];
    writeFileSync(join(recipeDir, "package.json"), JSON.stringify(pkg));

    const report = validatePiPackageManifest(readPiPackageManifest(recipeDir));

    expect(report.valid).toBe(false);
    expect(report.findings.map((finding) => finding.message)).toContain(
      `package.json#pi.channels provider 'slack' requires dependency '${SLACK_RECIPE_CHANNEL_PACKAGE}'`
    );
  });

  it("allows an extension-owned tool search name", () => {
    const recipeDir = fixture();
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "model:",
        "  name: anthropic/claude-sonnet-4-5",
        "tools: [tool_search]",
        "",
      ].join("\n")
    );

    expect(resolveRecipe({ recipeDir }).agents.get("agent")?.tools).toEqual([
      "tool_search",
    ]);
  });

  it("resolves locked Python and approved system runtime requirements", () => {
    const recipeDir = fixture();
    mkdirSync(join(recipeDir, "python"), { recursive: true });
    writeFileSync(join(recipeDir, "python", "pyproject.toml"), "[project]\nname='controls'\n");
    writeFileSync(join(recipeDir, "python", "uv.lock"), "version = 1\n");
    const pkg = JSON.parse(readFileSync(join(recipeDir, "package.json"), "utf8"));
    pkg.pi.runtime = {
      python: {
        project: "python",
        lockfile: "python/uv.lock",
        version: ">=3.12,<3.15",
        imports: ["pandas", "openpyxl"],
      },
      system: {
        packages: [{ id: "document.pdf-tools", version: "1" }],
      },
    };
    writeFileSync(join(recipeDir, "package.json"), JSON.stringify(pkg));

    expect(readPiPackageManifest(recipeDir).runtime).toEqual({
      python: {
        project: "python",
        lockfile: "python/uv.lock",
        version: ">=3.12,<3.15",
        imports: ["pandas", "openpyxl"],
      },
      system: {
        packages: [{ id: "document.pdf-tools", version: "1" }],
      },
    });
  });

  it("scopes resource globs and skips installed dependency trees", () => {
    const recipeDir = mkdtempSync(join(tmpdir(), "recipe-format-globs-"));
    cleanups.push(() => rmSync(recipeDir, { recursive: true, force: true }));
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    mkdirSync(join(recipeDir, "skills", "research"), { recursive: true });
    mkdirSync(join(recipeDir, "skills", "research", "node_modules", "decoy"), {
      recursive: true,
    });
    mkdirSync(join(recipeDir, "node_modules", "decoy", "skills"), {
      recursive: true,
    });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "scoped-globs",
        pi: {
          agents: ["agents/*.yaml"],
          skills: ["skills/**/SKILL.md"],
        },
      })
    );
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      "name: agent\nmodel:\n  name: anthropic/claude-sonnet-4-5\n"
    );
    writeFileSync(join(recipeDir, "skills", "research", "SKILL.md"), "---\nname: research\n---\n");
    writeFileSync(
      join(recipeDir, "skills", "research", "node_modules", "decoy", "SKILL.md"),
      "decoy\n"
    );
    writeFileSync(join(recipeDir, "node_modules", "decoy", "skills", "SKILL.md"), "decoy\n");

    const manifest = readPiPackageManifest(recipeDir);
    expect(packageResourcePaths(manifest, "skills")).toEqual([
      join(recipeDir, "skills", "research", "SKILL.md"),
    ]);
  });

  it("keeps root-anchored resource globs package-wide", () => {
    const recipeDir = mkdtempSync(join(tmpdir(), "recipe-format-root-glob-"));
    cleanups.push(() => rmSync(recipeDir, { recursive: true, force: true }));
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    mkdirSync(join(recipeDir, "nested"), { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "root-glob",
        pi: {
          agents: ["agents/*.yaml"],
          prompts: ["**/*.md"],
        },
      })
    );
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      "name: agent\nmodel:\n  name: anthropic/claude-sonnet-4-5\n"
    );
    writeFileSync(join(recipeDir, "nested", "review.md"), "Review\n");

    const manifest = readPiPackageManifest(recipeDir);
    expect(packageResourcePaths(manifest, "prompts")).toEqual([
      join(recipeDir, "nested", "review.md"),
    ]);
  });

  it("accepts an empty pi manifest with conventional resources and a minimal agent", () => {
    const recipeDir = mkdtempSync(join(tmpdir(), "recipe-format-minimal-"));
    cleanups.push(() => rmSync(recipeDir, { recursive: true, force: true }));
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({ name: "minimal-agent", version: "1.0.0", pi: {} })
    );
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      "name: agent\nmodel:\n  name: anthropic/claude-sonnet-4-5\n"
    );

    const manifest = readPiPackageManifest(recipeDir);
    expect(packageResourcePaths(manifest, "agents")).toEqual([join(recipeDir, "agents")]);
    expect(resolveRecipe({ recipeDir }).selectAgent()).toMatchObject({
      name: "agent",
      modelSpec: "anthropic/claude-sonnet-4-5",
      tools: [],
    });
  });

  it("rejects a Recipe with no agent definitions", () => {
    const recipeDir = mkdtempSync(join(tmpdir(), "recipe-format-empty-"));
    cleanups.push(() => rmSync(recipeDir, { recursive: true, force: true }));
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({ name: "empty-agent", version: "1.0.0", pi: {} })
    );

    expect(() => resolveRecipe({ recipeDir }).selectAgent()).toThrow(
      'Recipe "empty-agent" does not define any agents'
    );
  });

  it("distinguishes omitted resource conventions from explicit empty arrays", () => {
    const recipeDir = mkdtempSync(join(tmpdir(), "recipe-format-explicit-empty-"));
    cleanups.push(() => rmSync(recipeDir, { recursive: true, force: true }));
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    mkdirSync(join(recipeDir, "skills", "ambient"), { recursive: true });
    mkdirSync(join(recipeDir, "prompts"), { recursive: true });
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      "name: agent\nmodel:\n  name: anthropic/claude-sonnet-4-5\n"
    );
    writeFileSync(join(recipeDir, "skills", "ambient", "SKILL.md"), "---\nname: ambient\n---\n");
    writeFileSync(join(recipeDir, "prompts", "ambient.md"), "ambient\n");
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "explicit-empty",
        pi: {
          skills: [],
          prompts: [],
        },
      })
    );

    const resolved = resolveRecipe({ recipeDir }).selectAgent();
    expect(resolved.skillPaths).toEqual([]);
    expect(resolved.promptPaths).toEqual([]);

    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "explicit-empty",
        pi: { agents: [] },
      })
    );
    expect(() => resolveRecipe({ recipeDir }).selectAgent()).toThrow(
      'Recipe "explicit-empty" does not define any agents'
    );
  });

  it("rejects malformed manifest resource shapes in direct resolution", () => {
    const recipeDir = fixture();
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "malformed-resources",
        pi: { agents: "agents/*.yaml" },
      })
    );

    expect(() => resolveRecipe({ recipeDir }).selectAgent()).toThrow(
      "package.json#pi.agents must be an array of non-empty strings"
    );
  });

  it("rejects unmatched explicitly declared extension patterns", () => {
    const recipeDir = fixture();
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "missing-extension",
        pi: {
          agents: ["agents/*.yaml"],
          extensions: ["extensions/policy-*.ts"],
        },
      })
    );

    expect(() => resolveRecipe({ recipeDir }).selectAgent()).toThrow(
      "declares extensions glob with no matches"
    );
  });

  it("reads and resolves a complete Recipe from ordinary source", () => {
    const recipeDir = fixture();
    const manifest = readPiPackageManifest(recipeDir);

    expect(validatePiPackageManifest(manifest)).toEqual({
      valid: true,
      findings: [],
    });
    expect(packageResourcePaths(manifest, "skills")).toEqual([
      join(recipeDir, "skills", "research", "SKILL.md"),
    ]);

    const recipe = resolveRecipe({ recipeDir }).selectAgent();
    expect(recipe.name).toBe("agent");
    expect(recipe.modelSpec).toBe("anthropic/claude-sonnet-4-5");
    expect(recipe.tools).toEqual(["read"]);
    expect(recipe.skillPaths).toEqual([join(recipeDir, "skills", "research", "SKILL.md")]);
  });

  it("rejects resources that escape the package", () => {
    const recipeDir = fixture();
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "escaping-agent",
        pi: { agents: ["../agents/*.yaml"] },
      })
    );

    expect(() => resolveRecipe({ recipeDir }).selectAgent()).toThrow(/outside the package/);
  });

  it("rejects traversal glob roots before scanning", () => {
    const recipeDir = fixture();
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "escaping-agent",
        pi: { agents: ["../../**/*.yaml"] },
      })
    );

    expect(() => resolveRecipe({ recipeDir }).selectAgent()).toThrow(
      /resource glob resolves outside the package/
    );
  });

  it("resolves the package extension closure deterministically", () => {
    const recipeDir = fixture();
    mkdirSync(join(recipeDir, "extensions"), { recursive: true });
    writeFileSync(join(recipeDir, "extensions", "first.ts"), "export default () => {};\n");
    writeFileSync(join(recipeDir, "extensions", "second.ts"), "export default () => {};\n");
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "complete-agent",
        pi: {
          agents: ["agents/*.yaml"],
          extensions: ["extensions/second.ts", "extensions/first.ts"],
        },
      })
    );

    expect(resolveRecipe({ recipeDir }).selectAgent().extensionPaths).toEqual([
      join(recipeDir, "extensions", "second.ts"),
      join(recipeDir, "extensions", "first.ts"),
    ]);

    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "complete-agent",
        pi: {
          agents: ["agents/*.yaml"],
          extensions: ["extensions/*.ts"],
        },
      })
    );
    expect(resolveRecipe({ recipeDir }).selectAgent().extensionPaths).toEqual([
      join(recipeDir, "extensions", "first.ts"),
      join(recipeDir, "extensions", "second.ts"),
    ]);
  });

  it("expands declared extension directories with shallow Pi semantics", () => {
    const recipeDir = fixture();
    mkdirSync(join(recipeDir, "extensions", "nested"), { recursive: true });
    mkdirSync(join(recipeDir, "extensions", "without-index"), {
      recursive: true,
    });
    writeFileSync(join(recipeDir, "extensions", "z-last.ts"), "export default () => {};\n");
    writeFileSync(join(recipeDir, "extensions", "a-first.js"), "export default () => {};\n");
    writeFileSync(
      join(recipeDir, "extensions", "nested", "index.ts"),
      "export default () => {};\n"
    );
    writeFileSync(
      join(recipeDir, "extensions", "without-index", "ignored.ts"),
      "export default () => {};\n"
    );
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "complete-agent",
        pi: {
          agents: ["agents/*.yaml"],
          extensions: ["extensions"],
        },
      })
    );

    expect(resolveRecipe({ recipeDir }).selectAgent().extensionPaths).toEqual([
      join(recipeDir, "extensions", "a-first.js"),
      join(recipeDir, "extensions", "nested", "index.ts"),
      join(recipeDir, "extensions", "z-last.ts"),
    ]);

    writeFileSync(join(recipeDir, "extensions", "index.js"), "export default () => {};\n");
    writeFileSync(join(recipeDir, "extensions", "index.ts"), "export default () => {};\n");
    expect(resolveRecipe({ recipeDir }).selectAgent().extensionPaths).toEqual([
      join(recipeDir, "extensions", "index.ts"),
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "rejects extension symlinks that execute outside the package",
    () => {
      const recipeDir = fixture();
      const outside = join(recipeDir, "..", `${basename(recipeDir)}-outside.ts`);
      writeFileSync(outside, "export default () => {};\n");
      cleanups.push(() => rmSync(outside, { force: true }));
      mkdirSync(join(recipeDir, "extensions"), { recursive: true });
      symlinkSync(outside, join(recipeDir, "extensions", "outside.ts"));
      writeFileSync(
        join(recipeDir, "package.json"),
        JSON.stringify({
          name: "complete-agent",
          pi: {
            agents: ["agents/*.yaml"],
            extensions: ["extensions/outside.ts"],
          },
        })
      );

      expect(() => resolveRecipe({ recipeDir }).selectAgent()).toThrow(
        "Recipe extensions resource resolves outside the package"
      );
    }
  );

  it.skipIf(process.platform === "win32")(
    "rejects SYSTEM.md symlinks that resolve outside the package",
    () => {
      const recipeDir = fixture();
      const outside = join(recipeDir, "..", `${basename(recipeDir)}-outside-system.md`);
      writeFileSync(outside, "outside prompt\n");
      cleanups.push(() => rmSync(outside, { force: true }));
      symlinkSync(outside, join(recipeDir, "SYSTEM.md"));

      expect(() => resolveRecipe({ recipeDir }).selectAgent()).toThrow(
        "Recipe SYSTEM.md resolves outside the package"
      );
    }
  );
});

describe("npm package boundary", () => {
  it("keeps the root API to resolution and session construction", async () => {
    const api = await import("../src/index.js");
    expect(Object.keys(api).sort()).toEqual([
      "RecipeCredentialError",
      "RecipeMcpEnvironmentInUseError",
      "RecipeModelError",
      "RecipeModelTransportError",
      "RecipeResolutionError",
      "createAgentSession",
      "resolveRecipe",
    ]);
  });

  it("ships a library and Pi extension without a standalone CLI or server", () => {
    const root = join(import.meta.dirname, "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name: string;
      description: string;
      bin?: unknown;
      exports: Record<string, unknown>;
      files: string[];
    };

    expect(pkg.name).toBe("@introspection-ai/recipes");
    expect(pkg.description).toBe("The open format for vertical agents, built on Pi.");
    expect(pkg.bin).toBeUndefined();
    expect(pkg.exports).not.toHaveProperty("./serve");
    expect(pkg.exports).not.toHaveProperty("./agui");
    expect(pkg.exports).not.toHaveProperty("./tracing");
    expect(pkg.exports).toHaveProperty("./session");
    expect(pkg.exports).toHaveProperty("./extensions");
    expect(pkg.exports["./session"]).toMatchObject({
      import: "./dist/api/session.js",
    });
    expect(pkg.exports["./extensions"]).toMatchObject({
      import: "./dist/api/extensions.js",
    });
    expect(pkg.exports["./mcp"]).toMatchObject({
      import: "./dist/api/mcp.js",
    });
    expect(pkg.exports).not.toHaveProperty("./run");
    expect(pkg.exports).toHaveProperty("./test-utils");
    expect(existsSync(join(root, "src", "cli.ts"))).toBe(false);
    expect(existsSync(join(root, "src", "serve.ts"))).toBe(false);
    // Internal snapshot bridge used by `pi --recipe`; it is not exposed in
    // package.json#bin and therefore does not restore a Recipes CLI.
    expect(existsSync(join(root, "crates", "introspection-recipe-check", "src", "main.rs"))).toBe(true);
    // Python bindings share the source repository and release train but are
    // published separately; they never enter the npm package boundary.
    expect(existsSync(join(root, "bindings", "python"))).toBe(true);
    expect(pkg.files.some((path) => path.startsWith("bindings/"))).toBe(false);
    expect(existsSync(join(root, "harbor"))).toBe(false);
    expect(existsSync(join(root, "docs", "recipe-evals.md"))).toBe(false);
  });
});

describe("release train isolation", () => {
  it("uses distinct release-please labels for root and checker trains", () => {
    const root = join(import.meta.dirname, "..");
    const rootConfig = JSON.parse(
      readFileSync(join(root, "release-please-config.json"), "utf8")
    ) as {
      label?: string;
      "release-label"?: string;
      "group-pull-request-title-pattern"?: string;
      packages?: Record<string, { "initial-version"?: string }>;
    };
    const checkerConfig = JSON.parse(
      readFileSync(join(root, "release-please-checker-config.json"), "utf8")
    ) as {
      label?: string;
      "release-label"?: string;
      "group-pull-request-title-pattern"?: string;
    };

    expect(rootConfig).toMatchObject({
      label: "autorelease: pending-root",
      "release-label": "autorelease: tagged-root",
      "group-pull-request-title-pattern":
        "chore(${branch}): release ${version}",
      packages: {
        "packages/channels/slack": {
          "initial-version": "0.1.0",
        },
      },
    });
    expect(checkerConfig).toMatchObject({
      label: "autorelease: pending-checker",
      "release-label": "autorelease: tagged-checker",
      // linked-versions emits this shared title without a version. The same
      // pattern must parse the merged PR so release-please can create tags.
      "group-pull-request-title-pattern":
        "chore(${branch}): release introspection-recipe-check libraries",
    });
  });

  it("does not record a false Slack release version", () => {
    const root = join(import.meta.dirname, "..");
    const manifest = JSON.parse(
      readFileSync(join(root, ".release-please-manifest.json"), "utf8")
    ) as Record<string, string>;
    const slackPackage = JSON.parse(
      readFileSync(
        join(root, "packages", "channels", "slack", "package.json"),
        "utf8"
      )
    ) as { version: string };
    const releasedVersion = manifest["packages/channels/slack"];

    expect(releasedVersion).not.toBe("0.0.0");
    if (releasedVersion !== undefined) {
      expect(releasedVersion).toBe(slackPackage.version);
    }
  });

  it("fails visibly when a merged root release PR remains pending", () => {
    const root = join(import.meta.dirname, "..");
    const workflow = readFileSync(
      join(root, ".github", "workflows", "release-please.yml"),
      "utf8"
    );

    expect(workflow).toContain("name: Verify root release state");
    expect(workflow).toContain('.name == "autorelease: pending-root"');
    expect(workflow).toContain("Merged root release PRs remain untagged");
  });

  it("fails visibly when a merged checker release PR remains pending", () => {
    const root = join(import.meta.dirname, "..");
    const workflow = readFileSync(
      join(root, ".github", "workflows", "release-please.yml"),
      "utf8"
    );

    expect(workflow).toContain("name: Verify checker release state");
    expect(workflow).toContain(
      '.name == "autorelease: pending-checker"'
    );
    expect(workflow).toContain("Merged checker release PRs remain untagged");
  });

  it("publishes npm packages publicly without a redundant access mutation", () => {
    const root = join(import.meta.dirname, "..");
    const workflow = readFileSync(
      join(root, ".github", "workflows", "release-please.yml"),
      "utf8"
    );

    expect(workflow).toContain("pnpm publish --access public");
    expect(workflow).not.toContain("npm access set status=public");
  });

  it("does not fail a release by deleting temporary npm tags", () => {
    const root = join(import.meta.dirname, "..");
    const workflow = readFileSync(
      join(root, ".github", "workflows", "release-please.yml"),
      "utf8"
    );

    expect(workflow).toContain('--tag "$staging_tag"');
    expect(workflow).toContain('npm dist-tag add "$package_name@$version" "$root_tag"');
    expect(workflow).not.toContain("npm dist-tag rm");
  });
});
