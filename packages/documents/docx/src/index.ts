import { fileURLToPath } from "node:url";

import {
  createDocumentFormatModule,
  type DocumentAdapter,
  type DocumentAdapterContext,
  type DocumentCapabilities,
  type DocumentCommentInput,
  type DocumentProposeEditsInput,
  type DocumentReadInput,
  type DocumentRemoveSectionInput,
  type DocumentRespondInput,
  type DocumentReviseInput,
  type DocumentResult,
} from "@introspection-ai/recipes/documents";

import { runHelper } from "./python.js";

export { pythonExecutable, runHelper } from "./python.js";

/** The helper entry point shipped in this package. */
export const DOCX_HELPER = fileURLToPath(new URL("../python/docx_helper.py", import.meta.url));

/**
 * What Word supports. `render` is false: page images need a layout engine
 * (LibreOffice or Word), which the runtime image does not carry, so the
 * command is absent for .docx rather than failing.
 */
export const DOCX_DOCUMENT_CAPABILITIES: DocumentCapabilities = {
  read: true,
  revise: true,
  proposeEdits: true,
  comment: true,
  respond: true,
  removeSection: true,
  render: false,
};

export class DocxDocumentAdapter implements DocumentAdapter {
  readonly format = "docx";
  readonly extensions = [".docx"] as const;
  readonly capabilities = DOCX_DOCUMENT_CAPABILITIES;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly script = DOCX_HELPER) {}

  private call(ctx: DocumentAdapterContext, command: string, input: object): Promise<DocumentResult> {
    return runHelper(this.script, { command, ...input }, { env: this.env, cwd: ctx.cwd, signal: ctx.signal });
  }

  read(ctx: DocumentAdapterContext, input: DocumentReadInput) {
    return this.call(ctx, "read", input);
  }

  revise(ctx: DocumentAdapterContext, input: DocumentReviseInput) {
    return this.call(ctx, "revise", input);
  }

  proposeEdits(ctx: DocumentAdapterContext, input: DocumentProposeEditsInput) {
    return this.call(ctx, "propose_edits", input);
  }

  comment(ctx: DocumentAdapterContext, input: DocumentCommentInput) {
    return this.call(ctx, "comment", input);
  }

  respond(ctx: DocumentAdapterContext, input: DocumentRespondInput) {
    return this.call(ctx, "respond", input);
  }

  removeSection(ctx: DocumentAdapterContext, input: DocumentRemoveSectionInput) {
    return this.call(ctx, "remove_section", input);
  }
}

/**
 * Word as a document format.
 *
 * ```json
 * { "pi": { "documents": [{ "format": "docx" }] } }
 * ```
 *
 * ```yaml
 * tools: [documents]
 * ```
 */
export const docxDocumentFormatModule = createDocumentFormatModule({
  format: "docx",
  extensions: [".docx"],
  capabilities: DOCX_DOCUMENT_CAPABILITIES,
  createAdapter: ({ env }) => new DocxDocumentAdapter(env),
});

export default docxDocumentFormatModule;
