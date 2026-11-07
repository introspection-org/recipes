import type { ProductivityContent } from "./types.js";

/** The most characters of a mail or event body a result carries. */
export const BODY_LIMIT_CHARS = 20_000;

/** The most characters of a file's text `drive read` returns. */
export const FILE_TEXT_LIMIT_CHARS = 100_000;

/** Text as a result carries it: plain, and capped at a limit the result states. */
export interface ProductivityText {
  text: string;
  /** Whether `text` was cut at `limit_chars`. */
  truncated: boolean;
  limit_chars: number;
  /** The length before cutting, when it was cut. */
  original_chars?: number;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  zwnj: "",
  zwj: "",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi,
    (match, entity: string) => {
      if (entity[0] === "#") {
        const code =
          entity[1] === "x" || entity[1] === "X"
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : "";
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

/**
 * HTML to plain text for the model. Scripts, styles, comments and images
 * (tracking pixels and remote content) are dropped; a link keeps its text and,
 * when it differs, its address; block elements become line breaks.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(head|script|style|noscript|template|svg|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      "",
    )
    .replace(/<img\b[^>]*>/gi, "")
    .replace(
      /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_match, _raw, dq?: string, sq?: string, bare?: string, inner = "") => {
        const href = decodeEntities(dq ?? sq ?? bare ?? "").trim();
        const label = inner.replace(/<[^>]*>/g, "").trim();
        if (!/^(https?:|mailto:)/i.test(href)) return label;
        const shown = href.replace(/^mailto:/i, "");
        return !label || decodeEntities(label) === shown
          ? shown
          : `${label} (${shown})`;
      },
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(td|th)\s*>/gi, "\t")
    .replace(
      /<\/?(p|div|tr|table|h[1-6]|ul|ol|blockquote|pre|section|article|header|footer|hr)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]*>/g, "");
  text = decodeEntities(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** Cut text at `limit` characters, saying so. */
export function capText(text: string, limit: number): ProductivityText {
  if (text.length <= limit)
    return { text, truncated: false, limit_chars: limit };
  return {
    text: text.slice(0, limit),
    truncated: true,
    limit_chars: limit,
    original_chars: text.length,
  };
}

/** A provider's content as capped plain text. */
export function contentText(
  content: ProductivityContent | undefined,
  limit: number,
): ProductivityText | undefined {
  if (!content) return undefined;
  const text =
    content.content_type === "html"
      ? htmlToText(content.content)
      : content.content.replace(/\r\n?/g, "\n").trim();
  return capText(text, limit);
}
