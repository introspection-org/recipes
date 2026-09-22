import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { composeInstalledSystemPrompt } from "../src/recipe/skills-prompt.js";

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

describe("composeInstalledSystemPrompt", () => {
  const recipePrompt = "Recipe system prompt\n\nAgent instructions";
  const forwarded = `${recipePrompt}\n\n${skillsSection([skill()], "read")}`;

  it("appends Pi's skills prompt when SYSTEM.md replaces the forwarded prompt", () => {
    const skills = [skill()];
    const prompt = composeInstalledSystemPrompt({
      hasSystemPrompt: true,
      recipePrompt,
      skills,
      selectedTools: ["bash", "read"],
    });

    expect(prompt).toBe(`${recipePrompt}\n\n${skillsSection(skills, "read")}`);
    expect(prompt?.match(/<skills>/g)).toEqual(["<skills>"]);
    expect(prompt).toContain("<location>/recipe/skills/crm-operations/SKILL.md</location>");
    expect(prompt).toContain("Use the read tool");
  });

  it("uses the bash instruction when read is not selected", () => {
    const skills = [skill()];
    expect(
      composeInstalledSystemPrompt({
        hasSystemPrompt: true,
        recipePrompt,
        skills,
        selectedTools: ["bash"],
      })
    ).toBe(`${recipePrompt}\n\n${skillsSection(skills, "bash")}`);
  });

  it("does not add a skills block when no skill can be read", () => {
    expect(
      composeInstalledSystemPrompt({
        hasSystemPrompt: true,
        recipePrompt,
        skills: [skill({ disableModelInvocation: true })],
        selectedTools: ["read"],
      })
    ).toBe(recipePrompt);
    expect(
      composeInstalledSystemPrompt({
        hasSystemPrompt: true,
        recipePrompt,
        skills: [skill()],
        selectedTools: ["write"],
      })
    ).toBe(recipePrompt);
    expect(
      composeInstalledSystemPrompt({
        hasSystemPrompt: true,
        recipePrompt,
        skills: [],
        selectedTools: ["read"],
      })
    ).toBe(recipePrompt);
  });

  it("keeps a forwarded skills block unchanged when the recipe has no SYSTEM.md", () => {
    expect(
      composeInstalledSystemPrompt({
        hasSystemPrompt: false,
        recipePrompt: forwarded,
        skills: [skill()],
        selectedTools: ["read"],
      })
    ).toBe(forwarded);
  });
});
