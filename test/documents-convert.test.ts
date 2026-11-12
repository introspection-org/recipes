import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  registerDocumentTools,
  runDocumentHelper,
} from "../src/documents/index.js";
import { DocxDocumentAdapter } from "../packages/documents/docx/src/index.js";
import { PdfDocumentAdapter } from "../packages/documents/pdf/src/index.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

type Tool = {
  execute(
    id: string,
    params: Record<string, unknown>,
  ): Promise<{ content: Array<{ text?: string }>; details: any }>;
};

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "table"; rows: string[][] };

const fixtures = resolve("test/fixtures/documents");
const HEADER =
  "Acme Analytics, Inc. Statement of Work: Resident Analyst Access v.2";
const COUNSEL = "Talent Co. Legal";

/** The contract the PDF is laid out from: what a conversion should give back. */
const SOURCE: Block[] = (
  JSON.parse(
    readFileSync(join(fixtures, "sow-contract.json"), "utf8"),
  ) as Array<Block & { ruled?: boolean }>
).map(({ ruled: _ruled, ...block }) => block as Block);

let cwd = "";
let pdfPython = "";
let docxPython = "";
/** Both formats, the PDF with the `tables` extra; and the same without it. */
let documents: Tool;
let withoutTables: Tool;

function environment(project: string, name: string, extras: string[] = []) {
  const path = join(tmpdir(), `recipe-documents-convert-tests-${name}`);
  execFileSync(
    "uv",
    ["sync", "--frozen", "--quiet", "--project", resolve(project), ...extras],
    {
      env: { ...process.env, UV_PROJECT_ENVIRONMENT: path },
      stdio: "inherit",
    },
  );
  return join(path, "bin", "python");
}

/** One `documents` tool over PDF and Word, each adapter on its own package environment. */
function tool(pdf: string): Tool {
  const pi = createMockExtensionAPI();
  registerDocumentTools(
    pi,
    [
      new PdfDocumentAdapter({
        runHelper: runDocumentHelper,
        env: process.env,
        python: pdf,
      }),
      new DocxDocumentAdapter({
        runHelper: runDocumentHelper,
        env: process.env,
        python: docxPython,
      }),
    ],
    { cwd, pagesDir: join(cwd, "pages") },
  );
  return pi.tools.get("documents") as unknown as Tool;
}

/** Lay blocks out as a paged PDF with a running header and page-number footer. */
function layOut(
  blocks: Array<Block & { beside?: string }>,
  name: string,
  bare = false,
): string {
  const source = join(cwd, `${name}.json`);
  writeFileSync(source, JSON.stringify(blocks));
  execFileSync(docxPython, [
    join(fixtures, "make_text_pdf.py"),
    source,
    join(cwd, `${name}.pdf`),
    "--header",
    HEADER,
    ...(bare ? ["--bare"] : []),
  ]);
  return `${name}.pdf`;
}

/** A Word file's body as blocks, tracked changes accepted. */
function dump(path: string): Block[] {
  return JSON.parse(
    execFileSync(docxPython, [
      join(fixtures, "dump_docx.py"),
      join(cwd, path),
    ]).toString(),
  ) as Block[];
}

/** A Word file's page, Normal font, footer and heading runs. */
function layoutOf(path: string): {
  page: { width: number; height: number; left: number; right: number };
  font: { family: string; size: number };
  footer: string[];
  headings: Array<
    Array<{ text: string; bold: boolean; size: number; color: string }>
  >;
} {
  return JSON.parse(
    execFileSync(docxPython, [
      join(fixtures, "dump_docx.py"),
      join(cwd, path),
      "--layout",
    ]).toString(),
  );
}

/** A PDF's body lines page by page, as `read` gives them, without the running header and footer. */
async function pdfLines(path: string): Promise<string[][]> {
  const body = text(
    await documents.execute("lines", { command: "read", path }),
  );
  return body
    .split(/\n--- page \d+\n/)
    .slice(1)
    .map((page) =>
      page
        .split("\n")
        .map((line) => line.trim())
        .filter(
          (line) =>
            line.trim() &&
            line !== HEADER &&
            !/^Page \d+ of \d+$/.test(line) &&
            !line.startsWith("---"),
        ),
    );
}

const text = (result: { content: Array<{ text?: string }> }) =>
  result.content.at(-1)?.text ?? "";

