/**
 * The checks and preparation `signature create` runs on a `.docx` before
 * anything leaves the sandbox (`docs/signature/README.md`): no pending
 * tracked changes, no comments, and each signer's own `By:` and `Date:` lines
 * found and given an anchor of their own in the copy that is sent.
 *
 * A `.docx` is a zip of XML parts. Only `word/document.xml` is rewritten; every
 * other entry is copied byte for byte, compressed as it was.
 */

import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Zip

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  time: number;
  date: number;
  /** The compressed bytes. */
  data: Uint8Array;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/** The archive's entries, in central-directory order; undefined when it is not a zip this reader takes. */
function readZip(bytes: Uint8Array): ZipEntry[] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (
    let at = bytes.length - 22;
    at >= Math.max(0, bytes.length - 22 - 0xffff);
    at -= 1
  ) {
    if (view.getUint32(at, true) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return undefined;
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (at === 0xffffffff) return undefined;
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL)
      return undefined;
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const time = view.getUint16(at + 12, true);
    const date = view.getUint16(at + 14, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    if (compressedSize === 0xffffffff || local === 0xffffffff) return undefined;
    const name = new TextDecoder().decode(
      bytes.subarray(at + 46, at + 46 + nameLength),
    );
    if (view.getUint32(local, true) !== LOCAL) return undefined;
    const start =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    entries.push({
      name,
      method,
      flags,
      crc,
      compressedSize,
      size,
      time,
      date,
      data: bytes.subarray(start, start + compressedSize),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryBytes(entry: ZipEntry): Uint8Array {
  if (entry.method === STORED) return entry.data;
  if (entry.method === DEFLATED) return inflateRawSync(entry.data);
  throw new Error(
    `${entry.name} uses zip compression method ${entry.method}, which is not supported`,
  );
}

function deflatedEntry(base: ZipEntry, content: Uint8Array): ZipEntry {
  return {
    ...base,
    method: DEFLATED,
    // Bit 3 says sizes follow the data; this writer puts them in the header.
    flags: base.flags & ~0x0008,
    crc: crc32(content),
    size: content.length,
    data: deflateRawSync(content),
    compressedSize: 0,
  };
}

function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const size = entry.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, entry.flags & ~0x0008, true);
    local.setUint16(8, entry.method, true);
    local.setUint16(10, entry.time, true);
    local.setUint16(12, entry.date, true);
    local.setUint32(14, entry.crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, entry.size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, entry.data);
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, CENTRAL, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, entry.flags & ~0x0008, true);
    record.setUint16(10, entry.method, true);
    record.setUint16(12, entry.time, true);
    record.setUint16(14, entry.date, true);
    record.setUint32(16, entry.crc, true);
    record.setUint32(20, size, true);
    record.setUint32(24, entry.size, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    central.push(new Uint8Array(record.buffer), name);
    offset += 30 + name.length + size;
  }
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, EOCD, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return Buffer.concat([...chunks, ...central, new Uint8Array(end.buffer)]);
}

/** Build a `.docx` (or any zip) from its parts, for tests and fixtures. */
export function zipParts(parts: Readonly<Record<string, string>>): Uint8Array {
  return writeZip(
    Object.entries(parts).map(([name, text]) =>
      deflatedEntry(
        {
          name,
          method: DEFLATED,
          flags: 0x0800,
          crc: 0,
          compressedSize: 0,
          size: 0,
          time: 0,
          date: 0x21,
          data: new Uint8Array(),
        },
        new TextEncoder().encode(text),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// XML

interface Span {
  start: number;
  end: number;
}

/**
 * The outermost `<name>` elements in `xml[from, to)`, by tag depth. A tag
 * matches only on its whole name, so `w:p` never matches `w:pPr`.
 */
function elements(
  xml: string,
  name: string,
  from = 0,
  to = xml.length,
): Span[] {
  const pattern = new RegExp(`<(/?)${name}(?=[\\s>/])[^>]*?(/?)>`, "g");
  pattern.lastIndex = from;
  const spans: Span[] = [];
  let depth = 0;
  let start = -1;
  for (
    let match = pattern.exec(xml);
    match && match.index < to;
    match = pattern.exec(xml)
  ) {
    const closing = match[1] === "/";
    const selfClosing = match[2] === "/";
    if (closing) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        spans.push({ start, end: match.index + match[0].length });
        start = -1;
      }
    } else if (selfClosing) {
      if (depth === 0)
        spans.push({ start: match.index, end: match.index + match[0].length });
    } else {
      if (depth === 0) start = match.index;
      depth += 1;
    }
  }
  return spans;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X"))
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#"))
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity] ?? whole;
  });
}

