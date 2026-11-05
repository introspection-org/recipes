import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import docxFormat, {
  LEGAL_REDLINING_EN_US,
} from "../packages/documents/docx/src/index.js";
import {
  DOCUMENTS_SKILL,
  documentProfileSkillProblem,
  loadRecipeDocuments,
} from "../src/documents/index.js";
import {
  readPiPackageManifest,
  validatePiPackageManifest,
} from "../src/recipe/package.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const HOUSE_STYLE =
  "---\nname: house-style-en-gb\ndescription: Our memo conventions.\n---\n\nUse British spelling in every change.\n";

/** A Recipe folder with a stand-in docx format package, so the loader runs without Python. */
function recipe(
  documents: unknown,
  files: Record<string, string> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "documents-profiles-"));
  const pkg = join(
    dir,
    "node_modules",
    "@introspection-ai",
    "recipe-documents-docx",
  );
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@introspection-ai/recipe-documents-docx",
      type: "module",
      main: "index.js",
    }),
  );
  writeFileSync(
    join(pkg, "index.js"),
    `export default { kind: "documents", format: "docx", extensions: [".docx"], capabilities: { read: true },
      profiles: { "legal-redlining-en-US": ${JSON.stringify(LEGAL_REDLINING_EN_US)} },
      createAdapter: () => ({ format: "docx", extensions: [".docx"], capabilities: { read: true }, read: async () => ({ text: "" }) }) };\n`,
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "r", type: "module", pi: { documents } }),
  );
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const load = (documents: { format: string; profile?: string }[], dir: string) =>
  loadRecipeDocuments(documents, ["documents"], { recipeDir: dir });

function frontmatterName(path: string): string | undefined {
  return /^---\nname: ([^\n]+)\n/.exec(readFileSync(path, "utf8"))?.[1];
}

describe("document profiles", () => {
  it("offers the core documents skill to every agent with the tool, and nothing more without a profile", async () => {
    const loaded = await load(
      [{ format: "docx" }],
      recipe([{ format: "docx" }]),
    );
    expect(loaded.skillPaths).toEqual([DOCUMENTS_SKILL]);
    expect(frontmatterName(DOCUMENTS_SKILL)).toBe("documents");
  });

  it("selects a profile the format ships by name, in any case, and offers it beside the core skill", async () => {
    for (const profile of ["legal-redlining-en-US", "legal-redlining-en-us"]) {
      const declarations = [{ format: "docx", profile }];
      const loaded = await load(declarations, recipe(declarations));
      expect(loaded.skillPaths).toEqual([
        DOCUMENTS_SKILL,
        LEGAL_REDLINING_EN_US,
      ]);
    }
    // The extension offers the same skills to the session through resources_discover.
    const declarations = [{ format: "docx", profile: "legal-redlining-en-US" }];
    const loaded = await load(declarations, recipe(declarations));
    const pi = createMockExtensionAPI();
    await loaded.extension!.factory(pi as never);
    const [discover] = pi.handlers.get("resources_discover") ?? [];
    expect(await discover!({ type: "resources_discover" }, {})).toEqual({
      skillPaths: loaded.skillPaths,
    });
  });

  it("offers the Recipe's own profile by its folder or its SKILL.md, as the file itself", async () => {
    for (const profile of [
      "./profiles/house-style-en-gb",
      "profiles/house-style-en-gb/SKILL.md",
    ]) {
      const declarations = [{ format: "docx", profile }];
      const dir = recipe(declarations, {
        "profiles/house-style-en-gb/SKILL.md": HOUSE_STYLE,
      });
      const loaded = await load(declarations, dir);
      expect(loaded.skillPaths).toEqual([
        DOCUMENTS_SKILL,
        join(dir, "profiles", "house-style-en-gb", "SKILL.md"),
      ]);
    }
  });

  it("offers no skills when the agent doesn't select the documents tool", async () => {
    const declarations = [{ format: "docx", profile: "legal-redlining-en-US" }];
    const loaded = await loadRecipeDocuments(declarations, ["read"], {
      recipeDir: recipe(declarations),
    });
    expect(loaded).toEqual({ toolNames: [] });
  });

  it("refuses a name the format doesn't ship, listing the ones it does", async () => {
    const declarations = [{ format: "docx", profile: "legal-redlining" }];
    await expect(load(declarations, recipe(declarations))).rejects.toThrow(
      "Unknown document profile 'legal-redlining': the docx format ships legal-redlining-en-US.",
    );
  });

  it.each([
    ["a missing folder", {}, "doesn't exist in the Recipe"],
    [
      "a folder without SKILL.md",
      { "profiles/house-style-en-gb/notes.md": "x" },
      "has no SKILL.md",
    ],
    [
      "no frontmatter",
      { "profiles/house-style-en-gb/SKILL.md": "Just text.\n" },
      "SKILL.md has no frontmatter",
    ],
    [
      "a name that isn't the folder's",
      {
        "profiles/house-style-en-gb/SKILL.md": HOUSE_STYLE.replace(
          "name: house-style-en-gb",
          "name: house-style",
        ),
      },
      "frontmatter name must be its folder's name in lower case ('house-style-en-gb'), not 'house-style'",
    ],
    [
      "no description",
      {
        "profiles/house-style-en-gb/SKILL.md":
          "---\nname: house-style-en-gb\n---\n\nText.\n",
      },
      "frontmatter needs a description",
    ],
  ])("refuses a Recipe profile with %s", async (_, files, message) => {
    const declarations = [
      { format: "docx", profile: "./profiles/house-style-en-gb" },
    ];
    await expect(
      load(declarations, recipe(declarations, files)),
    ).rejects.toThrow(message);
  });

  it("refuses a profile folder or SKILL.md that resolves outside the Recipe, and offers nothing from there", async () => {
    const outside = mkdtempSync(join(tmpdir(), "documents-profile-outside-"));
    mkdirSync(join(outside, "house-style-en-gb"));
    writeFileSync(
      join(outside, "house-style-en-gb", "SKILL.md"),
      HOUSE_STYLE.replace("British spelling", "OUTSIDE TEXT"),
    );

    const linkedFolder = [
      { format: "docx", profile: "./profiles/house-style-en-gb" },
    ];
    const folderDir = recipe(linkedFolder);
    mkdirSync(join(folderDir, "profiles"));
    symlinkSync(
      join(outside, "house-style-en-gb"),
      join(folderDir, "profiles", "house-style-en-gb"),
    );
    await expect(load(linkedFolder, folderDir)).rejects.toThrow(
      "resolves outside the package",
    );

    const linkedFile = [
      { format: "docx", profile: "./profiles/house-style-en-gb/SKILL.md" },
    ];
    const fileDir = recipe(linkedFile);
    mkdirSync(join(fileDir, "profiles", "house-style-en-gb"), {
      recursive: true,
    });
    symlinkSync(
      join(outside, "house-style-en-gb", "SKILL.md"),
      join(fileDir, "profiles", "house-style-en-gb", "SKILL.md"),
    );
    await expect(load(linkedFile, fileDir)).rejects.toThrow(
      "resolves outside the package",
    );
    await expect(
      load(
        [{ format: "docx", profile: "./profiles/house-style-en-gb" }],
        fileDir,
      ),
    ).rejects.toThrow("resolves outside the package");
  });

  it("ships the legal profile with the docx package as a skill that follows the contract", () => {
    expect(docxFormat.profiles).toEqual({
      "legal-redlining-en-US": LEGAL_REDLINING_EN_US,
    });
    expect(existsSync(LEGAL_REDLINING_EN_US)).toBe(true);
    expect(LEGAL_REDLINING_EN_US).toContain(
      join(
        "packages",
        "documents",
        "docx",
        "profiles",
        "legal-redlining-en-us",
        "SKILL.md",
      ),
    );
    expect(documentProfileSkillProblem(LEGAL_REDLINING_EN_US)).toBeUndefined();
    const files = JSON.parse(
      readFileSync("packages/documents/docx/package.json", "utf8"),
    ).files as string[];
    expect(files).toContain("profiles");
  });
});

