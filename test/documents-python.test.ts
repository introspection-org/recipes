import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { recipesVersion } from "../src/recipe/companions.js";

import { describe, expect, it } from "vitest";

import { loadRecipeDocuments } from "../src/documents/index.js";
import { prepareRecipePython } from "../src/recipe/python.js";
import { LEGAL_REDLINING_EN_US } from "../packages/documents/docx/src/index.js";
import { documentPythonExecutable } from "../src/documents/index.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

describe("document helper interpreter order", () => {
  const pythonExecutable = documentPythonExecutable;
  const prepared = "/envs/package/bin/python";

  it("prefers RECIPE_DOCUMENTS_PYTHON over everything", () => {
    const env = {
      RECIPE_DOCUMENTS_PYTHON: "/override/python",
      VIRTUAL_ENV: "/venv",
    };
    expect(pythonExecutable(env, prepared, "linux")).toBe("/override/python");
  });

  it("then the interpreter the host prepared for the package, over VIRTUAL_ENV", () => {
    expect(pythonExecutable({ VIRTUAL_ENV: "/venv" }, prepared, "linux")).toBe(
      prepared,
    );
  });

  it("then VIRTUAL_ENV, in the layout of the platform", () => {
    expect(pythonExecutable({ VIRTUAL_ENV: "/venv" }, undefined, "linux")).toBe(
      "/venv/bin/python",
    );
    expect(
      pythonExecutable({ VIRTUAL_ENV: "/venv" }, undefined, "darwin"),
    ).toBe("/venv/bin/python");
    expect(
      pythonExecutable({ VIRTUAL_ENV: "C:\\r\\.venv" }, undefined, "win32"),
    ).toBe("C:\\r\\.venv\\Scripts\\python.exe");
  });

  it("then python3 from PATH", () => {
    expect(pythonExecutable({}, undefined, "linux")).toBe("python3");
  });
});

const hasUv = spawnSync("uv", ["--version"]).status === 0;

type Tool = {
  execute(
    id: string,
    params: Record<string, unknown>,
  ): Promise<{ content: Array<{ text?: string }> }>;
};

/**
 * A synthetic Recipe that declares no Python of its own and uses both format
 * packages: pinned in its dependencies, or omitted so the host supplies them
 * from beside its own `@introspection-ai/recipes`. `prepareRecipePython` builds each package's environment
 * from its own `pi.runtime.python` with the real uv, and the documents tool
 * reads a synthetic .docx and .pdf through them. The tool's environment has
 * no VIRTUAL_ENV, no override and no python3 on PATH, so only the prepared
 * interpreters can serve the reads.
 */
describe.skipIf(!hasUv || process.platform === "win32")(
  "documents in their packages' own environments",
  () => {
    it.each([
      "pinned by the Recipe",
      "companion packages installed alongside Recipes",
    ])(
      "reads a .docx and a .pdf for a Recipe that declares no Python, %s",
      async (source) => {
        const pinned = source === "pinned by the Recipe";
        const recipeDir = mkdtempSync(
          join(tmpdir(), "documents-package-python-"),
        );
        const hostRoot = mkdtempSync(
          join(tmpdir(), "documents-package-python-host-"),
        );
        const hostDir = join(
          hostRoot,
          "node_modules",
          "@introspection-ai",
          "recipes",
        );
        mkdirSync(hostDir, { recursive: true });
        writeFileSync(
          join(hostDir, "package.json"),
          JSON.stringify({
            name: "@introspection-ai/recipes",
            version: recipesVersion(),
          }),
        );
        const scope = join(
          pinned ? recipeDir : hostRoot,
          "node_modules",
          "@introspection-ai",
        );
        mkdirSync(scope, { recursive: true });
        symlinkSync(
          resolve("packages/documents/docx"),
          join(scope, "recipe-documents-docx"),
          "dir",
        );
        symlinkSync(
          resolve("packages/documents/pdf"),
          join(scope, "recipe-documents-pdf"),
          "dir",
        );
        const declarations = [
          { format: "docx", profile: "legal-redlining-en-US" },
          { format: "pdf" },
        ];
        writeFileSync(
          join(recipeDir, "package.json"),
          JSON.stringify({
            name: "synthetic-documents-recipe",
            version: "0.1.0",
            type: "module",
            ...(pinned
              ? {
                  dependencies: {
                    "@introspection-ai/recipe-documents-docx": ">=0.3.0",
                    "@introspection-ai/recipe-documents-pdf": ">=0.2.0",
                  },
                }
              : {}),
            pi: { documents: declarations },
          }),
        );

        const prepareEnv = { ...process.env };
        delete prepareEnv.VIRTUAL_ENV;
        delete prepareEnv.UV_PROJECT_ENVIRONMENT;
        const prepared = await prepareRecipePython(recipeDir, {
          mode: "sync",
          env: prepareEnv,
          environmentRoot: join(recipeDir, ".pi"),
          allowPythonDownloads: true,
          hostDir,
        });
        expect(prepared.recipe).toBeUndefined();
        const docx =
          prepared.packages["@introspection-ai/recipe-documents-docx"]!;
        const pdf =
          prepared.packages["@introspection-ai/recipe-documents-pdf"]!;
        expect(docx.interpreter).toBe(
          join(
            recipeDir,
            ".pi",
            "python-packages",
            "@introspection-ai",
            "recipe-documents-docx",
            "bin",
            "python",
          ),
        );
        expect(pdf.interpreter).toBe(
          join(
            recipeDir,
            ".pi",
            "python-packages",
            "@introspection-ai",
            "recipe-documents-pdf",
            "bin",
            "python",
          ),
        );

        const cwd = join(recipeDir, "workspace");
        mkdirSync(cwd);
        execFileSync(docx.interpreter, [
          resolve("test/fixtures/documents/make_contract.py"),
          join(cwd, "contract.docx"),
        ]);
        copyFileSync(
          resolve("test/fixtures/documents/schedule-table.pdf"),
          join(cwd, "schedule.pdf"),
        );

        const toolEnv: NodeJS.ProcessEnv = {
          ...process.env,
          PATH: join(recipeDir, "no-python-here"),
        };
        delete toolEnv.VIRTUAL_ENV;
        delete toolEnv.RECIPE_DOCUMENTS_PYTHON;
        const loaded = await loadRecipeDocuments(declarations, ["documents"], {
          recipeDir,
          cwd,
          env: toolEnv,
          python: prepared.packages,
          hostDir,
        });
        expect(loaded.skillPaths).toContain(LEGAL_REDLINING_EN_US);
        const pi = createMockExtensionAPI();
        await loaded.extension!.factory(pi as never);
        const documents = pi.tools.get("documents") as unknown as Tool;
        const text = async (path: string) =>
          (await documents.execute("1", { command: "read", path })).content.at(
            -1,
          )?.text ?? "";

        expect(await text("contract.docx")).toMatch(
          /\[p-002\] 2\. Fees\. Customer pays the fees within thirty days/,
        );
        expect(await text("schedule.pdf")).toContain(
          "Schedule B: Fees and Service Levels",
        );
      },
      600_000,
    );
  },
);
