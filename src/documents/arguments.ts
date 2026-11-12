/**
 * The arguments each `documents` command takes, as the model sees them.
 * `scripts/generate-tool-schemas.mjs` turns each `Documents<Command>Arguments`
 * type into the JSON Schema in `arguments.generated.ts`: a field's doc comment
 * is its description and its tags are its limits.
 */

/**
 * The document to read from
 * @minLength 1
 */
type Source = string;

/**
 * Where to save the result, under outputs/. Omit to keep editing a result this tool already saved at path.
 * @minLength 1
 */
type Output = string;

/**
 * Name every change and comment is signed with
 * @minLength 1
 */
type Author = string;

/**
 * Text copied from the read output of the paragraph. Whitespace, curly quotes, dashes and soft hyphens are forgiven; words are not.
 * @minLength 1
 */
type Quote = string;

/**
 * Paragraph id from read, such as p-031, that holds the quote
 * @minLength 1
 */
type QuoteParagraph = string;

/**
 * Nearby text that picks one match
 * @minLength 1
 */
type Near = string;

/**
 * 1-based match number when the quote repeats
 * @asType integer
 * @minimum 1
 */
type Occurrence = number;

/**
 * A comment thread's number from read
 * @asType integer
 * @minimum 0
 */
type Thread = number;

/** @minLength 1 */
type Text = string;

/**
 * The document, a path in the workspace
 * @minLength 1
 */
type Path = string;

interface Edit {
  op: "replace" | "delete" | "insert_after";
  quote: Quote;
  paragraph?: QuoteParagraph;
  near?: Near;
  occurrence?: Occurrence;
  /** Replacement text (replace) or inserted text (insert_after) */
  new?: string;
  /**
   * Margin comment giving the reason
   * @minLength 1
   */
  rationale: string;
}

interface Revision {
  /**
   * Paragraph id from read, such as p-031
   * @minLength 1
   */
  paragraph: string;
  /** The paragraph's full revised text (empty to strike it all; unchanged to comment on it) */
  text: string;
  // Optional in the schema so one missing rationale fails that revision, not the batch.
  /** Margin comment giving the reason (required) */
  rationale?: string;
}

interface Decision {
  action: "accept" | "reject";
  /**
   * Change numbers from read, like 12-19 or 30,34
   * @minLength 1
   */
  changes: string;
}

interface Reply {
  action: "reply";
  /**
   * @asType integer
   * @minimum 0
   */
  thread: number;
  text: Text;
}

interface Counter {
  action: "counter";
  quote: Quote;
  paragraph?: QuoteParagraph;
  near?: Near;
  occurrence?: Occurrence;
  new: string;
  rationale: Text;
  /**
   * Thread to put the rationale on
   * @asType integer
   * @minimum 0
   */
  thread?: number;
}

export interface DocumentsReadArguments {
  path: Path;
  /**
   * Where to continue, as given by the previous part: a paragraph, or the tracked-change and comment listings after the last one
   * @asType integer
   * @minimum 0
   */
  offset?: number;
  /**
   * Characters per part (default 30000)
   * @asType integer
   * @minimum 2000
   * @maximum 80000
   */
  budget?: number;
  /**
   * Pages to read, like 2-4,9 (paged formats)
   * @maxLength 100
   */
  pages?: string;
  /** PDF: also return tables as rows of cells. Ask for it on contracts with fee schedules, SLA grids or price tables, where plain text loses which figure belongs to which row. Needs the PDF adapter's tables extra; without it you get the text and a note. */
  tables?: boolean;
}

export interface DocumentsReviseArguments {
  path: Source;
  output?: Output;
  author: Author;
  /**
   * Each paragraph's revised text
   * @minItems 1
   * @maxItems 60
   */
  revisions: Revision[];
}

export interface DocumentsProposeEditsArguments {
  path: Source;
  output?: Output;
  author: Author;
  /**
   * The tracked edits to make
   * @minItems 1
   * @maxItems 60
   */
  edits: Edit[];
}

export interface DocumentsCommentArguments {
  path: Source;
  output?: Output;
  author: Author;
  /**
   * The comment
   * @minLength 1
   */
  text: string;
  quote?: Quote;
  paragraph?: QuoteParagraph;
  near?: Near;
  occurrence?: Occurrence;
  thread?: Thread;
}

export interface DocumentsRespondArguments {
  path: Source;
  output?: Output;
  author: Author;
  /**
   * What to do with each change or thread
   * @minItems 1
   * @maxItems 60
   */
  responses: (Decision | Reply | Counter)[];
}

export interface DocumentsRemoveSectionArguments {
  path: Source;
  output?: Output;
  author: Author;
  /**
   * First paragraph id
   * @minLength 1
   */
  from: string;
  /**
   * Last paragraph id
   * @minLength 1
   */
  through: string;
  /**
   * Leading text of the first paragraph to keep, such as its heading
   * @minLength 1
   */
  keep?: string;
  /**
   * The comment giving the reason
   * @minLength 1
   */
  rationale: string;
}

export interface DocumentsConvertArguments {
  /**
   * The document to convert, such as a PDF to redline
   * @minLength 1
   */
  path: string;
  /**
   * The new file under outputs/, in the format to convert to, such as outputs/contract.docx
   * @minLength 1
   */
  output: string;
  /**
   * Pages to convert, like 2-4,9 (default: every page)
   * @maxLength 100
   */
  pages?: string;
}

export interface DocumentsRenderArguments {
  path: Path;
  /**
   * Pages to render, like 2-4,9 (default: from page 1); for HTML, chart numbers (default: the full page and every chart)
   * @maxLength 100
   */
  pages?: string;
}
