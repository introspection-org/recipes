import {
  loadRecipePackageModule,
  resolveRecipePackage,
} from "../recipe/companions.js";
import {
  SEARCH_PROVIDER_API_VERSION,
  SEARCH_PROVIDER_IDS,
  type RecipeSearchModule,
  type SearchProviders,
} from "./types.js";

/** The package that serves `web_search`'s providers, a companion of Recipes. */
export const SEARCH_PROVIDERS_PACKAGE = "@introspection-ai/recipe-search";

/**
 * The search providers for the Recipe at `recipeDir`, from
 * `@introspection-ai/recipe-search`: the Recipe's own copy when it pins one,
 * else the one installed beside Recipes. With neither installed there are
 * none, and `web_search` offers no provider (`not_bound`). A package that is
 * installed but does not load, or implements another contract version, fails.
 */
export async function loadSearchProviders(options: {
  recipeDir: string;
  /** Where companion packages resolve from. Default: where `@introspection-ai/recipes` is installed. */
  hostDir?: string;
}): Promise<SearchProviders> {
  if (
    !resolveRecipePackage(
      options.recipeDir,
      SEARCH_PROVIDERS_PACKAGE,
      options.hostDir,
    )
  )
    return {};
  const imported = await loadRecipePackageModule(
    options.recipeDir,
    SEARCH_PROVIDERS_PACKAGE,
    {
      what: "web_search",
      api: { name: "search provider", version: SEARCH_PROVIDER_API_VERSION },
      ...(options.hostDir !== undefined ? { hostDir: options.hostDir } : {}),
    },
  );
  const module = (
    imported && typeof imported === "object" && "default" in imported
      ? (imported as { default: unknown }).default
      : imported
  ) as Partial<RecipeSearchModule> | undefined;
  if (
    !module ||
    module.kind !== "search" ||
    !module.providers ||
    typeof module.providers !== "object"
  )
    throw new Error(
      `${SEARCH_PROVIDERS_PACKAGE} has an invalid module contract`,
    );
  return Object.fromEntries(
    Object.entries(module.providers).filter(([id]) =>
      (SEARCH_PROVIDER_IDS as readonly string[]).includes(id),
    ),
  ) as SearchProviders;
}
