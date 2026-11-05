/**
 * A shown artifact as every renderer shares it: the tool's name, how a path's
 * file renders, the `details` a `show_artifact` result carries, and the lines
 * of its diff. Pi's terminal panel (`./artifact-viewer.ts`) writes the details
 * and a browser host reads them, through `./review.ts`, so this imports
 * nothing from Node, Pi or a renderer.
 */

export const SHOW_ARTIFACT_TOOL_NAME = "show_artifact";

/** How a file renders: markdown rendered, HTML as a page in a browser, the rest as highlighted text. */
export type ArtifactKind = "markdown" | "html" | "text";

/** How a path's file renders, from its extension. */
export function artifactKind(path: string): ArtifactKind {
  if (/\.(md|markdown)$/i.test(path)) return "markdown";
  return /\.html?$/i.test(path) ? "html" : "text";
}

/** How a shown file differs from its base. */
export interface ArtifactDiff {
  /** The base: a git ref, or "the version shown before". */
  against: string;
  /** Pi's display diff: a line each, `+` added, `-` removed, ` ` context, with line numbers. */
  text: string;
  added: number;
  removed: number;
  truncated?: true;
}

/** Structured `details` of a `show_artifact` result, enough for a host without the panel to render it. */
export interface ShowArtifactDetails {
  /** The file, relative to the working directory. */
  path: string;
  /** Whether the terminal panel is showing it. */
  shown: boolean;
  kind: ArtifactKind;
  /** The highlighting language, when the path names one. */
  language?: string;
  /** The commit shown, when not the working tree. */
  ref?: string;
  /** The file as shown, capped (see `truncated`). */
  content: string;
  /** The content was cut to the cap. */
  truncated?: true;
  /** The working directory's git branch, and whether its tree has uncommitted changes. */
  git?: { branch: string; dirty: boolean };
  /** How the file differs from its base: the `diff` asked for, else HEAD or the version shown before. */
  diff?: ArtifactDiff;
  /** The view to open on: the diff when `diff` was asked for. */
  opens?: "diff";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Read a `show_artifact` result's `details` as a host received them, or
 * undefined without a path. A release before the details carried the file
 * sends only `{ path, shown }`: `content` then reads as empty and the host
 * should say the file wasn't included (`hasContent` is false).
 */
export function artifactDetails(
  value: unknown,
): (ShowArtifactDetails & { hasContent: boolean }) | undefined {
  const details = asRecord(value);
  const path = nonEmpty(details?.path);
  if (!details || !path) return undefined;
  const kinds: readonly ArtifactKind[] = ["markdown", "html", "text"];
  const kind = kinds.includes(details.kind as ArtifactKind)
    ? (details.kind as ArtifactKind)
    : artifactKind(path);
  const git = asRecord(details.git);
  const branch = nonEmpty(git?.branch);
  const diff = asRecord(details.diff);
  const diffText = typeof diff?.text === "string" ? diff.text : undefined;
  const language = nonEmpty(details.language);
  const ref = nonEmpty(details.ref);
  return {
    path,
    shown: details.shown === true,
    kind,
    ...(language ? { language } : {}),
    ...(ref ? { ref } : {}),
    content: typeof details.content === "string" ? details.content : "",
    hasContent: typeof details.content === "string",
    ...(details.truncated === true ? { truncated: true as const } : {}),
    ...(branch ? { git: { branch, dirty: git?.dirty === true } } : {}),
    ...(diff && diffText !== undefined
      ? {
          diff: {
            against: nonEmpty(diff.against) ?? "HEAD",
            text: diffText,
            added: count(diff.added),
            removed: count(diff.removed),
            ...(diff.truncated === true ? { truncated: true as const } : {}),
          },
        }
      : {}),
    ...(details.opens === "diff" && diffText !== undefined
      ? { opens: "diff" as const }
      : {}),
  };
}

export type ArtifactDiffLineKind = "added" | "removed" | "context";

/** Pi's display diff as lines, each with its kind; a `...` gap reads as context. */
export function artifactDiffLines(
  diff: string,
): Array<{ kind: ArtifactDiffLineKind; text: string }> {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((text) => ({
    kind: text.startsWith("+")
      ? "added"
      : text.startsWith("-")
        ? "removed"
        : "context",
    text,
  }));
}

/** Lines added and removed in Pi's display diff. */
export function artifactDiffCounts(diff: string): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of artifactDiffLines(diff)) {
    if (line.kind === "added") added += 1;
    else if (line.kind === "removed") removed += 1;
  }
  return { added, removed };
}
