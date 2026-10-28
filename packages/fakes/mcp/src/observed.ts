// A fake's recorded answers against what the real server answered, as `observed.ts` records it:
// a wrong type, format or result format fails; a key every sample held fails when missing only
// once the tool was sampled REQUIRED_MIN_SAMPLES times; an extra key is allowed; a key the
// observed schema masked is held to its `x-masked-values` only once sampled as often. TOON is also held to how the TOON
// encoder writes it wherever every observed result was, prefixed JSON to its observed text
// before and after the JSON, and other text to its observed first line only.
import { decode as decodeToon, encode as encodeToon } from "@toon-format/toon";
import type { Entry, Observed, ObservedAnswer } from "./contract.js";
import type { RecordedCall } from "./server.js";

/**
 * A key present in every sample is required of a fake, and a masked key's value held to its
 * `x-masked-values`, only when the tool was sampled this often.
 */
export const REQUIRED_MIN_SAMPLES = 3;

// The string formats `observe` names, tried in its order.
const STRING_FORMATS: [string, RegExp][] = [
  ["uuid", /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/],
  ["email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/],
  ["date-time", /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/],
  ["date", /^\d{4}-\d{2}-\d{2}$/],
  ["url", /^[a-z][a-z0-9+.-]*:\/\/\S+$/i],
];

function stringFormat(value: string): string | undefined {
  let text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  return STRING_FORMATS.find(([, pattern]) => pattern.test(text))?.[0];
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** The part of an observed schema the check reads. */
interface ObservedSchema {
  type?: string | string[];
  format?: string;
  properties?: Record<string, ObservedSchema>;
  required?: string[];
  "x-masked-values"?: ObservedSchema;
  items?: ObservedSchema;
}

function validate(value: unknown, schema: ObservedSchema, path: string, firm: boolean): string[] {
  const types = schema.type === undefined ? [] : [schema.type].flat();
  const actual = typeOf(value);
  const ok =
    typeof value === "number"
      ? types.includes("number") || (Number.isInteger(value) && types.includes("integer"))
      : types.includes(actual);
  if (types.length && !ok) return [`${path}: type ${actual}, observed ${types.join("|")}`];
  const fails: string[] = [];
  if (typeof value === "string" && schema.format) {
    const format = stringFormat(value);
    if (format !== schema.format)
      fails.push(`${path}: format ${format ?? "none"}, observed ${schema.format}`);
  }
  if (actual === "object") {
    const map = value as Record<string, unknown>;
    if (firm)
      for (const key of schema.required ?? [])
        if (!Object.hasOwn(map, key)) fails.push(`${path}.${key}: missing, observed in every sample`);
    for (const [key, child] of Object.entries(map)) {
      const property = schema.properties?.[key];
      if (property) fails.push(...validate(child, property, `${path}.${key}`, firm));
      else if (firm && schema["x-masked-values"])
        fails.push(...validate(child, schema["x-masked-values"], `${path}.<masked>`, firm));
    }
  }
  if (Array.isArray(value) && schema.items)
    for (const item of value) fails.push(...validate(item, schema.items, `${path}[]`, firm));
  return fails;
}

// Masked text as a pattern of the whole text: each `<...>` placeholder `observe` masked a value
// with matches any text, and a space any run of whitespace. `observe` cuts a masked text longer
// than 240 characters and ends it with `...`, so a masked text ending so matches any text it
// begins.
function maskedPattern(masked: string): RegExp {
  const trimmed = masked.trim();
  const cut = trimmed.endsWith("...");
  const parts = (cut ? trimmed.slice(0, -3) : trimmed)
    .trimEnd()
    .split(/<[^<>]+>/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  return new RegExp(`^${parts.join(".*")}${cut ? "" : "$"}`, "s");
}

// The end of the JSON object or array opening at `start`, past its closing bracket; none when
// its brackets never close.
function jsonEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "{" || ch === "[") depth++;
    else if ((ch === "}" || ch === "]") && --depth === 0) return i + 1;
  }
  return undefined;
}

// The JSON value inside other text, as `observe` finds it: the first object, or array holding an
// object, that opens after the start; with the trimmed text before and after it.
function prefixedJson(text: string): { value: unknown; prefix: string; suffix: string } | undefined {
  const s = text.trim();
  for (let i = 1; i < s.length; i++) {
    if (s[i] !== "{" && s[i] !== "[") continue;
    const end = jsonEnd(s, i);
    if (end === undefined) continue;
    let value: unknown;
    try {
      value = JSON.parse(s.slice(i, end));
    } catch {
      continue;
    }
    const structured =
      typeOf(value) === "object" ||
      (Array.isArray(value) && value.some((item) => typeOf(item) === "object"));
    if (structured) return { value, prefix: s.slice(0, i).trim(), suffix: s.slice(end).trim() };
  }
  return undefined;
}

// Whether `text` reads as the observed masked text or one of its observed alternatives.
const matchesAny = (text: string, observed: (string | undefined)[]) =>
  observed.some((masked) => masked !== undefined && maskedPattern(masked).test(text));

// The first line of `text` where it differs from how the TOON encoder writes `value`, counted from
// 1; none when it is written exactly so.
function toonDifference(text: string, value: unknown): number | undefined {
  const canonical = encodeToon(value);
  if (canonical === text) return undefined;
  const written = text.split("\n");
  const wanted = canonical.split("\n");
  const line = written.findIndex((item, i) => item !== wanted[i]);
  return (line === -1 ? written.length : line) + 1;
}

