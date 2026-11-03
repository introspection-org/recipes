import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { registerDocumentTools, runDocumentHelper } from "../src/documents/index.js";
import { DocxDocumentAdapter } from "../packages/documents/docx/src/index.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const AUTHOR = "Reviewing Counsel (AgentCo)";
let python = "";
let cwd = "";

type Tool = { execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ text?: string }>; details: any }> };
let documents: Tool;

/** The adapter's locked Python environment (paper-docx), built outside the repo as `uv run` does. */
beforeAll(() => {
  const environment = join(tmpdir(), "recipe-documents-docx-tests-python");
  execFileSync("uv", ["sync", "--frozen", "--quiet", "--project", resolve("packages/documents/docx/python")], {
    env: { ...process.env, UV_PROJECT_ENVIRONMENT: environment },
    stdio: "inherit",
  });
  python = join(environment, "bin", "python");
  cwd = mkdtempSync(join(tmpdir(), "documents-word-"));
  execFileSync(python, [resolve("test/fixtures/documents/make_contract.py"), join(cwd, "contract.docx")]);
  const pi = createMockExtensionAPI();
  registerDocumentTools(pi, [new DocxDocumentAdapter({ runHelper: runDocumentHelper, env: { ...process.env, RECIPE_DOCUMENTS_PYTHON: python } })], { cwd });
  documents = pi.tools.get("documents") as unknown as Tool;
}, 300_000);

const text = (result: { content: Array<{ text?: string }> }) => result.content.at(-1)?.text ?? "";