const words = (blocks: Block[]) =>
  blocks
    .flatMap((block) =>
      block.type === "table" ? block.rows.flat() : [block.text],
    )
    .join(" ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

/** How much of the wording two documents share, from 0 to 1, whatever the block boundaries. */
function overlap(left: Block[], right: Block[]): number {
  const counts = new Map<string, number>();
  for (const word of words(left)) counts.set(word, (counts.get(word) ?? 0) + 1);
  let shared = 0;
  const others = words(right);
  for (const word of others) {
    const count = counts.get(word) ?? 0;
    if (count > 0) {
      shared += 1;
      counts.set(word, count - 1);
    }
  }
  return (2 * shared) / (words(left).length + others.length);
}

/** The read output's id for each signature-block cell in the customer's column. */
function customerCells(read: string): Record<string, string> {
  const cells: Record<string, string> = {};
  for (const [, id, label] of read.matchAll(
    /\[(p-\d+\.r\dc2)\] (By|Name|Title|Date):/g,
  )) {
    cells[label!] = id!;
  }
  return cells;
}

const signed = (blocks: Block[]): Block[] =>
  blocks.map((block) =>
    block.type === "table" && block.rows[0]?.[1] === "TALENT CO."
      ? {
          ...block,
          rows: block.rows.map((row) => {
            const [left = "", right = ""] = row;
            if (right.startsWith("Name:")) return [left, "Name: Sam Rivera"];
            if (right.startsWith("Title:"))
              return [left, "Title: General Counsel"];
            if (right.startsWith("Date:"))
              return [left, "Date: November 12, 2026"];
            return row;
          }),
        }
      : block,
  );

beforeAll(() => {
  pdfPython = environment("packages/documents/pdf/python", "pdf-tables", [
    "--extra",
    "tables",
  ]);
  const pdfBase = environment("packages/documents/pdf/python", "pdf-base");
  docxPython = environment("packages/documents/docx/python", "docx");
  cwd = mkdtempSync(join(tmpdir(), "documents-convert-"));
  layOut(SOURCE, "sow");
  copyFileSync(
    join(fixtures, "scanned-schedule.pdf"),
    join(cwd, "scanned.pdf"),
  );
  documents = tool(pdfPython);
  withoutTables = tool(pdfBase);
}, 300_000);

// Each conversion starts Python twice; CI runners take several seconds per call.
describe("documents convert", { timeout: 60_000 }, () => {
  it("converts a PDF to Word: headings, clauses, the fee table and the signature block come over", async () => {
    const result = await documents.execute("1", {
      command: "convert",
      path: "sow.pdf",
      output: "outputs/sow.docx",
    });
    const count = (type: Block["type"]) =>
      SOURCE.filter((block) => block.type === type).length;
    expect(text(result)).toContain(
      `Converted sow.pdf to sow.docx: ${count("heading")} heading(s), ${count("paragraph")} paragraph(s), ${count("table")} table(s).`,
    );
    // A header and a footer on each of the two pages.
    expect(text(result)).toContain(
      "Dropped 4 running header, footer or page-number line(s).",
    );
    expect(result.details).toMatchObject({
      output: "outputs/sow.docx",
      export: { pages: 2, tables: 2, dropped: 4, tables_extra: "used" },
    });

    // The Reporting clause runs across the page break, under page 2's header and footer.
    const pages = text(
      await documents.execute("1b", { command: "read", path: "sow.pdf" }),
    );
    expect(pages).toMatch(
      /only to deliver\n--- page 2\n[^\n]+\nPage 2 of 2\nand improve the Services\./,
    );

    const converted = dump("outputs/sow.docx");
    expect(converted).toEqual(SOURCE);
    // The running header and footer are gone; the clause that ran across a page break is whole.
    const all = JSON.stringify(converted);
    expect(all).not.toContain("Page 1 of");
    expect(all).not.toContain(HEADER);
    expect(
      converted.some(
        (block) =>
          block.type === "paragraph" &&
          block.text.startsWith("3. Reporting.") &&
          block.text.endsWith("deliver and improve the Services."),
      ),
    ).toBe(true);
  });

  it("carries the page, fonts, headings and running header and footer into the Word file", async () => {
    const layout = layoutOf("outputs/sow.docx");
    expect(layout.page).toMatchObject({ width: 612, height: 792 });
    expect(layout.page.left).toBeCloseTo(72, 0);
    // The PDF's Helvetica is Arial in Word, at the body's 11 points.
    expect(layout.font).toEqual({ family: "Arial", size: 11 });
    expect(layout.footer).toEqual(["Page {PAGE} of {NUMPAGES}"]);
    expect(
      layout.headings.map(([run]) => [
        run!.text,
        run!.size,
        run!.bold,
        run!.color,
      ]),
    ).toEqual([
      ["Professional Services Statement of Work", 18, true, "000000"],
      ["Resident Analyst Access", 14, true, "000000"],
      ...SOURCE.filter(
        (block): block is Extract<Block, { type: "heading" }> =>
          block.type === "heading" && block.level === 3,
      ).map((block) => [block.text, 12, true, "000000"]),
    ]);
  });

  it("gives a file the Word commands read and redline", async () => {
    await documents.execute("2", {
      command: "convert",
      path: "sow.pdf",
      output: "outputs/redline.docx",
    });
    const read = text(
      await documents.execute("3", {
        command: "read",
        path: "outputs/redline.docx",
      }),
    );
    expect(read).toContain(
      "(Heading 1) Professional Services Statement of Work",
    );
    expect(read).toMatch(/\[p-\d+\.r2c3\] \$24,000/);
    const applied = text(
      await documents.execute("4", {
        command: "propose_edits",
        path: "outputs/redline.docx",
        author: COUNSEL,
        edits: [
          {
            op: "replace",
            quote: "within thirty days of the invoice date",
            new: "within forty-five days of receiving a correct invoice",
            rationale: "Our payment cycle is forty-five days.",
          },
        ],
      }),
    );
    expect(applied).toContain("applied");
    expect(applied).not.toContain("FAILED");
  });

  it("signs the customer's side, accepts it, converts back to PDF and to Word again with the content kept", async () => {
    await documents.execute("5", {
      command: "convert",
      path: "sow.pdf",
      output: "outputs/countersign.docx",
    });
    const cells = customerCells(
      text(
        await documents.execute("6", {
          command: "read",
          path: "outputs/countersign.docx",
        }),
      ),
    );
    expect(Object.keys(cells).sort()).toEqual(["By", "Date", "Name", "Title"]);

    const revised = text(
      await documents.execute("7", {
        command: "revise",
        path: "outputs/countersign.docx",
        author: COUNSEL,
        revisions: [
          {
            paragraph: cells.Name,
            text: "Name: Sam Rivera",
            rationale: "Our signatory.",
          },
          {
            paragraph: cells.Title,
            text: "Title: General Counsel",
            rationale: "Our signatory's title.",
          },
          {
            paragraph: cells.Date,
            text: "Date: November 12, 2026",
            rationale: "Date of signature.",
          },
        ],
      }),
    );
    expect(revised).not.toContain("FAILED");
    const marked = text(
      await documents.execute("8", {
        command: "read",
        path: "outputs/countersign.docx",
      }),
    );
    const changes = Number(/(\d+) tracked change\(s\)/.exec(marked)?.[1]);
    expect(changes).toBeGreaterThanOrEqual(3);
    expect(marked).toContain(COUNSEL);
    // Only the customer's cells are marked: Acme's side of the block is untouched.
    expect(marked).not.toContain("row_deletion");
    expect(marked).toMatch(/\[p-\d+\.r3c1\] Name: Jordan Lee\n\[/);

    // Review: accept every change into a clean copy, as the person would before it goes out.
    const accepted = text(
      await documents.execute("9", {
        command: "respond",
        path: "outputs/countersign.docx",
        output: "outputs/countersigned.docx",
        author: COUNSEL,
        // Change numbers start at 0.
        responses: [{ action: "accept", changes: `0-${changes - 1}` }],
      }),
    );
    expect(accepted).not.toContain("FAILED");
    const final = dump("outputs/countersigned.docx");
    expect(final).toEqual(signed(SOURCE));

    // Back to PDF, then to Word again: the same document comes back.
    const pdf = layOut(final, "countersigned");
    await documents.execute("10", {
      command: "convert",
      path: pdf,
      output: "outputs/round-trip.docx",
    });
    const again = dump("outputs/round-trip.docx");
    expect(again).toEqual(final);
    expect(overlap(again, SOURCE)).toBeGreaterThan(0.98);
  });

  it.skipIf(!hasSoffice())(
    "converts a PDF that LibreOffice printed from the Word file back with the content mostly kept",
    async () => {
      await documents.execute("11", {
        command: "convert",
        path: "sow.pdf",
        output: "outputs/office.docx",
      });
      execFileSync(
        "soffice",
        [
          "--headless",
          `-env:UserInstallation=file://${join(cwd, "office-profile")}`,
          "--convert-to",
          "pdf",
          "--outdir",
          cwd,
          join(cwd, "outputs", "office.docx"),
        ],
        { stdio: "ignore", timeout: 120_000 },
      );
      await documents.execute("12", {
        command: "convert",
        path: "office.pdf",
        output: "outputs/office-again.docx",
      });
      // Render both and compare them: the same pages, and most lines broken where the source broke them.
      const source = await pdfLines("sow.pdf");
      const rendered = await pdfLines("office.pdf");
      expect(Math.abs(rendered.length - source.length)).toBeLessThanOrEqual(1);
      const printed = new Set(rendered.flat());
      const kept = source.flat().filter((line) => printed.has(line)).length;
      expect(kept / source.flat().length).toBeGreaterThan(0.8);

      const again = dump("outputs/office-again.docx");
      expect(overlap(again, SOURCE)).toBeGreaterThan(0.97);
      const headings = (blocks: Block[]) =>
        blocks.flatMap((block) =>
          block.type === "heading" ? [block.text] : [],
        );
      expect(headings(again)).toEqual(headings(SOURCE));
      const tables = again.filter((block) => block.type === "table");
      expect(tables).toHaveLength(2);
    },
  );

  it("refuses a scanned page and writes nothing", async () => {
    await expect(
      documents.execute("13", {
        command: "convert",
        path: "scanned.pdf",
        output: "outputs/scanned.docx",
      }),
    ).rejects.toThrow(
      /No text layer on page\(s\) 1 \(a scan\), so convert wrote nothing/,
    );
    expect(existsSync(join(cwd, "outputs", "scanned.docx"))).toBe(false);
  });

  it("writes only a new file under outputs/, in a format that creates, from one that exports", async () => {
    const convert = (output: string, path = "sow.pdf") =>
      documents.execute("14", { command: "convert", path, output });
    await expect(convert("sow.docx")).rejects.toThrow(
      "output must be under outputs/",
    );
    await expect(convert("outputs/sow-copy.pdf")).rejects.toThrow(
      "convert can't write pdf files; it converts to docx",
    );
    await expect(
      convert("outputs/again.docx", "outputs/sow.docx"),
    ).rejects.toThrow("convert can't read docx files; it converts from pdf");
    await expect(convert("outputs/sow.docx")).rejects.toThrow(
      "outputs/sow.docx was already written: convert to a new file",
    );
  });

  it("keeps the values filled into a PDF form, which live in its fields rather than its text", async () => {
    execFileSync(docxPython, [
      join(fixtures, "make_annotated_pdf.py"),
      join(cwd, "form.pdf"),
    ]);
    const result = await documents.execute("18", {
      command: "convert",
      path: "form.pdf",
      output: "outputs/form.docx",
    });
    expect(text(result)).toContain(
      "Set 1 filled form field(s) into the text where the PDF shows them",
    );
    expect(result.details.export).toMatchObject({ form_fields: 1 });
    // The value, in the body's font: not a heading in the field's size, nor its box read as a table.
    expect(dump("outputs/form.docx")).toEqual([
      { type: "paragraph", text: "Clause 1. Fees are due in thirty days." },
      { type: "paragraph", text: "GiantCo Ltd" },
    ]);
  });

  it("keeps a note set beside a ruled table, in reading order", async () => {
    const fees: Block = {
      type: "table",
      rows: [
        ["Service", "Fee"],
        ["Pilot", "$40,000"],
        ["Support", "$9,000"],
      ],
    };
    const pdf = layOut(
      [
        { type: "paragraph", text: "Customer will pay the fees below." },
        {
          ...fees,
          beside: "Note: fees rise with the consumer price index each January.",
        },
        { type: "paragraph", text: "Fees are payable within thirty days." },
      ],
      "beside",
      true,
    );
    await documents.execute("16", {
      command: "convert",
      path: pdf,
      output: "outputs/beside.docx",
    });
    expect(dump("outputs/beside.docx")).toEqual([
      { type: "paragraph", text: "Customer will pay the fees below." },
      fees,
      {
        type: "paragraph",
        text: "Note: fees rise with the consumer price index each January.",
      },
      { type: "paragraph", text: "Fees are payable within thirty days." },
    ]);
  });

  it("keeps a usable page width when there is no body text to measure: only tables, or only headings", async () => {
    const only: Array<[string, Block[]]> = [
      [
        "only-table",
        [
          {
            type: "table",
            rows: [
              ["Service", "Fee"],
              ["Pilot", "$40,000"],
            ],
          },
        ],
      ],
      [
        "only-headings",
        [
          { type: "heading", level: 1, text: "Schedule A" },
          { type: "heading", level: 2, text: "Pricing" },
        ],
      ],
    ];
    for (const [name, blocks] of only) {
      await documents.execute("17", {
        command: "convert",
        path: layOut(blocks, name, true),
        output: `outputs/${name}.docx`,
      });
      const { page } = layoutOf(`outputs/${name}.docx`);
      // The text sits an inch in from each side, as the PDF set it.
      expect(page.left).toBeCloseTo(72, -1);
      expect(page.right).toBeCloseTo(72, -1);
      expect(dump(`outputs/${name}.docx`)).toEqual(blocks);
    }
  });

  it("without the tables extra, still finds tables whose columns line up, and says the extra is missing", async () => {
    const result = await withoutTables.execute("15", {
      command: "convert",
      path: "sow.pdf",
      output: "outputs/no-extra.docx",
    });
    expect(text(result)).toContain(
      "the `tables` extra (pdfplumber) is not installed",
    );
    expect(result.details.export).toMatchObject({ tables_extra: "missing" });
    expect(overlap(dump("outputs/no-extra.docx"), SOURCE)).toBeGreaterThan(
      0.98,
    );
  });
});

function hasSoffice(): boolean {
  try {
    execFileSync("soffice", ["--version"], {
      stdio: "ignore",
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}
