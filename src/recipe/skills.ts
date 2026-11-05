import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parse } from "yaml";
import { assertRecipePathContained, type RecipeSkillResource } from "./package.js";

export function skillName(filePath: string, recipeDir: string): string {
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

/**
 * A skill path the way Pi's resource loader resolves it: trimmed, `~`
 * expanded, and a relative path taken against the session's working
 * directory (`baseDir`), not the process's.
 */
export function resolveSkillPath(path: string, baseDir: string): string {
  let input = path.trim();
  if (input === "~") input = homedir();
  else if (input.startsWith("~/")) input = join(homedir(), input.slice(2));
  return isAbsolute(input) ? resolve(input) : resolve(baseDir, input);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Match a skill file against the skills a Recipe run may offer. Each path is
 * a `SKILL.md` or a folder of skills; a skill matches when its file is one of
 * them or lies inside one, compared by real path. Relative paths are
 * resolved against `baseDir`, the session's working directory, as Pi does.
 */
export function recipeSkillMatcher(
  paths: readonly string[],
  baseDir: string = process.cwd()
): (filePath: string) => boolean {
  const roots = paths.map((path) => canonicalPath(resolveSkillPath(path, baseDir)));
  return (filePath) => {
    const file = canonicalPath(filePath);
    return roots.some((root) => file === root || file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
  };
}
