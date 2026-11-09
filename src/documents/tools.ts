import { realpathSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";

import type {
  DocumentAdapter,
  DocumentAdapterContext,
  DocumentCapabilities,
  DocumentResult,
} from "./types.js";

/** Commands of the registered `documents` tool. */
export const DOCUMENT_COMMANDS = [
  "read",
  "revise",
  "propose_edits",
  "comment",
  "respond",
  "remove_section",
  "render",
] as const;

export type DocumentCommand = (typeof DOCUMENT_COMMANDS)[number];

const WRITE_COMMANDS = new Set<DocumentCommand>([
  "revise",
  "propose_edits",
  "comment",
  "respond",
  "remove_section",
]);

/** Which commands a capability descriptor supports. */
export function documentCommandsFor(
  capabilities: DocumentCapabilities,
): DocumentCommand[] {
  const supported: DocumentCommand[] = ["read"];
  if (capabilities.revise) supported.push("revise");
  if (capabilities.proposeEdits) supported.push("propose_edits");
  if (capabilities.comment) supported.push("comment");
  if (capabilities.respond) supported.push("respond");
  if (capabilities.removeSection) supported.push("remove_section");
  if (capabilities.render) supported.push("render");
  return supported;
}

export function documentConnectorTools(_capabilities: DocumentCapabilities) {
  return [{ id: "documents", name: "documents", defaultActive: true }];
}

const METHOD: Record<DocumentCommand, keyof DocumentAdapter> = {
  read: "read",
  revise: "revise",
  propose_edits: "proposeEdits",
  comment: "comment",
  respond: "respond",
  remove_section: "removeSection",
  render: "render",
};

/** A capability claimed but not implemented would be discovered by failing a call; caught at registration. */
function assertImplemented(adapter: DocumentAdapter): void {
  const missing = documentCommandsFor(adapter.capabilities).filter(
    (command) => typeof adapter[METHOD[command]] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(
      `Document adapter '${adapter.format}' declares capabilities it does not implement: ${missing.join(", ")}`,
    );
  }
}

export interface RegisterDocumentToolsOptions {
  /** The task workspace. Every path the tool takes must resolve inside it. */
  cwd: string;
  /** Where results may be written. Defaults to `<cwd>/outputs`. */
  outputsDir?: string;
  /** Where `render` writes page images. Defaults to a fresh directory under the system temp dir. */
  pagesDir?: string;
  /** Restrict commands; defaults to every command some format supports. An empty list exposes no tool. */
  commands?: readonly DocumentCommand[];
}

/** Host surface used here. Opaque so Pi's TypeBox copy stays behind this seam. */
export interface DocumentToolHost {
  registerTool(...args: never[]): unknown;
  on?: ExtensionAPI["on"];
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
};

const inside = (root: string, path: string): boolean => {
  const local = relative(root, path);
  return (
    Boolean(local) &&
    local !== ".." &&
    !local.startsWith(`..${sep}`) &&
    !local.startsWith(sep)
  );
};

/** The workspace file a path names, refusing anything outside the workspace, through a symlink too. */
export function workspacePath(path: unknown, cwd: string): string {
  if (typeof path !== "string" || !path.trim())
    throw new Error("Pass the path of a document");
  const workspace = resolve(cwd);
  const full = resolve(workspace, path.trim());
  if (!inside(workspace, full) || !inside(real(workspace), real(full))) {
    throw new Error(`${path} is outside the workspace`);
  }
  return full;
}

const quoteFields = {
  quote: Type.String({
    minLength: 1,
    description:
      "Text copied from the read output of the paragraph. Whitespace, curly quotes, dashes and soft hyphens are forgiven; words are not.",
  }),
  paragraph: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Paragraph id from read, such as p-031, that holds the quote",
    }),
  ),
  near: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Nearby text that picks one match",
    }),
  ),
  occurrence: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "1-based match number when the quote repeats",
    }),
  ),
};

const writeFields = {
  path: Type.String({ minLength: 1, description: "The document to read from" }),
  output: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Where to save the result, under outputs/. Omit to keep editing a result this tool already saved at path.",
    }),
  ),
  author: Type.String({
    minLength: 1,
    description: "Name every change and comment is signed with",
  }),
};

