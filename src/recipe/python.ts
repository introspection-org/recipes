/**
 * Prepare the Python environments a Recipe declares with `pi.runtime.python`.
 *
 * Two kinds of declaration exist, and they never share an environment:
 *
 * - The Recipe's own declaration is its **shell environment**. Activating it
 *   sets `VIRTUAL_ENV` and `UV_PROJECT_ENVIRONMENT`, puts its `bin` first on
 *   `PATH` and removes `PYTHONHOME`, so the agent's shell tools run it.
 * - A direct dependency's declaration is that **package's environment**. It is
 *   installed with `--no-editable`, never activated and never put on `PATH`;
 *   the host passes its interpreter to the package (documents formats receive
 *   it through `createAdapter({ python })`).
 *
 * `check` never writes and never touches the network. `sync` checks first and
 * installs only an environment that is missing or outdated.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { resolveRecipePackage } from "./companions.js";
import {
  installedRecipeDependencies,
  isPythonModuleName,
  readPiPackageManifest,
  recipeChannelPackageName,
  recipeDocumentPackageName,
  validateRecipePythonPackage,
  type RecipePythonRuntimeRequirement,
} from "./package.js";

/** Hosts read a fixed environment root from this variable (see `environmentRoot`). */
export const RECIPE_PYTHON_ROOT_ENV = "PI_RECIPES_PYTHON_ROOT";

export const UV_INSTALL_URL =
  "https://docs.astral.sh/uv/getting-started/installation/";

export type RecipePythonMode = "check" | "sync";

export interface PrepareRecipePythonOptions {
  /** `check` verifies without writing; `sync` installs what is missing or outdated. */
  mode: RecipePythonMode;
  /**
   * Fixed location for the environments instead of the shared, lock-keyed
   * cache under `~/.introspection/python`. The Recipe's shell environment is
   * `<root>/python`, each package's `<root>/python-packages/<name>`. A host
   * that bakes environments into a Recipe image passes `<recipe>/.pi`.
   */
  environmentRoot?: string;
  /** Let uv download a managed Python interpreter. Default false: `--no-python-downloads`. */
  allowPythonDownloads?: boolean;
  /** Environment uv and the import check run with. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The uv executable. Default `uv` from `env.PATH`. */
  uv?: string;
  /** Called before an environment is installed: `firstBuild` when it did not exist yet. */
  onSync?(event: RecipePythonSyncEvent): void;
  /** Where companion packages resolve from. Default: where `@introspection-ai/recipes` is installed. */
  hostDir?: string;
}

export interface RecipePythonSyncEvent {
  /** The declaring package's name: the Recipe's own name for the shell environment. */
  owner: string;
  kind: "recipe" | "package";
  environmentDir: string;
  firstBuild: boolean;
}

/** How to put the Recipe's shell environment in front of a process environment. */
export interface RecipePythonActivation {
  /** Variables to set: `VIRTUAL_ENV` and `UV_PROJECT_ENVIRONMENT`. */
  set: Readonly<Record<string, string>>;
  /** Prepended to `PATH`. */
  pathPrepend: string;
  /** Variables to remove: `PYTHONHOME`. */
  unset: readonly string[];
}

export interface RecipePythonEnvironment {
  kind: "recipe" | "package";
  /** The declaring package's name. */
  owner: string;
  packageDir: string;
  projectDir: string;
  lockfile: string;
  environmentDir: string;
  /** `bin/python`, or `Scripts\python.exe` on Windows. */
  interpreter: string;
  imports: readonly string[];
  /** Whether this call installed into the environment. */
  synced: boolean;
}

export interface RecipeShellPythonEnvironment extends RecipePythonEnvironment {
  kind: "recipe";
  activation: RecipePythonActivation;
}

export interface PreparedRecipePython {
  /** The Recipe's own declaration, if any: the shell environment. */
  recipe?: RecipeShellPythonEnvironment;
  /** Each direct dependency's declaration, by package name. */
  packages: Readonly<Record<string, RecipePythonEnvironment>>;
}

