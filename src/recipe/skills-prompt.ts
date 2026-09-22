import {
  formatSkillsForPrompt,
  type Skill,
} from "@earendil-works/pi-coding-agent";

const SKILL_FILE_READ_TOOLS = ["read", "bash"] as const;

export interface SystemPromptEvent {
  readonly systemPrompt: string;
  readonly systemPromptOptions: {
    readonly skills?: readonly Skill[];
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
