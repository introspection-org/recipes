/**
 * The Recipe a Pi session runs, recorded in the session itself so whoever
 * continues it (`introspection local`, a local task, a person) can start the
 * same Recipe and agent again without being told.
 */

export const RECIPE_SESSION_ENTRY_TYPE = "recipe_session";

export interface RecipeSessionEntry {
  /** Absolute path of the Recipe package. */
  recipe_dir: string;
  agent: string;
  package: string;
  version: string;
}

type Entry = { type?: string; customType?: string; data?: unknown };

/** The latest Recipe a session's entries record, if any. */
export function latestRecipeSession(
  entries: readonly unknown[],
): RecipeSessionEntry | undefined {
  let latest: RecipeSessionEntry | undefined;
  for (const entry of entries as Entry[]) {
    if (
      entry?.type === "custom" &&
      entry.customType === RECIPE_SESSION_ENTRY_TYPE &&
      entry.data
    ) {
      latest = entry.data as RecipeSessionEntry;
    }
  }
  return latest;
}

/** Whether `entry` differs from what the session last recorded, so a resume doesn't repeat it. */
export function recipeSessionChanged(
  entries: readonly unknown[],
  entry: RecipeSessionEntry,
): boolean {
  const latest = latestRecipeSession(entries);
  return (
    !latest ||
    latest.recipe_dir !== entry.recipe_dir ||
    latest.agent !== entry.agent ||
    latest.version !== entry.version
  );
}
