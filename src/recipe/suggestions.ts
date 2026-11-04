/**
 * Suggestions are a Recipe's Pi prompt templates: the Markdown files its
 * `pi.prompts` selects (or `prompts/` by convention). There is no separate
 * manifest field. Pi turns each into a `/name` command; this module reads the
 * same files so other surfaces (a web chat's chips, `introspection check`,
 * the first-run picker in Pi) can offer them without a Pi session.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";

import { packageResourcePaths, readPiPackageManifest } from "./package.js";

/** One prompt template, read the way Pi reads it. */
export interface RecipeSuggestion {
  /** The command name: the file name without `.md`. Invoked as `/name`. */
  name: string;
  /**
   * The frontmatter `description`, or Pi's fallback (the body's first
   * non-empty line, cut at 60 characters) when it has none.
   */
  description: string;
  /** Frontmatter `argument-hint`, such as `<file>` or `[focus]`. */
  argumentHint?: string;
  /** The raw template body, with Pi arguments and placeholders unexpanded. */
  text: string;
  /** The `{{name}}` placeholders the body uses, in order, without duplicates. */
  placeholders: string[];
}

/** The placeholders a host may fill in a suggestion. Nothing else is replaced. */
export const SUGGESTION_PLACEHOLDERS = [
  "member.name",
  "member.email",
  "org.name",
  "today",
] as const;

export type SuggestionPlaceholder = (typeof SUGGESTION_PLACEHOLDERS)[number];

/** Values a host knows; a missing or empty one leaves its placeholder as written. */
export type SuggestionValues = Partial<Record<SuggestionPlaceholder, string>>;

const PLACEHOLDER = /\{\{([A-Za-z][\w.-]*)\}\}/g;
const ALLOWED = new Set<string>(SUGGESTION_PLACEHOLDERS);

/** Every `{{name}}` in `text`, allowlisted or not, in order without duplicates. */
export function findPlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]!))];
}

/**
 * Replace allowlisted `{{name}}` placeholders that have a value. Unknown
 * names, and names without a value, are left exactly as written.
 */
export function fillSuggestion(text: string, values: SuggestionValues): string {
  return text.replace(PLACEHOLDER, (match, name: string) => {
    if (!ALLOWED.has(name)) return match;
    const value = values[name as SuggestionPlaceholder];
    return value ? value : match;
  });
}

/** Pi's argument substitution with no arguments: defaults apply, the rest is empty. */
export function expandWithoutArguments(text: string): string {
  return text.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, defaultTarget: string | undefined, defaultValue: string | undefined) =>
      defaultTarget ? (defaultValue ?? "") : ""
  );
}

/** Split frontmatter from the body exactly as Pi's `parseFrontmatter` does. */
function parseTemplate(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const end = normalized.startsWith("---") ? normalized.indexOf("\n---", 3) : -1;
  if (end === -1) return { frontmatter: {}, body: normalized };
  const parsed: unknown = parse(normalized.slice(4, end));
  return {
    frontmatter:
      parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {},
    body: normalized.slice(end + 4).trim(),
  };
}

function readTemplate(path: string): RecipeSuggestion | undefined {
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    ({ frontmatter, body } = parseTemplate(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
  let description =
    typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (!description) {
    const firstLine = body.split("\n").find((line) => line.trim()) ?? "";
    description = firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
  }
  const argumentHint = frontmatter["argument-hint"];
  return {
    name: basename(path).replace(/\.md$/, ""),
    description,
    ...(typeof argumentHint === "string" && argumentHint ? { argumentHint } : {}),
    text: body,
    placeholders: findPlaceholders(body),
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Read prompt templates from resolved prompt paths, as Pi loads them: a
 * directory contributes its direct `.md` children, a file itself. Later
 * duplicates of a name are dropped.
 */
export function readRecipeSuggestions(promptPaths: readonly string[]): RecipeSuggestion[] {
  const files: string[] = [];
  for (const path of promptPaths) {
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) {
      files.push(
        ...readdirSync(path)
          .filter((name) => name.endsWith(".md"))
          .sort()
          .map((name) => join(path, name))
          .filter(isFile)
      );
    } else if (path.endsWith(".md")) {
      files.push(path);
    }
  }
  const byName = new Map<string, RecipeSuggestion>();
  for (const file of files) {
    const template = readTemplate(file);
    if (template && !byName.has(template.name)) byName.set(template.name, template);
  }
  return [...byName.values()];
}

/**
 * A Recipe's suggestions: its prompt templates, read from `recipeDir`.
 * Returns an empty list when the Recipe has none.
 */
export function listRecipeSuggestions(recipeDir: string): RecipeSuggestion[] {
  const manifest = readPiPackageManifest(recipeDir);
  return readRecipeSuggestions(packageResourcePaths(manifest, "prompts"));
}

/** A small seeded generator (mulberry32), so a seed pins the choice. */
export function seededRandom(seed: string): () => number {
  let state = 0;
  for (const char of seed) state = (Math.imul(state, 31) + char.charCodeAt(0)) | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Up to `count` suggestions; a random selection when there are more. */
export function pickSuggestions<T>(
  suggestions: readonly T[],
  count = 3,
  random: () => number = Math.random
): T[] {
  if (suggestions.length <= count) return [...suggestions];
  const pool = [...suggestions];
  for (let index = 0; index < count; index++) {
    const swap = index + Math.floor(random() * (pool.length - index));
    [pool[index], pool[swap]] = [pool[swap]!, pool[index]!];
  }
  return pool.slice(0, count);
}