export class RecipePythonError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RecipePythonError";
  }
}

/** uv is not installed or not on PATH. */
export class RecipePythonUvMissingError extends RecipePythonError {
  constructor(uv: string, options?: { cause?: unknown }) {
    super(
      `uv was not found (${uv}); it prepares the Recipe's Python environments. Install it: ${UV_INSTALL_URL}`,
      options,
    );
    this.name = "RecipePythonUvMissingError";
  }
}

/** No interpreter satisfies the declared or required Python version. */
export class RecipePythonVersionError extends RecipePythonError {
  constructor(message: string) {
    super(message);
    this.name = "RecipePythonVersionError";
  }
}

/** Check mode found an environment missing or not matching its lockfile. */
export class RecipePythonOutdatedError extends RecipePythonError {
  constructor(message: string) {
    super(message);
    this.name = "RecipePythonOutdatedError";
  }
}

/** A declared `imports` entry does not import in its environment. */
export class RecipePythonImportError extends RecipePythonError {
  constructor(message: string) {
    super(message);
    this.name = "RecipePythonImportError";
  }
}

interface Declaration {
  kind: "recipe" | "package";
  owner: string;
  packageDir: string;
  python: RecipePythonRuntimeRequirement;
}

const IS_WINDOWS = process.platform === "win32";
const ENVIRONMENT_FORMAT = "1";
const LOCK_TIMEOUT_MS = 15 * 60_000;
const LOCK_POLL_MS = 100;
const TAKEOVER_MARKER_STALE_MS = 60_000;

function readJson(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function packagePythonDeclaration(
  name: string,
  packageDir: string,
): Declaration | undefined {
  const report = validateRecipePythonPackage(packageDir);
  if (!report.valid) {
    throw new RecipePythonError(
      `Dependency ${name} declares an invalid pi.runtime.python:\n${report.findings
        .map((item) => `- ${item.message}`)
        .join("\n")}`,
    );
  }
  return report.python
    ? { kind: "package", owner: name, packageDir, python: report.python }
    : undefined;
}

/**
 * Every `pi.runtime.python` the Recipe declares: its own, its direct
 * dependencies', and that of each channel or document format package its
 * `pi.channels` or `pi.documents` uses but does not list, found as the loader
 * finds it (the copy installed alongside Recipes; see `resolveRecipePackage`).
 */
export function recipePythonDeclarations(
  recipeDir: string,
  options: { hostDir?: string } = {},
): Declaration[] {
  const root = resolve(recipeDir);
  const declarations: Declaration[] = [];
  const manifest = readPiPackageManifest(root);
  if (manifest.runtime?.python) {
    declarations.push({
      kind: "recipe",
      owner: manifest.name,
      packageDir: root,
      python: manifest.runtime.python,
    });
  }
  for (const { name, packageDir } of installedRecipeDependencies(root, [
    "dependencies",
    "peerDependencies",
  ])) {
    const declaration = packagePythonDeclaration(name, packageDir);
    if (declaration) declarations.push(declaration);
  }
  const used = [
    ...(manifest.channels ?? []).map((channel) =>
      recipeChannelPackageName(channel.provider),
    ),
    ...(manifest.documents ?? []).map((document) =>
      recipeDocumentPackageName(document.format),
    ),
  ];
  for (const name of used) {
    if (
      declarations.some(
        (declaration) =>
          declaration.kind === "package" && declaration.owner === name,
      )
    )
      continue;
    const resolved = resolveRecipePackage(root, name, options.hostDir);
    const declaration =
      resolved && packagePythonDeclaration(name, resolved.packageDir);
    if (declaration) declarations.push(declaration);
  }
  return declarations;
}

function hashFile(
  hash: ReturnType<typeof createHash>,
  label: string,
  path: string,
): void {
  hash.update(`${label}\0`);
  hash.update(readFileSync(path));
  hash.update("\0");
}

const PIN_FILES = [".python-version", ".python-versions"] as const;

/** uv's user configuration directory, which holds its global pin (`uv python pin --global`). */
function uvUserConfigDir(env: NodeJS.ProcessEnv): string {
  if (IS_WINDOWS)
    return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "uv");
  return join(
    env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"),
    "uv",
  );
}

