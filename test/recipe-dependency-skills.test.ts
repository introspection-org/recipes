import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { recipePythonDeclarations } from "../src/recipe/python.js";
import { resolveRecipe } from "../src/recipe/resolve.js";
import { pythonProject } from "./helpers/fake-uv.js";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} guidance\n---\n`;
}

interface FakePackage {
  name: string;
  /** `pi.skills`, or undefined for a package without it. */
  skills?: unknown;
  /** Extra files, relative to the package. */
  files?: Record<string, string>;
  as?: "dependencies" | "peerDependencies" | "devDependencies" | "none";
}

/**
 * A Recipe folder with packages installed the way pnpm does: the package
 * lives under node_modules/.pnpm and node_modules/<name> links to it.
 */
function recipe(options: {
  agentSkills: string[];
  ownSkills?: Record<string, string>;
  packages?: FakePackage[];
  missingDependency?: string;
}): { dir: string; packageDir(name: string): string } {
  const dir = mkdtempSync(join(tmpdir(), "recipe-dependency-skills-"));
  scratchDirs.push(dir);
  const blocks: Record<string, Record<string, string>> = {
    dependencies: {},
    peerDependencies: {},
    devDependencies: {},
  };
  for (const pkg of options.packages ?? []) {
    const store = join(dir, "node_modules", ".pnpm", `${pkg.name.replace("/", "+")}@1.0.0`, "node_modules", ...pkg.name.split("/"));
    write(
      join(store, "package.json"),
      JSON.stringify({ name: pkg.name, version: "1.0.0", ...(pkg.skills === undefined ? {} : { pi: { skills: pkg.skills } }) })
    );
    for (const [path, body] of Object.entries(pkg.files ?? {})) write(join(store, path), body);
    const link = join(dir, "node_modules", ...pkg.name.split("/"));
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(store, link, "dir");
    const as = pkg.as ?? "dependencies";
    if (as !== "none") blocks[as]![pkg.name] = ">=1.0.0";
  }
  if (options.missingDependency) blocks.dependencies![options.missingDependency] = ">=1.0.0";
  write(join(dir, "package.json"), JSON.stringify({ name: "synthetic-recipe", version: "0.1.0", ...blocks, pi: {} }));
  write(
    join(dir, "agents", "agent.yaml"),
    `name: agent\nmodel:\n  name: anthropic/claude-sonnet-4-6\nskills: [${options.agentSkills.join(", ")}]\n`
  );
  for (const [name, body] of Object.entries(options.ownSkills ?? {})) write(join(dir, "skills", name, "SKILL.md"), body);
  return {
    dir,
    packageDir: (name) => realpathSync(join(dir, "node_modules", ...name.split("/"))),
  };
}

const skillPaths = (dir: string) => resolveRecipe({ recipeDir: dir }).selectAgent().skillPaths;

describe("skills from dependency packages", () => {
  it("offers the skills a direct dependency declares in pi.skills, filtered by the agent's allowlist", () => {
    const fixture = recipe({
      agentSkills: ["own", "review"],
      ownSkills: { own: skill("own") },
      packages: [
        {
          name: "@acme/legal-skills",
          skills: ["skills"],
          files: { "skills/review/SKILL.md": skill("review"), "skills/draft/SKILL.md": skill("draft") },
        },
      ],
    });
    const packageDir = fixture.packageDir("@acme/legal-skills");

    expect(skillPaths(fixture.dir)).toEqual(
      [join(fixture.dir, "skills", "own", "SKILL.md"), join(packageDir, "skills", "review", "SKILL.md")].sort()
    );
    // The unselected dependency skill is a resource but not offered to the agent.
    expect(resolveRecipe({ recipeDir: fixture.dir }).resources.skills).toEqual([
      join(fixture.dir, "skills"),
      join(packageDir, "skills"),
    ]);
  });

  it("accepts a glob and a direct SKILL.md path inside the package", () => {
    const fixture = recipe({
      agentSkills: ["one", "two"],
      packages: [
        {
          name: "acme-skills",
          skills: ["skills/*", "extra/SKILL.md"],
          files: { "skills/one/SKILL.md": skill("one"), "extra/SKILL.md": skill("two") },
        },
      ],
    });
    const packageDir = fixture.packageDir("acme-skills");
    expect(skillPaths(fixture.dir)).toEqual(
      [join(packageDir, "skills", "one", "SKILL.md"), join(packageDir, "extra", "SKILL.md")].sort()
    );
  });

  /** A direct dependency offering `visible`, so a test that ignores another package also sees one offered. */
  const VISIBLE: FakePackage = { name: "acme-visible", skills: ["skills"], files: { "skills/visible/SKILL.md": skill("visible") } };
  const visiblePath = (fixture: ReturnType<typeof recipe>) => join(fixture.packageDir("acme-visible"), "skills", "visible", "SKILL.md");

  it("offers the skills of a peer the platform provides from an ancestor node_modules, and skips a missing peer", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-peer-skills-"));
    scratchDirs.push(root);
    const recipeDir = join(root, "opt", "recipe");
    const peerDir = join(root, "opt", "node_modules", "@acme", "peer-skills");
    write(join(peerDir, "package.json"), JSON.stringify({ name: "@acme/peer-skills", version: "1.0.0", pi: { skills: ["skills"] } }));
    write(join(peerDir, "skills", "review", "SKILL.md"), skill("review"));
    write(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "synthetic-recipe",
        version: "0.1.0",
        peerDependencies: { "@acme/peer-skills": ">=1.0.0", "@acme/not-provided": ">=1.0.0" },
        pi: {},
      })
    );
    write(join(recipeDir, "agents", "agent.yaml"), "name: agent\nmodel:\n  name: anthropic/claude-sonnet-4-6\nskills: [review]\n");

    expect(skillPaths(recipeDir)).toEqual([join(realpathSync(peerDir), "skills", "review", "SKILL.md")]);
  });

  it("ignores dev and transitive dependencies", () => {
    for (const as of ["devDependencies", "none"] as const) {
      const ignored: FakePackage = { name: "acme-skills", as, skills: ["skills"], files: { "skills/hidden/SKILL.md": skill("hidden") } };
      const fixture = recipe({ agentSkills: ["visible"], packages: [VISIBLE, ignored] });
      expect(skillPaths(fixture.dir), as).toEqual([visiblePath(fixture)]);
      expect(resolveRecipe({ recipeDir: fixture.dir }).resources.skills, as).toEqual([join(fixture.packageDir("acme-visible"), "skills")]);

      const selecting = recipe({ agentSkills: ["visible", "hidden"], packages: [VISIBLE, ignored] });
      expect(() => skillPaths(selecting.dir), as).toThrow('references missing packaged skill "hidden"');
    }
  });

  it("takes nothing from a dependency without pi.skills, even with a skills folder", () => {
    const plain: FakePackage = { name: "acme-plain", files: { "skills/by-convention/SKILL.md": skill("by-convention") } };
    const fixture = recipe({ agentSkills: ["visible"], packages: [VISIBLE, plain] });
    expect(skillPaths(fixture.dir)).toEqual([visiblePath(fixture)]);
    const selecting = recipe({ agentSkills: ["visible", "by-convention"], packages: [VISIBLE, plain] });
    expect(() => skillPaths(selecting.dir)).toThrow('references missing packaged skill "by-convention"');

    const empty = recipe({
      agentSkills: ["visible"],
      packages: [VISIBLE, { name: "acme-plain", skills: [], files: { "skills/a/SKILL.md": skill("a") } }],
    });
    expect(resolveRecipe({ recipeDir: empty.dir }).resources.skills).toEqual([join(empty.packageDir("acme-visible"), "skills")]);
  });

  it("skips a declared dependency that is not installed", () => {
    const fixture = recipe({ agentSkills: ["visible"], packages: [VISIBLE], missingDependency: "not-installed" });
    expect(skillPaths(fixture.dir)).toEqual([visiblePath(fixture)]);
  });

  it("finds a dependency hoisted beside the Recipe, for its skills and its Python declaration", () => {
    // npm, npx and `npm install --prefix` install the Recipe as
    // <prefix>/node_modules/recipe and its dependencies beside it.
    const prefix = mkdtempSync(join(tmpdir(), "recipe-dependency-skills-hoisted-"));
    scratchDirs.push(prefix);
    const recipeDir = join(prefix, "node_modules", "recipe");
    const depDir = join(prefix, "node_modules", "@acme", "legal-skills");
    write(
      join(recipeDir, "package.json"),
      JSON.stringify({ name: "recipe", version: "0.1.0", dependencies: { "@acme/legal-skills": ">=1.0.0" }, pi: {} })
    );
    write(join(recipeDir, "agents", "agent.yaml"), "name: agent\nmodel:\n  name: anthropic/claude-sonnet-4-6\nskills: [review]\n");
    write(
      join(depDir, "package.json"),
      JSON.stringify({
        name: "@acme/legal-skills",
        version: "1.0.0",
        pi: { skills: ["skills"], runtime: { python: { project: "python", lockfile: "python/uv.lock" } } },
      })
    );
    write(join(depDir, "skills", "review", "SKILL.md"), skill("review"));
    pythonProject(depDir);
    const realDepDir = realpathSync(depDir);

    expect(skillPaths(recipeDir)).toEqual([join(realDepDir, "skills", "review", "SKILL.md")]);
    expect(recipePythonDeclarations(recipeDir)).toEqual([
      expect.objectContaining({ kind: "package", owner: "@acme/legal-skills", packageDir: realDepDir }),
    ]);
  });

  it("refuses a selected skill name that the Recipe and a dependency both ship", () => {
    const fixture = recipe({
      agentSkills: ["review"],
      ownSkills: { review: skill("review") },
      packages: [{ name: "@acme/legal-skills", skills: ["skills"], files: { "skills/review/SKILL.md": skill("review") } }],
    });
    expect(() => skillPaths(fixture.dir)).toThrow(
      /skill "review" resolves to multiple packaged SKILL\.md files: the Recipe \(skills\/review\/SKILL\.md\), dependency @acme\/legal-skills \(/
    );
  });

  it("refuses a selected skill name that two dependencies both ship", () => {
    const fixture = recipe({
      agentSkills: ["review"],
      packages: [
        { name: "acme-a", skills: ["skills"], files: { "skills/review/SKILL.md": skill("review") } },
        { name: "acme-b", skills: ["skills"], files: { "skills/other-folder/SKILL.md": skill("review") } },
      ],
    });
    expect(() => skillPaths(fixture.dir)).toThrow(/resolves to multiple packaged SKILL\.md files: dependency acme-a .*dependency acme-b/);
  });

  it("refuses a dependency skill path that escapes the package through a symlink", () => {
    const outside = mkdtempSync(join(tmpdir(), "recipe-dependency-skills-outside-"));
    scratchDirs.push(outside);
    write(join(outside, "stolen", "SKILL.md"), skill("stolen"));
    const fixture = recipe({
      agentSkills: [],
      packages: [{ name: "acme-skills", skills: ["skills"], files: { "skills/ok/SKILL.md": skill("ok") } }],
    });
    symlinkSync(join(outside, "stolen"), join(fixture.packageDir("acme-skills"), "skills", "stolen"), "dir");
    expect(() => resolveRecipe({ recipeDir: fixture.dir })).toThrow(
      "Dependency acme-skills skills resource resolves outside the package"
    );
  });

  it("refuses a dependency skill path that points into another installed package", () => {
    // pnpm puts packages side by side under node_modules/.pnpm, so containment
    // is within the dependency's own real path, not the Recipe's.
    const fixture = recipe({
      agentSkills: [],
      packages: [
        { name: "acme-other", files: { "skills/x/SKILL.md": skill("x") } },
        { name: "acme-skills", skills: ["skills"], files: { "skills/ok/SKILL.md": skill("ok") } },
      ],
    });
    symlinkSync(
      join(fixture.packageDir("acme-other"), "skills", "x"),
      join(fixture.packageDir("acme-skills"), "skills", "x"),
      "dir"
    );
    expect(() => resolveRecipe({ recipeDir: fixture.dir })).toThrow(
      "Dependency acme-skills skills resource resolves outside the package"
    );
  });

  it("refuses a dependency skill path that doesn't match, or leaves the package, naming the package", () => {
    const cases: Array<[unknown, string]> = [
      [["missing"], "Dependency acme-skills declares missing skills resource: missing"],
      [["nothing/*"], "Dependency acme-skills declares skills glob with no matches: nothing/*"],
      [["../escape"], "Dependency acme-skills declares skills resource outside the package: ../escape"],
      ["skills", "Dependency acme-skills package.json#pi.skills must be an array of non-empty strings"],
    ];
    for (const [skills, message] of cases) {
      const fixture = recipe({
        agentSkills: [],
        packages: [{ name: "acme-skills", skills, files: { "skills/ok/SKILL.md": skill("ok") } }],
      });
      expect(() => resolveRecipe({ recipeDir: fixture.dir })).toThrow(message);
    }
  });
});
