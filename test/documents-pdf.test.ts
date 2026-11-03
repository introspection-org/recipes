import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { registerDocumentTools, runDocumentHelper } from "../src/documents/index.js";
import { PdfDocumentAdapter } from "../packages/documents/pdf/src/index.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

type Tool = { execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ text?: string }>; details: any }> };

const project = resolve("packages/documents/pdf/python");
const fixtures = resolve("test/fixtures/documents");
let cwd = "";
let pagesDir = "";
/** With the `tables` extra (pdfplumber) and without it: the same lock, two environments. */
let withTables: Tool;
let withoutTables: Tool;

function environment(name: string, extras: string[]): string {
  const path = join(tmpdir(), `recipe-documents-pdf-tests-${name}`);
  execFileSync("uv", ["sync", "--frozen", "--quiet", "--project", project, ...extras], {
    env: { ...process.env, UV_PROJECT_ENVIRONMENT: path },
    stdio: "inherit",
  });
  return join(path, "bin", "python");
}

function documents(python: string): Tool {
  const pi = createMockExtensionAPI();
  registerDocumentTools(pi, [new PdfDocumentAdapter({ runHelper: runDocumentHelper, env: { ...process.env, RECIPE_DOCUMENTS_PYTHON: python } })], { cwd, pagesDir });
  return pi.tools.get("documents") as unknown as Tool;
}

let baseEnvironment: string;

beforeAll(() => {
  const full = environment("tables", ["--extra", "tables"]);
  const base = environment("base", []);
  baseEnvironment = base;
  cwd = mkdtempSync(join(tmpdir(), "documents-pdf-"));
  pagesDir = join(cwd, "pages");
  copyFileSync(join(fixtures, "schedule-table.pdf"), join(cwd, "schedule.pdf"));
  copyFileSync(join(fixtures, "scanned-schedule.pdf"), join(cwd, "scanned.pdf"));
  execFileSync(base, [join(fixtures, "make_annotated_pdf.py"), join(cwd, "annotated.pdf")]);
  withTables = documents(full);
  withoutTables = documents(base);
}, 300_000);

const text = (result: { content: Array<{ text?: string }> }) => result.content.at(-1)?.text ?? "";

// Each test starts Python; CI runners take several seconds per call.
describe("pdf adapter", { timeout: 30_000 }, () => {
  it("reads text in reading order and reports the text path", async () => {
    const result = await withoutTables.execute("1", { command: "read", path: "schedule.pdf" });
    const body = text(result);
    expect(body.split("\n")[0]).toBe("Path: text.");
    expect(body).toContain("--- page 1\nSchedule B: Fees and Service Levels");
    expect(body.indexOf("Schedule B")).toBeLessThan(body.indexOf("Fees are payable within thirty (30) days"));
    expect(body).not.toContain("| Pilot");
    expect(result.details).toMatchObject({ pages: 1, path: ["text"], scanned: [], tables_extra: "not requested" });
  });

  it("reads filled form fields and page comments", async () => {
    const body = text(await withoutTables.execute("2", { command: "read", path: "annotated.pdf" }));
    expect(body).toContain("Clause 1. Fees are due in thirty days.");
    expect(body).toContain("--- form fields (filled in)\nLicensee: GiantCo Ltd");
    expect(body).toContain("--- comments on the pages\npage 1, Counsel: Check the cap");
  });

  it("returns table cells when asked and the tables extra is installed", async () => {
    const result = await withTables.execute("3", { command: "read", path: "schedule.pdf", tables: true });
    const body = text(result);
    expect(body.split("\n")[0]).toBe("Path: text, tables.");
    expect(body).toContain("--- page 1, table 1 (4 rows)");
    expect(body).toContain("| Service tier | Monthly fee | Uptime | Service credit |");
    expect(body).toContain("| Pilot (150 users) | $40,000 | 99.5% | 5% per 0.1% below |");
    expect(result.details).toMatchObject({ path: ["text", "tables"], tables: 1, tables_extra: "used" });
  });

  it("returns text and names the missing extra when tables are asked for without it", async () => {
    const result = await withoutTables.execute("4", { command: "read", path: "schedule.pdf", tables: true });
    const body = text(result);
    expect(body.split("\n")[0]).toBe("Path: text.");
    expect(body).toContain("Pilot (150 users) $40,000");
    expect(body).toContain("table extraction needs the PDF adapter's `tables` extra (pdfplumber)");
    expect(result.details).toMatchObject({ path: ["text"], tables: 0, tables_extra: "missing" });
  });

  it("detects a scanned page with no text layer and suggests rendering", async () => {
    const result = await withTables.execute("5", { command: "read", path: "scanned.pdf", tables: true });
    const body = text(result);
    expect(body.split("\n")[0]).toBe("Path: page images (no text layer).");
    expect(body).toContain('No text layer on page(s) 1 (a scan): render them with documents render (pages "1")');
    expect(result.details).toMatchObject({ path: ["page images (no text layer)"], scanned: [1] });
  });

  it("renders pages to PNG files and returns their paths for the read tool", async () => {
    const result = await withoutTables.execute("6", { command: "render", path: "scanned.pdf", pages: "1" });
    const [image] = result.details.images as string[];
    expect(text(result)).toContain("Path: page images. Rendered 1 of 1 page(s) to PNG");
    expect(text(result)).toContain(`page 1: ${image}`);
    expect(dirname(dirname(image!))).toBe(pagesDir);
    expect(readFileSync(image!).subarray(1, 4).toString()).toBe("PNG");
    expect(result.content.every((part) => "text" in part)).toBe(true);
  });

  it("renders filled form fields, not just the page behind them", async () => {
    const result = await withoutTables.execute("6f", { command: "render", path: "annotated.pdf", pages: "1" });
    const [image] = result.details.images as string[];
    // Dark pixels in the rendered PNG, against the same page drawn without the form environment.
    const dark = execFileSync(baseEnvironment, ["-c", [
      "import sys, pypdfium2 as p",
      "from PIL import Image",
      "count = lambda im: sum(1 for v in im.convert('L').get_flattened_data() if v < 200)",
      "page = p.PdfDocument(sys.argv[2])[0]",
      "bare = page.render(scale=Image.open(sys.argv[1]).width / page.get_width()).to_pil()",
      "print(count(Image.open(sys.argv[1])), count(bare))",
    ].join("\n"), image!, join(cwd, "annotated.pdf")], { encoding: "utf8" }).trim().split(" ").map(Number);
    expect(dark[0]).toBeGreaterThan(dark[1]! * 1.1);
  });

  it("is read-only: no write command is registered for PDF", async () => {
    await expect(
      withoutTables.execute("7", { command: "propose_edits", path: "schedule.pdf", output: "outputs/x.pdf", author: "A", edits: [] }),
    ).rejects.toThrow();
  });
});
