import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, expect, it } from "vitest";

import { RECIPES_PACKAGE_DIR_ENV } from "../src/recipe/companions.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// A runtime image's layout: the bundle sits in its own directory with no
// `node_modules` above it, and the host's dependencies live elsewhere.
let host: string;
let appDir: string;
let bundle: string;
let recipeDir: string;

beforeEach(async () => {
  host = realpathSync(mkdtempSync(join(tmpdir(), "recipes-bundled-")));
  appDir = join(host, "repo", "app");
  const modules = join(appDir, "node_modules", "@introspection-ai");
  mkdirSync(modules, { recursive: true });
  symlinkSync(root, join(modules, "recipes"), "dir");
  recipeDir = join(host, "recipe");
  mkdirSync(recipeDir);
  writeFileSync(
    join(recipeDir, "package.json"),
    JSON.stringify({
      name: "r",
      version: "0.1.0",
      type: "module",
      dependencies: { "@introspection-ai/recipe-documents-docx": "*" },
      pi: {},
    }),
  );
  bundle = join(host, "usr", "local", "lib", "runtime", "probe.mjs");
  await build({
    stdin: {
      resolveDir: root,
      contents: `
        import { recipePythonDeclarations } from "./src/recipe/python.ts";
        import { DOCUMENTS_SKILL } from "./src/documents/module.ts";
        const shared = recipePythonDeclarations(process.argv[2])
          .find((declaration) => declaration.kind === "shared");
        console.log(JSON.stringify({ shared: shared?.packageDir, skill: DOCUMENTS_SKILL }));
      `,
      loader: "ts",
    },
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
    logLevel: "silent",
  });
});

afterEach(() => rmSync(host, { recursive: true, force: true }));

function probe(env: NodeJS.ProcessEnv = {}): {
  shared?: string;
  skill: string;
} {
  const run = spawnSync(process.execPath, [bundle, recipeDir], {
    cwd: root,
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
  expect(run.stderr).toBe("");
  return JSON.parse(run.stdout) as { shared?: string; skill: string };
}

it("finds the shared Python project and skills through PI_RECIPES_PACKAGE_DIR when Recipes is bundled", () => {
  const recipes = join(appDir, "node_modules", "@introspection-ai", "recipes");
  expect(probe({ [RECIPES_PACKAGE_DIR_ENV]: recipes })).toEqual({
    shared: recipes,
    skill: join(recipes, "skills", "documents", "SKILL.md"),
  });
});

it("finds them through node_modules when one above the bundle holds Recipes", async () => {
  const modules = join(
    host,
    "usr",
    "local",
    "lib",
    "node_modules",
    "@introspection-ai",
  );
  mkdirSync(modules, { recursive: true });
  symlinkSync(root, join(modules, "recipes"), "dir");
  expect(probe()).toEqual({
    shared: realpathSync(root),
    skill: join(realpathSync(root), "skills", "documents", "SKILL.md"),
  });
});

it("cannot place them from the bundle's own location alone", () => {
  expect(probe().shared).toBe(join(host, "usr", "local"));
});
