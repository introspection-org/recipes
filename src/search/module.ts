import {
  loadRecipePackageModule,
  resolveRecipePackage,
} from "../recipe/companions.js";
import type { RecipePackageSearch } from "../recipe/package.js";
import {
  checkProviderModule,
  isProviderBundle,
  loadProviderModules,
  providerBundleIds,
  type ProviderFamily,
} from "../recipe/providers.js";
import {
  SEARCH_PROVIDER_API_VERSION,
  type SearchProviderModule,
  type SearchProviders,
} from "./types.js";

/** The package that serves `web_search`'s first-party providers, a companion of Recipes. */
export const SEARCH_PROVIDERS_PACKAGE = "@introspection-ai/recipe-search";

/** The search family for `loadProviderModules`: every first-party id is in one bundle. */
export const SEARCH_PROVIDER_FAMILY: ProviderFamily<SearchProviderModule> = {
  kind: "search",
  apiName: "search provider",
  apiVersion: SEARCH_PROVIDER_API_VERSION,
  firstPartyPackage: () => SEARCH_PROVIDERS_PACKAGE,
  firstPartyBundle: true,
  idOf: (module) => module.id,
};

/**
 * The search providers for the Recipe at `recipeDir`.
 *
 * With `declarations` (the Recipe's `pi.search`), exactly those: each
 * first-party id from `@introspection-ai/recipe-search`, and each of the
 * Recipe's own from its `package` or `module`. One that does not load fails.
 *
 * Without them, every provider `@introspection-ai/recipe-search` exports: the
 * Recipe's own copy when it pins one, else the one installed beside Recipes.
 * With neither installed there are none, and `web_search` offers no provider
 * (`not_bound`). A package that is installed but does not load, or implements
 * another contract version, fails.
 */
export async function loadSearchProviders(options: {
  recipeDir: string;
  /** Where companion packages resolve from. Default: where `@introspection-ai/recipes` is installed. */
  hostDir?: string;
  /** The Recipe's `pi.search`, when it declares one. */
  declarations?: readonly RecipePackageSearch[];
}): Promise<SearchProviders> {
  const { recipeDir, hostDir, declarations } = options;
  const location = { recipeDir, ...(hostDir !== undefined ? { hostDir } : {}) };
  if (declarations !== undefined) {
    const loaded = await loadProviderModules(
      SEARCH_PROVIDER_FAMILY,
      declarations,
      location,
    );
    return Object.fromEntries(
      loaded.map(({ declaration, module }) => [declaration.provider, module]),
    );
  }
  if (!resolveRecipePackage(recipeDir, SEARCH_PROVIDERS_PACKAGE, hostDir))
    return {};
  const bundle = await loadRecipePackageModule(
    recipeDir,
    SEARCH_PROVIDERS_PACKAGE,
    {
      what: "web_search",
      api: { name: "search provider", version: SEARCH_PROVIDER_API_VERSION },
      ...(hostDir !== undefined ? { hostDir } : {}),
    },
  );
  if (!isProviderBundle(SEARCH_PROVIDER_FAMILY, bundle))
    throw new Error(
      `${SEARCH_PROVIDERS_PACKAGE} has an invalid module contract`,
    );
  return Object.fromEntries(
    providerBundleIds(bundle).map((provider) => [
      provider,
      checkProviderModule(
        SEARCH_PROVIDER_FAMILY,
        bundle,
        { provider },
        { from: SEARCH_PROVIDERS_PACKAGE, source: "first-party" },
      ),
    ]),
  );
}
