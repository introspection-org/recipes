// The formats a tool answers in, as `introspection bindings mcp observe` names them: `json`,
// `toon`, `prefixed_json` (JSON between fixed text) and `text`. A fake writes its answers with
// `encode` and the readers decode them back, so no fake brings its own codec.
import { decode as decodeToon, encode as encodeToon } from "@toon-format/toon";
import type { Answer } from "./contract.js";

/** The formats `encode` and `decode` know. */
export const FORMATS = ["json", "toon", "prefixed_json", "text"] as const;

// An answer's value as the text the server sends. TOON is spec 3.0, which @toon-format/toon
// writes up to 2.2.0; hence the exact pin in package.json.
export function encode(answer: Answer, value: unknown): string {
  if (answer.format === "text") return String(value);
  if (answer.format === "json") return JSON.stringify(value);
  if (answer.format === "prefixed_json")
    return `${answer.prefix ?? ""}${JSON.stringify(value)}${answer.suffix ?? ""}`;
  if (answer.format === "toon") return encodeToon(value as never);
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