/** The text a paragraph shows: its `w:t` runs and tabs, without deleted text. */
function textOf(xml: string, span: Span): string {
  const part = xml.slice(span.start, span.end);
  let text = "";
  for (const match of part.matchAll(
    /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>/g,
  ))
    text += match[1] === undefined ? "\t" : decode(match[1]);
  return text;
}

/** Folded for matching: whitespace collapsed, non-breaking spaces as spaces, lower case. */
function fold(text: string): string {
  return text
    .replace(/[\s\u00a0\u2007\u202f]+/g, " ")
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Readiness

/** The parts that can carry tracked changes. */
const CONTENT_PART =
  /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

/** Revision marks: insertions, deletions, moves, and property and table changes. */
const REVISION =
  /<w:(ins|del|moveFrom|moveTo|cellIns|cellDel|cellMerge|rPrChange|pPrChange|sectPrChange|tblPrChange|tblGridChange|trPrChange|tcPrChange|tblPrExChange|numberingChange)(?=[\s>/])/g;

export interface DocxReadiness {
  /** Tracked changes still pending, across every content part. */
  trackedChanges: number;
  /** Comments in the file, open or resolved. */
  comments: number;
}

/** A document `create` refuses; it carries the family's error, as a provider's does. */
class DocxError extends Error {
  readonly signature: {
    code: "not_ready" | "anchor_not_found" | "ambiguous";
    message: string;
  };
  constructor(
    readonly code: "not_ready" | "anchor_not_found" | "ambiguous",
    message: string,
  ) {
    super(message);
    this.name = "DocxError";
    this.signature = { code, message };
  }
}

interface Docx {
  entries: ZipEntry[];
  part(name: string): string | undefined;
}

function openDocx(bytes: Uint8Array): Docx {
  const entries = readZip(bytes);
  if (!entries || !entries.some((entry) => entry.name === "word/document.xml"))
    throw new DocxError(
      "not_ready",
      "The file is not a Word document (.docx): it has no word/document.xml.",
    );
  const cache = new Map<string, string>();
  return {
    entries,
    part(name) {
      if (!cache.has(name)) {
        const entry = entries.find((candidate) => candidate.name === name);
        if (!entry) return undefined;
        cache.set(name, new TextDecoder().decode(entryBytes(entry)));
      }
      return cache.get(name);
    },
  };
}

function readiness(docx: Docx): DocxReadiness {
  let trackedChanges = 0;
  for (const entry of docx.entries) {
    if (!CONTENT_PART.test(entry.name)) continue;
    trackedChanges += docx.part(entry.name)!.match(REVISION)?.length ?? 0;
  }
  const commentsPart = docx.part("word/comments.xml") ?? "";
  const comments = Math.max(
    commentsPart.match(/<w:comment(?=[\s>/])/g)?.length ?? 0,
    docx.part("word/document.xml")!.match(/<w:commentReference(?=[\s>/])/g)
      ?.length ?? 0,
  );
  return { trackedChanges, comments };
}

/** What `create` would refuse in this file: its tracked changes and comments. */
export function docxReadiness(bytes: Uint8Array): DocxReadiness {
  return readiness(openDocx(bytes));
}

// ---------------------------------------------------------------------------
// Signature lines

interface Cell {
  /** The cell's first grid column, counting each earlier cell's `gridSpan`. */
  column: number;
  /** Its own paragraphs, not those of a table nested in it. */
  paragraphs: Span[];
}

interface Table {
  rows: Cell[][];
}

function tablesIn(xml: string, from: number, to: number): Table[] {
  const tables: Table[] = [];
  for (const table of elements(xml, "w:tbl", from, to)) {
    const rows: Cell[][] = [];
    for (const row of elements(xml, "w:tr", table.start, table.end)) {
      const cells: Cell[] = [];
      let column = 0;
      for (const cell of elements(xml, "w:tc", row.start, row.end)) {
        const nested = elements(xml, "w:tbl", cell.start, cell.end);
        const paragraphs = elements(xml, "w:p", cell.start, cell.end).filter(
          (paragraph) =>
            !nested.some(
              (inner) =>
                paragraph.start >= inner.start && paragraph.end <= inner.end,
            ),
        );
        cells.push({ column, paragraphs });
        const properties = xml.slice(cell.start, cell.end);
        const span = /<w:gridSpan\s+w:val="(\d+)"/.exec(properties);
        column += span ? Number(span[1]) : 1;
        tables.push(...tablesIn(xml, cell.start + 1, cell.end));
      }
      rows.push(cells);
    }
    tables.push({ rows });
  }
  return tables;
}

const labelled = (label: string) => (text: string) =>
  new RegExp(`^${label}\\s*:`).test(fold(text));
const isBy = labelled("by");
const isDate = labelled("date");

/** The signer's name on a `Name:` line, folded; undefined for any other line. */
function nameLine(text: string): string | undefined {
  const match = /^name\s*:\s*(.+)$/.exec(fold(text));
  return match?.[1]?.trim();
}

export interface DocxSigner {
  name: string;
}

interface Located {
  sign: Span;
  date?: Span;
}

function locate(xml: string, tables: Table[], signer: DocxSigner): Located {
  const wanted = fold(signer.name);
  const found: Array<{ table: Table; row: number; cell: Cell }> = [];
  for (const table of tables)
    table.rows.forEach((cells, row) => {
      for (const cell of cells)
        if (
          cell.paragraphs.some(
            (paragraph) => nameLine(textOf(xml, paragraph)) === wanted,
          )
        )
          found.push({ table, row, cell });
    });
  if (found.length === 0)
    throw new DocxError(
      "anchor_not_found",
      `No "Name: ${signer.name}" line in a table of the document. Fill in the signer's name on their side of the signature block, spelled as given here.`,
    );
  if (found.length > 1)
    throw new DocxError(
      "ambiguous",
      `"Name: ${signer.name}" is on ${found.length} lines of the signature block, so their side cannot be told apart.`,
    );
  const { table, row, cell } = found[0]!;
  const inCell = (test: (text: string) => boolean, of: Cell) =>
    of.paragraphs.find((paragraph) => test(textOf(xml, paragraph)));
  // One cell holding every line, or one line per row in the signer's column.
  const nearest = (test: (text: string) => boolean, prefer: -1 | 1) => {
    const own = inCell(test, cell);
    if (own) return own;
    const order = table.rows
      .map((cells, index) => ({ cells, index }))
      .filter(({ index }) => index !== row)
      .sort(
        (a, b) =>
          Math.abs(a.index - row) - Math.abs(b.index - row) ||
          (Math.sign(a.index - row) === prefer ? -1 : 1),
      );
    for (const { cells } of order) {
      const same = cells.find((candidate) => candidate.column === cell.column);
      const paragraph = same && inCell(test, same);
      if (paragraph) return paragraph;
    }
    return undefined;
  };
  const sign = nearest(isBy, -1);
  if (!sign)
    throw new DocxError(
      "anchor_not_found",
      `No "By:" line on ${signer.name}'s side of the signature block.`,
    );
  const date = nearest(isDate, 1);
  return { sign, ...(date ? { date } : {}) };
}

/** An invisible run: white, 1-point text DocuSign finds and a reader does not see. */
function anchorRun(anchor: string): string {
  return `<w:r><w:rPr><w:color w:val="FFFFFF"/><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr><w:t xml:space="preserve">${anchor}</w:t></w:r>`;
}

/** Where a line's anchor goes: after the run that holds its label's colon, else at its end. */
function anchorOffset(xml: string, paragraph: Span): number {
  let text = "";
  for (const run of elements(xml, "w:r", paragraph.start, paragraph.end)) {
    text += textOf(xml, run);
    if (text.includes(":")) return run.end;
  }
  return xml.lastIndexOf("</w:p>", paragraph.end);
}

export interface PreparedDocx {
  /** The copy to send: the file with each signer's anchors added. */
  bytes: Uint8Array;
  /** Per signer, in the order given. */
  placements: Array<{ sign: string; date?: string }>;
}

/**
 * Check a final `.docx` and prepare the copy to send: refuses one with
 * pending tracked changes or comments, finds each signer's `By:` and `Date:`
 * lines from their `Name:` line, and appends an anchor that occurs once
 * (`\s1\`, `\d1\`, …) to each.
 */
export function prepareDocx(
  bytes: Uint8Array,
  signers: readonly DocxSigner[],
): PreparedDocx {
  const docx = openDocx(bytes);
  const { trackedChanges, comments } = readiness(docx);
  if (trackedChanges > 0 || comments > 0) {
    const left = [
      ...(trackedChanges > 0
        ? [`${trackedChanges} tracked change${trackedChanges === 1 ? "" : "s"}`]
        : []),
      ...(comments > 0
        ? [`${comments} comment${comments === 1 ? "" : "s"}`]
        : []),
    ];
    throw new DocxError(
      "not_ready",
      `The document still has ${left.join(" and ")}. Resolve every tracked change (documents respond) and remove the comments before sending it for signature.`,
    );
  }
  const xml = docx.part("word/document.xml")!;
  const body = elements(xml, "w:body")[0] ?? { start: 0, end: xml.length };
  const tables = tablesIn(xml, body.start, body.end);
  const inserts: Array<{ at: number; run: string }> = [];
  const placements: PreparedDocx["placements"] = [];
  const used = new Set<number>();
  signers.forEach((signer, index) => {
    const located = locate(xml, tables, signer);
    if (used.has(located.sign.start))
      throw new DocxError(
        "ambiguous",
        `${signer.name}'s "By:" line is another signer's too.`,
      );
    used.add(located.sign.start);
    const sign = `\\s${index + 1}\\`;
    inserts.push({ at: anchorOffset(xml, located.sign), run: anchorRun(sign) });
    let date: string | undefined;
    if (located.date && !used.has(located.date.start)) {
      used.add(located.date.start);
      date = `\\d${index + 1}\\`;
      inserts.push({
        at: anchorOffset(xml, located.date),
        run: anchorRun(date),
      });
    }
    placements.push({ sign, ...(date ? { date } : {}) });
  });
  let prepared = xml;
  for (const { at, run } of [...inserts].sort((a, b) => b.at - a.at))
    prepared = prepared.slice(0, at) + run + prepared.slice(at);
  const entries = docx.entries.map((entry) =>
    entry.name === "word/document.xml"
      ? deflatedEntry(entry, new TextEncoder().encode(prepared))
      : entry,
  );
  return { bytes: writeZip(entries), placements };
}

/** The text of every paragraph in the main document, for tests and diagnostics. */
export function docxParagraphs(bytes: Uint8Array): string[] {
  const xml = openDocx(bytes).part("word/document.xml")!;
  return elements(xml, "w:p").map((paragraph) => textOf(xml, paragraph));
}
