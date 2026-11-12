import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { autoResolveInteractions } from "../src/interactions.js";
import {
  readPiPackageManifest,
  validatePiPackageManifest,
} from "../src/recipe/package.js";
import {
  docxParagraphs,
  docxReadiness,
  prepareDocx,
  zipParts,
} from "../src/signature/docx.js";
import {
  createSignatureTool,
  loadRecipeSignature,
  registerSignatureTool,
  sendBinding,
  SIGNATURE_FIRST_PARTY_OPTIONS,
  SIGNATURE_SEND_APPROVAL_KIND,
  signatureParameters,
  voidBinding,
  type ProviderSignatureRequest,
  type RecipeSignatureProviderModule,
  type SignatureSendArgs,
  type SignatureToolArgs,
} from "../src/signature/index.js";
import { docusignSignatureProvider } from "../packages/signature/src/index.js";

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text: string) =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const tc = (...paragraphs: string[]) =>
  `<w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr>${paragraphs.join("")}</w:tc>`;
const tr = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;
const tbl = (...rows: string[]) =>
  `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:insideH w:val="single"/></w:tblBorders></w:tblPr>${rows.join("")}</w:tbl>`;

function docx(body: string, parts: Record<string, string> = {}): Uint8Array {
  return zipParts({
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
    ...parts,
  });
}

/** The two-column block a redline fills in: one party per column, one line per row. */
const TWO_COLUMNS = tbl(
  tr(tc(p("ACME, INC.")), tc(p("EXAMPLE CORP."))),
  tr(tc(p("By:")), tc(p("By:"))),
  tr(tc(p("Name: Alex Acme")), tc(p("Name: Jane Doe"))),
  tr(tc(p("Title: Chief Executive")), tc(p("Title: Operations Lead"))),
  tr(tc(p("Date:")), tc(p("Date:"))),
);

const CONTRACT = docx(
  `${p("1. Services. Acme provides the services.")}${TWO_COLUMNS}`,
);

describe("docx readiness", () => {
  it("counts tracked changes in every content part and every comment", () => {
    expect(docxReadiness(CONTRACT)).toEqual({ trackedChanges: 0, comments: 0 });
    const marked = docx(
      `<w:p><w:ins w:id="1" w:author="Acme"><w:r><w:t>new</w:t></w:r></w:ins><w:del w:id="2" w:author="Acme"><w:r><w:delText>old</w:delText></w:r></w:del><w:r><w:rPr><w:rPrChange w:id="3" w:author="Acme"/></w:rPr><w:commentReference w:id="0"/></w:r></w:p>`,
      {
        "word/header1.xml": `<w:hdr ${W}><w:p><w:moveTo w:id="4"><w:r><w:t>x</w:t></w:r></w:moveTo></w:p></w:hdr>`,
        "word/comments.xml": `<w:comments ${W}><w:comment w:id="0" w:author="Acme"><w:p/></w:comment></w:comments>`,
      },
    );
    expect(docxReadiness(marked)).toEqual({ trackedChanges: 4, comments: 1 });
  });

  it("does not mistake table borders or range marks for changes", () => {
    const clean = docx(
      `${tbl(tr(tc(p("a"))))}<w:p><w:moveFromRangeStart w:id="1"/><w:r><w:t>x</w:t></w:r></w:p>`,
    );
    expect(docxReadiness(clean).trackedChanges).toBe(0);
  });

  it("refuses a document with pending changes or comments, naming what is left", () => {
    const resolvedComment = docx(TWO_COLUMNS, {
      "word/comments.xml": `<w:comments ${W}><w:comment w:id="0"/><w:comment w:id="1"/></w:comments>`,
    });
    expect(() => prepareDocx(resolvedComment, [{ name: "Jane Doe" }])).toThrow(
      /still has 2 comments/,
    );
  });
});

