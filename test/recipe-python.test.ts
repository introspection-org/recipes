import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRecipeDocuments } from "../src/documents/index.js";
import { validateRecipePythonPackage } from "../src/recipe/package.js";
import {
  activateRecipePython,
  prepareRecipePython,
  RecipePythonImportError,
  RecipePythonOutdatedError,
  RecipePythonUvMissingError,
  RecipePythonVersionError,
  UV_INSTALL_URL,
  type PrepareRecipePythonOptions,
  type RecipePythonSyncEvent,
} from "../src/recipe/python.js";
import { fakeUv, pythonProject, scratch, write } from "./helpers/fake-uv.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const IS_WINDOWS = process.platform === "win32";

function pythonCalls(log: string): Array<{ pythonhome: string }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((call) => call.python);
}

interface RecipeFixture {
  dir: string;
}

/**
 * A synthetic Recipe. `python` adds its own declaration; each entry of
 * `packages` installs a package under node_modules, declared as a dependency
 * (or devDependency) of the Recipe.
 */
function recipe(options: {
  python?: Record<string, unknown> | false;
  packages?: Array<{
    name: string;
    python?: Record<string, unknown>;
    files?: string[];
    as?: "dependencies" | "peerDependencies" | "devDependencies" | "none";
  }>;
  missingDependency?: string;
}): RecipeFixture {
  const dir = scratch("recipe-python-");
  const dependencies: Record<string, string> = {};
  const peerDependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  for (const pkg of options.packages ?? []) {
    const packageDir = join(dir, "node_modules", ...pkg.name.split("/"));
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: pkg.name,
        version: "1.0.0",
        ...(pkg.files ? { files: pkg.files } : {}),
        ...(pkg.python ? { pi: { runtime: { python: pkg.python } } } : {}),
      })
    );
    if (pkg.python) pythonProject(packageDir);
    const as = pkg.as ?? "dependencies";
    if (as === "dependencies") dependencies[pkg.name] = "1.0.0";
    if (as === "peerDependencies") peerDependencies[pkg.name] = "1.0.0";
    if (as === "devDependencies") devDependencies[pkg.name] = "1.0.0";
  }
  if (options.missingDependency) dependencies[options.missingDependency] = "1.0.0";
  const python =
    options.python === false
      ? undefined
      : { project: "python", lockfile: "python/uv.lock", ...(options.python ?? {}) };
  if (python) pythonProject(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "synthetic-recipe",
      version: "0.1.0",
      dependencies,
      peerDependencies,
      devDependencies,
      pi: python ? { runtime: { python } } : {},
    })
  );
  return { dir };
}

