/**
 * Python-compatible text primitives, for builders that must reproduce a
 * Python original byte for byte: lengths and slices in code points, Python's
 * whitespace, `json.dumps` spacing, pydantic's datetimes and `saxutils`
 * escaping. A float that arrives as an integer-valued JSON number (`1.0`)
 * cannot be told from an integer here, so it renders as `1`.
 */

/** Python's `str.isspace` set: JavaScript's `\s` without U+FEFF, plus U+001C–U+001F and U+0085. */
const PY_SPACE =
  "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PY_SPACE_RUN = new RegExp(`${PY_SPACE}+`, "u");
const PY_LEADING = new RegExp(`^${PY_SPACE}+`, "u");
const PY_TRAILING = new RegExp(`${PY_SPACE}+$`, "u");

/** `" ".join(text.split())` */
export function squashSpace(text: string): string {
  return text
    .split(PY_SPACE_RUN)
    .filter((piece) => piece !== "")
    .join(" ");
}

export function pyStrip(text: string): string {
  return text.replace(PY_LEADING, "").replace(PY_TRAILING, "");
}

export function pyRstrip(text: string): string {
  return text.replace(PY_TRAILING, "");
}

/** `len(text)`: code points, not UTF-16 units. */
export function cpLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

/** `text[:count]` in code points. */
export function cpHead(text: string, count: number): string {
  if (count <= 0) return "";
  if (text.length <= count) return text;
  let points = 0;
  for (let i = 0; i < text.length; i++) {
    if (points === count) return text.slice(0, i);
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    points++;
  }
  return text;
}

/** `text[-count:]` in code points (`count` > 0). */
export function cpTail(text: string, count: number): string {
  const total = cpLength(text);
  if (count >= total) return text;
  const points = Array.from(text);
  return points.slice(total - count).join("");
}

/** `repr(float)`: shortest round-trip digits, exponent below 1e-4 and from 1e16. */
export function pyFloat(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const [mantissa, exponentText] = Math.abs(value).toExponential().split("e");
  const exponent = Number(exponentText);
  const digits = mantissa!.replace(".", "");
  if (exponent < -4 || exponent >= 16) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
    const magnitude = String(Math.abs(exponent)).padStart(2, "0");
    return `${sign}${digits[0]}${fraction}e${exponent < 0 ? "-" : "+"}${magnitude}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  if (digits.length > exponent + 1) {
    return `${sign}${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
  }
  return `${sign}${digits.padEnd(exponent + 1, "0")}.0`;
}

function pyNumber(value: number): string {
  return Number.isInteger(value) && Math.abs(value) < 1e16
    ? String(value)
    : pyFloat(value);
}

function asciiOnly(json: string): string {
  return json.replace(/[\u007f-￿]/g, (char) => {
    const code = char.charCodeAt(0);
    return code === 0x7f ? char : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

export interface PyDumpsOptions {
  /** `sort_keys=True` */
  sortKeys?: boolean;
  /** `separators=(",", ":")`; otherwise Python's `", "` and `": "`. */
  compact?: boolean;
  /** `ensure_ascii=True` */
  ensureAscii?: boolean;
}

/** `json.dumps(value, ...)`. Keys keep insertion order unless sorted. */
export function pyDumps(value: unknown, options: PyDumpsOptions = {}): string {
  const item = options.compact ? "," : ", ";
  const pair = options.compact ? ":" : ": ";
  const str = (text: string): string => {
    const json = JSON.stringify(text);
    return options.ensureAscii ? asciiOnly(json) : json;
  };
  const dump = (node: unknown): string => {
    if (node === null || node === undefined) return "null";
    if (typeof node === "boolean") return node ? "true" : "false";
    if (typeof node === "number") return pyNumber(node);
    if (typeof node === "bigint") return node.toString();
    if (typeof node === "string") return str(node);
    if (Array.isArray(node)) return `[${node.map(dump).join(item)}]`;
    if (typeof node === "object") {
      let keys = Object.keys(node as Record<string, unknown>).filter(
        (key) => (node as Record<string, unknown>)[key] !== undefined,
      );
      if (options.sortKeys) keys = [...keys].sort();
      return `{${keys.map((key) => `${str(key)}${pair}${dump((node as Record<string, unknown>)[key])}`).join(item)}}`;
    }
    return str(String(node));
  };
  return dump(value);
}

/** `str(value)` for a JSON value, as Python prints it. */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null || value === undefined) return "None";
  if (typeof value === "number") return pyNumber(value);
  return pyDumps(value)
    .replace(/"/g, "'")
    .replace(/\btrue\b/g, "True")
    .replace(/\bfalse\b/g, "False")
    .replace(/\bnull\b/g, "None");
}

/** `str(float)` for a field Python types as a float, so an integral value keeps its `.0`. */
export function pyFloatField(value: number): string {
  return pyFloat(value);
}

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;

/** An ISO-8601 instant as microseconds since the epoch, truncated as pydantic parses it. */
export function isoMicros(text: string): number {
  const match = ISO.exec(text);
  if (match === null) throw new Error(`not an ISO-8601 datetime: ${text}`);
  const [, y, mo, d, h, mi, s, fraction = "", zone = "Z"] = match;
  let millis = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
  if (zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    millis -=
      sign *
      (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) *
      60_000;
  }
  return millis * 1_000 + Number(fraction.padEnd(6, "0").slice(0, 6));
}

/** Microseconds as pydantic serializes a UTC datetime: `…T09:00:00Z`, or `.ffffffZ` when it has a fraction. */
export function pydanticDatetime(micros: number): string {
  const whole = Math.floor(micros / 1_000_000);
  const fraction = micros - whole * 1_000_000;
  const base = new Date(whole * 1_000).toISOString().slice(0, 19);
  return fraction === 0
    ? `${base}Z`
    : `${base}.${String(fraction).padStart(6, "0")}Z`;
}

/** `int(dt.timestamp() * 1_000_000_000)`, including its float rounding. */
export function microsToNanos(micros: number): bigint {
  return BigInt(Math.trunc((micros / 1_000_000) * 1_000_000_000));
}

/** `xml.sax.saxutils.escape` */
export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/>/g, "&gt;")
    .replace(/</g, "&lt;");
}

/** `xml.sax.saxutils.quoteattr` */
export function xmlQuoteAttr(text: string): string {
  let data = xmlEscape(text)
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;")
    .replace(/\t/g, "&#9;");
  if (data.includes('"')) {
    if (data.includes("'")) data = `"${data.replace(/"/g, "&quot;")}"`;
    else data = `'${data}'`;
  } else {
    data = `"${data}"`;
  }
  return data;
}