describe("signature anchors", () => {
  it("anchors each signer on their own column's By: and Date: lines", () => {
    const prepared = prepareDocx(CONTRACT, [
      { name: "Jane Doe" },
      { name: "Alex Acme" },
    ]);
    expect(prepared.placements).toEqual([
      { sign: "\\s1\\", date: "\\d1\\" },
      { sign: "\\s2\\", date: "\\d2\\" },
    ]);
    expect(docxParagraphs(prepared.bytes)).toEqual([
      "1. Services. Acme provides the services.",
      "ACME, INC.",
      "EXAMPLE CORP.",
      "By:\\s2\\",
      "By:\\s1\\",
      "Name: Alex Acme",
      "Name: Jane Doe",
      "Title: Chief Executive",
      "Title: Operations Lead",
      "Date:\\d2\\",
      "Date:\\d1\\",
    ]);
    // The anchors are invisible: white, 1-point text.
    const xml = new TextDecoder().decode(prepared.bytes);
    expect(xml).not.toContain("\\s1\\"); // compressed in the copy
    expect(docxReadiness(prepared.bytes)).toEqual({
      trackedChanges: 0,
      comments: 0,
    });
  });

  it("finds the lines in one cell holding the whole block", () => {
    const block = docx(
      tbl(
        tr(
          tc(p("ACME, INC."), p("By: "), p("Name: Alex Acme"), p("Date:")),
          tc(p("EXAMPLE CORP."), p("By:"), p("Name:  jane   DOE")),
        ),
      ),
    );
    const prepared = prepareDocx(block, [{ name: "Jane Doe" }]);
    expect(prepared.placements).toEqual([{ sign: "\\s1\\" }]);
    expect(docxParagraphs(prepared.bytes)).toContain("By:\\s1\\");
    expect(docxParagraphs(prepared.bytes)).toContain("By: ");
  });

  it("places the anchor after the label's run, not after the signature line", () => {
    const split = docx(
      tbl(
        tr(
          tc(
            `<w:p><w:r><w:t>By:</w:t></w:r><w:r><w:t>_________</w:t></w:r></w:p>`,
          ),
        ),
        tr(tc(p("Name: Jane Doe"))),
      ),
    );
    expect(
      docxParagraphs(prepareDocx(split, [{ name: "Jane Doe" }]).bytes),
    ).toContain("By:\\s1\\_________");
  });

  it("splits a run holding the label and its line, so the field starts at the colon", () => {
    const joined = docx(
      tbl(tr(tc(p("By: _________"))), tr(tc(p("Name: Jane Doe")))),
    );
    const paragraphs = docxParagraphs(
      prepareDocx(joined, [{ name: "Jane Doe" }]).bytes,
    );
    expect(paragraphs).toContain("By:\\s1\\ _________");
  });

  it("refuses a signer with no Name: line, one on two lines, or no By: line", () => {
    expect(() => prepareDocx(CONTRACT, [{ name: "Sam Other" }])).toThrow(
      expect.objectContaining({ code: "anchor_not_found" }),
    );
    const twice = docx(
      `${TWO_COLUMNS}${tbl(tr(tc(p("By:"))), tr(tc(p("Name: Jane Doe"))))}`,
    );
    expect(() => prepareDocx(twice, [{ name: "Jane Doe" }])).toThrow(
      expect.objectContaining({ code: "ambiguous" }),
    );
    const noBy = docx(tbl(tr(tc(p("Name: Jane Doe")))));
    expect(() => prepareDocx(noBy, [{ name: "Jane Doe" }])).toThrow(
      expect.objectContaining({ code: "anchor_not_found" }),
    );
  });

  it("refuses a file that is not a Word document", () => {
    expect(() =>
      prepareDocx(new TextEncoder().encode("%PDF-1.7"), [{ name: "x" }]),
    ).toThrow(expect.objectContaining({ code: "not_ready" }));
  });
});

// ---------------------------------------------------------------------------

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "signature-")));
  scratch.push(dir);
  mkdirSync(join(dir, "outputs"));
  writeFileSync(join(dir, "outputs", "acme-msa.docx"), CONTRACT);
  return dir;
}