const editSchema = Type.Object(
  {
    op: Type.Union([
      Type.Literal("replace"),
      Type.Literal("delete"),
      Type.Literal("insert_after"),
    ]),
    ...quoteFields,
    new: Type.Optional(
      Type.String({
        description:
          "Replacement text (replace) or inserted text (insert_after)",
      }),
    ),
    rationale: Type.String({
      minLength: 1,
      description: "Margin comment giving the reason",
    }),
  },
  { additionalProperties: false },
);

const responseSchema = Type.Union([
  Type.Object(
    {
      action: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
      changes: Type.String({
        minLength: 1,
        description: "Change numbers from read, like 12-19 or 30,34",
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("reply"),
      thread: Type.Integer({ minimum: 0 }),
      text: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("counter"),
      ...quoteFields,
      new: Type.String(),
      rationale: Type.String({ minLength: 1 }),
      thread: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Thread to put the rationale on",
        }),
      ),
    },
    { additionalProperties: false },
  ),
]);

interface Definition {
  description: string;
  parameters: TSchema & { properties: Record<string, TSchema> };
}

const DEFINITIONS: Record<DocumentCommand, Definition> = {
  read: {
    description:
      "Read a document. Word: each paragraph's current text after its id (quote from this text), tracked changes and comments inline by author, numbered changes and comment threads. PDF: the text page by page, filled form fields and page comments; the first line names the path used (text, tables, or page images when a page has no text layer, a scan, which you then render). Pass tables: true for a PDF with a fee schedule, SLA grid or price table. HTML: the page as markdown, each chart (a figure or inline SVG) a [chart N] line, to render. Long documents come in parts: pass the offset it gives.",
    parameters: Type.Object(
      {
        path: Type.String({ minLength: 1 }),
        offset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "Where to continue, as given by the previous part: a paragraph, or the tracked-change and comment listings after the last one",
          }),
        ),
        budget: Type.Optional(
          Type.Integer({
            minimum: 2000,
            maximum: 80000,
            description: "Characters per part (default 30000)",
          }),
        ),
        pages: Type.Optional(
          Type.String({
            maxLength: 100,
            description: "Pages to read, like 2-4,9 (paged formats)",
          }),
        ),
        tables: Type.Optional(
          Type.Boolean({
            description:
              "PDF: also return tables as rows of cells. Ask for it on contracts with fee schedules, SLA grids or price tables, where plain text loses which figure belongs to which row. Needs the PDF adapter's tables extra; without it you get the text and a note.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
  },
  revise: {
    description:
      "Redline whole paragraphs without quoting: for each paragraph id from read, give its full revised text and the rationale. The tool works out the word-level tracked changes, signs them with author, and puts the rationale as a comment on the changed text. Saves to output (a copy; never the original). Returns per-paragraph applied or failed.",
    parameters: Type.Object(
      {
        ...writeFields,
        revisions: Type.Array(
          Type.Object(
            {
              paragraph: Type.String({
                minLength: 1,
                description: "Paragraph id from read, such as p-031",
              }),
              text: Type.String({
                description:
                  "The paragraph's full revised text (empty to strike it all; unchanged to comment on it)",
              }),
              // Optional in the schema so one missing rationale fails that revision, not the batch.
              rationale: Type.Optional(
                Type.String({
                  description: "Margin comment giving the reason (required)",
                }),
              ),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 60 },
        ),
      },
      { additionalProperties: false },
    ),
  },
  propose_edits: {
    description:
      "Make a batch of tracked edits (replace, delete, insert_after), each anchored to a quote and carrying its rationale as a margin comment, signed by author. Saves to output (a copy; never the original). Returns per-edit applied or failed; a failed edit lists the closest paragraphs. Resubmit only failed edits.",
    parameters: Type.Object(
      {
        ...writeFields,
        edits: Type.Array(editSchema, { minItems: 1, maxItems: 60 }),
      },
      { additionalProperties: false },
    ),
  },
  comment: {
    description:
      "Add a margin comment on a quote, or reply on an existing thread (thread number from read). Signed by author; saved to output.",
    parameters: Type.Object(
      {
        ...writeFields,
        text: Type.String({ minLength: 1 }),
        quote: Type.Optional(quoteFields.quote),
        paragraph: quoteFields.paragraph,
        near: quoteFields.near,
        occurrence: quoteFields.occurrence,
        thread: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false },
    ),
  },
  respond: {
    description:
      "Respond to markup already in the document: accept or reject tracked changes by number, reply on a thread, or counter with your own tracked change. Accepts and rejects run first, so numbers refer to the file as read; each accept or reject applies whole or not at all.",
    parameters: Type.Object(
      {
        ...writeFields,
        responses: Type.Array(responseSchema, { minItems: 1, maxItems: 60 }),
      },
      { additionalProperties: false },
    ),
  },
  remove_section: {
    description:
      "Remove a whole section as tracked changes while keeping numbering: strikes paragraphs from..through and leaves 'Reserved.' in the first, after any keep text such as its heading. One rationale comment.",
    parameters: Type.Object(
      {
        ...writeFields,
        from: Type.String({ minLength: 1, description: "First paragraph id" }),
        through: Type.String({
          minLength: 1,
          description: "Last paragraph id",
        }),
        keep: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Leading text of the first paragraph to keep, such as its heading",
          }),
        ),
        rationale: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  render: {
    description:
      "Render PDF pages, or an HTML page and its charts, to PNG files (at most 10 per call) and return their paths; open each with the read tool to see the page. Use it for PDF pages read reports have no text layer (scans), to check signatures, stamps, handwriting, charts or layout, and to check each chart on an HTML page makes sense. HTML renders the full page light and dark and each chart with a browser; without one, only inline SVG charts, and the result says so.",
    parameters: Type.Object(
      {
        path: Type.String({ minLength: 1 }),
        pages: Type.Optional(
          Type.String({
            maxLength: 100,
            description:
              "Pages to render, like 2-4,9 (default: from page 1); for HTML, chart numbers (default: the full page and every chart)",
          }),
        ),
      },
      { additionalProperties: false },
    ),
  },
};

function toolResult(result: DocumentResult) {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > = [];
  for (const image of result.images ?? []) {
    content.push({ type: "text", text: image.label });
    content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  content.push({ type: "text", text: result.text });
  return { content, details: result.details ?? {} };
}

/**
 * Register ONE `documents` tool over every declared format.
 *
 * Unlike channels, where each provider owns a whole conversation, a Recipe
 * reads a PDF brief and edits a Word contract in the same turn, so formats
 * share one tool and the file extension picks the adapter. A command is
 * registered when at least one format supports it; calling it on a format
 * that does not fails before the adapter runs and names the formats that do.
 */
export function registerDocumentTools(
  pi: DocumentToolHost,
  adapters: readonly DocumentAdapter[],
  options: RegisterDocumentToolsOptions,
): void {
  const byExtension = new Map<string, DocumentAdapter>();
  for (const adapter of adapters) {
    assertImplemented(adapter);
    for (const extension of adapter.extensions) {
      const key = extension.toLowerCase();
      if (byExtension.has(key)) {
        throw new Error(
          `Document formats '${byExtension.get(key)!.format}' and '${adapter.format}' both open ${key}`,
        );
      }
      byExtension.set(key, adapter);
    }
  }
  const supported = new Set(
    adapters.flatMap((adapter) => documentCommandsFor(adapter.capabilities)),
  );
  for (const command of options.commands ?? []) {
    if (!supported.has(command))
      throw new Error(`Unsupported documents command: ${command}`);
  }
  const selected = DOCUMENT_COMMANDS.filter(
    (command) =>
      supported.has(command) &&
      (options.commands ?? [...supported]).includes(command),
  );
  if (selected.length === 0) return;

  const cwd = resolve(options.cwd);
  const outputsDir = resolve(options.outputsDir ?? join(cwd, "outputs"));
  /** Files this tool saved in this session: the only existing files it may write over. */
  const written = new Set<string>();
  let pagesDir: string | undefined = options.pagesDir
    ? resolve(options.pagesDir)
    : undefined;
  /** A fresh directory per render call, so pages of two documents with the same name never collide. */
  const renderDir = async (source: string): Promise<string> => {
    pagesDir ??= await mkdtemp(join(tmpdir(), "recipe-documents-pages-"));
    await mkdir(pagesDir, { recursive: true });
    return mkdtemp(join(pagesDir, `${basename(source, extname(source))}-`));
  };

  const adapterFor = (
    path: string,
    command: DocumentCommand,
  ): DocumentAdapter => {
    const extension = extname(path).toLowerCase();
    const adapter = byExtension.get(extension);
    if (!adapter) {
      throw new Error(
        `documents doesn't open ${extension || "files without an extension"}; it opens ${[...byExtension.keys()].join(", ")}`,
      );
    }
    if (!documentCommandsFor(adapter.capabilities).includes(command)) {
      const formats = adapters.filter((other) =>
        documentCommandsFor(other.capabilities).includes(command),
      );
      throw new Error(
        `${command} is not supported for ${adapter.format} files${formats.length ? `; it is for ${formats.map((other) => other.format).join(", ")}` : ""}`,
      );
    }
    return adapter;
  };

  const outputFor = async (
    source: string,
    output: unknown,
  ): Promise<string> => {
    const target = output === undefined ? source : workspacePath(output, cwd);
    // An in-place write may only target a file this tool saved in this session,
    // wherever it lives: never a source document, an upload, or an earlier result.
    if (target === source && !written.has(source)) {
      throw new Error(
        `Pass output: a new file under ${relative(cwd, outputsDir) || outputsDir}/. ` +
          "documents edits in place only a file it wrote in this session; the original is never changed.",
      );
    }
    // Both must hold: the path as written, and where it really resolves (a link inside outputs/ can point elsewhere).
    if (
      !inside(outputsDir, target) ||
      !inside(real(outputsDir), real(target))
    ) {
      throw new Error(
        `output must be under ${relative(cwd, outputsDir) || outputsDir}/`,
      );
    }
    if (extname(target).toLowerCase() !== extname(source).toLowerCase()) {
      throw new Error(`output must keep the ${extname(source)} extension`);
    }
    if (!written.has(target)) {
      try {
        realpathSync(target);
        throw new Error(
          `${relative(cwd, target)} already exists and this tool didn't write it: choose a new output`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await mkdir(dirname(target), { recursive: true });
    return target;
  };

  const variants = selected.map((command) => {
    const definition = DEFINITIONS[command];
    return Type.Object(
      { command: Type.Literal(command), ...definition.parameters.properties },
      { additionalProperties: false, description: definition.description },
    );
  });
  // Providers expect a top-level object. Branches retain command-specific required fields.
  const fields = new Map<string, TSchema[]>();
  for (const variant of variants) {
    for (const [key, schema] of Object.entries(variant.properties)) {
      const known = fields.get(key) ?? [];
      if (
        !known.some((other) => JSON.stringify(other) === JSON.stringify(schema))
      )
        known.push(schema);
      fields.set(key, known);
    }
  }
  const properties = Object.fromEntries(
    [...fields].map(([key, schemas]) => {
      const union = schemas.length === 1 ? schemas[0]! : Type.Union(schemas);
      return [key, key === "command" ? union : Type.Optional(union)];
    }),
  );
  const parameters = Type.Object(properties, {
    additionalProperties: false,
    anyOf: variants,
  });

  pi.registerTool({
    name: "documents",
    label: "Documents",
    description:
      `Read and mark up documents (${adapters.map((adapter) => `${adapter.format}: ${adapter.extensions.join(", ")}`).join("; ")}). ` +
      "Choose a command. Results are compact; read the document again after changing it. " +
      selected
        .map((command) => `${command}: ${DEFINITIONS[command].description}`)
        .join("\n"),
    parameters,
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: { command: DocumentCommand } & Record<string, unknown>,
      signal?: AbortSignal,
    ) {
      if (!Check(parameters, params)) {
        throw new Error(
          "Invalid documents command or arguments; follow the command schema.",
        );
      }
      const { command, ...input } = params;
      const source = workspacePath(input.path, cwd);
      const adapter = adapterFor(source, command);
      const ctx: DocumentAdapterContext = { cwd, signal };
      let result: DocumentResult;
      if (WRITE_COMMANDS.has(command)) {
        const output = await outputFor(source, input.output);
        const call = { ...input, source, output } as never;
        result = await (
          adapter[METHOD[command]] as (
            ctx: DocumentAdapterContext,
            input: never,
          ) => Promise<DocumentResult>
        )(ctx, call);
        written.add(output);
        result = {
          ...result,
          details: { ...result.details, output: relative(cwd, output) },
        };
      } else {
        result = await (
          adapter[METHOD[command]] as (
            ctx: DocumentAdapterContext,
            input: never,
          ) => Promise<DocumentResult>
        )(
          ctx,
          (command === "render"
            ? { ...input, path: source, outputDir: await renderDir(source) }
            : { ...input, path: source }) as never,
        );
      }
      return toolResult(result);
    },
  } as never);
}
