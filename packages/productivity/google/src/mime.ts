import { htmlToText } from "./html.js";

/** A Gmail `MessagePart` (gmail/v1 discovery, schema `MessagePart`). */
export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePart[];
}

/** Gmail's `data` fields are base64url (RFC 4648 §5), padded or not. */
export function decodeBase64Url(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64url"));
}

export function encodeBase64Url(data: Uint8Array | string): string {
  return Buffer.from(data).toString("base64url");
}

/** Decode bytes in a MIME charset, falling back to UTF-8 for one Node does not know. */
function decodeCharset(bytes: Uint8Array, charset?: string): string {
  const label = (charset ?? "utf-8").trim().replace(/^"|"$/g, "").toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function quotedPrintableBytes(
  text: string,
  underscoreIsSpace: boolean,
): Uint8Array {
  const out: number[] = [];
  const source = underscoreIsSpace ? text.replace(/_/g, " ") : text;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === "=" && /^[0-9a-f]{2}$/i.test(source.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(source.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (
      char === "=" &&
      source[i + 1] === "\r" &&
      source[i + 2] === "\n"
    ) {
      i += 2;
    } else if (char === "=" && source[i + 1] === "\n") {
      i += 1;
    } else {
      out.push(...Buffer.from(char, "utf8"));
    }
  }
  return new Uint8Array(out);
}

/** Decode RFC 2047 encoded-words (`=?charset?B|Q?…?=`) in a header value. */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?[^?]+\?[bq]\?)/gi, "$1")
    .replace(
      /=\?([^?*]+)(?:\*[^?]*)?\?([bq])\?([^?]*)\?=/gi,
      (_match, charset: string, encoding: string, text: string) => {
        const bytes =
          encoding.toLowerCase() === "b"
            ? new Uint8Array(Buffer.from(text, "base64"))
            : quotedPrintableBytes(text, true);
        return decodeCharset(bytes, charset);
      },
    );
}

export function header(
  part: GmailMessagePart | undefined,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  const value = part?.headers?.find(
    (h) => h.name?.toLowerCase() === lower,
  )?.value;
  return value === undefined ? undefined : decodeEncodedWords(value);
}

/** A parameter of a structured header such as `Content-Type: text/plain; charset=…`. */
function headerParameter(
  value: string | undefined,
  name: string,
): string | undefined {
  if (!value) return undefined;
  const match = new RegExp(
    `;\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`,
    "i",
  ).exec(value);
  return match ? (match[2] ?? match[1]) : undefined;
}

interface ParsedAttachment {
  /** Gmail's `partId`; stable across fetches, unlike `attachmentId`. */
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface ParsedMailBody {
  text: string;
  /** Whether the text was converted from the message's HTML part. */
  fromHtml: boolean;
  attachments: ParsedAttachment[];
}

function isAttachment(part: GmailMessagePart): boolean {
  if (part.filename) return true;
  return /^\s*attachment\b/i.test(header(part, "Content-Disposition") ?? "");
}

function partText(part: GmailMessagePart): string {
  const data = part.body?.data;
  if (!data) return "";
  const charset = headerParameter(header(part, "Content-Type"), "charset");
  return decodeCharset(decodeBase64Url(data), charset);
}

function walk(
  part: GmailMessagePart,
  visit: (part: GmailMessagePart) => void,
): void {
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

/**
 * A Gmail message payload as text: its first `text/plain` body part, or its
 * first `text/html` part converted to text when it has none. Gmail has
 * already undone the transfer encoding; the part data is base64url bytes in
 * the part's charset. Parts with a file name or an attachment disposition are
 * listed, not read.
 */
export function parseMailPayload(
  payload: GmailMessagePart | undefined,
): ParsedMailBody {
  let plain: GmailMessagePart | undefined;
  let html: GmailMessagePart | undefined;
  const attachments: ParsedAttachment[] = [];
  if (payload) {
    walk(payload, (part) => {
      const type = (part.mimeType ?? "").toLowerCase();
      if (isAttachment(part)) {
        if (part.partId !== undefined) {
          attachments.push({
            partId: part.partId,
            filename: part.filename || "attachment",
            mimeType: part.mimeType ?? "application/octet-stream",
            size: part.body?.size ?? 0,
          });
        }
        return;
      }
      if (type === "text/plain" && !plain) plain = part;
      if (type === "text/html" && !html) html = part;
    });
  }
  if (plain) return { text: partText(plain), fromHtml: false, attachments };
  if (html)
    return { text: htmlToText(partText(html)), fromHtml: true, attachments };
  return { text: "", fromHtml: false, attachments };
}

export function findPart(
  payload: GmailMessagePart | undefined,
  partId: string,
): GmailMessagePart | undefined {
  let found: GmailMessagePart | undefined;
  if (payload)
    walk(payload, (part) => {
      if (!found && part.partId === partId) found = part;
    });
  return found;
}

/** Split an address list header into addresses, keeping display names. */
export function splitAddresses(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    else if (char === "<" && !quoted) angle += 1;
    else if (char === ">" && !quoted) angle = Math.max(0, angle - 1);
    if (char === "," && !quoted && angle === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