const ENVELOPE_ID = "6f1c2a8e-1b2c-4d3e-8f90-1234567890ab";

/** A provider that keeps one request in memory and records what it was asked. */
function fakeProvider(
  overrides: Partial<RecipeSignatureProviderModule["capabilities"]> = {},
) {
  const sent: SignatureSendArgs[] = [];
  const voided: string[] = [];
  let reads = 0;
  let status: ProviderSignatureRequest["status"] = "sent";
  const answer = (): ProviderSignatureRequest => ({
    ref: ENVELOPE_ID,
    status,
    recipients: [
      {
        name: "Jane Doe",
        email: "jane@example.com",
        role: "signer",
        order: 1,
        status: status === "completed" ? "signed" : "sent",
      },
    ],
  });
  const module: RecipeSignatureProviderModule = {
    kind: "signature",
    apiVersion: 2,
    id: "docusign",
    capabilities: {
      commands: ["send", "status", "void"],
      extensions: ["docx"],
      document: ["link", "upload"],
      status_interval_seconds: 900,
      hosts: ["demo.docusign.net"],
      options: {},
      ...overrides,
    },
    createSession: () => ({
      async send(args) {
        sent.push(args);
        return answer();
      },
      async status() {
        reads += 1;
        return answer();
      },
      async void({ ref }) {
        voided.push(ref);
        status = "voided";
        return answer();
      },
    }),
  };
  return {
    module,
    sent,
    voided,
    reads: () => reads,
    complete: () => {
      status = "completed";
    },
  };
}

const PREPARE: SignatureToolArgs = {
  command: "prepare",
  path: "outputs/acme-msa.docx",
  subject: "Acme MSA for signature",
  signers: [{ name: "Jane Doe", email: "jane@example.com" }],
  cc: [{ name: "Legal", email: "legal@example.com", order: 2 }],
};

const approveAll = async () => ({ type: "approved" as const });

function toolFor(
  fake: ReturnType<typeof fakeProvider>,
  cwd: string,
  extra: Partial<Parameters<typeof createSignatureTool>[0]> = {},
) {
  return createSignatureTool({
    provider: {
      module: fake.module,
      config: { provider: "docusign", options: {} },
    },
    cwd,
    ...extra,
  });
}

describe("signature prepare", () => {
  it("keeps a draft in the host and calls no provider", async () => {
    const fake = fakeProvider();
    const tool = toolFor(fake, workspace());
    const result = await tool(PREPARE);
    expect(result.command).toBe("prepare");
    expect(result.request).toMatchObject({
      status: "draft",
      provider: "docusign",
      subject: "Acme MSA for signature",
      document: {
        name: "acme-msa.docx",
        sha256: createHash("sha256").update(CONTRACT).digest("hex"),
      },
    });
    expect(result.request.handle).toMatch(/^sig_[\w-]+$/);
    expect(result.request.recipients.map((r) => r.status)).toEqual([
      "pending",
      "pending",
    ]);
    expect(fake.sent).toEqual([]);
  });

  it("refuses anything but a .docx under outputs/, before any request", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "original.docx"), CONTRACT);
    writeFileSync(join(cwd, "outputs", "brief.pdf"), "%PDF-1.7");
    symlinkSync(join(cwd, "original.docx"), join(cwd, "outputs", "link.docx"));
    writeFileSync(
      join(cwd, "outputs", "marked.docx"),
      docx(
        `<w:p><w:ins w:id="1"><w:r><w:t>x</w:t></w:r></w:ins></w:p>${TWO_COLUMNS}`,
      ),
    );
    const fake = fakeProvider();
    const tool = toolFor(fake, cwd);
    for (const [path, code] of [
      ["original.docx", "not_ready"],
      ["outputs/link.docx", "not_ready"],
      ["outputs/brief.pdf", "not_ready"],
      ["outputs/marked.docx", "not_ready"],
      ["outputs/missing.docx", "invalid_request"],
    ] as const)
      await expect(tool({ ...PREPARE, path })).rejects.toMatchObject({
        signature: { code },
      });
    await expect(
      tool({
        ...PREPARE,
        signers: [{ name: "Jane Doe", email: "not-an-email" }],
      }),
    ).rejects.toMatchObject({ signature: { code: "invalid_request" } });
    await expect(
      tool({
        ...PREPARE,
        cc: [{ name: "Jane again", email: "JANE@example.com" }],
      }),
    ).rejects.toMatchObject({ signature: { code: "invalid_request" } });
    expect(fake.sent).toEqual([]);
  });
});

