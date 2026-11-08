import { loadRecipePackageModule } from "./companions.js";

/**
 * One provider a Recipe declares for a family (`pi.search`, `pi.productivity`):
 * its id and, for a provider of the Recipe's own, the installed package that
 * serves it. Without `package`, the first-party provider of that id is used.
 */
export interface RecipeProviderDeclaration {
  provider: string;
  /** A package the Recipe lists in `dependencies`. */
  package?: string;
}

/**
 * What the shared loader needs to know about one family: the `kind` its
 * modules declare, the contract version this host implements, where its
 * first-party providers live, and which field carries a module's id. Each
 * family keeps its own contract version.
 */
export interface ProviderFamily<Module> {
  kind: string;
  /** Names the contract in errors, such as `search provider`. */
  apiName: string;
  apiVersion: number;
  /** The package serving a first-party id without a source. */
  firstPartyPackage(id: string): string;
  /**
   * Whether `firstPartyPackage` is a family bundle: one module
   * `{ kind, apiVersion, providers: { [id]: module } }` rather than one
   * provider module.
   */
  firstPartyBundle?: boolean;
  /** The id the module declares (`id`, or `provider` for productivity). */
  idOf(module: Module): unknown;
}

export type ProviderSource = "first-party" | "package";

export interface LoadedProviderModule<Module> {
  declaration: RecipeProviderDeclaration;
  module: Module;
  source: ProviderSource;
}

function fieldOf(value: unknown, field: string): unknown {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)[field]
    : undefined;
}

/** Whether `loaded` is a family bundle (`{ kind, apiVersion, providers }`) rather than one provider. */
export function isProviderBundle<Module>(
  family: ProviderFamily<Module>,
  loaded: unknown,
): boolean {
  return (
    fieldOf(loaded, "kind") === family.kind &&
    fieldOf(loaded, "providers") !== undefined &&
    family.idOf(loaded as Module) === undefined
  );
}

/** The ids a family bundle exports. */
export function providerBundleIds(loaded: unknown): string[] {
  const providers = fieldOf(loaded, "providers");
  return providers && typeof providers === "object"
    ? Object.keys(providers)
    : [];
}

/**
 * The provider `declaration` names in `loaded`, a module or a family bundle
 * imported from `from`: refused when its `kind` is not the family's, its
 * `apiVersion` (or its bundle's) is not this host's, or its id is not the
 * declaration's.
 */
export function checkProviderModule<Module>(
  family: ProviderFamily<Module>,
  loaded: unknown,
  declaration: RecipeProviderDeclaration,
  origin: { from: string; source: ProviderSource },
): Module {
  const id = declaration.provider;
  const { from, source } = origin;
  const what = `Recipe ${family.kind} provider '${id}'`;
  const wrongVersion = (version: unknown) =>
    new Error(
      `${what}: ${from} implements ${family.apiName} API ${String(version)}, but this host implements ${family.apiName} API ${family.apiVersion}`,
    );
  let module = loaded;
  if (isProviderBundle(family, loaded)) {
    const bundleVersion = fieldOf(loaded, "apiVersion");
    if (bundleVersion !== family.apiVersion) throw wrongVersion(bundleVersion);
    module = fieldOf(fieldOf(loaded, "providers"), id);
    if (module === undefined)
      throw new Error(
        source === "first-party"
          ? `${what}: ${from} has no provider '${id}'; give the declaration a package for a provider of the Recipe's own`
          : `${what}: ${from} has no provider '${id}'`,
      );
  } else if (source === "first-party" && family.firstPartyBundle)
    throw new Error(`${what}: ${from} is not a ${family.kind} bundle`);
  const kind = fieldOf(module, "kind");
  if (kind !== family.kind)
    throw new Error(
      `${what}: ${from} exports kind '${String(kind)}', not '${family.kind}'`,
    );
  const version = fieldOf(module, "apiVersion");
  if (version !== family.apiVersion) throw wrongVersion(version);
  const declared = family.idOf(module as Module);
  if (declared !== id)
    throw new Error(
      `${what}: ${from} declares id '${String(declared)}', not '${id}'`,
    );
  return module as Module;
}

/**
 * Load every provider a Recipe declares for one family, in declaration order.
 * Each comes from its first-party package (or the family's bundle) or a
 * package the Recipe depends on, and is checked by `checkProviderModule`. Ids are open slugs, unique within the family.
 */
export async function loadProviderModules<Module>(
  family: ProviderFamily<Module>,
  declarations: readonly RecipeProviderDeclaration[],
  options: { recipeDir: string; hostDir?: string },
): Promise<LoadedProviderModule<Module>[]> {
  const seen = new Set<string>();
  for (const { provider } of declarations) {
    if (seen.has(provider))
      throw new Error(
        `pi.${family.kind} declares provider '${provider}' more than once`,
      );
    seen.add(provider);
  }
  const imports = new Map<string, Promise<unknown>>();
  const once = (key: string, load: () => Promise<unknown>) => {
    if (!imports.has(key)) imports.set(key, load());
    return imports.get(key)!;
  };
  return Promise.all(
    declarations.map(async (declaration) => {
      const id = declaration.provider;
      const what = `Recipe ${family.kind} provider '${id}'`;
      const source =
        declaration.package !== undefined ? "package" : "first-party";
      const from = declaration.package ?? family.firstPartyPackage(id);
      const loaded = await once(`package:${from}`, () =>
        loadRecipePackageModule(options.recipeDir, from, {
          what,
          api: { name: family.apiName, version: family.apiVersion },
          ...(options.hostDir !== undefined
            ? { hostDir: options.hostDir }
            : {}),
        }),
      );
      return {
        declaration,
        module: checkProviderModule(family, loaded, declaration, {
          from,
          source,
        }),
        source,
      };
    }),
  );
}
