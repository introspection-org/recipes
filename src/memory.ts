import { closeSync, openSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_MEMORY_INDEX_MAX_LINES = 200;
export const DEFAULT_MEMORY_INDEX_MAX_BYTES = 25_000;

export interface MemoryContextSource {
  /** Memory index path, resolved from the session cwd when relative. */
  indexPath: string;
  /** Lines loaded into the prompt. Maximum and default: 200. */
  maxLines?: number;
  /** UTF-8 bytes loaded into the prompt. Maximum and default: 25,000. */
  maxBytes?: number;
}

export interface MemoryIndex {
  filePath: string;
  baseDir: string;
  content: string;
  maxLines: number;
  maxBytes: number;
  truncated: boolean;
}

export interface MemoryDiagnostic {
  type: "warning" | "error";
  message: string;
  path?: string;
}

export interface LoadMemoryIndexResult {
  memory: MemoryIndex | null;
  diagnostics: MemoryDiagnostic[];
}

export interface LoadMemoryIndexOptions extends MemoryContextSource {
  /** Working directory used to resolve a relative indexPath. */
  cwd: string;
}

export type MemoryContextOverride = (
  base: LoadMemoryIndexResult,
) => LoadMemoryIndexResult;

export class MemoryContextConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryContextConfigError";
  }
}

function boundedLimit(
  name: "maxLines" | "maxBytes",
  value: number | undefined,
  maximum: number,
): number {
  const resolved = value ?? maximum;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new MemoryContextConfigError(
      `${name} must be an integer between 1 and ${maximum}`,
    );
  }
  return resolved;
}

function readBoundedFile(
  path: string,
  maxBytes: number,
): {
  content: string;
  truncated: boolean;
} {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = readSync(
        descriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (read === 0) break;
      bytesRead += read;
    }
    const truncated = bytesRead > maxBytes;
    const content = new StringDecoder("utf8").write(
      buffer.subarray(0, Math.min(bytesRead, maxBytes)),
    );
    return { content, truncated };
  } finally {
    closeSync(descriptor);
  }
}

function boundLines(
  content: string,
  maxLines: number,
): { content: string; truncated: boolean } {
  const lines = content.split(/\r\n|\r|\n/);
  // A final line terminator does not introduce another logical line.
  if (lines.at(-1) === "") lines.pop();
  return {
    content: (lines.length > maxLines ? lines.slice(0, maxLines) : lines).join(
      "\n",
    ),
    truncated: lines.length > maxLines,
  };
}

/** Load one bounded memory index. A missing or empty index is normal. */
export function loadMemoryIndex(
  options: LoadMemoryIndexOptions,
): LoadMemoryIndexResult {
  const maxLines = boundedLimit(
    "maxLines",
    options.maxLines,
    DEFAULT_MEMORY_INDEX_MAX_LINES,
  );
  const maxBytes = boundedLimit(
    "maxBytes",
    options.maxBytes,
    DEFAULT_MEMORY_INDEX_MAX_BYTES,
  );
  const filePath = resolve(options.cwd, options.indexPath);

  try {
    const bounded = readBoundedFile(filePath, maxBytes);
    const boundedLines = boundLines(bounded.content, maxLines);
    const content = boundedLines.content.trim();
    if (!content) return { memory: null, diagnostics: [] };

    return {
      memory: {
        filePath,
        baseDir: dirname(filePath),
        content,
        maxLines,
        maxBytes,
        truncated: bounded.truncated || boundedLines.truncated,
      },
      diagnostics: [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { memory: null, diagnostics: [] };
    }
    return {
      memory: null,
      diagnostics: [
        {
          type: "warning",
          message: `Unable to load memory index: ${error instanceof Error ? error.message : String(error)}`,
          path: filePath,
        },
      ],
    };
  }
}

function escapeXmlCharacter(value: string): string {
  switch (value) {
    case "&":
      return "&amp;";
    case "<":
      return "&lt;";
    case ">":
      return "&gt;";
    case '"':
      return "&quot;";
    case "'":
      return "&apos;";
    default:
      return value;
  }
}

function escapeXml(value: string): string {
  return Array.from(value, escapeXmlCharacter).join("");
}

function escapeXmlWithinBytes(
  value: string,
  maxBytes: number,
): { content: string; truncated: boolean } {
  const parts: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const escaped = escapeXmlCharacter(character);
    const escapedBytes = Buffer.byteLength(escaped, "utf8");
    if (bytes + escapedBytes > maxBytes) {
      return { content: parts.join(""), truncated: true };
    }
    parts.push(escaped);
    bytes += escapedBytes;
  }
  return { content: parts.join(""), truncated: false };
}

/** Format durable memory for the system prompt, following Pi's skill renderer. */
export function formatMemoryForPrompt(memory: MemoryIndex | null): string {
  if (!memory) return "";

  const maxLines = boundedLimit(
    "maxLines",
    memory.maxLines,
    DEFAULT_MEMORY_INDEX_MAX_LINES,
  );
  const maxBytes = boundedLimit(
    "maxBytes",
    memory.maxBytes,
    DEFAULT_MEMORY_INDEX_MAX_BYTES,
  );
  const boundedLines = boundLines(memory.content, maxLines);
  const escaped = escapeXmlWithinBytes(boundedLines.content, maxBytes);
  const truncated =
    memory.truncated || boundedLines.truncated || escaped.truncated;
  const suffix = maxBytes >= 3 ? "..." : ".".repeat(maxBytes);
  const content = truncated
    ? escapeXmlWithinBytes(
        boundedLines.content,
        maxBytes - Buffer.byteLength(suffix, "utf8"),
      ).content + suffix
    : escaped.content;
  return [
    "\n\nThe following memories contain durable context and preferences that should inform your work:",
    "",
    "<memories>",
    "  <memory>",
    `    <location>${escapeXml(memory.filePath)}</location>`,
    "    <content>",
    content,
    "    </content>",
    "  </memory>",
    "</memories>",
  ].join("\n");
}
