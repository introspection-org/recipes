import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";

import { loadRecipeModule, packageEntry } from "./extensions.js";
import { resolveDependencyDir } from "./package.js";

/**
 * Companion packages: the first-party channel and document format packages
 * Recipes installs alongside itself, as its `optionalDependencies`. Installing
 * `@introspection-ai/recipes` (Pi's npm folder, a runtime image, npm or npx)
 * puts them in the same `node_modules`. A Recipe may declare `pi.channels` or
 * `pi.documents` for one without listing its package, and the copy beside the
 * running Recipes is used. A Recipe that lists the package in `dependencies`
 * pins it, and its copy wins.
 *
 * `optionalDependencies` in this package's `package.json` is the one list
 * (package name to the compatible version range); an installer can read it
 * with `npm view @introspection-ai/recipes@<v> optionalDependencies --json`.
 */

const RECIPES_PACKAGE = "@introspection-ai/recipes";

/** This package's own `package.json`: `src/recipe` and `dist/recipe` both sit two levels below it. */
const recipesManifestPath = fileURLToPath(
  new URL("../../package.json", import.meta.url),
);

interface RecipesManifest {
  version: string;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

let recipesManifest: RecipesManifest | undefined;

/** Read on first use, so a bundle that never loads a package never looks for it. */
function readRecipesManifest(): RecipesManifest {
  recipesManifest ??= JSON.parse(
    readFileSync(recipesManifestPath, "utf8"),
  ) as RecipesManifest;
  return recipesManifest;
}

/** The version of the running `@introspection-ai/recipes`. */
export function recipesVersion(): string {
  return readRecipesManifest().version;
}

/**
 * Companion package name to compatible version range, from
 * `package.json#optionalDependencies`. Inside this repository a range reads
 * `workspace:<range>`; the published manifest carries `<range>`.
 */
export function companionPackages(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(readRecipesManifest().optionalDependencies ?? {})
      .filter(([name]) => isCompanionName(name))
      .map(([name, range]) => [name, range.replace(/^workspace:/, "")]),
  );
}

/**
 * The published manifest's `optionalDependencies` also names the MCP client's
 * platform binaries, which the release stamps in; only the tool packages
 * (`@introspection-ai/recipe-*`) are companions.
 */
function isCompanionName(name: string): boolean {
  return name.startsWith(COMPANION_PREFIX);
}

const COMPANION_PREFIX = "@introspection-ai/recipe-";

/** Whether Recipes installs `name` alongside itself, so a Recipe may omit it. */
export function isCompanionPackage(name: string): boolean {
  return (
    isCompanionName(name) &&
    Object.hasOwn(readRecipesManifest().optionalDependencies ?? {}, name)
  );
}

/**
 * Whether the host imports `name` itself and so always provides it: Recipes,
 * and Recipes' own peers (the Pi packages and typebox).
 */
export function isHostPeerPackage(name: string): boolean {
  return (
    name === RECIPES_PACKAGE ||
    Object.hasOwn(readRecipesManifest().peerDependencies ?? {}, name)
  );
}

/** Where the running `@introspection-ai/recipes` is installed; companion packages resolve from here. */
function hostRecipesDir(): string {
  return realpathSync(dirname(recipesManifestPath));
}

/** A channel or document format package, found for one Recipe. */
export interface ResolvedRecipePackage {
  name: string;
  /** The package's real directory. */
  packageDir: string;
  version: string;
  /**
   * `recipe`: resolved from the Recipe, a dependency it pins or a peer the
   * platform provides in an ancestor `node_modules`. `host`: the copy installed
   * alongside the running Recipes.
   */
  source: "recipe" | "host";
}

/**
 * Find `name` for the Recipe at `recipeDir`: the copy Node resolves from the
 * Recipe first, else, for a companion package, the copy Node resolves from where
 * `@introspection-ai/recipes` itself is installed (`hostDir`). Undefined when
 * neither has it.
 */
export function resolveRecipePackage(
  recipeDir: string,
  name: string,
  hostDir: string = hostRecipesDir(),
): ResolvedRecipePackage | undefined {
  const fromRecipe = resolveDependencyDir(recipeDir, name);
  const source = fromRecipe ? "recipe" : "host";
  const packageDir =
    fromRecipe ??
    (isCompanionPackage(name)
      ? resolveDependencyDir(hostDir, name)
      : undefined);
  if (!packageDir) return undefined;
  const manifest = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  ) as { version?: unknown };
  return {
    name,
    packageDir,
    version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
    source,
  };
}

