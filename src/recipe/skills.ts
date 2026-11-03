import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";
import { assertRecipePathContained, type RecipeSkillResource } from "./package.js";

function skillName(filePath: string, recipeDir: string): string {
  try {
    const content = readFileSync(filePath, "utf8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (match) {
      const frontmatter = parse(match[1] ?? "");
      if (
        frontmatter &&
        typeof frontmatter === "object" &&
        typeof frontmatter.name === "string" &&
        frontmatter.name.trim()
      ) {
        return frontmatter.name.trim();
      }
    }
  } catch {
    // Pi's resource loader reports content and schema diagnostics later.
  }
  const directory = dirname(filePath);
  return directory === recipeDir ? "skill" : basename(directory);
}

function discoverSkillFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return basename(path) === "SKILL.md" ? [path] : [];
  if (!stat.isDirectory()) return [];

  const direct = join(path, "SKILL.md");
  if (existsSync(direct) && statSync(direct).isFile()) return [direct];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => discoverSkillFiles(join(path, entry.name)));
}

/** A packaged `SKILL.md`, its name, and the package it comes from. */
export interface PackagedSkill {
  name: string;
  path: string;
  /** The dependency that ships it; absent for the Recipe's own skills. */
  dependency?: string;
}

/**
 * Every `SKILL.md` the Recipe's skill resources hold, each checked to stay
 * inside its own package. A plain path is one of the Recipe's own resources;
 * a dependency's resources carry their package directory and name.
 */
export function packagedSkills(
  recipeDir: string,
  resources: readonly (string | RecipeSkillResource)[]
): PackagedSkill[] {
  const skills = new Map<string, PackagedSkill>();
  for (const resource of resources) {
    const { path, packageDir, dependency } =
      typeof resource === "string" ? { path: resource, packageDir: recipeDir } : resource;
    for (const file of discoverSkillFiles(path)) {
      assertRecipePathContained(
        packageDir,
        file,
        "skill resource",
        dependency ? `Dependency ${dependency}` : "Recipe"
      );
      if (skills.has(file)) continue;
      skills.set(file, {
        name: skillName(file, packageDir),
        path: file,
        ...(dependency ? { dependency } : {}),
      });
    }
  }
  return [...skills.values()];
}

/**
 * Resolve the package's physical skill resources to the subset selected by an
 * agent definition. Selection controls Pi discovery and prompt exposure; it
 * does not remove the remaining recipe files from the shared sandbox.
 */
export function resolveAgentSkillPaths(
  recipeDir: string,
  resourcePaths: readonly (string | RecipeSkillResource)[],
  selectedNames: readonly string[]
): string[] {
  if (selectedNames.length === 0 || resourcePaths.length === 0) return [];

  const selected = new Set(selectedNames);
  return packagedSkills(recipeDir, resourcePaths)
    .filter((skill) => selected.has(skill.name))
    .map((skill) => skill.path)
    .sort();
}