describe("signature send", () => {
  it("uploads the marked copy with the reviewed file's digest once approved", async () => {
    const fake = fakeProvider();
    const tool = toolFor(fake, workspace());
    const { request } = await tool(PREPARE);
    const result = await tool(
      { command: "send", request: request.handle },
      { approve: approveAll },
    );
    expect(result).toMatchObject({
      command: "send",
      done: true,
      request: { status: "sent" },
    });
    const [args] = fake.sent;
    expect(args!.document.url).toBeUndefined();
    expect(args!.document.sha256).toBe(request.document.sha256);
    expect(docxParagraphs(args!.document.bytes)).toContain("By:\\s1\\");
    expect(args!.signers).toEqual([
      {
        name: "Jane Doe",
        email: "jane@example.com",
        order: 1,
        placement: { sign: "\\s1\\", date: "\\d1\\" },
      },
    ]);
    expect(args!.cc).toEqual([
      { name: "Legal", email: "legal@example.com", order: 2 },
    ]);
    await expect(
      tool(
        { command: "send", request: request.handle },
        { approve: approveAll },
      ),
    ).rejects.toMatchObject({ signature: { code: "invalid_request" } });
    expect(fake.sent).toHaveLength(1);
  });

  it("passes a short-lived signed link when the host issues one, minted only after approval", async () => {
    const fake = fakeProvider();
    const published: Uint8Array[] = [];
    const now = new Date("2026-11-12T05:00:00Z");
    const tool = toolFor(fake, workspace(), {
      now: () => now,
      publishDocument: async (bytes) => {
        published.push(bytes);
        return {
          url: "https://files.acme.test/signed/abc",
          expires_at: new Date(now.getTime() + 5 * 60_000).toISOString(),
        };
      },
    });
    const { request } = await tool(PREPARE);
    await tool(
      { command: "send", request: request.handle },
      { approve: async () => ({ type: "pending", result: {} as never }) },
    );
    expect(published).toEqual([]);
    const result = await tool(
      { command: "send", request: request.handle },
      { approve: approveAll },
    );
    expect(published).toHaveLength(1);
    expect(fake.sent[0]!.document.url).toBe(
      "https://files.acme.test/signed/abc",
    );
    expect(JSON.stringify(result)).not.toContain("files.acme.test");
  });

  it("refuses a link that lives longer than ten minutes, and a link-only provider without one", async () => {
    const now = new Date("2026-11-12T05:00:00Z");
    const fake = fakeProvider();
    const tool = toolFor(fake, workspace(), {
      now: () => now,
      publishDocument: async () => ({
        url: "https://files.acme.test/signed/abc",
        expires_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
      }),
    });
    const { request } = await tool(PREPARE);
    await expect(
      tool(
        { command: "send", request: request.handle },
        { approve: approveAll },
      ),
    ).rejects.toMatchObject({ signature: { code: "invalid_request" } });
    const linkOnly = fakeProvider({ document: ["link"] });
    const plain = toolFor(linkOnly, workspace());
    const draft = await plain(PREPARE);
    await expect(
      plain(
        { command: "send", request: draft.request.handle },
        { approve: approveAll },
      ),
    ).rejects.toMatchObject({ signature: { code: "invalid_request" } });
    expect([...fake.sent, ...linkOnly.sent]).toEqual([]);
  });

  it("refuses a file that changed after prepare", async () => {
    const cwd = workspace();
    const fake = fakeProvider();
    const tool = toolFor(fake, cwd);
    const { request } = await tool(PREPARE);
    writeFileSync(
      join(cwd, "outputs", "acme-msa.docx"),
      docx(TWO_COLUMNS + p("New clause")),
    );
    await expect(
      tool(
        { command: "send", request: request.handle },
        { approve: approveAll },
      ),
    ).rejects.toMatchObject({ signature: { code: "changed" } });
    expect(fake.sent).toEqual([]);
  });

  it("refuses without a way to ask, and a handle it did not mint", async () => {
    const fake = fakeProvider();
    const tool = toolFor(fake, workspace());
    const { request } = await tool(PREPARE);
    await expect(
      tool({ command: "send", request: request.handle }),
    ).rejects.toMatchObject({ signature: { code: "approval_required" } });
    await expect(
      tool(
        { command: "send", request: `docusign:${ENVELOPE_ID}` },
        { approve: approveAll },
      ),
    ).rejects.toMatchObject({ signature: { code: "not_found" } });
    expect(fake.sent).toEqual([]);
  });

  it("binds an approval to the draft, its document and its recipients", () => {
    const record = {
      handle: "sig_a",
      provider: "docusign",
      status: "draft" as const,
      path: "outputs/acme-msa.docx",
      name: "acme-msa.docx",
      extension: "docx",
      sha256: "a".repeat(64),
      subject: "Acme MSA",
      signers: [
        {
          name: "Jane Doe",
          email: "jane@example.com",
          order: 1,
          placement: { sign: "\\s1\\" },
        },
      ],
      cc: [],
    };
    const binding = sendBinding(record);
    expect(
      sendBinding({
        ...record,
        signers: [{ ...record.signers[0]!, email: "other@example.com" }],
      }),
    ).not.toBe(binding);
    expect(sendBinding({ ...record, sha256: "b".repeat(64) })).not.toBe(
      binding,
    );
    expect(
      voidBinding({ ...record, ref: ENVELOPE_ID }, "Wrong version"),
    ).not.toBe(voidBinding({ ...record, ref: ENVELOPE_ID }, "Another reason"));
  });
});

