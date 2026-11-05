import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadRecipeDocuments,
  documentCommandsFor,
  registerDocumentTools,
  workspacePath,
  type DocumentAdapter,
} from "../src/documents/index.js";
import { recipesVersion } from "../src/recipe/companions.js";
import {
  readPiPackageManifest,
  validatePiPackageManifest,
} from "../src/recipe/package.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "documents-test-"));
  writeFileSync(join(dir, "contract.docx"), "original");
  writeFileSync(join(dir, "brief.pdf"), "pdf");
  return dir;
}

function wordStub(
  calls: Array<[string, Record<string, unknown>]>,
): DocumentAdapter {
  return {
    format: "docx",
    extensions: [".docx"],
    capabilities: {
      read: true,
      proposeEdits: true,
      comment: true,
      respond: true,
      removeSection: true,
    },
    async read(_ctx, input) {
      calls.push(["read", input as never]);
      return { text: "read" };
    },
    async proposeEdits(_ctx, input) {
      calls.push(["propose_edits", input as never]);
      writeFileSync(input.output, "redline");
      return { text: "1 of 1 edit(s) applied" };
    },
    async comment() {
      return { text: "comment" };
    },
    async respond() {
      return { text: "respond" };
    },
    async removeSection() {
      return { text: "remove" };
    },
  };
}

