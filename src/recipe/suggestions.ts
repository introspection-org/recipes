/**
 * Suggestions are the Recipe's Pi prompt templates marked `suggest` in their
 * frontmatter: `true` for every agent, or a list of agent names, among the Markdown files its `pi.prompts` selects (or
 * `prompts/` by convention). There is no separate manifest field. Pi turns
 * every template into a `/name` command, marked or not; this module reads the
 * marked ones so other surfaces (a web chat's chips, `introspection check`,
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
  /** The agents that offer it, from `suggest`; `null` when every agent does. */
  agents: string[] | null;
}

/** Narrows a Recipe's suggestions to the ones an agent offers. */
export interface RecipeSuggestionOptions {
  /** An agent name; omitted, every marked template is returned. */
  agent?: string;
}

/**
 * The agents a `suggest` value names: `null` for `true` (every agent), the
 * names for a non-empty list of non-empty strings, and `undefined` (not a
 * suggestion) for anything else.
 */
function suggestAgents(value: unknown): string[] | null | undefined {
  if (value === true) return null;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item)
  )
    return [...(value as string[])];
  return undefined;
}

function offeredTo(
  suggestion: RecipeSuggestion,
  options: RecipeSuggestionOptions,
): boolean {
  return (
    options.agent === undefined ||
    suggestion.agents === null ||
    suggestion.agents.includes(options.agent)
  );
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
  return [
    ...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]!)),
  ];
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
    (
      _match,
      defaultTarget: string | undefined,
      defaultValue: string | undefined,
    ) => (defaultTarget ? (defaultValue ?? "") : ""),
  );
}

/** Split frontmatter from the body exactly as Pi's `parseFrontmatter` does. */
function parseTemplate(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const end = normalized.startsWith("---")
    ? normalized.indexOf("\n---", 3)
    : -1;
  if (end === -1) return { frontmatter: {}, body: normalized };
  const parsed: unknown = parse(normalized.slice(4, end));
  return {
    frontmatter:
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {},
    body: normalized.slice(end + 4).trim(),
  };
}

/** A readable template, and whether `suggest` marks it. */
function readTemplate(
  path: string,
): { suggest: boolean; template: RecipeSuggestion } | undefined {
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    ({ frontmatter, body } = parseTemplate(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
  let description =
    typeof frontmatter.description === "string"
      ? frontmatter.description.trim()
      : "";
  if (!description) {
    const firstLine = body.split("\n").find((line) => line.trim()) ?? "";
    description =
      firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
  }
  const argumentHint = frontmatter["argument-hint"];
  const agents = suggestAgents(frontmatter.suggest);
  return {
    suggest: agents !== undefined,
    template: {
      name: basename(path).replace(/\.md$/, ""),
      description,
      ...(typeof argumentHint === "string" && argumentHint
        ? { argumentHint }
        : {}),
      text: body,
      placeholders: findPlaceholders(body),
      agents: agents ?? null,
    },
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
 * Read the templates marked `suggest` from resolved prompt paths, as Pi
 * loads them: a directory contributes its direct `.md` children, a file
 * itself. As in Pi, the first template with a name wins, so an unmarked
 * template hides a later marked one of the same name.
 */
export function readRecipeSuggestions(
  promptPaths: readonly string[],
  options: RecipeSuggestionOptions = {},
): RecipeSuggestion[] {
  const files: string[] = [];
  for (const path of promptPaths) {
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) {
      files.push(
        ...readdirSync(path)
          .filter((name) => name.endsWith(".md"))
          .sort()
          .map((name) => join(path, name))
          .filter(isFile),
      );
    } else if (path.endsWith(".md")) {
      files.push(path);
    }
  }
  // As in Pi, the first template with a name wins, marked or not.
  const byName = new Map<
    string,
    { suggest: boolean; template: RecipeSuggestion }
  >();
  for (const file of files) {
    const read = readTemplate(file);
    if (read && !byName.has(read.template.name))
      byName.set(read.template.name, read);
  }
  return [...byName.values()]
    .filter((read) => read.suggest && offeredTo(read.template, options))
    .map((read) => read.template);
}

/**
 * A Recipe's suggestions: its prompt templates marked `suggest`, read from
 * `recipeDir` in file order. With `agent`, only those that agent offers.
 * Returns an empty list when none are marked.
 */
export function listRecipeSuggestions(
  recipeDir: string,
  options: RecipeSuggestionOptions = {},
): RecipeSuggestion[] {
  const manifest = readPiPackageManifest(recipeDir);
  return readRecipeSuggestions(
    packageResourcePaths(manifest, "prompts"),
    options,
  );
}

/** A small seeded generator (mulberry32), so a seed pins the choice. */
export function seededRandom(seed: string): () => number {
  let state = 0;
  for (const char of seed)
    state = (Math.imul(state, 31) + char.charCodeAt(0)) | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Up to `count` suggestions in their original order; a random selection
 * when there are more.
 */
export function pickSuggestions<T>(
  suggestions: readonly T[],
  count = 3,
  random: () => number = Math.random,
): T[] {
  if (suggestions.length <= count) return [...suggestions];
  const pool = suggestions.map((_, index) => index);
  for (let index = 0; index < count; index++) {
    const swap = index + Math.floor(random() * (pool.length - index));
    [pool[index], pool[swap]] = [pool[swap]!, pool[index]!];
  }
  return pool
    .slice(0, count)
    .sort((a, b) => a - b)
    .map((index) => suggestions[index]!);
}