describe("signature status and void", () => {
  it("reads a draft without the provider, then keeps an answer for the provider's interval", async () => {
    let now = new Date("2026-11-12T05:00:00Z");
    const fake = fakeProvider();
    const tool = toolFor(fake, workspace(), { now: () => now });
    const { request } = await tool(PREPARE);
    expect(
      (await tool({ command: "status", request: request.handle })).request
        .status,
    ).toBe("draft");
    expect(fake.reads()).toBe(0);
    await tool(
      { command: "send", request: request.handle },
      { approve: approveAll },
    );
    const first = await tool({ command: "status", request: request.handle });
    expect(first).toMatchObject({
      request: { status: "sent" },
      next_check_after: "2026-11-12T05:15:00.000Z",
    });
    fake.complete();
    now = new Date("2026-11-12T05:10:00Z");
    expect(
      (await tool({ command: "status", request: request.handle })).request
        .status,
    ).toBe("sent");
    expect(fake.reads()).toBe(1);
    now = new Date("2026-11-12T05:16:00Z");
    expect(
      (await tool({ command: "status", request: request.handle })).request,
    ).toMatchObject({
      status: "completed",
      recipients: [{ status: "signed" }],
    });
    expect(fake.reads()).toBe(2);
  });

  it("voids a sent request once approved, never a draft or a completed one", async () => {
    const fake = fakeProvider();
    const tool = toolFor(fake, workspace());
    const { request } = await tool(PREPARE);
    await expect(
      tool(
        { command: "void", request: request.handle, reason: "Wrong version" },
        { approve: approveAll },
      ),
    ).rejects.toMatchObject({ signature: { code: "invalid_request" } });
    await tool(
      { command: "send", request: request.handle },
      { approve: approveAll },
    );
    await expect(
      tool({
        command: "void",
        request: request.handle,
        reason: "Wrong version",
      }),
    ).rejects.toMatchObject({ signature: { code: "approval_required" } });
    const voided = await tool(
      { command: "void", request: request.handle, reason: "Wrong version" },
      { approve: approveAll },
    );
    expect(voided).toMatchObject({ done: true, request: { status: "voided" } });
    expect(fake.voided).toEqual([ENVELOPE_ID]);
    await expect(
      tool(
        { command: "void", request: request.handle, reason: "Again" },
        { approve: approveAll },
      ),
    ).rejects.toMatchObject({ signature: { code: "invalid_request" } });
  });

  it("offers void only when the provider serves it", async () => {
    const fake = fakeProvider({ commands: ["send", "status"] });
    const tool = toolFor(fake, workspace());
    await expect(
      tool({ command: "void", request: "sig_x", reason: "x" }),
    ).rejects.toMatchObject({ signature: { code: "invalid_request" } });
    expect(JSON.stringify(signatureParameters(fake.module))).not.toContain(
      '"void"',
    );
  });
});