/**
 * Fail when the package's `peerDependencies["@introspection-ai/recipes"]`
 * range does not admit the running Recipes version, naming the package, its
 * version and range, the running version, and the fix. A package declaring no
 * range is not checked; neither is a `workspace:` link that names no range.
 */
function assertRecipesCompatible(
  pkg: ResolvedRecipePackage,
  running: string = recipesVersion(),
): void {
  const manifest = JSON.parse(
    readFileSync(join(pkg.packageDir, "package.json"), "utf8"),
  ) as {
    peerDependencies?: Record<string, unknown>;
  };
  const declared = manifest.peerDependencies?.[RECIPES_PACKAGE];
  if (typeof declared !== "string") return;
  // pnpm publishes `workspace:<range>` as `<range>`; `workspace:^` and the like
  // only occur in an unpublished checkout, linked to this very package.
  const range = declared.startsWith("workspace:")
    ? declared.slice("workspace:".length)
    : declared;
  if (declared.startsWith("workspace:") && semver.validRange(range) === null)
    return;
  if (semver.satisfies(running, range, { includePrerelease: true })) return;
  throw new Error(
    `${describe(pkg)} requires ${RECIPES_PACKAGE} ${range}, but ${RECIPES_PACKAGE} ${running} is running. ${fix(pkg)}`,
  );
}

function describe(pkg: ResolvedRecipePackage): string {
  const copy =
    pkg.source === "recipe"
      ? "resolved from the Recipe"
      : "installed alongside Recipes";
  return `${pkg.name}@${pkg.version} (${copy}, ${pkg.packageDir})`;
}

function fix(pkg: ResolvedRecipePackage): string {
  return `Raise or remove the Recipe's pin on ${pkg.name} in its dependencies, or run \`introspection upgrade\`.`;
}

/** The contract a module must implement: its name in errors, and the version this host implements. */
export interface RecipeModuleApi {
  name: string;
  version: number;
}

/**
 * Fail when a loaded module declares an `apiVersion` other than the one this
 * host implements. A module without one predates the contract version and
 * imports Recipes itself, so `assertRecipesCompatible` covers it.
 */
function assertModuleApi(
  pkg: ResolvedRecipePackage,
  imported: unknown,
  api: RecipeModuleApi,
  running: string = recipesVersion(),
): void {
  const module =
    imported && typeof imported === "object" && "default" in imported
      ? (imported as { default: unknown }).default
      : imported;
  const declared =
    module && typeof module === "object"
      ? (module as { apiVersion?: unknown }).apiVersion
      : undefined;
  if (declared === undefined || declared === api.version) return;
  throw new Error(
    `${describe(pkg)} implements ${api.name} API ${String(declared)}, but ${RECIPES_PACKAGE} ${running} implements ${api.name} API ${api.version}. ${fix(pkg)}`,
  );
}

/**
 * Import a channel or document format package for the Recipe at `recipeDir`,
 * from the Recipe or the host (see `resolveRecipePackage`), checking it accepts
 * the running Recipes version: its Recipes peer range when it declares one,
 * and the contract version (`apiVersion`) its module declares. `what` names the declaration in errors,
 * such as `Recipe channel 'slack'`.
 */
export async function loadRecipePackageModule(
  recipeDir: string,
  name: string,
  options: { what: string; api: RecipeModuleApi; hostDir?: string },
): Promise<unknown> {
  const resolved = resolveRecipePackage(recipeDir, name, options.hostDir);
  if (!resolved) {
    throw new Error(
      isCompanionPackage(name)
        ? `${options.what} requires ${name}: add it to the Recipe dependencies, or reinstall Recipes, which installs it alongside itself (\`introspection upgrade\`)`
        : `${options.what} requires ${name} in the Recipe dependencies`,
    );
  }
  assertRecipesCompatible(resolved);
  const entry = packageEntry(resolved.packageDir);
  if (!entry)
    throw new Error(
      `${options.what}: ${name} at ${resolved.packageDir} has no entry point`,
    );
  let imported: unknown;
  try {
    imported = await loadRecipeModule(recipeDir, entry);
  } catch (error) {
    throw new Error(
      `${options.what}: failed to load ${name} from ${resolved.packageDir}`,
      { cause: error },
    );
  }
  assertModuleApi(resolved, imported, options.api);
  return imported;
}