function harness(extraEnv: Record<string, string> = {}) {
  const uv = fakeUv();
  const home = scratch("recipe-python-home-");
  const env: NodeJS.ProcessEnv = {
    PATH: `${uv.bin}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    FAKE_UV_LOG: uv.log,
    ...extraEnv,
  };
  const prepare = (dir: string, options: Partial<PrepareRecipePythonOptions> = {}) =>
    prepareRecipePython(dir, { mode: "sync", env, ...options });
  return { uv, env, home, prepare };
}

describe.skipIf(IS_WINDOWS)("prepareRecipePython with a fake uv", () => {
  it("does nothing, and never runs uv, for a Recipe without declarations", async () => {
    const { uv, prepare } = harness();
    const { dir } = recipe({ python: false, packages: [{ name: "plain" }] });
    await expect(prepare(dir)).resolves.toEqual({ packages: {} });
    expect(uv.calls()).toEqual([]);
  });

  it("names a missing uv with its install link", async () => {
    const { prepare } = harness();
    const { dir } = recipe({});
    const error = await prepare(dir, { uv: join(scratch("no-uv-"), "uv") }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RecipePythonUvMissingError);
    expect((error as Error).name).toBe("RecipePythonUvMissingError");
    expect((error as Error).message).toContain(UV_INSTALL_URL);
  });

  describe("check mode", () => {
    it("rejects a missing environment without writing or syncing", async () => {
      const { uv, prepare } = harness();
      const { dir } = recipe({});
      const root = join(scratch("roots-"), ".pi");
      const error = await prepare(dir, { mode: "check", environmentRoot: root }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RecipePythonOutdatedError);
      expect(existsSync(root)).toBe(false);
      expect(uv.calls().map((call) => call.args[0])).toEqual(["--version"]);
    });

    it("rejects an outdated environment (uv exit 1) and never installs", async () => {
      const { uv, prepare } = harness();
      const { dir } = recipe({});
      const root = scratch("roots-");
      await prepare(dir, { environmentRoot: root });
      rmSync(join(root, "python", ".fake-current"));
      await expect(prepare(dir, { mode: "check", environmentRoot: root })).rejects.toBeInstanceOf(
        RecipePythonOutdatedError
      );
      const checks = uv.calls().filter((call) => call.args[0] === "sync");
      const last = checks.at(-1)!.args;
      expect(last).toEqual(
        expect.arrayContaining(["--frozen", "--no-dev", "--check", "--offline", "--no-python-downloads"])
      );
      expect(last).not.toContain("--compile-bytecode");
      expect(checks.filter((call) => !call.args.includes("--check"))).toHaveLength(1);
    });

    it("names an unsatisfiable Python version (uv exit 2)", async () => {
      const { prepare, env } = harness();
      const { dir } = recipe({ python: { version: ">=3.99" } });
      const root = scratch("roots-");
      await prepare(dir, { environmentRoot: root });
      rmSync(join(root, "python", ".fake-current"));
      env.FAKE_UV_CHECK_EXIT = "2";
      const error = await prepare(dir, { mode: "check", environmentRoot: root }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RecipePythonVersionError);
      expect((error as Error).message).toContain(">=3.99");
    });

    it("passes a current environment and runs only the check and the imports", async () => {
      const { uv, prepare } = harness();
      const { dir } = recipe({ python: { imports: ["docx", "paper_docx.api"] } });
      const root = scratch("roots-");
      await prepare(dir, { environmentRoot: root });
      const before = uv.calls().length;
      const prepared = await prepare(dir, { mode: "check", environmentRoot: root });
      expect(prepared.recipe?.synced).toBe(false);
      const after = uv.calls().slice(before).filter((call) => call.args[0] !== "--version");
      expect(after.map((call) => call.args.includes("--check"))).toEqual([true]);
    });
  });

  describe("sync mode", () => {
    it("installs a missing shell environment once, compiled, and returns its activation", async () => {
      const { uv, prepare } = harness();
      const { dir } = recipe({ python: { version: ">=3.12,<3.15" } });
      const root = scratch("roots-");
      const events: RecipePythonSyncEvent[] = [];
      const prepared = await prepare(dir, { environmentRoot: root, onSync: (event) => events.push(event) });
      const environmentDir = join(root, "python");
      expect(prepared.recipe).toMatchObject({
        kind: "recipe",
        owner: "synthetic-recipe",
        environmentDir,
        interpreter: join(environmentDir, "bin", "python"),
        synced: true,
        activation: {
          set: { VIRTUAL_ENV: environmentDir, UV_PROJECT_ENVIRONMENT: environmentDir },
          pathPrepend: join(environmentDir, "bin"),
          unset: ["PYTHONHOME"],
        },
      });
      expect(events).toEqual([{ owner: "synthetic-recipe", kind: "recipe", environmentDir, firstBuild: true }]);
      const syncs = uv.calls().filter((call) => call.args[0] === "sync" && !call.args.includes("--check"));
      expect(syncs).toHaveLength(1);
      expect(syncs[0]!.project).toBe(environmentDir);
      expect(syncs[0]!.args).toEqual(
        expect.arrayContaining([
          "--frozen",
          "--no-dev",
          "--compile-bytecode",
          "--no-python-downloads",
          "--python",
          ">=3.12,<3.15",
        ])
      );
      // The Recipe's own environment is editable, like `uv sync` in a checkout.
      expect(syncs[0]!.args).not.toContain("--no-editable");
    });

    it("never recompiles a current environment", async () => {
      const { uv, prepare } = harness();
      const { dir } = recipe({});
      const root = scratch("roots-");
      await prepare(dir, { environmentRoot: root });
      const before = uv.calls().length;
      const again = await prepare(dir, { environmentRoot: root });
      expect(again.recipe?.synced).toBe(false);
      expect(uv.calls().slice(before).some((call) => call.args.includes("--compile-bytecode"))).toBe(false);
    });

    it("re-syncs an outdated environment and says it is not a first build", async () => {
      const { prepare } = harness();
      const { dir } = recipe({});
      const root = scratch("roots-");
      await prepare(dir, { environmentRoot: root });
      rmSync(join(root, "python", ".fake-current"));
      const events: RecipePythonSyncEvent[] = [];
      const again = await prepare(dir, { environmentRoot: root, onSync: (event) => events.push(event) });
      expect(again.recipe?.synced).toBe(true);
      expect(events.map((event) => event.firstBuild)).toEqual([false]);
    });

    it("lets uv download an interpreter only when allowed", async () => {
      const { uv, prepare, env } = harness();
      const { dir } = recipe({ python: { version: ">=3.13" } });
      await prepare(dir, { environmentRoot: scratch("roots-"), allowPythonDownloads: true });
      expect(uv.calls().filter((call) => call.args[0] === "sync").every((call) => !call.args.includes("--no-python-downloads"))).toBe(true);

      const root = scratch("roots-");
      await prepare(dir, { environmentRoot: root });
      rmSync(join(root, "python", ".fake-current"));
      env.FAKE_UV_CHECK_EXIT = "2";
      await expect(prepare(dir, { environmentRoot: root })).rejects.toBeInstanceOf(RecipePythonVersionError);
    });

    it("reports a sync that finds no interpreter as a version error", async () => {
      const { prepare } = harness({
        FAKE_UV_SYNC_EXIT: "2",
        FAKE_UV_SYNC_STDERR: "error: No interpreter found for Python >=3.99",
      });
      const { dir } = recipe({});
      await expect(prepare(dir, { environmentRoot: scratch("roots-"), allowPythonDownloads: true })).rejects.toBeInstanceOf(
        RecipePythonVersionError
      );
    });

    it("serialises two concurrent preparations of one environment: one installs, both succeed", async () => {
      const { uv, prepare } = harness({ FAKE_UV_SYNC_DELAY_MS: "300" });
      const { dir } = recipe({});
      const root = scratch("roots-");
      const results = await Promise.all([prepare(dir, { environmentRoot: root }), prepare(dir, { environmentRoot: root })]);
      expect(results.map((result) => result.recipe?.synced).sort()).toEqual([false, true]);
      expect(uv.calls().filter((call) => call.args.includes("--compile-bytecode"))).toHaveLength(1);
      expect(existsSync(join(root, "python.lock"))).toBe(false);
    });

    it("takes over a lock left by a process that is gone", async () => {
      const { prepare } = harness();
      const { dir } = recipe({});
      const root = scratch("roots-");
      const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString();
      write(join(root, "python.lock"), JSON.stringify({ pid: Number(gone), host: (await import("node:os")).hostname() }));
      await expect(prepare(dir, { environmentRoot: root })).resolves.toMatchObject({ recipe: { synced: true } });
    });
  });

  describe("imports", () => {
    it("fails with a named error, and runs the interpreter without PYTHONHOME", async () => {
      const { uv, prepare, env } = harness({ PYTHONHOME: "/elsewhere" });
      const { dir } = recipe({ python: { imports: ["docx"] } });
      const root = scratch("roots-");
      await prepare(dir, { environmentRoot: root });
      expect(pythonCalls(uv.log).map((call) => call.pythonhome)).toEqual(["unset"]);
      env.FAKE_IMPORT_FAIL = "1";
      const error = await prepare(dir, { mode: "check", environmentRoot: root }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RecipePythonImportError);
      expect((error as Error).message).toContain("No module named docx");
    });

    it("refuses an entry that is not a dotted module name before running Python", async () => {
      const { uv, prepare } = harness();
      const { dir } = recipe({ python: { imports: ["os; import sys"] } });
      await expect(prepare(dir, { environmentRoot: scratch("roots-") })).rejects.toBeInstanceOf(RecipePythonImportError);
      expect(pythonCalls(uv.log)).toEqual([]);
    });
  });

  describe("package declarations", () => {
    const docx = "@introspection-ai/recipe-documents-docx";

    it("gives each direct dependency its own non-editable environment, never the shell's", async () => {
      const { uv, prepare } = harness();
      const { dir } = recipe({
        packages: [
          { name: docx, python: { project: "python", lockfile: "python/uv.lock" } },
          { name: "peer-pkg", python: { project: "python", lockfile: "python/uv.lock" }, as: "peerDependencies" },
          { name: "dev-only", python: { project: "python", lockfile: "python/uv.lock" }, as: "devDependencies" },
          { name: "transitive", python: { project: "python", lockfile: "python/uv.lock" }, as: "none" },
          { name: "no-python" },
        ],
        missingDependency: "not-installed",
      });
      const root = join(scratch("roots-"), ".pi");
      const prepared = await prepare(dir, { environmentRoot: root });
      expect(Object.keys(prepared.packages).sort()).toEqual([docx, "peer-pkg"]);
      const docxEnv = join(root, "python-packages", "@introspection-ai", "recipe-documents-docx");
      expect(prepared.packages[docx]).toMatchObject({
        kind: "package",
        environmentDir: docxEnv,
        interpreter: join(docxEnv, "bin", "python"),
      });
      expect(prepared.packages[docx]).not.toHaveProperty("activation");
      expect(prepared.recipe?.environmentDir).toBe(join(root, "python"));
      const packageSyncs = uv.calls().filter(
        (call) => call.args.includes("--compile-bytecode") && call.project !== join(root, "python")
      );
      expect(packageSyncs).toHaveLength(2);
      for (const call of packageSyncs) expect(call.args).toContain("--no-editable");
    });

    it("works for a Recipe whose only declaration is a package's", async () => {
      const { prepare } = harness();
      const { dir } = recipe({
        python: false,
        packages: [{ name: docx, python: { project: "python", lockfile: "python/uv.lock" } }],
      });
      const prepared = await prepare(dir, { environmentRoot: scratch("roots-") });
      expect(prepared.recipe).toBeUndefined();
      expect(Object.keys(prepared.packages)).toEqual([docx]);
    });

    it("rejects a dependency that does not ship its project files", async () => {
      const { prepare } = harness();
      const { dir } = recipe({
        python: false,
        packages: [{ name: docx, python: { project: "python", lockfile: "python/uv.lock" }, files: ["dist", "python/*.py"] }],
      });
      await expect(prepare(dir, { environmentRoot: scratch("roots-") })).rejects.toThrow(
        /must ship python\/pyproject\.toml[\s\S]*must ship python\/uv\.lock/
      );
    });
  });

  describe("default location", () => {
    it("keys shared environments by the lock under ~/.introspection/python", async () => {
      const { prepare, home } = harness();
      const { dir } = recipe({});
      const first = await prepare(dir);
      expect(first.recipe?.environmentDir).toMatch(
        new RegExp(`^${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.introspection/python/[0-9a-f]{32}$`)
      );
      // A second Recipe with the same lock shares the environment.
      const twin = recipe({});
      expect((await prepare(twin.dir)).recipe?.environmentDir).toBe(first.recipe?.environmentDir);
      // A different lock gets its own.
      writeFileSync(join(dir, "python", "uv.lock"), "version = 1\n# changed\n");
      expect((await prepare(dir)).recipe?.environmentDir).not.toBe(first.recipe?.environmentDir);
    });

    it("keys the shell and a package environment apart even with identical locks", async () => {
      const { prepare } = harness();
      const { dir } = recipe({ packages: [{ name: "pkg", python: { project: "python", lockfile: "python/uv.lock" } }] });
      const prepared = await prepare(dir);
      expect(prepared.packages.pkg?.environmentDir).not.toBe(prepared.recipe?.environmentDir);
    });

    it("keys each installed copy of a package apart, even with identical project files", async () => {
      const { prepare } = harness();
      const pkg = { name: "pkg", python: { project: "python", lockfile: "python/uv.lock" } };
      const first = recipe({ python: false, packages: [pkg] });
      const second = recipe({ python: false, packages: [pkg] });
      const firstEnv = (await prepare(first.dir)).packages.pkg?.environmentDir;
      const secondEnv = (await prepare(second.dir)).packages.pkg?.environmentDir;
      expect(firstEnv).toBeDefined();
      expect(secondEnv).not.toBe(firstEnv);
      // The same copy keeps its environment.
      expect((await prepare(first.dir)).packages.pkg?.environmentDir).toBe(firstEnv);
      // A new version installed in the same place gets a new one.
      const manifest = join(first.dir, "node_modules", "pkg", "package.json");
      writeFileSync(manifest, readFileSync(manifest, "utf8").replace('"1.0.0"', '"1.0.1"'));
      expect((await prepare(first.dir)).packages.pkg?.environmentDir).not.toBe(firstEnv);
    });

    it("keys a Recipe whose lock installs a local source by its project directory", async () => {
      const { prepare } = harness();
      const lock = 'version = 1\n\n[[package]]\nname = "synthdep"\nversion = "0.1.0"\nsource = { directory = "../synthdep" }\n';
      const first = recipe({});
      const second = recipe({});
      writeFileSync(join(first.dir, "python", "uv.lock"), lock);
      writeFileSync(join(second.dir, "python", "uv.lock"), lock);
      expect((await prepare(first.dir)).recipe?.environmentDir).not.toBe((await prepare(second.dir)).recipe?.environmentDir);
    });
  });
});

describe("activateRecipePython", () => {
  it("sets the venv, prepends its bin once and removes PYTHONHOME", () => {
    const activation = {
      set: { VIRTUAL_ENV: "/envs/shell", UV_PROJECT_ENVIRONMENT: "/envs/shell" },
      pathPrepend: "/envs/shell/bin",
      unset: ["PYTHONHOME"],
    };
    const env: NodeJS.ProcessEnv = { PATH: ["/usr/bin", "/envs/shell/bin"].join(delimiter), PYTHONHOME: "/x" };
    activateRecipePython(env, activation);
    activateRecipePython(env, activation);
    expect(env).toEqual({
      PATH: ["/envs/shell/bin", "/usr/bin"].join(delimiter),
      VIRTUAL_ENV: "/envs/shell",
      UV_PROJECT_ENVIRONMENT: "/envs/shell",
    });
  });
});

describe("validateRecipePythonPackage", () => {
  function pkg(body: Record<string, unknown>): string {
    const dir = scratch("python-package-");
    pythonProject(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", ...body }));
    return dir;
  }
  const python = { project: "python", lockfile: "python/uv.lock" };

  it("accepts a package shipping its project, by file, directory or glob", () => {
    for (const files of [["python/pyproject.toml", "python/uv.lock"], ["python"], ["python/*"], ["dist", "python/"]]) {
      expect(validateRecipePythonPackage(pkg({ files, pi: { runtime: { python } } })).findings).toEqual([]);
    }
    expect(validateRecipePythonPackage(pkg({ pi: { runtime: { python } } })).valid).toBe(true);
    expect(validateRecipePythonPackage(pkg({})).python).toBeUndefined();
  });

  it("rejects files that leave out the lock, or negate it", () => {
    for (const files of [["python/pyproject.toml"], ["python", "!python/uv.lock"]]) {
      const report = validateRecipePythonPackage(pkg({ files, pi: { runtime: { python } } }));
      expect(report.findings.map((item) => item.code)).toEqual(["pi.runtime_files_missing"]);
    }
  });

  it("rejects a lockfile that is not the project's, and non-module imports", () => {
    const moved = pkg({ pi: { runtime: { python: { ...python, lockfile: "uv.lock" } } } });
    writeFileSync(join(moved, "uv.lock"), "version = 1\n");
    expect(validateRecipePythonPackage(moved).findings.map((item) => item.message).join("\n")).toContain(
      "must be the project's uv.lock"
    );
    const imports = validateRecipePythonPackage(pkg({ pi: { runtime: { python: { ...python, imports: ["a-b"] } } } }));
    expect(imports.findings.map((item) => item.message)).toEqual([
      "package.json#pi.runtime.python.imports entry 'a-b' must be a dotted Python module name",
    ]);
  });
});

describe("documents receive their package's interpreter", () => {
  function documentsRecipe(): string {
    const dir = scratch("documents-python-");
    const pkg = join(dir, "node_modules", "@introspection-ai", "recipe-documents-docx");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@introspection-ai/recipe-documents-docx", type: "module", main: "index.js" }));
    writeFileSync(
      join(pkg, "index.js"),
      `export const seen = [];
export default { kind: "documents", format: "docx", extensions: [".docx"], capabilities: { read: true },
  createAdapter: (options) => { globalThis.__recipePythonSeen = options.python ?? null;
    return { format: "docx", extensions: [".docx"], capabilities: { read: true }, read: async () => ({ text: "" }) }; } };\n`
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "r", type: "module", pi: {} }));
    return dir;
  }

  it("passes python to createAdapter, and nothing when the package declares no environment", async () => {
    const dir = documentsRecipe();
    const declarations = [{ format: "docx" }];
    const g = globalThis as { __recipePythonSeen?: string | null };
    const withPython = await loadRecipeDocuments(declarations, ["documents"], {
      recipeDir: dir,
      python: { "@introspection-ai/recipe-documents-docx": { interpreter: "/envs/docx/bin/python" } },
    });
    await withPython.extension!.factory(createMockExtensionAPI() as never);
    expect(g.__recipePythonSeen).toBe("/envs/docx/bin/python");

    const without = await loadRecipeDocuments(declarations, ["documents"], { recipeDir: dir });
    await without.extension!.factory(createMockExtensionAPI() as never);
    expect(g.__recipePythonSeen).toBeNull();
  });
});

const hasUv = spawnSync("uv", ["--version"]).status === 0;

/**
 * Against the real uv, with a synthetic locked project whose one dependency
 * is a local path package, so nothing needs the network beyond what uv's
 * bundled build backend already covers.
 */
describe.skipIf(!hasUv || IS_WINDOWS)("prepareRecipePython with the real uv", () => {
  function lockedRecipe(): string {
    const dir = scratch("recipe-python-real-");
    write(join(dir, "synthdep", "src", "synthdep", "__init__.py"), "VALUE = 42\n");
    write(
      join(dir, "synthdep", "pyproject.toml"),
      [
        "[project]",
        'name = "synthdep"',
        'version = "0.1.0"',
        'requires-python = ">=3.9"',
        "[build-system]",
        'requires = ["uv_build>=0.7"]',
        'build-backend = "uv_build"',
        "",
      ].join("\n")
    );
    write(
      join(dir, "python", "pyproject.toml"),
      [
        "[project]",
        'name = "synthetic"',
        'version = "0.1.0"',
        'requires-python = ">=3.9"',
        'dependencies = ["synthdep"]',
        "[tool.uv.sources]",
        'synthdep = { path = "../synthdep" }',
        "",
      ].join("\n")
    );
    const lockEnv = { ...process.env };
    delete lockEnv.UV_FROZEN;
    delete lockEnv.UV_LOCKED;
    const locked = spawnSync("uv", ["lock", "--project", join(dir, "python")], { env: lockEnv, encoding: "utf8" });
    if (locked.status !== 0) throw new Error(`uv lock failed: ${locked.stderr}`);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "synthetic-real",
        version: "0.1.0",
        pi: { runtime: { python: { project: "python", lockfile: "python/uv.lock", imports: ["synthdep"] } } },
      })
    );
    return dir;
  }

  it(
    "syncs once, checks clean, detects drift in check mode and repairs it in sync mode",
    async () => {
      const dir = lockedRecipe();
      const root = scratch("recipe-python-real-root-");
      const env = { ...process.env };
      delete env.VIRTUAL_ENV;

      // Two preparations racing for one fresh environment: one installs.
      const raced = await Promise.all([
        prepareRecipePython(dir, { mode: "sync", env, environmentRoot: root }),
        prepareRecipePython(dir, { mode: "sync", env, environmentRoot: root }),
      ]);
      expect(raced.map((result) => result.recipe?.synced).sort()).toEqual([false, true]);
      const shell = raced[0]!.recipe!;
      const value = spawnSync(shell.interpreter, ["-c", "import synthdep; print(synthdep.VALUE)"], { encoding: "utf8" });
      expect(value.stdout.trim()).toBe("42");

      const checked = await prepareRecipePython(dir, { mode: "check", env, environmentRoot: root });
      expect(checked.recipe?.synced).toBe(false);

      const removed = spawnSync("uv", ["pip", "uninstall", "--python", shell.interpreter, "synthdep"], { encoding: "utf8" });
      expect(removed.status).toBe(0);
      await expect(prepareRecipePython(dir, { mode: "check", env, environmentRoot: root })).rejects.toBeInstanceOf(
        RecipePythonOutdatedError
      );
      const repaired = await prepareRecipePython(dir, { mode: "sync", env, environmentRoot: root });
      expect(repaired.recipe?.synced).toBe(true);

      await expect(
        prepareRecipePython(dir, { mode: "check", env, environmentRoot: scratch("recipe-python-real-empty-") })
      ).rejects.toBeInstanceOf(RecipePythonOutdatedError);
    },
    120_000
  );

  it("names a version no interpreter satisfies", async () => {
    const dir = lockedRecipe();
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    manifest.pi.runtime.python.version = ">=3.99";
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    await expect(
      prepareRecipePython(dir, { mode: "sync", env: process.env, environmentRoot: scratch("recipe-python-real-root-") })
    ).rejects.toBeInstanceOf(RecipePythonVersionError);
  }, 60_000);
});