// ---------------------------------------------------------------------------

interface Branch {
  entries: unknown[];
}

function fakeCtx(options: {
  hasUI?: boolean;
  select?: string;
  input?: string;
  branch?: Branch;
}): ExtensionContext {
  const branch = options.branch ?? { entries: [] };
  return {
    hasUI: options.hasUI ?? false,
    mode: "tui",
    ui: {
      select: async () => options.select,
      input: async () => options.input,
    },
    sessionManager: { getBranch: () => branch.entries },
  } as unknown as ExtensionContext;
}

type Executed = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

function registered(
  module: RecipeSignatureProviderModule,
  cwd: string,
  env: NodeJS.ProcessEnv = {},
) {
  let tool: {
    execute: (
      id: string,
      params: SignatureToolArgs,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx?: ExtensionContext,
    ) => Promise<Executed>;
  };
  registerSignatureTool(
    {
      registerTool: ((definition: typeof tool) => (tool = definition)) as never,
    },
    {
      provider: { module, config: { provider: "docusign", options: {} } },
      cwd,
      env,
    },
  );
  return tool!;
}

const handleOf = (result: Executed) =>
  (result.details as { request: { handle: string } }).request.handle;

/** A tool result as the session stores it. */
const stored = (toolCallId: string, result: Executed, text?: string) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId,
    toolName: "signature",
    content: text ? [{ type: "text", text }] : result.content,
    details: result.details,
  },
});

