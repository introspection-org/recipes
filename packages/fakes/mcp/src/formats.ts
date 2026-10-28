// The formats a tool answers in, as `introspection bindings mcp observe` names them: `json`,
// `toon`, `prefixed_json` (JSON between fixed text) and `text`. A fake writes its answers with
// `encode` and the readers decode them back, so no fake brings its own codec.
import { decode as decodeToon, encode as encodeToonLibrary } from "@toon-format/toon";
import type { Answer } from "./contract.js";

/** The formats `encode` and `decode` know. */
export const FORMATS = ["json", "toon", "prefixed_json", "text"] as const;

// A value as TOON the way the real server's encoder writes it. From 2.3, @toon-format/toon writes
// an empty array under a key or at the root as `key: []` / `[]`, the form TOON spec 3.3 prefers;
// the spec still allows the length form `key[0]:` / `[0]:` (section 9.1), which the real server
// writes and toon-python reads (it decodes `[]` as a string), so it is rewritten to that. A string
// "[]" is always quoted, and an empty array as a list item is already written `- [0]:`.
export function encodeToon(value: unknown): string {
  return encodeToonLibrary(value as never)
    .replace(/^(\s*(?:- )?)((?:"(?:[^"\\]|\\.)*"|[^\s:"][^:]*?)?): \[\]$/gm, "$1$2[0]:")
    .replace(/^\[\]$/, "[0]:");
}

// An answer's value as the text the server sends.
export function encode(answer: Answer, value: unknown): string {
  if (answer.format === "text") return String(value);
  if (answer.format === "json") return JSON.stringify(value);
  if (answer.format === "prefixed_json")
    return `${answer.prefix ?? ""}${JSON.stringify(value)}${answer.suffix ?? ""}`;
  if (answer.format === "toon") return encodeToon(value);
  throw new Error(`no format ${answer.format}`);
}

// An answer's text as its value. Throws for text that is not in the answer's format.
export function decode(answer: Answer, text: string): unknown {
  if (answer.format === "text") return text;
  if (answer.format === "json") return JSON.parse(text);
  if (answer.format === "prefixed_json") {
    if (!answer.prefix || !text.startsWith(answer.prefix))
      throw new Error(`the answer does not start with ${JSON.stringify(answer.prefix)}`);
    const suffix = answer.suffix ?? "";
    if (!text.endsWith(suffix) || text.length - suffix.length < answer.prefix.length)
      throw new Error(`the answer does not end with ${JSON.stringify(suffix)}`);
    return JSON.parse(text.slice(answer.prefix.length, text.length - suffix.length));
  }
  if (answer.format === "toon") return decodeToon(text);
  throw new Error(`no format ${answer.format}`);
}
