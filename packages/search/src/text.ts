import type { McpCallToolResult } from "@introspection-ai/recipes/search";

const REGIONS = new Intl.DisplayNames(["en"], { type: "region" });

/** A country's English name in lower case (`US` → `united states`), as Tavily takes it. */
export function countryName(code: string): string {
  return (REGIONS.of(code) ?? code).toLowerCase();
}

/** A text cut to `limit` characters, on a word boundary where one is near. */
export function capText(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${space > limit * 0.6 ? cut.slice(0, space) : cut}…`;
}

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** `YYYY-MM-DD` of an ISO-ish date string, or undefined. */
export function dateOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
  if (match) return match[0];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? undefined
    : parsed.toISOString().slice(0, 10);
}

const FRESHNESS_DAYS = { day: 1, week: 7, month: 31, year: 365 } as const;

/** The first day a freshness window admits, as `YYYY-MM-DD`. */
export function freshnessStart(
  freshness: keyof typeof FRESHNESS_DAYS,
  now: Date,
): string {
  return new Date(now.getTime() - FRESHNESS_DAYS[freshness] * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** The text of a result's text blocks, joined. */
export function mcpResultText(result: McpCallToolResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** A tool's text as JSON, or undefined when it is not JSON. */
export function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
