import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import semver from "semver";
import { describe, expect, it } from "vitest";

import { LEGAL_REDLINING_EN_US } from "../packages/documents/docx/src/index.js";
import { loadRecipeConnectors } from "../src/connector-tools.js";
import { loadRecipeDocuments } from "../src/documents/index.js";
import { companionPackages, recipesVersion } from "../src/recipe/companions.js";
import { readPiPackageManifest } from "../src/recipe/package.js";
import { recipePythonDeclarations } from "../src/recipe/python.js";
import { pythonProject } from "./helpers/fake-uv.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const DOCX = "@introspection-ai/recipe-documents-docx";
const SLACK = "@introspection-ai/recipe-channel-slack";
const PROFILE =
  "---\nname: legal-redlining-en-us\ndescription: Redline a contract.\n---\n";

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/**
 * A stand-in docx format package in `nodeModules`, shipping one profile and
 * recording the options its adapter is created with on `globalThis`.
 */
function docxPackage(
  nodeModules: string,
  options: { version?: string; recipesRange?: string; python?: boolean } = {},
): string {
  const dir = join(nodeModules, ...DOCX.split("/"));
  write(
    join(dir, "package.json"),
    JSON.stringify({
      name: DOCX,
      version: options.version ?? "0.3.0",
      type: "module",
      main: "index.js",
      ...(options.recipesRange
        ? {
            peerDependencies: {
              "@introspection-ai/recipes": options.recipesRange,
            },
          }
        : {}),
      ...(options.python
        ? {
            pi: {
              runtime: {
                python: { project: "python", lockfile: "python/uv.lock" },
              },
            },
          }
        : {}),
    }),
  );
  write(join(dir, "profiles", "legal-redlining-en-us", "SKILL.md"), PROFILE);
  write(
    join(dir, "index.js"),
    `const profile = new URL("./profiles/legal-redlining-en-us/SKILL.md", import.meta.url).pathname;
export default { kind: "documents", format: "docx", extensions: [".docx"], capabilities: { read: true },
  profiles: { "legal-redlining-en-US": profile },
  createAdapter: (options) => { globalThis.companionAdapterOptions = options;
    return { format: "docx", extensions: [".docx"], capabilities: { read: true }, read: async () => ({ text: "" }) }; } };\n`,
  );
  if (options.python) pythonProject(dir);
  return realpathSync(dir);
}

/** A host install: `@introspection-ai/recipes` with its siblings in one `node_modules`. Returns the Recipes directory. */
function host(): { hostDir: string; nodeModules: string } {
  const nodeModules = join(
    mkdtempSync(join(tmpdir(), "companions-host-")),
    "node_modules",
  );
  const hostDir = join(nodeModules, "@introspection-ai", "recipes");
  write(
    join(hostDir, "package.json"),
    JSON.stringify({
      name: "@introspection-ai/recipes",
      version: recipesVersion(),
    }),
  );
  return { hostDir, nodeModules };
}

function recipe(
  pi: Record<string, unknown>,
  dependencies: Record<string, string> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "companions-recipe-"));
  write(
    join(dir, "package.json"),
    JSON.stringify({
      name: "r",
      version: "0.1.0",
      type: "module",
      dependencies,
      pi,
    }),
  );
  return dir;
}

const documents = [{ format: "docx", profile: "legal-redlining-en-US" }];