/**
 * What uv picks the interpreter from when the declaration names no version:
 * `UV_PYTHON`, a `.python-version` or `.python-versions` pin it discovers from
 * the project, and the global pin. Every pin file from the project directory
 * up to the filesystem root is included, a superset of where any uv version
 * looks, so two projects that may select different interpreters never share a
 * key. A declared version is passed as `--python`, which overrides all of
 * them, so then none is read.
 */
function hashDiscoveredPins(
  hash: ReturnType<typeof createHash>,
  projectDir: string,
  env: NodeJS.ProcessEnv,
): void {
  hash.update(`UV_PYTHON\0${env.UV_PYTHON ?? ""}\0`);
  // Labelled by level, not path, so Recipes with the same pins still share.
  const dirs: Array<[string, string]> = [];
  let level = 0;
  for (let dir = resolve(projectDir); ; dir = dirname(dir)) {
    dirs.push([`pin ${level++}`, dir]);
    if (dirname(dir) === dir) break;
  }
  dirs.push(["global pin", uvUserConfigDir(env)]);
  for (const [label, dir] of dirs) {
    for (const name of PIN_FILES) {
      const path = join(dir, name);
      if (existsSync(path) && statSync(path).isFile())
        hashFile(hash, `${label} ${name}`, path);
    }
  }
}

