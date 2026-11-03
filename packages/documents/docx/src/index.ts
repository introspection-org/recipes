import { fileURLToPath } from "node:url";

// Types only: the host passes what this package runs (`runHelper`) into
// `createAdapter`, so it has no run-time dependency on @introspection-ai/recipes.
import type {
  DocumentAdapter,
  DocumentAdapterContext,
  DocumentCapabilities,
  DocumentCommentInput,
  DocumentHelperRunner,
  DocumentProposeEditsInput,
  DocumentReadInput,
  DocumentRemoveSectionInput,
  DocumentRespondInput,
  DocumentReviseInput,
  DocumentResult,
  RecipeDocumentFormatModule,
} from "@introspection-ai/recipes/documents";

/** What a `DocxDocumentAdapter` runs with. */
export interface DocxDocumentAdapterOptions {
  /** The host's `runDocumentHelper`, from `createAdapter`. */
  runHelper: DocumentHelperRunner;
  env?: NodeJS.ProcessEnv;
  /** The helper script. Default `DOCX_HELPER`. */
  script?: string;
  /** The interpreter of this package's environment, which the host prepares from its `pi.runtime.python`. */
  python?: string;
}

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

  constructor(private readonly options: DocxDocumentAdapterOptions) {}

  private call(ctx: DocumentAdapterContext, command: string, input: object): Promise<DocumentResult> {
    const { runHelper, env = process.env, script = DOCX_HELPER, python } = this.options;
    return runHelper(script, { command, ...input }, { env, cwd: ctx.cwd, python, signal: ctx.signal });
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

export const docxDocumentFormatModule: RecipeDocumentFormatModule = {
  kind: "documents",
  apiVersion: 1,
  format: "docx",
  extensions: [".docx"],
  capabilities: DOCX_DOCUMENT_CAPABILITIES,
  profiles: { "legal-redlining-en-US": LEGAL_REDLINING_EN_US },
  createAdapter: ({ env, python, runHelper }) => new DocxDocumentAdapter({ runHelper, env, ...(python ? { python } : {}) }),
};

export default docxDocumentFormatModule;