describe("pi.documents profile field", () => {
  function manifest(documents: unknown, files: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "documents-profile-manifest-"));
    const dependencies = {
      "@introspection-ai/recipe-documents-docx": ">=0.1.0 <1.0.0",
    };
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "r",
        version: "0.1.0",
        dependencies,
        pi: { documents },
      }),
    );
    mkdirSync(join(dir, "agents"));
    writeFileSync(
      join(dir, "agents", "agent.yaml"),
      "name: agent\nmodel:\n  name: openai/gpt-5\ntools: [documents]\n",
    );
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    return readPiPackageManifest(dir);
  }

  const messages = (report: ReturnType<typeof validatePiPackageManifest>) =>
    report.findings.map((finding) => finding.message).join("\n");

  // A name is checked against the format's profiles when the Recipe loads, not here.
  it.each([["legal-redlining-en-US"], ["legal-redlining"]])(
    "accepts the name %s",
    (profile) => {
      const parsed = manifest([{ format: "docx", profile }]);
      expect(parsed.documents).toEqual([{ format: "docx", profile }]);
      expect(validatePiPackageManifest(parsed).valid).toBe(true);
    },
  );

  it.each([
    ["./profiles/house-style-en-gb"],
    ["profiles/house-style-en-gb/SKILL.md"],
  ])("accepts the Recipe profile %s", (profile) => {
    const report = validatePiPackageManifest(
      manifest([{ format: "docx", profile }], {
        "profiles/house-style-en-gb/SKILL.md": HOUSE_STYLE,
      }),
    );
    expect(messages(report)).toBe("");
    expect(report.valid).toBe(true);
  });

  it.each([
    [
      "./profiles/missing",
      {},
      "./profiles/missing doesn't exist in the Recipe",
    ],
    [
      "./profiles/house-style-en-gb",
      {
        "profiles/house-style-en-gb/SKILL.md":
          "---\nname: house\ndescription: x\n---\n",
      },
      "frontmatter name must be its folder's name in lower case",
    ],
    [
      "../outside",
      {},
      "'../outside' must be a relative path inside the Recipe",
    ],
    [
      "/abs/profile",
      {},
      "'/abs/profile' must be a relative path inside the Recipe",
    ],
    ["C:\\profiles\\house", {}, "must be a relative path inside the Recipe"],
    ["", {}, "must be the name of a profile the format ships"],
    [3, {}, "must be the name of a profile the format ships"],
  ])("rejects %j", (profile, files, message) => {
    const report = validatePiPackageManifest(
      manifest([{ format: "docx", profile }], files),
    );
    expect(report.valid).toBe(false);
    expect(messages(report)).toContain(message);
  });
});
