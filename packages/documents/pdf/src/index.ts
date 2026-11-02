import { fileURLToPath } from "node:url";

import {
  createDocumentFormatModule,
  type DocumentAdapter,
  type DocumentAdapterContext,
  type DocumentCapabilities,
  type DocumentReadInput,
  type DocumentRenderInput,
  type DocumentResult,
} from "@introspection-ai/recipes/documents";

import { runHelper } from "./python.js";

export { pythonExecutable, runHelper } from "./python.js";

export const PDF_HELPER = fileURLToPath(new URL("../python/pdf.py", import.meta.url));

/**
 * PDFs are read and rendered here, never changed: the write commands are absent for .pdf.
 * read: pypdfium2 text, plus pdfplumber table cells when asked and the `tables` extra is installed.
 * render: PNG files in the directory the host passes, returned as paths for Pi's `read` tool.
 */
export const PDF_DOCUMENT_CAPABILITIES: DocumentCapabilities = {
  read: true,
  revise: false,
  proposeEdits: false,
  comment: false,
  respond: false,
  removeSection: false,
  render: true,
};

export class PdfDocumentAdapter implements DocumentAdapter {
  readonly format = "pdf";
  readonly extensions = [".pdf"] as const;
  readonly capabilities = PDF_DOCUMENT_CAPABILITIES;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly script = PDF_HELPER) {}

  read(ctx: DocumentAdapterContext, input: DocumentReadInput): Promise<DocumentResult> {
    return runHelper(this.script, { command: "read", ...input }, { env: this.env, cwd: ctx.cwd, signal: ctx.signal });
  }

  render(ctx: DocumentAdapterContext, input: DocumentRenderInput): Promise<DocumentResult> {
    return runHelper(this.script, { command: "render", ...input }, { env: this.env, cwd: ctx.cwd, signal: ctx.signal });
  }
}

/** PDF as a document format: `{ "pi": { "documents": [{ "format": "pdf" }] } }`. */
export const pdfDocumentFormatModule = createDocumentFormatModule({
  format: "pdf",
  extensions: [".pdf"],
  capabilities: PDF_DOCUMENT_CAPABILITIES,
  createAdapter: ({ env }) => new PdfDocumentAdapter(env),
});

export default pdfDocumentFormatModule;