// A text answer's first line against the observed first lines; nothing to hold it to when none
// was observed.
function textDifferences(answer: ObservedAnswer, text: string): string[] {
  const observed = [answer.prefix, ...(answer.prefixes ?? [])];
  if (observed.every((line) => line === undefined)) return [];
  const first = text.trim().split("\n")[0];
  return matchesAny(first, observed) ? [] : [`first line differs, observed ${answer.prefix}`];
}

/** The arguments that carry a code-mode tool's HTTP method and path, as dotted paths. */
export type CodeMode = { method: string; path: string };

// The bucket `observe` counts a call whose path matches no `api.json` template in.
const UNMATCHED_OPERATION = "<unmatched>";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const lookup = (value: unknown, dotted: string) =>
  dotted
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      value,
    );

const segments = (path: string) => path.split("/").filter(Boolean);

// The template a concrete path matches, the one with the most literal segments, as `observe`
// matches `api.json`'s; a server's base path before it is allowed.
function matchTemplate(path: string, templates: string[]): string | undefined {
  const actual = segments(path.split(/[?#]/)[0]);
  let best: { template: string; literal: number; offset: number } | undefined;
  for (const template of templates) {
    const wanted = segments(template);
    if (wanted.length > actual.length) continue;
    const offset = actual.length - wanted.length;
    const fits = wanted.every(
      (w, i) => (w.startsWith("{") && w.endsWith("}")) || w === actual[offset + i],
    );
    if (!fits) continue;
    const literal = wanted.filter((w) => !w.startsWith("{")).length;
    if (!best || literal > best.literal || (literal === best.literal && offset < best.offset))
      best = { template, literal, offset };
  }
  return best?.template;
}

/**
 * The observation a code-mode tool's call is held to: the operation its method and path arguments
 * select, keyed `METHOD /template` as `observe` keys it, matched against the templates observed.
 * The tool's own observation for a call that selects no observed operation with an answer, and
 * for a tool that is not code-mode.
 */
export function operationOf(
  observed: Observed,
  mode: CodeMode | undefined,
  args: unknown,
): Observed {
  if (!mode || !observed.operations) return observed;
  const keys = Object.keys(observed.operations).filter((key) => key !== UNMATCHED_OPERATION);
  const path = lookup(args, mode.path);
  const templates = keys.map((key) => key.slice(key.indexOf(" ") + 1));
  const template = typeof path === "string" ? matchTemplate(path, templates) : undefined;
  if (template === undefined) return observed;
  const sent = lookup(args, mode.method);
  const method =
    typeof sent === "string" && METHODS.includes(sent.toUpperCase()) ? sent.toUpperCase() : "<str>";
  const operation = observed.operations[`${method} ${template}`];
  return operation?.answer ? operation : observed;
}

/** A recorded call's text items, joined, and its structuredContent, unless it is an error. */
export function successful(call: RecordedCall): { text: string; structured?: unknown } | undefined {
  const result = call.result as {
    error?: unknown;
    isError?: boolean;
    content?: { type: string; text?: string }[];
    structuredContent?: unknown;
  };
  if (!result || result.error !== undefined || result.isError === true) return undefined;
  const text = (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
  return { text, structured: result.structuredContent };
}

/**
 * Where one successful answer differs from the observed one: its decoded value against the
 * observed answer's format and schema. A tool that states an outputSchema, or an answer with an
 * object in its structuredContent, is read from that structuredContent as a json answer, as
 * `observe` read the real server.
 */
export function differences(
  observed: Observed,
  entry: Entry | undefined,
  result: { text: string; structured?: unknown },
): string[] {
  const answer = observed.answer;
  if (!answer || answer.format === "mixed") return [];
  let value: unknown;
  // `observe` reads an object in structuredContent as a json answer, whatever its text says.
  const structured = typeOf(result.structured) === "object" ? result.structured : undefined;
  if (entry?.tool.outputSchema || structured !== undefined) {
    if (structured === undefined) return ["no structuredContent"];
    if (answer.format !== "json") return [`result format json, observed ${answer.format}`];
    value = structured;
  } else
    try {
      if (answer.format === "text") return textDifferences(answer, result.text);
      if (answer.format === "empty")
        return result.text.trim() ? ["result format text, observed empty"] : [];
      if (answer.format === "json") value = JSON.parse(result.text);
      else if (answer.format === "toon") {
        value = decodeToon(result.text);
        const line = answer.canonical === true ? toonDifference(result.text, value) : undefined;
        if (line !== undefined)
          return [
            `line ${line}: not written as the TOON encoder writes it (quoting or layout), which every observed result was`,
          ];
      }
      else if (answer.format === "prefixed_json") {
        const found = prefixedJson(result.text);
        if (!found) return ["not prefixed_json: no JSON object inside the text"];
        if (!matchesAny(found.prefix, [answer.prefix ?? "", ...(answer.prefixes ?? [])]))
          return [`prefix differs, observed ${answer.prefix}`];
        if (!matchesAny(found.suffix, [answer.suffix ?? "", ...(answer.suffixes ?? [])]))
          return [`suffix differs, observed ${answer.suffix ?? "none"}`];
        value = found.value;
      } else return [`observed an unknown format ${answer.format}`];
    } catch (error) {
      return [`not ${answer.format}: ${(error as Error).message}`];
    }
  if (!answer.schema) return [];
  const firm = observed.sampled >= REQUIRED_MIN_SAMPLES;
  return validate(value, answer.schema as ObservedSchema, "$", firm);
}
