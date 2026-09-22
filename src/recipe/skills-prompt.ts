import {
  formatSkillsForPrompt,
  type Skill,
} from "@earendil-works/pi-coding-agent";

const SKILL_FILE_READ_TOOLS = ["read", "bash"] as const;

/**
 * Compose the prompt returned by the installed Pi extension.
 *
 * Pi forwards a rendered system prompt that already contains its skills block.
 * When root SYSTEM.md exists, systemPromptOverride keeps the recipe prompt and
 * drops that block. Append the same block Pi would have rendered, using the
 * skills and tools from before_agent_start. Leave prompts without SYSTEM.md
 * unchanged so the forwarded block is not repeated. Embedded sessions append
 * the block themselves and must not use this helper.
 */
export function composeInstalledSystemPrompt(options: {
  hasSystemPrompt: boolean;
  recipePrompt: string | undefined;
  skills?: readonly Skill[];
  selectedTools?: readonly string[];
}): string | undefined {
  if (!options.hasSystemPrompt) return options.recipePrompt;
  const fileReadTool = SKILL_FILE_READ_TOOLS.find((tool) =>
    options.selectedTools?.includes(tool)
  );
  const skillsPrompt =
    fileReadTool && options.skills
      ? formatSkillsForPrompt([...options.skills], fileReadTool).trim()
      : "";
  if (!skillsPrompt) return options.recipePrompt;
  return [options.recipePrompt, `<skills>\n${skillsPrompt}\n</skills>`]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}
