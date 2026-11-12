import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { zipParts } from "../../../src/signature/docx.js";
import { createSignatureTool } from "../../../src/signature/index.js";
import {
  hasRecording,
  RECORDING,
  recordingToken,
  startRestRecording,
} from "../../../test/helpers/polly.js";
import { docusignSignatureProvider } from "../src/index.js";

/**
 * The `signature` tool against DocuSign's developer sandbox: userinfo,
 * create a draft, read it, send it, read it again. Records with
 * `POLLY_MODE=record` and `MCP_RECORD_TOKEN_FILE` (a JSON file holding a
 * sandbox `access_token` from the JWT grant); replays the committed cassette
 * otherwise, and is skipped until one is committed.
 *
 * Record only against `demo.docusign.net`, with this dummy contract and
 * `example.com` recipients, which no mail server delivers to. Read the cassette
 * before committing it.
 */
const DIR = join(import.meta.dirname, "recordings");
const NAME = "docusign-envelope";
const HOSTS = ["account-d.docusign.com", "demo.docusign.net"];

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const cell = (...paragraphs: string[]) => `<w:tc>${paragraphs.join("")}</w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;

/** A dummy agreement with a two-column signature block, the customer's side filled in. */
const CONTRACT = zipParts({
  "[Content_Types].xml":
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  "_rels/.rels":
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>${p("Recipe test agreement between Acme, Inc. and Example Corp. Not a real agreement.")}<w:tbl>${row(cell(p("ACME, INC.")), cell(p("EXAMPLE CORP.")))}${row(cell(p("By:")), cell(p("By:")))}${row(cell(p("Name: Alex Acme")), cell(p("Name: Jordan Example")))}${row(cell(p("Date:")), cell(p("Date:")))}</w:tbl><w:sectPr/></w:body></w:document>`,
});

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!RECORDING && !hasRecording(DIR, NAME))(
  "DocuSign sandbox",
  () => {
    it("creates a draft, then sends it once approved", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "docusign-recording-"));
      scratch.push(cwd);
      mkdirSync(join(cwd, "outputs"));
      writeFileSync(
        join(cwd, "outputs", "recipe-test-agreement.docx"),
        CONTRACT,
      );
      const token = recordingToken();
      const polly = startRestRecording(NAME, DIR, HOSTS);
      try {
        const tool = createSignatureTool({
          provider: {
            module: docusignSignatureProvider,
            config: { provider: "docusign", options: { environment: "demo" } },
          },
          cwd,
          env: {},
          fetch: (url, init) =>
            globalThis.fetch(url, {
              ...init,
              headers: { ...init.headers, Authorization: `Bearer ${token}` },
            } as RequestInit) as never,
        });
        const created = await tool({
          command: "create",
          path: "outputs/recipe-test-agreement.docx",
          subject: "Recipe test agreement (sandbox)",
          signers: [{ name: "Jordan Example", email: "signer@example.com" }],
          cc: [
            {
              name: "Acme Legal",
              email: "legal@example.com",
              routing_order: 2,
            },
          ],
        });
        expect(created.envelope.status).toBe("created");
        const handle = created.envelope.handle;

        const draft = await tool({ command: "get", envelope: handle });
        expect(draft.envelope).toMatchObject({
          status: "created",
          document: { name: "recipe-test-agreement.docx" },
        });

        // The person's approval is the gate's job, tested in signature.test.ts.
        const sent = await tool(
          { command: "send", envelope: handle },
          { approve: async () => ({ type: "approved" }) },
        );
        expect(sent).toMatchObject({ sent: true });
        expect(sent.envelope.status).toBe("sent");
      } finally {
        await polly.stop();
      }
    });
  },
);
