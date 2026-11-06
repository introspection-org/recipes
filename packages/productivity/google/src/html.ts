const NAMED_ENTITIES: Record<string, string> = {
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
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  zwnj: "",
  zwj: "",
};

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
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
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(
    `\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  if (!match) return undefined;
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
}

// Stand-ins for a link's angle brackets while tags are still being stripped.
const LINK_OPEN = "\u0001";
const LINK_CLOSE = "\u0002";

const BLOCK_TAGS =
  /^(p|div|br|tr|table|ul|ol|h[1-6]|blockquote|pre|section|article|header|footer|hr)$/;

/**
 * HTML mail as plain text. Remote content goes: images (and so tracking
 * pixels), stylesheets, scripts, embedded frames and objects are dropped
 * without a trace, never fetched. A link keeps its text and, when that
 * differs, its address in angle brackets, which is content to read, not to
 * load.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/[\u0001\u0002]/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(script|style|head|title|iframe|object|embed|svg|noscript|template)\b[\s\S]*?<\/\1\s*>/gi,
      "",
    )
    .replace(/<(img|link|meta|source|video|audio|picture|base)\b[^>]*>/gi, "");
  text = text.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi,
    (_match, attrs: string, inner: string) => {
      const label = inner.replace(/<[^>]*>/g, "").trim();
      const href = attribute(` ${attrs}`, "href");
      if (!href || !/^(https?:|mailto:)/i.test(href)) return label;
      const shown = decodeEntities(label);
      const address = href.replace(/^mailto:/i, "");
      return shown && shown !== address && shown !== href
        ? `${label} ${LINK_OPEN}${href}${LINK_CLOSE}`
        : href;
    },
  );
  text = text.replace(
    /<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi,
    (_m, close: string, tag: string) => {
      const name = tag.toLowerCase();
      if (name === "li") return close ? "" : "\n- ";
      if (name === "td" || name === "th") return close ? "\t" : "";
      return BLOCK_TAGS.test(name) ? "\n" : "";
    },
  );
  text = decodeEntities(text.replace(/<[^>]*>/g, ""))
    .replaceAll(LINK_OPEN, "<")
    .replaceAll(LINK_CLOSE, ">");
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
