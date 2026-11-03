import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { parse } from "yaml";

import { assertRecipePathContained } from "../recipe/package.js";

/**
 * A document profile is a skill: a folder holding a `SKILL.md` whose
 * frontmatter `name` is the folder's name, in lower case, with a
 * `description`. A format package ships some by name; a Recipe can bring its
 * own by a relative path to the folder (or its `SKILL.md`). A profile is only
 * read, never run. See docs/documents.md, "Write your own profile".
 */

/** A profile name a format ships, such as `legal-redlining-en-US`. */
export const DOCUMENT_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** A relative path to a profile folder or its SKILL.md, rather than a shipped name. */
export function isDocumentProfilePath(profile: string): boolean {
  return profile.includes("/") || profile.includes("\\") || profile.startsWith(".");
}

/** Why a `pi.documents[].profile` value has the wrong shape, or undefined when the shape is right. */
export function documentProfileShapeProblem(profile: unknown): string | undefined {
  const usage = "must be the name of a profile the format ships, such as legal-redlining-en-US, or a relative path to a profile folder in the Recipe";
  if (typeof profile !== "string" || !profile.trim()) return usage;
  if (!isDocumentProfilePath(profile)) return DOCUMENT_PROFILE_NAME.test(profile) ? undefined : usage;
  const absolute = isAbsolute(profile) || profile.startsWith("\\") || /^[A-Za-z]:/.test(profile);
  if (absolute || profile.split(/[\\/]/).includes("..")) return `'${profile}' must be a relative path inside the Recipe`;
  return undefined;
}

/** The frontmatter of a SKILL.md, or undefined when it has none. */
function frontmatter(text: string): Record<string, unknown> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return undefined;
  const parsed: unknown = parse(match[1] ?? "");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
}

/**
 * Check a profile's SKILL.md follows the contract: frontmatter whose `name`
 * is its folder's name in lower case, and a `description`. Returns the problem,
 * or undefined when it follows the contract.
 */
export function documentProfileSkillProblem(skillPath: string): string | undefined {
  const folder = basename(dirname(skillPath));
  const fields = frontmatter(readFileSync(skillPath, "utf8"));
  if (!fields) return "has no frontmatter; start it with --- name and description ---";
  if (fields.name !== folder || folder !== folder.toLowerCase()) {
    return `frontmatter name must be its folder's name in lower case ('${folder.toLowerCase()}'), not '${String(fields.name ?? "")}'`;
  }
  if (typeof fields.description !== "string" || !fields.description.trim()) return "frontmatter needs a description";
  return undefined;
}

/**
 * The SKILL.md of a profile a Recipe brings by path: the folder or the file,
 * inside the Recipe by its real path, following the contract.
 */
export function recipeProfileSkill(profile: string, recipeDir: string): string {
  const shape = documentProfileShapeProblem(profile);
  if (shape) throw new Error(`Document profile ${shape}`);
  const target = resolve(recipeDir, profile);
  if (!existsSync(target)) throw new Error(`Document profile ${profile} doesn't exist in the Recipe`);
  // Where it really resolves: a symlink inside the Recipe can point outside it.
  assertRecipePathContained(recipeDir, target, `document profile ${profile}`);
  const skill = statSync(target).isDirectory() ? join(target, "SKILL.md") : target;
  if (basename(skill) !== "SKILL.md") throw new Error(`Document profile ${profile} must be a folder holding a SKILL.md, or that SKILL.md`);
  if (!existsSync(skill)) throw new Error(`Document profile ${profile} has no SKILL.md`);
  assertRecipePathContained(recipeDir, skill, `document profile ${profile}`);
  const problem = documentProfileSkillProblem(skill);
  if (problem) throw new Error(`Document profile ${profile}: SKILL.md ${problem}`);
  return skill;
}

/**
 * The SKILL.md a declaration's `profile` selects: one the format ships, by
 * name (case-insensitive), or the Recipe's own, by relative path.
 */
export function resolveDocumentProfile(
  profile: string,
  options: { format: string; shipped?: Readonly<Record<string, string>>; recipeDir: string },
): string {
  if (isDocumentProfilePath(profile)) return recipeProfileSkill(profile, options.recipeDir);
  const shipped = options.shipped ?? {};
  const found = Object.keys(shipped).find((name) => name.toLowerCase() === profile.toLowerCase());
  if (found) return shipped[found]!;
  const names = Object.keys(shipped);
  throw new Error(
    `Unknown document profile '${profile}': the ${options.format} format ships ${names.length ? names.join(", ") : "no profiles"}. ` +
      "Bring your own as a relative path to a profile folder in the Recipe.",
  );
}