describe("companion packages", () => {
  it("uses the host's copy when the Recipe does not list the package", async () => {
    const { hostDir, nodeModules } = host();
    const hostDocx = docxPackage(nodeModules);
    const recipeDir = recipe({ documents });

    const loaded = await loadRecipeDocuments(documents, ["documents"], {
      recipeDir,
      hostDir,
    });

    expect(loaded.skillPaths?.[1]).toBe(
      join(hostDocx, "profiles", "legal-redlining-en-us", "SKILL.md"),
    );
  });

  it("by default finds the copy installed alongside the running Recipes", async () => {
    // In this repository the companions are linked beside Recipes, as an install puts them.
    const recipeDir = recipe({ documents });

    const loaded = await loadRecipeDocuments(documents, ["documents"], {
      recipeDir,
    });

    expect(loaded.skillPaths?.[1]).toBe(LEGAL_REDLINING_EN_US);
  });

  it("uses the Recipe's copy when the Recipe pins the package", async () => {
    const { hostDir, nodeModules } = host();
    docxPackage(nodeModules);
    const recipeDir = recipe({ documents }, { [DOCX]: ">=0.3.0" });
    const pinned = docxPackage(join(recipeDir, "node_modules"));

    const loaded = await loadRecipeDocuments(documents, ["documents"], {
      recipeDir,
      hostDir,
    });

    expect(loaded.skillPaths?.[1]).toBe(
      join(pinned, "profiles", "legal-redlining-en-us", "SKILL.md"),
    );
  });

  it("says to add the package or reinstall Recipes when neither has it", async () => {
    const { hostDir } = host();
    const recipeDir = recipe({ documents });

    await expect(
      loadRecipeDocuments(documents, ["documents"], { recipeDir, hostDir }),
    ).rejects.toThrow(
      `Recipe document format 'docx' requires ${DOCX}: add it to the Recipe dependencies, or reinstall Recipes, which installs it alongside itself (\`introspection upgrade\`)`,
    );
  });

  it("never supplies a package that is not a companion", async () => {
    const { hostDir, nodeModules } = host();
    write(
      join(
        nodeModules,
        "@introspection-ai",
        "recipe-documents-odt",
        "package.json",
      ),
      JSON.stringify({ name: "x", main: "index.js" }),
    );
    const recipeDir = recipe({ documents: [{ format: "odt" }] });

    await expect(
      loadRecipeDocuments([{ format: "odt" }], ["documents"], {
        recipeDir,
        hostDir,
      }),
    ).rejects.toThrow(
      "Recipe document format 'odt' requires @introspection-ai/recipe-documents-odt in the Recipe dependencies",
    );
  });

  it("supplies a companion channel package", async () => {
    const { hostDir, nodeModules } = host();
    const slackDir = join(nodeModules, ...SLACK.split("/"));
    write(
      join(slackDir, "package.json"),
      JSON.stringify({
        name: SLACK,
        version: "0.6.0",
        type: "module",
        main: "index.js",
      }),
    );
    write(
      join(slackDir, "index.js"),
      `export default { provider: "slack", tools: [{ id: "channels", name: "channels", defaultActive: true }], createExtension: () => () => {} };\n`,
    );
    const recipeDir = recipe({ channels: [{ provider: "slack" }] });

    const loaded = await loadRecipeConnectors(
      readPiPackageManifest(recipeDir),
      ["channels"],
      { recipeDir, hostDir },
    );

    expect(loaded.loadout.toolNames).toEqual(["channels"]);
  });

  it("builds a channel connector from a package's plain descriptor, and refuses another contract version", async () => {
    const slackHost = (apiVersion: number) => {
      const { hostDir, nodeModules } = host();
      const slackDir = join(nodeModules, ...SLACK.split("/"));
      write(
        join(slackDir, "package.json"),
        JSON.stringify({
          name: SLACK,
          version: "0.7.0",
          type: "module",
          main: "index.js",
        }),
      );
      write(
        join(slackDir, "index.js"),
        `export default { kind: "channel", apiVersion: ${apiVersion}, provider: "slack", capabilities: { reply: true, send: false, read: false, react: false, attach: false },
          createSession: () => { throw new Error("no session in this test"); } };\n`,
      );
      return { hostDir, slackDir };
    };
    const recipeDir = recipe({ channels: [{ provider: "slack" }] });

    const loaded = await loadRecipeConnectors(
      readPiPackageManifest(recipeDir),
      ["channels"],
      { recipeDir, hostDir: slackHost(1).hostDir },
    );
    expect(loaded.loadout.toolNames).toEqual(["channels"]);

    const { hostDir, slackDir } = slackHost(2);
    await expect(
      loadRecipeConnectors(readPiPackageManifest(recipeDir), ["channels"], {
        recipeDir,
        hostDir,
      }),
    ).rejects.toThrow(
      `${SLACK}@0.7.0 (installed alongside Recipes, ${realpathSync(slackDir)}) implements channel module API 2, ` +
        `but @introspection-ai/recipes ${recipesVersion()} implements channel module API 1.`,
    );
  });

  it("refuses a pin whose Recipes range excludes the running version, naming the fix", async () => {
    const { hostDir } = host();
    const recipeDir = recipe({ documents }, { [DOCX]: "0.1.0" });
    docxPackage(join(recipeDir, "node_modules"), {
      version: "0.1.0",
      recipesRange: ">=99.0.0",
    });

    const loading = loadRecipeDocuments(documents, ["documents"], {
      recipeDir,
      hostDir,
    });

    await expect(loading).rejects.toThrow(
      `${DOCX}@0.1.0 (resolved from the Recipe`,
    );
    await expect(loading).rejects.toThrow(
      `requires @introspection-ai/recipes >=99.0.0, but @introspection-ai/recipes ${recipesVersion()} is running. ` +
        `Raise or remove the Recipe's pin on ${DOCX} in its dependencies, or run \`introspection upgrade\`.`,
    );
  });

  it("loads a pin whose Recipes range admits the running version", async () => {
    const { hostDir } = host();
    const recipeDir = recipe({ documents }, { [DOCX]: ">=0.3.0" });
    docxPackage(join(recipeDir, "node_modules"), {
      recipesRange: `>=${recipesVersion()}`,
    });

    await expect(
      loadRecipeDocuments(documents, ["documents"], { recipeDir, hostDir }),
    ).resolves.toMatchObject({
      toolNames: ["documents"],
    });
  });

  it("checks the host's copy against the running Recipes version too", async () => {
    const { hostDir, nodeModules } = host();
    docxPackage(nodeModules, { recipesRange: ">=99.0.0" });
    const recipeDir = recipe({ documents });

    await expect(
      loadRecipeDocuments(documents, ["documents"], { recipeDir, hostDir }),
    ).rejects.toThrow(`${DOCX}@0.3.0 (installed alongside Recipes`);
  });

  it("finds a peer the platform installs in an ancestor node_modules, with its Python, profile and range check", async () => {
    const { hostDir } = host();
    const opt = join(
      mkdtempSync(join(tmpdir(), "companions-ancestor-")),
      "opt",
    );
    const recipeDir = join(opt, "recipe");
    write(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "r",
        version: "0.1.0",
        type: "module",
        peerDependencies: { [DOCX]: ">=0.3.0" },
        pi: { documents },
      }),
    );
    const platformDocx = docxPackage(join(opt, "node_modules"), {
      python: true,
      recipesRange: `>=${recipesVersion()}`,
    });

    const loaded = await loadRecipeDocuments(documents, ["documents"], {
      recipeDir,
      hostDir,
    });
    expect(loaded.skillPaths?.[1]).toBe(
      join(platformDocx, "profiles", "legal-redlining-en-us", "SKILL.md"),
    );
    expect(recipePythonDeclarations(recipeDir, { hostDir })).toEqual([
      expect.objectContaining({
        kind: "package",
        owner: DOCX,
        packageDir: platformDocx,
      }),
    ]);

    docxPackage(join(opt, "node_modules"), {
      python: true,
      recipesRange: ">=99.0.0",
    });
    await expect(
      loadRecipeDocuments(documents, ["documents"], { recipeDir, hostDir }),
    ).rejects.toThrow(
      `${DOCX}@0.3.0 (resolved from the Recipe, ${platformDocx}) requires @introspection-ai/recipes >=99.0.0`,
    );
  });

  it("prepares a companion's Python and hands its interpreter to the adapter", async () => {
    const { hostDir, nodeModules } = host();
    const hostDocx = docxPackage(nodeModules, { python: true });
    const recipeDir = recipe({ documents });

    expect(recipePythonDeclarations(recipeDir, { hostDir })).toEqual([
      expect.objectContaining({
        kind: "package",
        owner: DOCX,
        packageDir: hostDocx,
      }),
    ]);
    expect(recipePythonDeclarations(recipe({}), { hostDir })).toEqual([]);

    const loaded = await loadRecipeDocuments(documents, ["documents"], {
      recipeDir,
      hostDir,
      python: { [DOCX]: { interpreter: "/envs/docx/bin/python" } },
    });
    await loaded.extension!.factory(createMockExtensionAPI() as never);
    expect(
      (globalThis as { companionAdapterOptions?: { python?: string } })
        .companionAdapterOptions?.python,
    ).toBe("/envs/docx/bin/python");
  });
});