describe("signature approvals on each host", () => {
  it("sends once a person approves in the dialog", async () => {
    const fake = fakeProvider();
    const tool = registered(fake.module, workspace());
    const draft = await tool.execute(
      "c1",
      PREPARE,
      undefined,
      undefined,
      fakeCtx({}),
    );
    const result = await tool.execute(
      "c2",
      { command: "send", request: handleOf(draft) },
      undefined,
      undefined,
      fakeCtx({ hasUI: true, select: "Approve" }),
    );
    expect(result.content[0]!.text).toMatch(
      /^Sent: the signers have been emailed/,
    );
    expect(fake.sent).toHaveLength(1);
  });

  it("leaves the draft when the person requests changes", async () => {
    const fake = fakeProvider();
    const tool = registered(fake.module, workspace());
    const draft = await tool.execute(
      "c1",
      PREPARE,
      undefined,
      undefined,
      fakeCtx({}),
    );
    const result = await tool.execute(
      "c2",
      { command: "send", request: handleOf(draft) },
      undefined,
      undefined,
      fakeCtx({ hasUI: true, select: "Request changes", input: "Add our CFO" }),
    );
    expect(result.content[0]!.text).toBe(
      "Revision requested. Feedback: Add our CFO",
    );
    expect(fake.sent).toEqual([]);
  });

  it("never sends where approvals resolve without a person", async () => {
    const fake = fakeProvider();
    const cwd = workspace();
    const headless = registered(fake.module, cwd, {
      PI_ASK_USER_AUTO_APPROVE: "1",
    });
    const draft = await headless.execute(
      "c1",
      PREPARE,
      undefined,
      undefined,
      fakeCtx({}),
    );
    const send = { command: "send" as const, request: handleOf(draft) };
    const auto = await headless.execute(
      "c2",
      send,
      undefined,
      undefined,
      fakeCtx({ hasUI: true, select: "Approve" }),
    );
    expect(auto.isError).toBe(true);
    expect(auto.content[0]!.text).toMatch(/approval_required/);

    const child = registered(fake.module, cwd);
    const childDraft = await child.execute(
      "c3",
      PREPARE,
      undefined,
      undefined,
      fakeCtx({}),
    );
    const childSend = {
      command: "send" as const,
      request: handleOf(childDraft),
    };
    const inChild = await autoResolveInteractions(() =>
      child.execute(
        "c4",
        childSend,
        undefined,
        undefined,
        fakeCtx({ hasUI: true, select: "Approve" }),
      ),
    );
    expect(inChild.content[0]!.text).toMatch(/approval_required/);
    const noChannel = await child.execute(
      "c5",
      childSend,
      undefined,
      undefined,
      fakeCtx({}),
    );
    expect(noChannel.content[0]!.text).toMatch(/approval_required/);
    const noContext = await child.execute(
      "c6",
      childSend,
      undefined,
      undefined,
    );
    expect(noContext.content[0]!.text).toMatch(/approval_required/);
    expect(fake.sent).toEqual([]);
  });

  it("on a pause/resume host, finds the draft and the approval in the session after a restart", async () => {
    const fake = fakeProvider();
    const cwd = workspace();
    const env = { PI_INTERRUPT_RESUME: "1" };
    const branch: Branch = { entries: [] };
    const ctx = fakeCtx({ branch });
    const before = registered(fake.module, cwd, env);
    const draft = await before.execute(
      "c1",
      PREPARE,
      undefined,
      undefined,
      ctx,
    );
    branch.entries.push(stored("c1", draft));
    const send = { command: "send" as const, request: handleOf(draft) };
    const paused = await before.execute("c2", send, undefined, undefined, ctx);
    expect(paused.content[0]!.text).toBe("Awaiting user response.");
    const interrupt = (
      paused.details as {
        interrupt: { metadata: Record<string, unknown>; display: unknown };
      }
    ).interrupt;
    expect(interrupt.metadata).toMatchObject({
      kind: SIGNATURE_SEND_APPROVAL_KIND,
      request: handleOf(draft),
      document_sha256: createHash("sha256").update(CONTRACT).digest("hex"),
    });
    expect(JSON.stringify(interrupt.display)).toContain(
      "Jane Doe <jane@example.com>",
    );
    expect(fake.sent).toEqual([]);

    // A new process: nothing in memory, everything in the session.
    const after = registered(fake.module, cwd, env);
    branch.entries.push(stored("c2", paused, "Awaiting user response."));
    expect(
      (await after.execute("c3", send, undefined, undefined, ctx)).content[0]!
        .text,
    ).toBe("Awaiting user response.");
    branch.entries.push({
      type: "message",
      message: {
        ...stored("c2", paused, "Approved.").message,
        toolName: "bash",
      },
    });
    await after.execute("c4", send, undefined, undefined, ctx);
    expect(fake.sent).toEqual([]);

    branch.entries.push(stored("c2", paused, "Approved."));
    const sent = await after.execute("c5", send, undefined, undefined, ctx);
    expect(sent.content[0]!.text).toMatch(/^Sent:/);
    expect(fake.sent).toHaveLength(1);
    branch.entries.push(stored("c5", sent));
    const again = await registered(fake.module, cwd, env).execute(
      "c6",
      send,
      undefined,
      undefined,
      ctx,
    );
    expect(again.content[0]!.text).toMatch(/invalid_request.*not a draft/);
    expect(fake.sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

function recipe(pi: unknown, extra: Record<string, unknown> = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "signature-recipe-")));
  scratch.push(dir);
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, "agents", "agent.yaml"), "name: agent\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "acme-recipe", version: "1.0.0", pi, ...extra }),
  );
  return dir;
}

