import { fileURLToPath } from "node:url";

// Types only: the host passes what this package runs (`runHelper`) into
// `createAdapter`, so it has no run-time dependency on @introspection-ai/recipes.
import type {
  DocumentAdapter,
  DocumentAdapterContext,
  DocumentCapabilities,
  DocumentHelperRunner,
  DocumentReadInput,
  DocumentRenderInput,
  DocumentResult,
  RecipeDocumentFormatModule,
} from "@introspection-ai/recipes/documents";

/** What a `PdfDocumentAdapter` runs with. */
export interface PdfDocumentAdapterOptions {
  /** The host's `runDocumentHelper`, from `createAdapter`. */
  runHelper: DocumentHelperRunner;
  env?: NodeJS.ProcessEnv;
  /** The helper script. Default `PDF_HELPER`. */
  script?: string;
  /** The interpreter of this package's environment, which the host prepares from its `pi.runtime.python`. */
  python?: string;
}

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

  constructor(private readonly options: PdfDocumentAdapterOptions) {}

  private call(ctx: DocumentAdapterContext, command: string, input: object): Promise<DocumentResult> {
    const { runHelper, env = process.env, script = PDF_HELPER, python } = this.options;
    return runHelper(script, { command, ...input }, { env, cwd: ctx.cwd, python, signal: ctx.signal });
  }

  read(ctx: DocumentAdapterContext, input: DocumentReadInput): Promise<DocumentResult> {
    return this.call(ctx, "read", input);
  }

  render(ctx: DocumentAdapterContext, input: DocumentRenderInput): Promise<DocumentResult> {
    return this.call(ctx, "render", input);
  }
}

/** PDF as a document format: `{ "pi": { "documents": [{ "format": "pdf" }] } }`. */
export const pdfDocumentFormatModule: RecipeDocumentFormatModule = {
  kind: "documents",
  apiVersion: 1,
  format: "pdf",
  extensions: [".pdf"],
  capabilities: PDF_DOCUMENT_CAPABILITIES,
  createAdapter: ({ env, python, runHelper }) => new PdfDocumentAdapter({ runHelper, env, ...(python ? { python } : {}) }),
};

export default pdfDocumentFormatModule;