describe("Recipes' optionalDependencies", () => {
  const manifest = JSON.parse(
    readFileSync(resolve("package.json"), "utf8"),
  ) as {
    optionalDependencies: Record<string, string>;
  };
  const workspacePackages = ["packages/channels", "packages/documents"].flatMap(
    (root) =>
      readdirSync(resolve(root)).map(
        (name) =>
          JSON.parse(
            readFileSync(resolve(root, name, "package.json"), "utf8"),
          ) as { name: string; version: string },
      ),
  );

  // A release stamps the MCP client's platform binaries in beside the companions
  // (packages/mcp-client/npm/build-mcp-client-packages.mjs); they aren't companions.
  const companionEntries = Object.entries(manifest.optionalDependencies).filter(
    ([name]) => name.startsWith("@introspection-ai/recipe-"),
  );

  it("is what the loader uses, each a workspace link that publishes as a range", () => {
    expect(companionEntries.length).toBeGreaterThan(0);
    for (const [name, specifier] of companionEntries) {
      expect(specifier, name).toMatch(/^workspace:>=/);
      expect(companionPackages()[name]).toBe(
        specifier.slice("workspace:".length),
      );
    }
    expect(Object.keys(companionPackages())).toEqual(
      companionEntries.map(([name]) => name),
    );
  });

  it("keeps the companions when the release stamps the MCP client's binaries in", () => {
    const script = readFileSync(
      resolve("packages/mcp-client/npm/build-mcp-client-packages.mjs"),
      "utf8",
    );
    expect(script).toMatch(
      /optionalDependencies = \{\s*\.\.\.rootPkg\.optionalDependencies,\s*\.\.\.optionalDependencies,?\s*\}/,
    );
  });

  it("are never a run-time dependency of Recipes' companions: no cycle back to Recipes", () => {
    const recipesImport =
      /\b(import|export)\s+(type\s+)?[^;]*?from\s+["']@introspection-ai\/recipes[^"']*["']/gs;
    for (const root of ["packages/channels", "packages/documents"]) {
      for (const name of readdirSync(resolve(root))) {
        const dir = resolve(root, name);
        const pkg = JSON.parse(
          readFileSync(join(dir, "package.json"), "utf8"),
        ) as Record<string, Record<string, string> | undefined>;
        for (const block of [
          "dependencies",
          "peerDependencies",
          "optionalDependencies",
        ]) {
          expect(
            Object.keys(pkg[block] ?? {}),
            `${name} ${block}`,
          ).not.toContain("@introspection-ai/recipes");
        }
        for (const file of readdirSync(join(dir, "src")).filter((entry) =>
          entry.endsWith(".ts"),
        )) {
          for (const match of readFileSync(
            join(dir, "src", file),
            "utf8",
          ).matchAll(recipesImport)) {
            expect(
              match[2],
              `${name}/src/${file}: ${match[0].slice(0, 80)}`,
            ).toBeTruthy();
          }
        }
      }
    }
  });

  it("names every first-party channel and document format package, with an open lower bound its version satisfies", () => {
    expect(Object.keys(companionPackages()).sort()).toEqual(
      workspacePackages.map((pkg) => pkg.name).sort(),
    );
    for (const pkg of workspacePackages) {
      const range = companionPackages()[pkg.name]!;
      expect(range, pkg.name).toMatch(/^>=\d+\.\d+\.\d+$/);
      expect(
        semver.satisfies(pkg.version, range),
        `${pkg.name}@${pkg.version} ${range}`,
      ).toBe(true);
    }
  });
});