describe("pi.signature", () => {
  it("parses one provider and its options, and is absent without it", () => {
    expect(
      readPiPackageManifest(recipe({ agents: ["agents"] })).signature,
    ).toBeUndefined();
    expect(
      readPiPackageManifest(
        recipe({
          signature: [{ provider: "docusign", options: { account: "acme" } }],
        }),
      ).signature,
    ).toEqual([{ provider: "docusign", options: { account: "acme" } }]);
  });

  it("reports more than one provider, unknown options and fields", () => {
    const messages = validatePiPackageManifest(
      readPiPackageManifest(
        recipe({
          signature: [
            { provider: "docusign", options: { team: "x" } },
            { provider: "acme", package: "@acme/sign", enabled: false },
          ],
        }),
      ),
    )
      .findings.filter((finding) => finding.code === "pi.signature_invalid")
      .map((finding) => finding.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        "package.json#pi.signature declares 2 providers; it takes at most 1",
        expect.stringContaining("provider 'docusign' takes no option 'team'"),
        expect.stringContaining("contains unknown field(s): enabled"),
      ]),
    );
  });

  it("holds the first-party options the provider declares", () => {
    expect(SIGNATURE_FIRST_PARTY_OPTIONS.docusign).toEqual(
      docusignSignatureProvider.capabilities.options,
    );
  });
});

describe("loadRecipeSignature", () => {
  function providerPackage(dir: string) {
    const root = join(dir, "node_modules", "@acme", "sign");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/sign",
        version: "1.0.0",
        type: "module",
        main: "index.js",
      }),
    );
    writeFileSync(
      join(root, "index.js"),
      `export default { kind: "signature", apiVersion: 2, id: "acme",
        capabilities: { commands: ["send", "status"], extensions: ["docx"], document: ["upload"], status_interval_seconds: 60, hosts: ["sign.acme.test"], options: { region: "string" } },
        createSession: () => ({}) };\n`,
    );
  }

  it("offers nothing without pi.signature, or when the agent does not select it", async () => {
    const dir = recipe({});
    expect(
      await loadRecipeSignature(undefined, ["signature"], { recipeDir: dir }),
    ).toEqual({
      toolNames: [],
    });
    providerPackage(dir);
    const declared = [{ provider: "acme", package: "@acme/sign" }];
    expect(
      await loadRecipeSignature(declared, ["documents"], { recipeDir: dir }),
    ).toEqual({ toolNames: [], hosts: ["sign.acme.test"] });
    const loaded = await loadRecipeSignature(declared, ["signature"], {
      recipeDir: dir,
    });
    expect(loaded.toolNames).toEqual(["signature"]);
    expect(loaded.skillPaths?.[0]).toMatch(/skills\/signature\/SKILL\.md$/);
  });

  it("refuses an option the provider does not declare, and a second provider", async () => {
    const dir = recipe({});
    providerPackage(dir);
    await expect(
      loadRecipeSignature(
        [{ provider: "acme", package: "@acme/sign", options: { team: "x" } }],
        ["signature"],
        { recipeDir: dir },
      ),
    ).rejects.toThrow("takes no option 'team'; it takes region");
    await expect(
      loadRecipeSignature(
        [{ provider: "acme", package: "@acme/sign" }, { provider: "docusign" }],
        ["signature"],
        { recipeDir: dir },
      ),
    ).rejects.toThrow("a Recipe sends through one");
  });
});
