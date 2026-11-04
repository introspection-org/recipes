import { readFileSync } from "node:fs";
import {
  formatSkillsForPrompt,
  loadSkills,
  stripFrontmatter,
  type Skill,
} from "@earendil-works/pi-coding-agent";

const SKILL_FILE_READ_TOOLS = ["read", "bash"] as const;

export interface SystemPromptEvent {
  readonly systemPrompt: string;
  readonly systemPromptOptions: {
    skills?: readonly Skill[];
    readonly selectedTools?: readonly string[];
  };
}

export interface SystemPromptLaunchState {
  readonly resolvedRecipe: {
    readonly resources: { readonly hasSystemPrompt: boolean };
  };
  readonly resolved: {
    systemPromptOverride(base: string | undefined): string | undefined;
  };
}

/**
 * Build the prompt returned by the installed Pi extension.
 *
 * Pi forwards a rendered system prompt that already contains its skills block.
 * When root SYSTEM.md exists, systemPromptOverride keeps the recipe prompt and
 * drops that block. Append the same block Pi would have rendered, using the
 * skills and tools on the event. Leave prompts without SYSTEM.md unchanged so
 * the forwarded block is not repeated. Embedded sessions append the block
 * themselves and must not use this helper.
 */
export function createSystemPrompt(
  event: SystemPromptEvent,
  launchState: SystemPromptLaunchState
): string | undefined {
  const recipePrompt = launchState.resolved.systemPromptOverride(event.systemPrompt);
  if (!launchState.resolvedRecipe.resources.hasSystemPrompt) return recipePrompt;
  const selectedTools = event.systemPromptOptions.selectedTools ?? [];
  const skills = event.systemPromptOptions.skills ?? [];
  const fileReadTool = SKILL_FILE_READ_TOOLS.find((tool) =>
    selectedTools.includes(tool)
  );
  const skillsPrompt = fileReadTool
    ? formatSkillsForPrompt([...skills], fileReadTool).trim()
    : "";
  if (!skillsPrompt) return recipePrompt;
  const skillsSection = `<skills>\n${skillsPrompt}\n</skills>`;
  return recipePrompt ? `${recipePrompt}\n\n${skillsSection}` : skillsSection;
}

/**
 * Load exactly the skills a Recipe run offers from their resolved paths: the
 * agent's selected Recipe and dependency skills and the `documents` tool's
 * skills. Nothing Pi discovered elsewhere (packages, user or project skill
 * folders, `--skill`) is read, and a skill elsewhere that shares a name with
 * one of these cannot shadow it.
 */
export function loadRecipeSkills(
  recipeDir: string,
  cwd: string,
  paths: readonly string[]
): Skill[] {
  if (paths.length === 0) return [];
  // The Recipe stands in for Pi's agent folder, as in embedded sessions.
  return loadSkills({ cwd, agentDir: recipeDir, skillPaths: [...paths], includeDefaults: false }).skills;
}

/**
 * Replace the skills Pi offers on a `before_agent_start` event with the
 * Recipe's. Pi renders both the forwarded prompt and the prompt sections from
 * these mutable options, so later readers see only the Recipe's skills.
 */
export function offerOnlyRecipeSkills(
  event: SystemPromptEvent,
  skills: readonly Skill[]
): void {
  event.systemPromptOptions.skills = [...skills];
}

export type RecipeSkillCommand =
  | { readonly kind: "expanded"; readonly text: string }
  | { readonly kind: "unknown"; readonly name: string };

/**
 * Resolve a `/skill:name args` prompt against the Recipe's skills, the way Pi
 * expands it. Returns undefined for any other prompt. A name that is not one
 * of the Recipe's skills is unknown, so Pi never expands a skill from
 * outside the Recipe.
 */
export function resolveRecipeSkillCommand(
  text: string,
  skills: readonly Skill[]
): RecipeSkillCommand | undefined {
  if (!text.startsWith("/skill:")) return undefined;
  const spaceIndex = text.indexOf(" ");
  const name = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
  const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill) return { kind: "unknown", name };
  const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  return { kind: "expanded", text: args ? `${block}\n\n${args}` : block };
}
