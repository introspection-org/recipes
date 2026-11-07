import { GoogleProductivityError } from "./errors.js";
import { encodeBase64Url } from "./mime.js";

export interface ComposedDraft {
  to: string[];
  cc?: string[];
  subject: string;
  /** Markdown, sent as the `text/plain` body. */
  body: string;
  /** Send `body` as `text/html`: an HTML draft's body kept as it was. */
  html?: boolean;
  /** The message replied to: its `Message-ID` and `References`. */
  inReplyTo?: { messageId?: string; references?: string };
}

function safeHeaderValue(name: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new GoogleProductivityError(
      "invalid_request",
      `${name} must not contain a line break.`,
    );
  }
  return value;
}

/** RFC 2047 B-encoding for a header value that is not plain ASCII. */
function encodeHeaderText(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function addressList(name: string, addresses: string[]): string {
  return addresses
    .map((address) => safeHeaderValue(name, address.trim()))
    .filter(Boolean)
    .join(", ");
}

function wrapBase64(text: string): string {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

/**
 * An RFC 5322 message for `users.drafts.create` / `update`, as the base64url
 * `raw` Gmail takes. Header values are refused when they carry a line break,
 * so an argument cannot add a header (a `Bcc`, say) of its own.
 */
export function composeRawMessage(draft: ComposedDraft): string {
  if (draft.to.length === 0) {
    throw new GoogleProductivityError(
      "invalid_request",
      "A draft needs at least one recipient in `to`.",
    );
  }
  const lines = [
    `To: ${addressList("to", draft.to)}`,
    ...(draft.cc?.length ? [`Cc: ${addressList("cc", draft.cc)}`] : []),
    `Subject: ${encodeHeaderText(safeHeaderValue("subject", draft.subject))}`,
  ];
  const parent = draft.inReplyTo?.messageId?.trim();
  if (parent) {
    const references = [draft.inReplyTo?.references?.trim(), parent]
      .filter(Boolean)
      .join(" ");
    lines.push(
      `In-Reply-To: ${safeHeaderValue("In-Reply-To", parent)}`,
      `References: ${safeHeaderValue("References", references)}`,
    );
  }
  lines.push(
    "MIME-Version: 1.0",
    `Content-Type: text/${draft.html ? "html" : "plain"}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(draft.body),
  );
  return encodeBase64Url(lines.join("\r\n"));
}

/** `Re: ` once, for a reply's default subject. */
export function replySubject(subject: string | undefined): string {
  const base = subject?.trim() ?? "";
  return /^re:/i.test(base) ? base : `Re: ${base}`.trim();
}
