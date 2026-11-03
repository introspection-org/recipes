import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);

export function resolvePackageFromHost(
  specifier: string,
  hostEntry: string | undefined = process.argv[1]
): string | undefined {
  if (!hostEntry) return undefined;
  const realHostEntry = realpathSync(hostEntry);
  try {
    return createRequire(realHostEntry).resolve(specifier);
  } catch {
    // Pi's ESM-only packages expose an `import` condition but no CommonJS
    // entry, so createRequire cannot resolve them even from the active host.
  }
  try {
    const manifestPath = findPackageJSON(specifier, realHostEntry);
    return manifestPath ? packageEntry(dirname(manifestPath)) : undefined;
  } catch {
    return undefined;
  }
}

/** The conditions an ESM `import` in Node matches, in Node's order of preference. */
const IMPORT_CONDITIONS = ["import", "node", "default"];

/**
 * The target an `exports` value resolves to for an ESM import, following
 * Node's rules: a string is the target, an array is tried in order, and a
 * conditions object takes its first key, in its own order, that `import` in
 * Node matches.
 */
function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = exportTarget(item);
      if (target) return target;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [condition, nested] of Object.entries(value)) {
      if (!IMPORT_CONDITIONS.includes(condition)) continue;
      const target = exportTarget(nested);
      if (target) return target;
    }
  }
  return undefined;
}

/**
 * The file an ESM `import` of the package at `packageDir` loads: its root
 * export, whether written as `exports["."]` or as conditions at the top of
 * `exports`; else `module` or `main`; else `index.js`, as Node defaults to.
 */
export function packageEntry(packageDir: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    exports?: unknown;
    module?: string;
    main?: string;
  };
  const { exports } = manifest;
  const isSubpathMap =
    !!exports &&
    typeof exports === "object" &&
    !Array.isArray(exports) &&
    Object.keys(exports).some((key) => key.startsWith("."));
  const rootExport = isSubpathMap ? (exports as Record<string, unknown>)["."] : exports;
  const entry =
    exportTarget(rootExport) ??
    manifest.module ??
    manifest.main ??
    (existsSync(join(packageDir, "index.js")) ? "index.js" : undefined);
  return entry ? resolve(packageDir, entry) : undefined;
}

function resolvePackage(specifier: string): string | undefined {
  try {
    return import.meta.resolve(specifier);
  } catch {
    // Fall through to CommonJS resolution for packages that do not expose ESM exports.
  }
  try {
    return require.resolve(specifier);
  } catch {
    return resolvePackageFromHost(specifier);
  }
}

function resolvePackageModuleRoot(packageName: string): string | undefined {
  const resolved = resolvePackage(packageName);
  if (!resolved) return undefined;
  return dirname(resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved);
}

function packageResolvesFromDir(packageName: string, packageDir: string): boolean {
  const loaderPath = join(packageDir, ".recipe-extension-loader.js");
  try {
    createRequire(loaderPath).resolve(packageName);
    return true;
  } catch {
    // ESM-only packages can expose import subpaths without a CommonJS root.
  }
  try {
    return findPackageJSON(packageName, loaderPath) !== undefined;
  } catch {
    return false;
  }
}

function recipeExtensionAliases(recipeDir: string): Record<string, string> {
  const recipeHasRecipesPackage = packageResolvesFromDir(
    "@introspection-ai/recipes",
    recipeDir
  );
  const recipesRoot = resolvePackageModuleRoot("@introspection-ai/recipes");
  return Object.fromEntries(
    [
      // Jiti aliases are package-prefix mappings. They must point at the
      // directory containing a package's resolved modules, not an entry file,
      // so Jiti can append exported subpaths without corrupting the path.
      // Prefer the Recipe's installed package when it declares one, so a local
      // run can use helper subpaths added after the host was released. Fall
      // back to the host package for Recipes that rely on the bundled API.
      ["@introspection-ai/recipes", recipeHasRecipesPackage ? undefined : recipesRoot],
      ["@earendil-works/pi-coding-agent", resolvePackageModuleRoot("@earendil-works/pi-coding-agent")],
      ["@earendil-works/pi-agent-core", resolvePackageModuleRoot("@earendil-works/pi-agent-core")],
      ["@earendil-works/pi-ai", resolvePackageModuleRoot("@earendil-works/pi-ai")],
      ["typebox", resolvePackageModuleRoot("typebox")],
      ["@sinclair/typebox", resolvePackageModuleRoot("typebox")],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}

function loadJiti(): { createJiti: (url: string, opts: Record<string, unknown>) => { import: (id: string, opts?: { default?: boolean }) => Promise<unknown> } } {
  try {
    return require("jiti") as ReturnType<typeof loadJiti>;
  } catch {
    const piAgentEntry = resolvePackage("@earendil-works/pi-coding-agent");
    if (!piAgentEntry) {
      throw new Error("Unable to resolve @earendil-works/pi-coding-agent for recipe extension loading");
    }
    const piRequire = createRequire(piAgentEntry);
    return piRequire("jiti") as ReturnType<typeof loadJiti>;
  }
}

/**
 * Load a recipe-declared extension module and return its factory. TS sources
 * load through jiti with package aliases pinned to this package's resolved
 * module instances, so recipe extensions share interaction/interrupt state
 * with their host.
 */
export async function loadRecipeExtensionFactory(
  recipeDir: string,
  extensionPath: string
): Promise<ExtensionFactory> {
  const loaded = await loadRecipeModule(recipeDir, extensionPath);
  const factory =
    typeof loaded === "function"
      ? loaded
      : loaded && typeof loaded === "object" && "default" in loaded && typeof loaded.default === "function"
        ? loaded.default
        : undefined;
  if (!factory) {
    throw new Error(`Recipe extension does not export a factory function: ${extensionPath}`);
  }
  return factory as ExtensionFactory;
}

export async function loadRecipeModule(
  recipeDir: string,
  moduleId: string
): Promise<unknown> {
  const { createJiti } = loadJiti();
  const recipeLoaderUrl = pathToFileURL(join(recipeDir, ".recipe-extension-loader.js")).href;
  const jiti = createJiti(recipeLoaderUrl, {
    moduleCache: false,
    alias: recipeExtensionAliases(recipeDir),
  });
  return jiti.import(moduleId, { default: true });
}