/** A `uv.lock` that installs a source from the local disk: editable, directory or path. */
const LOCAL_LOCK_SOURCE =
  /^\s*source\s*=\s*\{\s*(?:editable|directory|path)\s*=/m;

/**
 * The shared-cache key: the environment kind, platform, `uv.lock`,
 * `pyproject.toml` and the declared version range, plus the identity of any
 * local source the environment installs, since uv does not re-install a local
 * package whose version is unchanged:
 *
 * - Without a declared version, the pins uv would select the interpreter from
 *   (`UV_PYTHON`, `.python-version` files, the global pin): see
 *   {@link hashDiscoveredPins}.
 *
 * - A package environment installs that package's own project, so its key
 *   holds the package's realpath and `name@version`. Two installed copies of a
 *   dependency never share one environment, even with identical project files.
 * - The Recipe's shell environment holds local code only when its project is
 *   itself a package (`[build-system]`, installed editable) or its lock names a
 *   local source; then the project's realpath is in the key. Otherwise Recipes
 *   with the same lock share one environment.
 */
function environmentHash(
  declaration: Declaration,
  projectDir: string,
  lockfile: string,
  env: NodeJS.ProcessEnv,
): string {
  const hash = createHash("sha256");
  hash.update(
    `recipes-python-env:${ENVIRONMENT_FORMAT}\0${declaration.kind}\0`,
  );
  hash.update(`${process.platform}-${process.arch}\0`);
  hashFile(hash, "uv.lock", lockfile);
  const pyproject = join(projectDir, "pyproject.toml");
  hashFile(hash, "pyproject.toml", pyproject);
  hash.update(`version\0${declaration.python.version ?? ""}\0`);
  if (!declaration.python.version) hashDiscoveredPins(hash, projectDir, env);
  if (declaration.kind === "package") {
    const packageJson = readJson(join(declaration.packageDir, "package.json"));
    const version =
      typeof packageJson.version === "string" ? packageJson.version : "";
    hash.update(
      `package\0${declaration.owner}@${version}\0${realpathSync(declaration.packageDir)}\0`,
    );
  } else if (
    /^\s*\[build-system\]/m.test(readFileSync(pyproject, "utf8")) ||
    LOCAL_LOCK_SOURCE.test(readFileSync(lockfile, "utf8"))
  ) {
    hash.update(`project\0${realpathSync(projectDir)}\0`);
  }
  return hash.digest("hex").slice(0, 32);
}

function environmentDirFor(
  declaration: Declaration,
  projectDir: string,
  lockfile: string,
  options: PrepareRecipePythonOptions,
  env: NodeJS.ProcessEnv,
): string {
  if (options.environmentRoot) {
    const root = resolve(options.environmentRoot);
    return declaration.kind === "recipe"
      ? join(root, "python")
      : join(root, "python-packages", ...declaration.owner.split("/"));
  }
  const home = (IS_WINDOWS ? env.USERPROFILE : env.HOME) || homedir();
  return join(
    home,
    ".introspection",
    "python",
    environmentHash(declaration, projectDir, lockfile, env),
  );
}

function binDir(environmentDir: string): string {
  return join(environmentDir, IS_WINDOWS ? "Scripts" : "bin");
}

function interpreterPath(environmentDir: string): string {
  return join(binDir(environmentDir), IS_WINDOWS ? "python.exe" : "python");
}

function sameDirectory(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function environmentExists(environmentDir: string): boolean {
  return (
    existsSync(join(environmentDir, "pyvenv.cfg")) &&
    existsSync(interpreterPath(environmentDir))
  );
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** A copy of `env` without `PYTHONHOME`, which would point a venv's Python at another stdlib. */
function withoutPythonHome(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (key.toUpperCase() === "PYTHONHOME") delete copy[key];
  }
  return copy;
}

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

/**
 * Apply a shell activation to `env` in place. Idempotent: the `bin`
 * directory is moved to the front of `PATH`, never duplicated.
 */
export function activateRecipePython(
  env: NodeJS.ProcessEnv,
  activation: RecipePythonActivation,
): NodeJS.ProcessEnv {
  for (const key of Object.keys(env)) {
    if (
      activation.unset.some((name) => name.toUpperCase() === key.toUpperCase())
    )
      delete env[key];
  }
  Object.assign(env, activation.set);
  const key = pathKey(env);
  const rest = (env[key] ?? "")
    .split(delimiter)
    .filter((entry) => entry && entry !== activation.pathPrepend);
  env[key] = [activation.pathPrepend, ...rest].join(delimiter);
  return env;
}

function lastLines(text: string, count = 12): string {
  return text.trim().split(/\r?\n/).slice(-count).join("\n");
}

const INTERPRETER_PROBLEM =
  /no interpreter found|requires-python|python version|python downloads are not allowed|does not satisfy|incompatible with the project/i;

class Preparer {
  private readonly env: NodeJS.ProcessEnv;
  private readonly uv: string;
  private uvChecked = false;

  constructor(private readonly options: PrepareRecipePythonOptions) {
    this.env = options.env ?? process.env;
    this.uv = options.uv ?? "uv";
  }

  private async uvRun(
    args: readonly string[],
    cwd: string,
    environmentDir: string,
    variable:
      "UV_PROJECT_ENVIRONMENT" | "VIRTUAL_ENV" = "UV_PROJECT_ENVIRONMENT",
  ): Promise<RunResult> {
    const env = withoutPythonHome(this.env);
    for (const key of Object.keys(env)) {
      if (["VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT"].includes(key.toUpperCase()))
        delete env[key];
    }
    if (environmentDir) env[variable] = environmentDir;
    try {
      return await run(this.uv, args, { cwd, env });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RecipePythonUvMissingError(this.uv, { cause: error });
      }
      throw error;
    }
  }

  private async ensureUv(cwd: string): Promise<void> {
    if (this.uvChecked) return;
    const result = await this.uvRun(["--version"], cwd, "");
    if (result.code !== 0) {
      throw new RecipePythonUvMissingError(this.uv);
    }
    this.uvChecked = true;
  }

  private commonArgs(declaration: Declaration, projectDir: string): string[] {
    return [
      "sync",
      "--project",
      projectDir,
      "--frozen",
      "--no-dev",
      ...(declaration.kind === "package" ? ["--no-editable"] : []),
      ...(declaration.python.version
        ? ["--python", declaration.python.version]
        : []),
      ...(this.options.allowPythonDownloads ? [] : ["--no-python-downloads"]),
    ];
  }

  /** `current`, `outdated` (exit 1 or missing), or `interpreter` (exit 2 naming the interpreter). */
  private async check(
    declaration: Declaration,
    projectDir: string,
    environmentDir: string,
  ): Promise<{
    state: "current" | "outdated" | "interpreter";
    detail: string;
  }> {
    // uv reports "Would create" with exit 0 for an environment that does not
    // exist when nothing needs installing, so a missing one is checked here.
    if (!environmentExists(environmentDir)) {
      return { state: "outdated", detail: `${environmentDir} does not exist` };
    }
    const result = await this.uvRun(
      [...this.commonArgs(declaration, projectDir), "--check", "--offline"],
      projectDir,
      environmentDir,
    );
    if (result.code === 0)
      return this.checkInterpreter(declaration, projectDir, environmentDir);
    const detail = lastLines(`${result.stdout}\n${result.stderr}`);
    if (result.code === 1) return { state: "outdated", detail };
    if (result.code === 2 && INTERPRETER_PROBLEM.test(detail))
      return { state: "interpreter", detail };
    throw new RecipePythonError(
      `uv could not check the Python environment for ${declaration.owner} (exit ${result.code}):\n${detail}`,
    );
  }

  /**
   * Whether the environment's interpreter still satisfies the declared version
   * and the project's `requires-python`. `uv sync --check` exits 0 even when
   * the sync it stands for would replace the environment for another
   * interpreter ("Would replace project environment"), so the check alone
   * would accept an environment built for a version no longer declared. Ask
   * uv which interpreter the request selects with this environment active: it
   * prefers the active environment whenever that satisfies the request.
   *
   * The request is the declared version, else `UV_PYTHON`, which `uv sync`
   * reads but `uv python find` does not. A request naming an interpreter path
   * selects that path rather than the environment, so an interpreter found
   * elsewhere is still accepted when it is the environment's base interpreter.
   */
  private async checkInterpreter(
    declaration: Declaration,
    projectDir: string,
    environmentDir: string,
  ): Promise<{
    state: "current" | "outdated" | "interpreter";
    detail: string;
  }> {
    const request =
      declaration.python.version ?? (this.env.UV_PYTHON || undefined);
    const result = await this.uvRun(
      [
        "python",
        "find",
        ...(request ? [request] : []),
        "--project",
        projectDir,
        "--no-python-downloads",
        "--offline",
      ],
      projectDir,
      environmentDir,
      "VIRTUAL_ENV",
    );
    const detail = lastLines(`${result.stdout}\n${result.stderr}`);
    if (result.code === 2 && INTERPRETER_PROBLEM.test(detail))
      return { state: "interpreter", detail };
    if (result.code !== 0) {
      throw new RecipePythonError(
        `uv could not check the Python interpreter for ${declaration.owner} (exit ${result.code}):\n${detail}`,
      );
    }
    const found = result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
    // uv names the environment's interpreter by the path it was given; an
    // interpreter elsewhere means the environment no longer satisfies the
    // request, and a warning means it conflicts with `requires-python`.
    if (
      !INTERPRETER_PROBLEM.test(result.stderr) &&
      (sameDirectory(dirname(dirname(found)), environmentDir) ||
        (await this.sameBaseInterpreter(found, environmentDir)))
    ) {
      return { state: "current", detail: "" };
    }
    const wanted = request ?? "the project's requires-python";
    return {
      state: "outdated",
      detail: `the interpreter in ${environmentDir} does not satisfy ${wanted}${
        result.stderr.trim() ? `:\n${lastLines(result.stderr)}` : ""
      }`,
    };
  }

  /** Whether `found` is the interpreter `environmentDir` was created from: same implementation, version and base prefix. */
  private async sameBaseInterpreter(
    found: string,
    environmentDir: string,
  ): Promise<boolean> {
    if (!found) return false;
    const probe = async (python: string): Promise<string | undefined> => {
      const script =
        "import os, sys; print(sys.implementation.name, sys.version_info[:3], os.path.realpath(sys.base_prefix))";
      try {
        const result = await run(python, ["-c", script], {
          cwd: environmentDir,
          env: withoutPythonHome(this.env),
        });
        const line = result.stdout.trim();
        return result.code === 0 && line ? line : undefined;
      } catch {
        return undefined;
      }
    };
    const [base, environment] = await Promise.all([
      probe(found),
      probe(interpreterPath(environmentDir)),
    ]);
    return base !== undefined && base === environment;
  }

  private versionError(
    declaration: Declaration,
    detail: string,
  ): RecipePythonVersionError {
    const wanted = declaration.python.version
      ? ` ${declaration.python.version}`
      : "";
    return new RecipePythonVersionError(
      `No Python interpreter satisfies${wanted} for ${declaration.owner}${
        this.options.allowPythonDownloads
          ? ""
          : " (Python downloads are disabled)"
      }:\n${detail}`,
    );
  }

  private async sync(
    declaration: Declaration,
    projectDir: string,
    environmentDir: string,
  ): Promise<void> {
    const result = await this.uvRun(
      [...this.commonArgs(declaration, projectDir), "--compile-bytecode"],
      projectDir,
      environmentDir,
    );
    if (result.code === 0) return;
    const detail = lastLines(`${result.stdout}\n${result.stderr}`);
    if (INTERPRETER_PROBLEM.test(detail))
      throw this.versionError(declaration, detail);
    throw new RecipePythonError(
      `uv could not install the Python environment for ${declaration.owner} (exit ${result.code}):\n${detail}`,
    );
  }

  private async importCheck(
    declaration: Declaration,
    environmentDir: string,
  ): Promise<void> {
    const imports = declaration.python.imports;
    if (imports.length === 0) return;
    const bad = imports.filter((name) => !isPythonModuleName(name));
    if (bad.length > 0) {
      throw new RecipePythonImportError(
        `${declaration.owner} declares imports that are not dotted Python module names: ${bad.join(", ")}`,
      );
    }
    const script = [
      "import importlib, sys",
      "failed = []",
      "for name in sys.argv[1:]:",
      "    try:",
      "        importlib.import_module(name)",
      "    except BaseException as error:",
      "        failed.append(f'{name}: {type(error).__name__}: {error}')",
      "if failed:",
      "    sys.stderr.write('\\n'.join(failed) + '\\n')",
      "    sys.exit(1)",
    ].join("\n");
    const env = withoutPythonHome(this.env);
    let result: RunResult;
    try {
      result = await run(
        interpreterPath(environmentDir),
        ["-c", script, ...imports],
        {
          cwd: environmentDir,
          env,
        },
      );
    } catch (error) {
      throw new RecipePythonImportError(
        `${declaration.owner}: the interpreter in ${environmentDir} could not run: ${(error as Error).message}`,
      );
    }
    if (result.code !== 0) {
      throw new RecipePythonImportError(
        `${declaration.owner}: declared Python imports failed in ${environmentDir}:\n${lastLines(result.stderr)}`,
      );
    }
  }

  async prepare(declaration: Declaration): Promise<RecipePythonEnvironment> {
    const projectDir = resolve(
      declaration.packageDir,
      declaration.python.project,
    );
    const lockfile = resolve(
      declaration.packageDir,
      declaration.python.lockfile,
    );
    if (!existsSync(join(projectDir, "pyproject.toml"))) {
      throw new RecipePythonError(
        `${declaration.owner}: pi.runtime.python.project has no pyproject.toml: ${declaration.python.project}`,
      );
    }
    if (!existsSync(lockfile)) {
      throw new RecipePythonError(
        `${declaration.owner}: pi.runtime.python.lockfile does not exist: ${declaration.python.lockfile}`,
      );
    }
    if (lockfile !== join(projectDir, "uv.lock")) {
      // uv reads the lockfile beside pyproject.toml and has no flag naming another.
      throw new RecipePythonError(
        `${declaration.owner}: pi.runtime.python.lockfile must be the project's uv.lock (${declaration.python.project}/uv.lock)`,
      );
    }
    const environmentDir = environmentDirFor(
      declaration,
      projectDir,
      lockfile,
      this.options,
      this.env,
    );
    await this.ensureUv(projectDir);

    let synced = false;
    const first = await this.check(declaration, projectDir, environmentDir);
    if (first.state !== "current") {
      if (this.options.mode === "check") {
        if (first.state === "interpreter")
          throw this.versionError(declaration, first.detail);
        throw new RecipePythonOutdatedError(
          `The Python environment for ${declaration.owner} is not prepared or does not match its uv.lock (${environmentDir}); the host must sync it before the session starts:\n${first.detail}`,
        );
      }
      if (first.state === "interpreter" && !this.options.allowPythonDownloads) {
        throw this.versionError(declaration, first.detail);
      }
      synced = await withEnvironmentLock(environmentDir, async () => {
        // Another process may have finished the same environment while this one waited.
        const again = await this.check(declaration, projectDir, environmentDir);
        if (again.state === "current") return false;
        if (
          again.state === "interpreter" &&
          !this.options.allowPythonDownloads
        ) {
          throw this.versionError(declaration, again.detail);
        }
        this.options.onSync?.({
          owner: declaration.owner,
          kind: declaration.kind,
          environmentDir,
          firstBuild: !environmentExists(environmentDir),
        });
        await this.sync(declaration, projectDir, environmentDir);
        return true;
      });
    }
    await this.importCheck(declaration, environmentDir);
    return {
      kind: declaration.kind,
      owner: declaration.owner,
      packageDir: declaration.packageDir,
      projectDir,
      lockfile,
      environmentDir,
      interpreter: interpreterPath(environmentDir),
      imports: [...declaration.python.imports],
      synced,
    };
  }
}

/** What a waiter saw in a lock file: who holds it, and whether that holder is gone. */
export interface InspectedEnvironmentLock {
  /** Identifies this one lock file: its inode, mtime and owner record. */
  generation: string;
  stale: boolean;
}

function lockGeneration(
  lockPath: string,
): { generation: string; owner: string } | undefined {
  try {
    const fd = openSync(lockPath, "r");
    try {
      const stat = fstatSync(fd);
      const owner = readFileSync(fd, "utf8");
      const generation = createHash("sha256")
        .update(
          `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}\0${owner}`,
        )
        .digest("hex")
        .slice(0, 32);
      return { generation, owner };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Read the lock at `lockPath`; `undefined` when there is none. */
export function inspectEnvironmentLock(
  lockPath: string,
): InspectedEnvironmentLock | undefined {
  const seen = lockGeneration(lockPath);
  if (!seen) return undefined;
  let stale: boolean | undefined;
  try {
    const owner = JSON.parse(seen.owner) as { pid?: number; host?: string };
    if (owner.host === hostname() && typeof owner.pid === "number") {
      try {
        process.kill(owner.pid, 0);
        stale = false;
      } catch (error) {
        stale = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    }
  } catch {
    // Unreadable: a writer died between create and write, or the file is mid-write.
  }
  if (stale === undefined) {
    try {
      stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_TIMEOUT_MS;
    } catch {
      stale = false;
    }
  }
  return { generation: seen.generation, stale };
}

/**
 * Remove the lock at `lockPath` only if it is still the `generation` a waiter
 * inspected and judged stale. Returns whether it was removed.
 *
 * Two waiters can both judge one lock stale. Each must first create the
 * takeover marker for that generation exclusively, so only one of them can
 * remove it; the other sees the marker, or, once it is gone, a lock of a new
 * generation, and leaves that lock alone. Nothing but the marker's holder
 * removes a lock of that generation (its owner is gone), so the check and the
 * removal cannot be split by another taker.
 */
export function takeOverStaleEnvironmentLock(
  lockPath: string,
  generation: string,
): boolean {
  const marker = `${lockPath}.takeover-${generation}`;
  let fd: number;
  try {
    fd = openSync(marker, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A marker outlives its few synchronous steps only when its taker died
    // between them; clear it so the next attempt can take the lock over.
    try {
      if (Date.now() - statSync(marker).mtimeMs > TAKEOVER_MARKER_STALE_MS)
        rmSync(marker, { force: true });
    } catch {
      // Gone already.
    }
    return false;
  }
  closeSync(fd);
  try {
    if (lockGeneration(lockPath)?.generation !== generation) return false;
    rmSync(lockPath, { force: true });
    return true;
  } finally {
    rmSync(marker, { force: true });
  }
}

/** Create the lock at `lockPath` if there is none. Returns the owner token on success. */
export function tryAcquireEnvironmentLock(
  lockPath: string,
): string | undefined {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  const token = randomUUID();
  try {
    writeSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        token,
        at: new Date().toISOString(),
      }),
    );
  } finally {
    closeSync(fd);
  }
  return token;
}

/** Remove the lock at `lockPath` only if it still carries `token`: never another owner's. */
export function releaseEnvironmentLock(
  lockPath: string,
  token: string,
): boolean {
  let owner: { token?: unknown };
  try {
    owner = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: unknown };
  } catch {
    return false;
  }
  if (owner.token !== token) return false;
  rmSync(lockPath, { force: true });
  return true;
}

/**
 * Serialise installs into one environment across processes with an
 * exclusive-create lock file beside it. A lock whose owner is gone is taken
 * over, by one waiter only (see `takeOverStaleEnvironmentLock`); one held
 * longer than the timeout fails the wait. Only the lock this call created is
 * removed when it finishes.
 */
async function withEnvironmentLock<T>(
  environmentDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  mkdirSync(dirname(environmentDir), { recursive: true });
  const lockPath = `${environmentDir}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let token: string | undefined;
  while ((token = tryAcquireEnvironmentLock(lockPath)) === undefined) {
    const held = inspectEnvironmentLock(lockPath);
    if (!held) continue;
    if (held.stale && takeOverStaleEnvironmentLock(lockPath, held.generation))
      continue;
    if (Date.now() > deadline) {
      throw new RecipePythonError(
        `Timed out waiting for another process preparing ${environmentDir} (${lockPath})`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_POLL_MS));
  }
  try {
    return await fn();
  } finally {
    releaseEnvironmentLock(lockPath, token);
  }
}

/**
 * Find and prepare every `pi.runtime.python` the Recipe at `recipeDir`
 * declares: its own (the shell environment), each direct `dependencies` or
 * `peerDependencies` entry Node resolves from the Recipe directory, and each
 * companion channel or document format package the Recipe uses without
 * listing it (each package in an environment of its own). Dev and transitive
 * dependencies are not read.
 */
export async function prepareRecipePython(
  recipeDir: string,
  options: PrepareRecipePythonOptions,
): Promise<PreparedRecipePython> {
  const declarations = recipePythonDeclarations(
    recipeDir,
    options.hostDir !== undefined ? { hostDir: options.hostDir } : {},
  );
  const preparer = new Preparer(options);
  const packages: Record<string, RecipePythonEnvironment> = {};
  let recipe: RecipeShellPythonEnvironment | undefined;
  // Sequential: uv already parallelises one install, and concurrent first
  // builds would only compete for the same downloads.
  for (const declaration of declarations) {
    const environment = await preparer.prepare(declaration);
    if (declaration.kind === "recipe") {
      recipe = {
        ...environment,
        kind: "recipe",
        activation: {
          set: {
            VIRTUAL_ENV: environment.environmentDir,
            UV_PROJECT_ENVIRONMENT: environment.environmentDir,
          },
          pathPrepend: binDir(environment.environmentDir),
          unset: ["PYTHONHOME"],
        },
      };
    } else {
      packages[declaration.owner] = environment;
    }
  }
  return { ...(recipe ? { recipe } : {}), packages };
}