const pdfStub: DocumentAdapter = {
  format: "pdf",
  extensions: [".pdf"],
  capabilities: { read: true, render: true },
  async read() {
    return { text: "pdf text" };
  },
  async render() {
    return {
      text: "1 page",
      images: [
        { label: "page 1", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
    };
  },
};

function tool(adapters: DocumentAdapter[], cwd: string, commands?: string[]) {
  const pi = createMockExtensionAPI();
  registerDocumentTools(pi, adapters, { cwd, commands: commands as never });
  return pi.tools.get("documents") as unknown as
    | {
        description: string;
        execute(
          id: string,
          params: Record<string, unknown>,
        ): Promise<{
          content: Array<{ type: string; text?: string }>;
          details: Record<string, unknown>;
        }>;
      }
    | undefined;
}

const edit = {
  op: "replace",
  quote: "thirty days",
  new: "sixty days",
  rationale: "Why.",
};

describe("documents tool", () => {
  it("registers one tool over every format, with the union of their commands", () => {
    const registered = tool([wordStub([]), pdfStub], workspace());
    expect(registered?.description).toContain("propose_edits:");
    expect(registered?.description).toContain("render:");
    expect(documentCommandsFor(pdfStub.capabilities)).toEqual([
      "read",
      "render",
    ]);
  });

  it("routes by extension and refuses a command the format lacks, naming the formats that have it", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const cwd = workspace();
    const registered = tool([wordStub(calls), pdfStub], cwd)!;
    const pdf = await registered.execute("1", {
      command: "read",
      path: "brief.pdf",
    });
    expect(pdf.content.at(-1)?.text).toBe("pdf text");
    await expect(
      registered.execute("2", { command: "render", path: "contract.docx" }),
    ).rejects.toThrow("render is not supported for docx files; it is for pdf");
    await expect(
      registered.execute("3", { command: "read", path: "notes.txt" }),
    ).rejects.toThrow("doesn't open .txt");
  });

  it("writes only to a new file under outputs/, then keeps editing that file in place", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const cwd = workspace();
    const registered = tool([wordStub(calls)], cwd)!;
    const base = {
      command: "propose_edits",
      author: "Reviewing Counsel (AgentCo)",
      edits: [edit],
    };
    await expect(
      registered.execute("1", { ...base, path: "contract.docx" }),
    ).rejects.toThrow("Pass output");
    await expect(
      registered.execute("2", {
        ...base,
        path: "contract.docx",
        output: "contract.docx",
      }),
    ).rejects.toThrow("Pass output");
    await expect(
      registered.execute("2b", {
        ...base,
        path: "contract.docx",
        output: "elsewhere/r.docx",
      }),
    ).rejects.toThrow("output must be under outputs/");
    const first = await registered.execute("3", {
      ...base,
      path: "contract.docx",
      output: "outputs/redline.docx",
    });
    expect(first.details.output).toBe(join("outputs", "redline.docx"));
    expect(calls.at(-1)?.[1]).toMatchObject({
      source: join(cwd, "contract.docx"),
      output: join(cwd, "outputs", "redline.docx"),
    });
    await registered.execute("4", { ...base, path: "outputs/redline.docx" });
    expect(calls.at(-1)?.[1]).toMatchObject({
      source: join(cwd, "outputs", "redline.docx"),
      output: join(cwd, "outputs", "redline.docx"),
    });
    mkdirSync(join(cwd, "outputs", "old"), { recursive: true });
    writeFileSync(join(cwd, "outputs", "old", "theirs.docx"), "x");
    await expect(
      registered.execute("5", {
        ...base,
        path: "contract.docx",
        output: "outputs/old/theirs.docx",
      }),
    ).rejects.toThrow("already exists");
  });

  it("refuses an output that a link inside outputs/ points outside it", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const cwd = workspace();
    const registered = tool([wordStub(calls)], cwd)!;
    mkdirSync(join(cwd, "outputs"), { recursive: true });
    mkdirSync(join(cwd, "files"), { recursive: true });
    symlinkSync("../files", join(cwd, "outputs", "link"));
    const base = {
      command: "propose_edits",
      author: "Reviewing Counsel (AgentCo)",
      edits: [edit],
    };
    await expect(
      registered.execute("1", {
        ...base,
        path: "contract.docx",
        output: "outputs/link/new.docx",
      }),
    ).rejects.toThrow("output must be under outputs/");
    expect(calls).toHaveLength(0);
  });

  it("never writes in place over a file this session did not create", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const cwd = workspace();
    const registered = tool([wordStub(calls)], cwd)!;
    const base = {
      command: "propose_edits",
      author: "Reviewing Counsel (AgentCo)",
      edits: [edit],
    };
    mkdirSync(join(cwd, "outputs"), { recursive: true });
    writeFileSync(join(cwd, "outputs", "earlier.docx"), "earlier");
    mkdirSync(join(cwd, "files"), { recursive: true });
    writeFileSync(join(cwd, "files", "upload.docx"), "upload");
    // An existing outputs/ file as path, with no output.
    await expect(
      registered.execute("1", { ...base, path: "outputs/earlier.docx" }),
    ).rejects.toThrow("Pass output");
    // output equal to path.
    await expect(
      registered.execute("2", {
        ...base,
        path: "outputs/earlier.docx",
        output: "outputs/earlier.docx",
      }),
    ).rejects.toThrow("Pass output");
    // An uploaded file under files/, with and without output equal to path.
    await expect(
      registered.execute("3", { ...base, path: "files/upload.docx" }),
    ).rejects.toThrow("Pass output");
    await expect(
      registered.execute("4", {
        ...base,
        path: "files/upload.docx",
        output: "files/upload.docx",
      }),
    ).rejects.toThrow("Pass output");
    expect(calls).toHaveLength(0);
    // A second edit to a file this session created is allowed, with or without output.
    await registered.execute("5", {
      ...base,
      path: "files/upload.docx",
      output: "outputs/mine.docx",
    });
    await registered.execute("6", { ...base, path: "outputs/mine.docx" });
    await registered.execute("7", {
      ...base,
      path: "outputs/mine.docx",
      output: "outputs/mine.docx",
    });
    expect(calls).toHaveLength(3);
    expect(calls.at(-1)?.[1]).toMatchObject({
      source: join(cwd, "outputs", "mine.docx"),
      output: join(cwd, "outputs", "mine.docx"),
    });
  });

  it("refuses paths outside the workspace, through a symlink too", () => {
    const cwd = workspace();
    symlinkSync("/etc", join(cwd, "link"));
    expect(() => workspacePath("/etc/hosts", cwd)).toThrow(
      "outside the workspace",
    );
    expect(() => workspacePath("link/hosts", cwd)).toThrow(
      "outside the workspace",
    );
  });

  it("returns images as image content", async () => {
    const result = await tool([pdfStub], workspace())!.execute("1", {
      command: "render",
      path: "brief.pdf",
    });
    expect(result.content.map((part) => part.type)).toEqual([
      "text",
      "image",
      "text",
    ]);
  });

  it("rejects invalid arguments before the adapter runs", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const registered = tool([wordStub(calls)], workspace())!;
    await expect(
      registered.execute("1", {
        command: "propose_edits",
        path: "contract.docx",
        output: "outputs/r.docx",
        edits: [edit],
      }),
    ).rejects.toThrow("Invalid documents command");
    expect(calls).toEqual([]);
  });

  it("honours a commands allowlist and an empty one exposes no tool", () => {
    expect(
      tool([wordStub([])], workspace(), ["read"])?.description,
    ).not.toContain("propose_edits:");
    expect(tool([wordStub([])], workspace(), [])).toBeUndefined();
    expect(() => tool([pdfStub], workspace(), ["propose_edits"])).toThrow(
      "Unsupported documents command",
    );
  });

  it("refuses an adapter that claims a command it does not implement", () => {
    const broken = { ...pdfStub, render: undefined };
    expect(() => tool([broken], workspace())).toThrow(
      "does not implement: render",
    );
  });

  it("checks a format module's adapter against its declared capabilities when the host loads it", async () => {
    const recipeDir = mkdtempSync(join(tmpdir(), "documents-catalog-"));
    const pkg = join(
      recipeDir,
      "node_modules",
      "@introspection-ai",
      "recipe-documents-pdf",
    );
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@introspection-ai/recipe-documents-pdf",
        version: "9.0.0",
        type: "module",
        main: "index.js",
      }),
    );
    writeFileSync(
      join(pkg, "index.js"),
      `export default { kind: "documents", apiVersion: 1, format: "pdf", extensions: [".pdf"], capabilities: { read: true, render: true },
        createAdapter: () => ({ format: "pdf", extensions: [".pdf"], capabilities: { read: true }, read: async () => ({ text: "" }) }) };\n`,
    );
    const loaded = await loadRecipeDocuments(
      [{ format: "pdf" }],
      ["documents"],
      { recipeDir },
    );
    expect(() =>
      loaded.extension!.factory(createMockExtensionAPI() as never),
    ).toThrow("differ from its declared catalog");
  });

  it("refuses a format module written against another contract version", async () => {
    const recipeDir = mkdtempSync(join(tmpdir(), "documents-api-"));
    const pkg = join(
      recipeDir,
      "node_modules",
      "@introspection-ai",
      "recipe-documents-pdf",
    );
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@introspection-ai/recipe-documents-pdf",
        version: "9.0.0",
        type: "module",
        main: "index.js",
      }),
    );
    writeFileSync(
      join(pkg, "index.js"),
      `export default { kind: "documents", apiVersion: 2, format: "pdf", extensions: [".pdf"], capabilities: { read: true }, createAdapter() {} };\n`,
    );

    await expect(
      loadRecipeDocuments([{ format: "pdf" }], ["documents"], { recipeDir }),
    ).rejects.toThrow(
      `@introspection-ai/recipe-documents-pdf@9.0.0 (resolved from the Recipe, ${realpathSync(pkg)}) implements document format API 2, ` +
        `but @introspection-ai/recipes ${recipesVersion()} implements document format API 1. ` +
        "Raise or remove the Recipe's pin on @introspection-ai/recipe-documents-pdf in its dependencies, or run `introspection upgrade`.",
    );
  });
});

