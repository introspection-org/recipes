/**
 * Provider-neutral document vocabulary.
 *
 * A format package (Word, PDF, ...) supplies the mechanics and a capability
 * descriptor; the `documents` tool, its command schemas and the path policy
 * live in the host so two formats cannot drift into differently-shaped
 * versions of the same operation.
 */

/** What a format supports, as static data the loader reads before any session exists. */
export interface DocumentCapabilities {
  /** Text with stable paragraph ids, tracked changes and comments by author. Always true. */
  readonly read: true;
  /** Batches of tracked replace/delete/insert_after edits, each with a rationale comment. */
  readonly proposeEdits?: boolean;
  /** Paragraph-level revisions (revised text per paragraph id), redlined without quoting. */
  readonly revise?: boolean;
  /** Standalone comments and threaded replies. */
  readonly comment?: boolean;
  /** Accept, reject or counter an existing tracked change; reply on a thread. */
  readonly respond?: boolean;
  /** Whole-section removal that keeps numbering ("Reserved."). */
  readonly removeSection?: boolean;
  /** Page images written as PNG files, for pages with no text layer or to check layout. */
  readonly render?: boolean;
}

/** A tracked edit anchored to quoted text. */
export interface DocumentEdit {
  op: "replace" | "delete" | "insert_after";
  /** Exact text from `read`; matching forgives whitespace, quotes, dashes and soft hyphens. */
  quote: string;
  /** A paragraph id from `read` that contains the quote. */
  paragraph?: string;
  /** Nearby text that picks one match when the quote appears more than once. */
  near?: string;
  /** 1-based match number among the remaining matches. */
  occurrence?: number;
  /** Replacement (replace) or inserted text (insert_after). */
  new?: string;
  /** The margin comment explaining the change. */
  rationale: string;
}

export interface DocumentReadInput {
  path: string;
  offset?: number;
  budget?: number;
  pages?: string;
  /** Also return table cells (paged formats that can find tables). A format without it reads text. */
  tables?: boolean;
}

export interface DocumentWriteTarget {
  /** Absolute path of the document read. */
  source: string;
  /** Absolute path the result is written to; never an original. */
  output: string;
}

export interface DocumentProposeEditsInput extends DocumentWriteTarget {
  author: string;
  edits: DocumentEdit[];
}

/** A paragraph's revised text, by its id from `read`. */
export interface DocumentRevision {
  paragraph: string;
  text: string;
  rationale: string;
}

export interface DocumentReviseInput extends DocumentWriteTarget {
  author: string;
  revisions: DocumentRevision[];
}

export interface DocumentCommentInput extends DocumentWriteTarget {
  author: string;
  text: string;
  quote?: string;
  paragraph?: string;
  near?: string;
  occurrence?: number;
  thread?: number;
}

export type DocumentResponse =
  | { action: "accept" | "reject"; changes: string }
  | { action: "reply"; thread: number; text: string }
  | {
      action: "counter";
      quote: string;
      new: string;
      rationale: string;
      paragraph?: string;
      near?: string;
      occurrence?: number;
      thread?: number;
    };

export interface DocumentRespondInput extends DocumentWriteTarget {
  author: string;
  responses: DocumentResponse[];
}

export interface DocumentRemoveSectionInput extends DocumentWriteTarget {
  author: string;
  from: string;
  through: string;
  /** Text at the start of the first paragraph to keep, such as the heading "Audit.". */
  keep?: string;
  rationale: string;
}

export interface DocumentRenderInput {
  path: string;
  pages?: string;
  /** Absolute directory, chosen by the host, where the page images are written. */
  outputDir: string;
}

export interface DocumentImage {
  label: string;
  /** Base64 image bytes. */
  data: string;
  mimeType: string;
}

/** What an adapter returns: compact text for the model, optional structured details and images. */
export interface DocumentResult {
  text: string;
  details?: Record<string, unknown>;
  images?: DocumentImage[];
}

export interface DocumentAdapterContext {
  /** The task workspace; every path is inside it. */
  cwd: string;
  signal?: AbortSignal;
}

export interface DocumentAdapter {
  readonly format: string;
  /** Lower-case file extensions, with the dot, that this adapter opens. */
  readonly extensions: readonly string[];
  readonly capabilities: DocumentCapabilities;
  read(ctx: DocumentAdapterContext, input: DocumentReadInput): Promise<DocumentResult>;
  proposeEdits?(ctx: DocumentAdapterContext, input: DocumentProposeEditsInput): Promise<DocumentResult>;
  revise?(ctx: DocumentAdapterContext, input: DocumentReviseInput): Promise<DocumentResult>;
  comment?(ctx: DocumentAdapterContext, input: DocumentCommentInput): Promise<DocumentResult>;
  respond?(ctx: DocumentAdapterContext, input: DocumentRespondInput): Promise<DocumentResult>;
  removeSection?(ctx: DocumentAdapterContext, input: DocumentRemoveSectionInput): Promise<DocumentResult>;
  render?(ctx: DocumentAdapterContext, input: DocumentRenderInput): Promise<DocumentResult>;
}