// Each test starts Python and paper-docx; CI runners take several seconds per call.
describe("docx adapter", { timeout: 30_000 }, () => {
  it("reads paragraphs with stable ids and their current text", async () => {
    const result = text(await documents.execute("1", { command: "read", path: "contract.docx" }));
    expect(result).toContain("0 tracked change(s), 0 comment(s)");
    expect(result).toMatch(/\[p-002\] 2\. Fees\. Customer pays the fees within thirty days of each invoice\./);
  });

  it("round-trips: propose_edits writes a copy with tracked changes and comments by author", async () => {
    const before = statSync(join(cwd, "contract.docx")).mtimeMs;
    const original = readFileSync(join(cwd, "contract.docx"));
    const result = await documents.execute("2", {
      command: "propose_edits",
      path: "contract.docx",
      output: "outputs/redline.docx",
      author: AUTHOR,
      edits: [
        { op: "replace", quote: "lasts thirty days", new: "lasts sixty days", rationale: "We need time to onboard." },
        // a straight apostrophe matches the document's curly one
        { op: "replace", quote: "Provider's liability is unlimited", new: "Provider's liability is capped at the fees paid", rationale: "Uncapped liability doesn't fit a deal this size." },
        // a non-breaking space in the document matches a typed space
        { op: "delete", quote: "at any time on notice", paragraph: "p-004", rationale: "Audits run on a schedule." },
        { op: "insert_after", quote: "the order form", new: " or as a party later designates", rationale: "Addresses change." },
      ],
    });
    expect(result.details).toMatchObject({ applied: 4, failed: 0, output: join("outputs", "redline.docx") });
    expect(text(result)).toContain("Reviewing Counsel (AgentCo): comment: 0 -> 4");
    expect(readFileSync(join(cwd, "contract.docx")).equals(original)).toBe(true);
    expect(statSync(join(cwd, "contract.docx")).mtimeMs).toBe(before);

    const read = text(await documents.execute("3", { command: "read", path: "outputs/redline.docx" }));
    expect(read).toContain("[p-001] 1. Term. This Agreement lasts sixty days from the Effective Date.");
    expect(read).toMatch(/\[\+sixty\+\]\(Reviewing Counsel \(AgentCo\), [0-9-]+\)\s?\[-thirty-\]|\[-thirty-\]\(Reviewing Counsel \(AgentCo\), [0-9-]+\)\s?\[\+sixty\+\]/);
    expect(read).toContain("[comment 0, Reviewing Counsel (AgentCo)");
    expect(read).toContain("## Tracked changes");
    expect(read).toContain("## Comment threads");
    // an unchanged lead-in keeps the document's curly apostrophe
    expect(read).toMatch(/Provider’s liability is \[\+capped at the fees paid\+\]\(Reviewing Counsel \(AgentCo\), [0-9-]+\)\[-unlimited-\]/);
  });

  it("reports an ambiguous or missing anchor with candidates, and still applies the rest", async () => {
    const result = await documents.execute("4", {
      command: "propose_edits",
      path: "outputs/redline.docx",
      author: AUTHOR,
      edits: [
        { op: "replace", quote: "the fees", new: "all fees", rationale: "x" },
        { op: "replace", quote: "Customer pays the fees within thirty dayz", new: "x", rationale: "x" },
        { op: "replace", quote: "thirty days", near: "invoice", new: "forty-five days", rationale: "Cash flow." },
      ],
    });
    const failed = result.details.results.filter((r: any) => r.status === "failed");
    expect(result.details.applied).toBe(1);
    expect(failed.map((r: any) => r.reason)).toEqual(["ambiguous", "not_found"]);
    expect(failed[1].candidates[0].paragraph).toBe("p-002");
    expect(text(result)).toContain("closest: [p-002]");
  });

  it("ignores a quoted list number and says so", async () => {
    const result = await documents.execute("5", {
      command: "propose_edits",
      path: "outputs/redline.docx",
      author: AUTHOR,
      edits: [{ op: "replace", quote: "5. Notices go to", new: "Notices are sent to", rationale: "Clearer." }],
    });
    expect(result.details.results[0]).toMatchObject({ status: "applied", note: expect.stringContaining("list number") });
  });

  it("keeps a capitalization change, and refuses a change in typography alone", async () => {
    const result = await documents.execute("5b", {
      command: "propose_edits",
      path: "outputs/redline.docx",
      author: AUTHOR,
      edits: [
        // a defined term: the capital letter is the change
        { op: "replace", quote: "Customer pays the fees", new: "Customer pays the Fees", rationale: "Fees is a defined term." },
        { op: "replace", quote: "the order form", new: "the Order Form", rationale: "Order Form is a defined term." },
        // only the apostrophe differs from the document's curly one
        { op: "replace", quote: "Provider\u2019s liability is capped", new: "Provider's liability is capped", rationale: "x" },
      ],
    });
    const statuses = result.details.results.map((r: any) => r.status);
    expect(statuses).toEqual(["applied", "applied", "failed"]);
    expect(result.details.results[2].reason).toBe("no_change");
    const read = text(await documents.execute("5c", { command: "read", path: "outputs/redline.docx" }));
    expect(read).toMatch(/\[\+Fees\+\]\(Reviewing Counsel \(AgentCo\), [0-9-]+\)\s?\[-fees-\]|\[-fees-\]\(Reviewing Counsel \(AgentCo\), [0-9-]+\)\s?\[\+Fees\+\]/);
    expect(read).toMatch(/\[\+Order Form\+\]|\[\+Order\+\]/);
  });

  it("absorbs the library's refusals: ambiguous alignment, bookmarks, proofing marks, tabs and no-break hyphens", async () => {
    // Both refusals reproduce with paper-docx called directly on the whole quote.
    const direct = (quote: string, replacement: string) =>
      execFileSync(python, ["-c", [
        "import sys, docx",
        "from docx.search import find_text",
        "d = docx.Document(sys.argv[1])",
        "s = find_text(d, sys.argv[2])[0]",
        "try:\n    s.replace(sys.argv[3], tracked=True, author='x'); print('ok')",
        "except Exception as e:\n    print(type(e).__name__, e)",
      ].join("\n"), join(cwd, "contract.docx"), quote, replacement], { encoding: "utf8" });
    expect(direct("Each payment is due", "Each payment is not due")).toContain("exact affix alignment is ambiguous");
    expect(direct("keeps records for", "holds books for")).toContain("crosses bookmark");
    expect(direct("inspects the premises yearly", "reviews the site quarterly")).toContain("crosses a positional marker");
    expect(direct("9.\tConfidentiality", "10. Secrecy")).toContain("crosses a tab");
    expect(direct("Non-Party keeps all", "Third-Parties keeps all")).toContain("no-break hyphen");
    expect(direct("survive termination of this", "continue after expiry of this")).toContain("non-text run node");
    const result = await documents.execute("5b", {
      command: "propose_edits",
      path: "contract.docx",
      output: "outputs/refusals.docx",
      author: AUTHOR,
      edits: [
        { op: "replace", quote: "Each payment is due", paragraph: "p-006", new: "Each payment is not due", rationale: "Payment follows acceptance." },
        { op: "replace", quote: "keeps records for", paragraph: "p-007", new: "holds books for", rationale: "Books is the term we use." },
        { op: "replace", quote: "inspects the premises yearly", paragraph: "p-008", new: "reviews the site quarterly", rationale: "Quarterly reviews fit the risk." },
        // the agent types a space where the document has a tab
        { op: "replace", quote: "9. Confidentiality", paragraph: "p-009", new: "10. Secrecy", rationale: "Renumbered." },
        { op: "replace", quote: "Non-Party keeps all", paragraph: "p-009", new: "Third-Parties keeps all", rationale: "Defined term." },
        { op: "replace", quote: "survive termination of this", paragraph: "p-010", new: "continue after expiry of this", rationale: "Expiry is the trigger here." },
      ],
    });
    expect(result.details.results.map((r: any) => [r.status, r.reason ?? ""])).toEqual(Array(6).fill(["applied", ""]));
    const read = text(await documents.execute("5c", { command: "read", path: "outputs/refusals.docx" }));
    expect(read).toContain("[p-006] 6. Payment. Each payment is not due on the payment date stated in the order.");
    expect(read).toContain("[p-007] 7. Records. Provider holds books for three years after termination.");
    expect(read).toContain("[p-008] 8. Inspections. Customer reviews the site quarterly.");
    // the tab and the no-break hyphen stay as they were
    expect(read).toContain("[p-009] 10.\tSecrecy. The Third-Parties keeps all information secret.");
    expect(read).toContain("[p-010] 10. Survival. Sections 3 and 4 continue after expiry of this Agreement.");
  });

  it("splits new text across a tab at the tab, and refuses when spaces leave its place unclear", async () => {
    const result = await documents.execute("5t", {
      command: "propose_edits",
      path: "contract.docx",
      output: "outputs/tab.docx",
      author: AUTHOR,
      edits: [{ op: "replace", quote: "9.\tConfidentiality", paragraph: "p-009", new: "Clause nine\tSecret terms", rationale: "x" }],
    });
    expect(result.details.results[0]).toMatchObject({ status: "applied" });
    expect(text(await documents.execute("5u", { command: "read", path: "outputs/tab.docx" }))).toContain("[p-009] Clause nine\tSecret terms. The");
    const unclear = await documents.execute("5v", {
      command: "propose_edits",
      path: "contract.docx",
      output: "outputs/tab-unclear.docx",
      author: AUTHOR,
      edits: [{ op: "replace", quote: "9. Confidentiality", paragraph: "p-009", new: "Clause nine Secret terms", rationale: "x" }],
    });
    expect(unclear.details.results[0]).toMatchObject({ status: "failed", reason: "crosses_marker" });
    expect(unclear.details.results[0].message).toContain("doesn't show where it goes");
  });

  it("reports a change across a no-break hyphen with nothing to keep on its far side as crosses_marker", async () => {
    const result = await documents.execute("5d", {
      command: "propose_edits",
      path: "contract.docx",
      output: "outputs/hyphen.docx",
      author: AUTHOR,
      edits: [{ op: "replace", quote: "The Non-Party keeps", paragraph: "p-009", new: "The Recipient keeps", rationale: "x" }],
    });
    expect(result.details.results[0]).toMatchObject({ status: "failed", reason: "crosses_marker" });
    expect(result.details.results[0].message).toContain("no-break hyphen");
  });

  it("revise redlines whole paragraphs without quoting: compare on a clean file, comment on the changed text", async () => {
    const result = await documents.execute("r1", {
      command: "revise",
      path: "contract.docx",
      output: "outputs/revised.docx",
      author: AUTHOR,
      revisions: [
        { paragraph: "p-001", text: "1. Term. This Agreement lasts sixty days from the Effective Date.", rationale: "We need time to onboard." },
        { paragraph: "p-003", text: "3. Liability. Provider's liability is capped at the fees paid for any claim.", rationale: "A cap fits the deal." },
        { paragraph: "p-004", text: "4. Audit. Customer may audit Provider once a year.", rationale: "Audits run on a schedule." },
        { paragraph: "p-999", text: "x", rationale: "x" },
        { paragraph: "p-005", text: "5. Notices. Notices go to the addresses on the order form.", rationale: "x" },
      ],
    });
    const statuses = result.details.results.map((r: any) => [r.status, r.via ?? r.reason]);
    // paper-docx's compare adds empty paragraphs for this multi-paragraph batch; ids must not
    // move, so the batch takes the tracked path
    expect(statuses.slice(0, 3)).toEqual(Array(3).fill(["applied", "tracked"]));
    expect(result.details.results[0].note).toContain("compare changed the paragraph structure");
    // an unchanged paragraph becomes a comment on it
    expect(statuses.slice(3)).toEqual([["failed", "paragraph_not_found"], ["applied", "comment"]]);
    const read = text(await documents.execute("r2", { command: "read", path: "outputs/revised.docx" }));
    expect(read).toContain("[p-001] 1. Term. This Agreement lasts sixty days from the Effective Date.");
    expect(read).toContain("[p-004] 4. Audit. Customer may audit Provider once a year.");
    // the unchanged curly apostrophe stays; only the changed words are marked
    expect(read).toContain("3. Liability. Provider’s liability is capped at the fees paid for any claim.");
    expect(read).toMatch(/\[comment \d+, Reviewing Counsel \(AgentCo\)[^\]]*: We need time to onboard\.\]/);
    expect(text(result)).toContain("Reviewing Counsel (AgentCo): comment: 0 -> 4");
  });

  it("revise uses paper-docx compare for a clean file when the redline keeps the paragraph structure", async () => {
    const result = await documents.execute("r0", {
      command: "revise",
      path: "contract.docx",
      output: "outputs/compared.docx",
      author: AUTHOR,
      revisions: [{ paragraph: "p-001", text: "1. Term. This Agreement lasts sixty days from the Effective Date.", rationale: "Onboarding." }],
    });
    expect(result.details.results[0]).toMatchObject({ status: "applied", via: "compare" });
    const read = text(await documents.execute("r0b", { command: "read", path: "outputs/compared.docx" }));
    expect(read).toContain("[p-002] 2. Fees.");
    expect(read).toMatch(/: Onboarding\.\]/);
  });

  it("revise reports a missing rationale on that revision alone", async () => {
    const result = await documents.execute("r5", {
      command: "revise",
      path: "contract.docx",
      output: "outputs/norationale.docx",
      author: AUTHOR,
      revisions: [
        { paragraph: "p-001", text: "1. Term. This Agreement lasts sixty days from the Effective Date." },
        { paragraph: "p-002", text: "2. Fees. Customer pays the fees within forty-five days of each invoice.", rationale: "Cash flow." },
      ],
    });
    expect(result.details.results.map((r: any) => [r.status, r.reason ?? r.via])).toEqual([
      ["failed", "invalid_revision"],
      ["applied", "compare"],
    ]);
  });

  it("revise on a file that already has changes applies targeted tracked edits and says so", async () => {
    const result = await documents.execute("r3", {
      command: "revise",
      path: "outputs/revised.docx",
      author: AUTHOR,
      revisions: [
        { paragraph: "p-002", text: "2. Fees. Customer pays the fees within forty-five days of each invoice.", rationale: "Cash flow." },
        // an appended sentence ending like its anchor, and a case-only change
        { paragraph: "p-005", text: "5. Notices. notices go to the addresses on the order form. Email notices count.", rationale: "Email is how we work." },
      ],
    });
    expect(result.details.results.map((r: any) => [r.status, r.via])).toEqual([["applied", "tracked"], ["applied", "tracked"]]);
    const read = text(await documents.execute("r4", { command: "read", path: "outputs/revised.docx" }));
    expect(read).toContain("[p-002] 2. Fees. Customer pays the fees within forty-five days of each invoice.");
    expect(read).toContain("[p-005] 5. Notices. notices go to the addresses on the order form. Email notices count.");
  });

  it("comments, replies on a thread, and responds: accept, reject and counter", async () => {
    await documents.execute("6", { command: "comment", path: "outputs/redline.docx", output: "outputs/turn2.docx", author: "Counterparty (Customer)", thread: 0, text: "Thirty is standard." });
    const respond = await documents.execute("7", {
      command: "respond",
      path: "outputs/turn2.docx",
      author: "Counterparty (Customer)",
      responses: [
        { action: "accept", changes: "0" },
        { action: "reject", changes: "1" },
        { action: "counter", quote: "capped at the fees paid", new: "capped at twice the fees paid", rationale: "Twice the fees covers our exposure.", thread: 1 },
        { action: "reply", thread: 2, text: "Agreed." },
        { action: "accept", changes: "999" },
      ],
    });
    expect(respond.details.results.map((r: any) => r.status)).toEqual(["applied", "applied", "applied", "applied", "failed"]);
    const read = text(await documents.execute("8", { command: "read", path: "outputs/turn2.docx" }));
    expect(read).toContain("Counterparty (Customer)");
    expect(read).toMatch(/0, Reviewing Counsel \(AgentCo\).*\n\s+\d+, Counterparty \(Customer\).*Thirty is standard\./);
  });

  it("pages the tracked-change and comment listings under the read budget", async () => {
    const reply = (n: number) => `Reply ${n}: we need a longer notice period here because our onboarding plan depends on it, and the pilot's training schedule, data migration and security review each take weeks we can't compress.`;
    await documents.execute("p0", { command: "comment", path: "outputs/redline.docx", output: "outputs/long.docx", author: AUTHOR, thread: 0, text: reply(0) });
    for (let n = 1; n < 16; n++) {
      await documents.execute(`p${n}`, { command: "comment", path: "outputs/long.docx", author: AUTHOR, thread: 0, text: reply(n) });
    }
    const parts: string[] = [];
    let offset: number | undefined = 0;
    for (let guard = 0; offset !== undefined && offset !== null && guard < 20; guard++) {
      const part = await documents.execute(`r${guard}`, { command: "read", path: "outputs/long.docx", budget: 2000, offset });
      parts.push(text(part));
      offset = part.details.next_offset ?? undefined;
    }
    expect(parts.length).toBeGreaterThan(1);
    const longest = Math.max(...Array.from({ length: 16 }, (_, n) => reply(n).length)) + 200;
    // A part may exceed the budget only when it holds a single paragraph, which is never split.
    const entries = (part: string) => part.split("\n").filter((line) => /^\[p-/.test(line) || /^\s+\d+, /.test(line) || /^\d+(-\d+)? /.test(line));
    for (const part of parts) {
      if (part.length > 2000 + longest) expect(entries(part).filter((line) => line.startsWith("[p-"))).toHaveLength(1);
    }
    // The listings themselves come in bounded parts.
    for (const part of parts.filter((p) => !/^\[p-/m.test(p))) expect(part.length).toBeLessThanOrEqual(2000 + longest);
    const all = parts.join("\n");
    for (let n = 0; n < 16; n++) expect(all.split(reply(n)).length - 1).toBe(1);
    expect(all).toContain("## Comment threads");
  }, 60_000);

  it("respond applies each accept or reject whole or not at all, and the rest of the batch still runs", async () => {
    const count = (read: string) => Number(/(\d+) tracked change\(s\)/.exec(read)?.[1]);
    const before = count(text(await documents.execute("a1", { command: "read", path: "outputs/redline.docx" })));
    const refused = await documents.execute("a2", {
      command: "respond",
      path: "outputs/redline.docx",
      output: "outputs/atomic-refused.docx",
      author: "Counterparty (Customer)",
      responses: [{ action: "accept", changes: "0,999" }],
    });
    expect(refused.details.results[0]).toMatchObject({ status: "failed", reason: "change_not_found" });
    expect(refused.details.results[0].message).toContain("there is no change 999");
    expect(refused.details.results[0].message).toContain("None of this response was applied");
    expect(text(refused)).toContain("take them from a fresh read of the saved file");
    expect(text(refused)).not.toMatch(/Resubmit only the failed response\(s\), with path set to the saved file\.$/m);
    expect(count(text(await documents.execute("a3", { command: "read", path: "outputs/atomic-refused.docx" })))).toBe(before);

    // A range that ends before it starts selects nothing: refused whole, not reported as applied.
    const descending = await documents.execute("a3b", {
      command: "respond",
      path: "outputs/redline.docx",
      output: "outputs/atomic-descending.docx",
      author: "Counterparty (Customer)",
      responses: [{ action: "accept", changes: "2-0" }, { action: "reject", changes: "0,2-1" }],
    });
    expect(descending.details.results.map((r: any) => r.reason)).toEqual(["invalid_changes", "invalid_changes"]);
    expect(descending.details.results[0].message).toContain("ends before it starts");
    expect(count(text(await documents.execute("a3c", { command: "read", path: "outputs/atomic-descending.docx" })))).toBe(before);

    const mixed = await documents.execute("a4", {
      command: "respond",
      path: "outputs/redline.docx",
      output: "outputs/atomic-mixed.docx",
      author: "Counterparty (Customer)",
      responses: [
        { action: "accept", changes: "0,999" },
        { action: "accept", changes: "0" },
        { action: "reject", changes: "1" },
      ],
    });
    expect(mixed.details.results.map((r: any) => r.status)).toEqual(["failed", "applied", "applied"]);
    expect(count(text(await documents.execute("a5", { command: "read", path: "outputs/atomic-mixed.docx" })))).toBe(before - 2);
  });

  it("reads a table nested in a table cell once, so a quote there is unambiguous and a section strikes it once", async () => {
    execFileSync(python, ["-c", [
      "import sys, docx",
      "d = docx.Document()",
      "d.add_paragraph('7. Schedule. The rates below apply.')",
      "outer = d.add_table(rows=1, cols=1)",
      "outer.cell(0, 0).paragraphs[0].text = 'Outer cell.'",
      "inner = outer.cell(0, 0).add_table(rows=1, cols=1)",
      "inner.cell(0, 0).paragraphs[0].text = 'Nested rate is ten dollars.'",
      "d.add_paragraph('8. Law. New York law governs.')",
      "d.save(sys.argv[1])",
    ].join("\n"), join(cwd, "nested.docx")]);
    const read = text(await documents.execute("n1", { command: "read", path: "nested.docx" }));
    expect(read.match(/Nested rate is ten dollars\./g)).toHaveLength(1);
    expect(read).toContain("[p-001.r1c1] Outer cell.");
    expect(read).toContain("[p-001.r1c1.2] Nested rate is ten dollars.");
    expect(read).toContain("[p-002] 8. Law. New York law governs.");

    const edit = await documents.execute("n2", {
      command: "propose_edits",
      path: "nested.docx",
      output: "outputs/nested-edit.docx",
      author: AUTHOR,
      edits: [{ op: "replace", quote: "ten dollars", new: "twelve dollars", rationale: "Rates rose." }],
    });
    expect(edit.details.results[0]).toMatchObject({ status: "applied", paragraph: "p-001.r1c1.2" });

    const removed = await documents.execute("n3", {
      command: "remove_section",
      path: "nested.docx",
      output: "outputs/nested-reserved.docx",
      author: AUTHOR,
      from: "p-000",
      through: "p-002",
      keep: "7. Schedule.",
      rationale: "The schedule moves to the order form.",
    });
    expect(removed.details.results[0]).toMatchObject({ status: "applied" });
    expect(removed.details.results[0].change).toContain("4 paragraph(s) struck");
    const after = text(await documents.execute("n4", { command: "read", path: "outputs/nested-reserved.docx" }));
    expect(after).toContain("[p-000] 7. Schedule. Reserved.");
    expect(after).toContain("5 tracked change(s)");
    expect(after.match(/\[-Nested rate is ten dollars\.-\]/g)).toHaveLength(1);
  });

  it("removes a section as tracked changes, leaving Reserved. after the kept heading", async () => {
    const result = await documents.execute("9", {
      command: "remove_section",
      path: "contract.docx",
      output: "outputs/reserved.docx",
      author: AUTHOR,
      from: "p-004",
      through: "p-004",
      keep: "4. Audit.",
      rationale: "Audits don't fit a hosted service.",
    });
    expect(result.details.applied).toBe(1);
    const read = text(await documents.execute("10", { command: "read", path: "outputs/reserved.docx" }));
    expect(read).toContain("[p-004] 4. Audit. Reserved.");
    expect(existsSync(join(cwd, "outputs", "reserved.docx"))).toBe(true);
  });

  it("reads every paragraph of a block-level content control, and edits one inside it", async () => {
    execFileSync(python, ["-c", [
      "import sys, docx",
      "from docx.oxml import OxmlElement",
      "d = docx.Document()",
      "d.add_paragraph('1. Scope. Provider runs the service.')",
      "sdt = OxmlElement('w:sdt'); sdt.append(OxmlElement('w:sdtPr')); content = OxmlElement('w:sdtContent'); sdt.append(content)",
      "for line in ('2. Warranty. Provider warrants the service for ninety days.', '3. Remedy. Provider repairs or refunds.', '4. Exclusions. Misuse voids the warranty.'):",
      "    content.append(d.add_paragraph(line)._p)",
      "d.element.body.insert(1, sdt)",
      "d.add_paragraph('5. Law. New York law governs.')",
      "d.save(sys.argv[1])",
    ].join("\n"), join(cwd, "control.docx")]);
    const read = text(await documents.execute("11", { command: "read", path: "control.docx" }));
    expect(read).toContain("[p-001] 2. Warranty. Provider warrants the service for ninety days.");
    expect(read).toContain("[p-001.2] 3. Remedy. Provider repairs or refunds.");
    expect(read).toContain("[p-001.3] 4. Exclusions. Misuse voids the warranty.");
    expect(read).toContain("[p-002] 5. Law. New York law governs.");
    const result = await documents.execute("12", {
      command: "propose_edits",
      path: "control.docx",
      output: "outputs/control.docx",
      author: AUTHOR,
      edits: [{ op: "replace", quote: "repairs or refunds", paragraph: "p-001.2", new: "repairs, replaces or refunds", rationale: "Replacement is often fastest." }],
    });
    expect(result.details.results[0]).toMatchObject({ status: "applied", paragraph: "p-001.2" });
    const after = text(await documents.execute("13", { command: "read", path: "outputs/control.docx" }));
    expect(after).toContain("[p-001.2] 3. Remedy. Provider repairs, replaces or refunds.");
    expect(after).toContain("[p-001.3] 4. Exclusions. Misuse voids the warranty.");
  });
});
