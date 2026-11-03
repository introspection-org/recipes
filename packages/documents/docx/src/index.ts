import { fileURLToPath } from "node:url";

import {
  createDocumentFormatModule,
  runDocumentHelper,
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

export {
  documentPythonExecutable as pythonExecutable,
  runDocumentHelper as runHelper,
} from "@introspection-ai/recipes/documents";

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

  /**
   * `python` is the interpreter of this package's environment, which the host
   * prepares from its `pi.runtime.python`; see `pythonExecutable` for the order.
   */
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly script = DOCX_HELPER,
    private readonly python?: string,
  ) {}

  private call(ctx: DocumentAdapterContext, command: string, input: object): Promise<DocumentResult> {
    return runDocumentHelper(this.script, { command, ...input }, { env: this.env, cwd: ctx.cwd, python: this.python, signal: ctx.signal });
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
/**
 * Contract redlining in US English: how to plan a first markup and answer the
 * other side's redline. A Recipe selects it with `"profile": "legal-redlining-en-US"`.
 */
export const LEGAL_REDLINING_EN_US = fileURLToPath(new URL("../profiles/legal-redlining-en-us/SKILL.md", import.meta.url));

export const docxDocumentFormatModule = createDocumentFormatModule({
  format: "docx",
  extensions: [".docx"],
  capabilities: DOCX_DOCUMENT_CAPABILITIES,
  profiles: { "legal-redlining-en-US": LEGAL_REDLINING_EN_US },
  createAdapter: ({ env, python }) => new DocxDocumentAdapter(env, DOCX_HELPER, python),
});

export default docxDocumentFormatModule;
