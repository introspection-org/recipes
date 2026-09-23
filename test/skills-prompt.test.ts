import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  createSystemPrompt,
  type SystemPromptEvent,
  type SystemPromptLaunchState,
} from "../src/recipe/skills-prompt.js";

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "crm-operations",
    description: "Resolve CRM records",
    filePath: "/recipe/skills/crm-operations/SKILL.md",
    baseDir: "/recipe/skills/crm-operations",
    disableModelInvocation: false,
    sourceInfo: {
      path: "/recipe/skills/crm-operations/SKILL.md",
      source: "recipe",
      scope: "project",
      origin: "package",
    },
    ...overrides,
  };
}

function skillsSection(skills: Skill[], tool: "read" | "bash"): string {
  return `<skills>\n${formatSkillsForPrompt(skills, tool).trim()}\n</skills>`;
}

function prompt(options: {
  hasSystemPrompt: boolean;
  recipePrompt: string;
  skills: readonly Skill[];
  selectedTools: readonly string[];
  forwarded?: string;
}): string | undefined {
  const event: SystemPromptEvent = {
    systemPrompt: options.forwarded ?? "Default Pi prompt",
    systemPromptOptions: {
      skills: options.skills,
      selectedTools: options.selectedTools,
    },
  };
  const launchState: SystemPromptLaunchState = {
    resolvedRecipe: { resources: { hasSystemPrompt: options.hasSystemPrompt } },
    resolved: {
      systemPromptOverride(base) {
        return options.hasSystemPrompt ? options.recipePrompt : base;
      },
    },
  };
  return createSystemPrompt(event, launchState);
}

describe("createSystemPrompt", () => {
  const recipePrompt = "Recipe system prompt\n\nAgent instructions";
  const forwarded = `${recipePrompt}\n\n${skillsSection([skill()], "read")}`;

  it("appends Pi's skills prompt when SYSTEM.md replaces the forwarded prompt", () => {
    const skills = [skill()];
    const result = prompt({
      hasSystemPrompt: true,
      recipePrompt,
      skills,
      selectedTools: ["bash", "read"],
      forwarded,
    });

    expect(result).toBe(`${recipePrompt}\n\n${skillsSection(skills, "read")}`);
    expect(result?.match(/<skills>/g)).toEqual(["<skills>"]);
    expect(result).toContain("<location>/recipe/skills/crm-operations/SKILL.md</location>");
    expect(result).toContain("Use the read tool");
    expect(result).not.toContain("Default Pi prompt");
  });

  it("uses the bash instruction when read is not selected", () => {
    const skills = [skill()];
    expect(
      prompt({
        hasSystemPrompt: true,
        recipePrompt,
        skills,
        selectedTools: ["bash"],
      })
    ).toBe(`${recipePrompt}\n\n${skillsSection(skills, "bash")}`);
  });

  it("does not add a skills block when no skill can be read", () => {
    expect(
      prompt({
        hasSystemPrompt: true,
        recipePrompt,
        skills: [skill({ disableModelInvocation: true })],
        selectedTools: ["read"],
      })
    ).toBe(recipePrompt);
    expect(
      prompt({
        hasSystemPrompt: true,
        recipePrompt,
        skills: [skill()],
        selectedTools: ["write"],
      })
    ).toBe(recipePrompt);
    expect(
      prompt({
        hasSystemPrompt: true,
        recipePrompt,
        skills: [],
        selectedTools: ["read"],
      })
    ).toBe(recipePrompt);
  });

  it("keeps a forwarded skills block unchanged when the recipe has no SYSTEM.md", () => {
    expect(
      prompt({
        hasSystemPrompt: false,
        recipePrompt,
        skills: [skill()],
        selectedTools: ["read"],
        forwarded,
      })
    ).toBe(forwarded);
  });
});
