import { record, text } from "./common.js";

function marks(value: string, node: Record<string, unknown>): string {
  let out = value;
  for (const raw of Array.isArray(node.marks) ? node.marks : []) {
    const mark = record(raw);
    switch (mark.type) {
      case "strong":
        out = `**${out}**`;
        break;
      case "em":
        out = `*${out}*`;
        break;
      case "strike":
        out = `~~${out}~~`;
        break;
      case "code":
        out = `\`${out}\``;
        break;
      case "link": {
        const href = text(record(mark.attrs).href);
        if (href) out = `[${out}](${href})`;
        break;
      }
    }
  }
  return out;
}

function inline(nodes: unknown): string {
  return (Array.isArray(nodes) ? nodes : [])
    .map((raw) => {
      const node = record(raw);
      const attrs = record(node.attrs);
      switch (node.type) {
        case "text":
          return marks(typeof node.text === "string" ? node.text : "", node);
        case "hardBreak":
          return "\n";
        case "mention":
          return text(attrs.text) ?? "@someone";
        case "emoji":
          return text(attrs.text) ?? text(attrs.shortName) ?? "";
        case "inlineCard":
          return text(attrs.url) ?? "";
        case "status":
          return text(attrs.text) ?? "";
        case "date":
          return text(attrs.timestamp)
            ? new Date(Number(attrs.timestamp)).toISOString().slice(0, 10)
            : "";
        default:
          return inline(node.content);
      }
    })
    .join("");
}

function block(raw: unknown, indent = ""): string {
  const node = record(raw);
  const children = Array.isArray(node.content) ? node.content : [];
  switch (node.type) {
    case "paragraph":
      return indent + inline(children);
    case "heading": {
      const level = Number(record(node.attrs).level) || 1;
      return `${"#".repeat(Math.min(Math.max(level, 1), 6))} ${inline(children)}`;
    }
    case "bulletList":
    case "orderedList":
      return children
        .map((item, index) => {
          const bullet = node.type === "orderedList" ? `${index + 1}. ` : "- ";
          const [first, ...rest] = (
            Array.isArray(record(item).content)
              ? (record(item).content as unknown[])
              : []
          ).map((child) => block(child, `${indent}  `).trimStart());
          return [
            `${indent}${bullet}${first ?? ""}`,
            ...rest.map((line) => `${indent}  ${line}`),
          ].join("\n");
        })
        .join("\n");
    case "codeBlock": {
      const language = text(record(node.attrs).language) ?? "";
      return `\`\`\`${language}\n${inline(children)}\n\`\`\``;
    }
    case "blockquote":
      return children
        .map((child) => block(child))
        .join("\n\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "rule":
      return "***";
    case "panel":
    case "expand":
    case "nestedExpand":
    case "layoutSection":
    case "layoutColumn":
    case "doc":
      return children.map((child) => block(child, indent)).join("\n\n");
    case "table":
      return children
        .map((row) =>
          (Array.isArray(record(row).content)
            ? (record(row).content as unknown[])
            : []
          )
            .map((cell) =>
              (Array.isArray(record(cell).content)
                ? (record(cell).content as unknown[])
                : []
              )
                .map((child) => block(child))
                .join(" "),
            )
            .join(" | "),
        )
        .map((line) => `| ${line} |`)
        .join("\n");
    default:
      return inline(children);
  }
}

/**
 * Atlassian Document Format as markdown, best-effort: paragraphs, headings,
 * lists, code, quotes, rules, tables as plain rows, and text marks. A string
 * is returned as it is, since a server may already render markdown.
 */
export function adfToMarkdown(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return block(value).trim();
}