describe("pi.documents manifest", () => {
  function manifest(pi: unknown, dependencies: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "documents-manifest-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "r", version: "0.1.0", dependencies, pi }),
    );
    mkdirSync(join(dir, "agents"));
    writeFileSync(
      join(dir, "agents", "agent.yaml"),
      "name: agent\nmodel:\n  name: openai/gpt-5\ntools: [documents]\n",
    );
    return readPiPackageManifest(dir);
  }
  const deps = { "@introspection-ai/recipe-documents-docx": ">=0.1.0 <1.0.0" };

  it("parses format declarations with an optional allowlist", () => {
    const parsed = manifest(
      { documents: [{ format: "docx", commands: ["read", "propose_edits"] }] },
      deps,
    );
    expect(parsed.documents).toEqual([
      { format: "docx", commands: ["read", "propose_edits"] },
    ]);
    expect(validatePiPackageManifest(parsed).valid).toBe(true);
  });

  it.each([
    [{ documents: { format: "docx" } }, "must be an array"],
    [{ documents: [{ format: "" }] }, "format must be non-empty"],
    [
      { documents: [{ format: "docx" }, { format: "docx" }] },
      "duplicate format",
    ],
    [{ documents: [{ format: "docx", provider: "x" }] }, "unknown field"],
    [
      { documents: [{ format: "docx", commands: ["read", "read"] }] },
      "unique non-empty strings",
    ],
    [
      { documents: [{ format: "odt" }] },
      "requires dependency '@introspection-ai/recipe-documents-odt'",
    ],
  ])("rejects %j", (pi, message) => {
    const report = validatePiPackageManifest(manifest(pi, deps));
    expect(report.valid).toBe(false);
    expect(
      report.findings.map((finding) => finding.message).join("\n"),
    ).toContain(message);
  });

  it("accepts a companion format the Recipe does not list", () => {
    expect(
      validatePiPackageManifest(
        manifest({ documents: [{ format: "docx" }, { format: "pdf" }] }),
      ).findings,
    ).toEqual([]);
  });

  it("accepts a companion format declared as a peer, which the platform provides", () => {
    const dir = mkdtempSync(join(tmpdir(), "documents-manifest-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "r",
        version: "0.1.0",
        peerDependencies: {
          "@introspection-ai/recipe-documents-pdf": ">=0.2.0",
        },
        pi: { documents: [{ format: "pdf" }] },
      }),
    );
    expect(
      validatePiPackageManifest(readPiPackageManifest(dir)).findings.filter(
        (item) =>
          item.code.startsWith("pi.documents") ||
          item.code.startsWith("package.peer"),
      ),
    ).toEqual([]);
  });
});
