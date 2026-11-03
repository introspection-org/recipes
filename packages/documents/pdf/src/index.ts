import { fileURLToPath } from "node:url";

import {
  createDocumentFormatModule,
  runDocumentHelper,
  type DocumentAdapter,
  type DocumentAdapterContext,
  type DocumentCapabilities,
  type DocumentReadInput,
  type DocumentRenderInput,
  type DocumentResult,
} from "@introspection-ai/recipes/documents";

export {
  documentPythonExecutable as pythonExecutable,
  runDocumentHelper as runHelper,
} from "@introspection-ai/recipes/documents";

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

  /**
   * `python` is the interpreter of this package's environment, which the host
   * prepares from its `pi.runtime.python`; see `pythonExecutable` for the order.
   */
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly script = PDF_HELPER,
    private readonly python?: string,
  ) {}

  read(ctx: DocumentAdapterContext, input: DocumentReadInput): Promise<DocumentResult> {
    return runDocumentHelper(this.script, { command: "read", ...input }, { env: this.env, cwd: ctx.cwd, python: this.python, signal: ctx.signal });
  }

  render(ctx: DocumentAdapterContext, input: DocumentRenderInput): Promise<DocumentResult> {
    return runDocumentHelper(this.script, { command: "render", ...input }, { env: this.env, cwd: ctx.cwd, python: this.python, signal: ctx.signal });
  }
}

/** PDF as a document format: `{ "pi": { "documents": [{ "format": "pdf" }] } }`. */
export const pdfDocumentFormatModule = createDocumentFormatModule({
  format: "pdf",
  extensions: [".pdf"],
  capabilities: PDF_DOCUMENT_CAPABILITIES,
  createAdapter: ({ env, python }) => new PdfDocumentAdapter(env, PDF_HELPER, python),
});

export default pdfDocumentFormatModule;
