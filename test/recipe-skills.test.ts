import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveAgentSkillPaths } from "../src/recipe/skills.js";

describe("recipe agent skills", () => {
  it("exposes only skills selected by the active agent", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-agent-skills-"));
    try {
      const skillsDir = join(root, "skills");
      const parentSkill = join(skillsDir, "parent-only", "SKILL.md");
      const explorerSkill = join(skillsDir, "explorer-only", "SKILL.md");
      mkdirSync(join(skillsDir, "parent-only"), { recursive: true });
      mkdirSync(join(skillsDir, "explorer-only"), { recursive: true });
      writeFileSync(parentSkill, "---\ndescription: Parent guidance\n---\n");
      writeFileSync(explorerSkill, "---\ndescription: Explorer guidance\n---\n");

      expect(resolveAgentSkillPaths(root, [skillsDir], ["explorer-only"])).toEqual([
        explorerSkill,
      ]);
      expect(resolveAgentSkillPaths(root, [skillsDir], [])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects a skill by its frontmatter name", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-agent-skill-name-"));
    try {
      const skillPath = join(root, "skills", "folder-name", "SKILL.md");
      mkdirSync(join(root, "skills", "folder-name"), { recursive: true });
      writeFileSync(
        skillPath,
        "---\nname: public-name\ndescription: Named guidance\n---\n"
      );

      expect(
        resolveAgentSkillPaths(root, [join(root, "skills")], ["public-name"])
      ).toEqual([skillPath]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a portable name for an unnamed root skill", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-root-skill-"));
    try {
      const skillPath = join(root, "SKILL.md");
      writeFileSync(skillPath, "---\ndescription: Root guidance\n---\n");

      expect(resolveAgentSkillPaths(root, [skillPath], ["skill"])).toEqual([
        skillPath,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves diagnostics for malformed selected skills only", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-agent-skill-diagnostics-"));
    try {
      const selectedPath = join(root, "skills", "folder-name", "SKILL.md");
      const unselectedPath = join(root, "skills", "unselected", "SKILL.md");
      mkdirSync(join(root, "skills", "folder-name"), { recursive: true });
      mkdirSync(join(root, "skills", "unselected"), { recursive: true });
      writeFileSync(selectedPath, "---\nname: public-name\n---\n");
      writeFileSync(unselectedPath, "---\n---\n");

      const selectedPaths = resolveAgentSkillPaths(
        root,
        [join(root, "skills")],
        ["public-name"]
      );
      expect(selectedPaths).toEqual([selectedPath]);

      const { diagnostics } = loadSkills({
        cwd: root,
        agentDir: root,
        skillPaths: selectedPaths,
        includeDefaults: false,
      });
      expect(diagnostics).toEqual([
        expect.objectContaining({
          path: selectedPath,
          message: "description is required",
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches Pi discovery for named and directory-named skills", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-agent-skill-conformance-"));
    try {
      const skillsDir = join(root, "skills");
      const named = join(skillsDir, "folder-name", "SKILL.md");
      const directoryNamed = join(skillsDir, "directory-name", "SKILL.md");
      mkdirSync(join(skillsDir, "folder-name"), { recursive: true });
      mkdirSync(join(skillsDir, "directory-name"), { recursive: true });
      writeFileSync(
        named,
        "---\nname: public-name\ndescription: Named guidance\n---\n"
      );
      writeFileSync(
        directoryNamed,
        "---\ndescription: Directory guidance\n---\n"
      );

      const selectedPaths = resolveAgentSkillPaths(
        root,
        [skillsDir],
        ["public-name", "directory-name"]
      );
      const pi = loadSkills({
        cwd: root,
        agentDir: root,
        skillPaths: selectedPaths,
        includeDefaults: false,
      });

      expect(pi.diagnostics).toEqual([]);
      expect(pi.skills.map((skill) => skill.name).sort()).toEqual([
        "directory-name",
        "public-name",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
