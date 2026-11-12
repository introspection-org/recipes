/**
 * A shown artifact as every renderer shares it: the tool's name, how a path's
 * file renders, the `details` a `show_artifact` result carries, and the lines
 * of its diff. Pi's terminal panel (`./artifact-viewer.ts`) writes the details
 * and a browser host reads them, through `./review.ts`, so this imports
 * nothing from Node, Pi or a renderer.
 */

export const SHOW_ARTIFACT_TOOL_NAME = "show_artifact";

/** How a file renders: markdown, HTML, highlighted text, or a binary file preview. */
export type ArtifactKind = "markdown" | "html" | "text" | "file";

/** How a path's file renders, from its extension. */
export function artifactKind(path: string): ArtifactKind {
  if (/\.(docx|pdf|png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path))
    return "file";
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

/** A shown file too large to carry inline, kept in the host's file store. */
export interface ArtifactFile {
  /** The store's id for the file (the platform's Files API id). */
  id: string;
  bytes: number;
}

/** A shown file as it stands at a pushed commit of a repository the host knows. */
export interface ArtifactRepositorySource {
  /** The host's id for the repository. */
  repository_id: string;
  /** The full commit SHA the file is shown at. */
  commit: string;
  /** The file's path from the repository's root. */
  path: string;
}

/**
 * The host's id for the git repository rooted at `root`, if it is one the host
 * serves (and so can read a pushed commit's files from), with the largest file
 * it reads from one (`maxBytes`); undefined otherwise.
 */
export type ArtifactRepositoryResolver = (
  root: string,
) => { id: string; maxBytes?: number } | undefined;

/**
 * Keeps a binary file or text too large to carry in a result, for a host that renders
 * artifacts from its own store; resolves to the store's id.
 */
export type ArtifactStore = (artifact: {
  path: string;
  content: string | Uint8Array;
  mimeType: string;
}) => Promise<{ id: string }>;

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
  /** The file as shown, capped (see `truncated`); empty when it is in the host's store (`file`). */
  content: string;
  /** The file, kept in the host's store because it is too large to carry here. */
  file?: ArtifactFile;
  /** The file as committed in a repository the host serves: it reads it from there instead. */
  source?: ArtifactRepositorySource;
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
 * should say the file wasn't included (`hasContent` is false). A file too large
 * to carry is in the host's store instead (`file`), and a committed file in a
 * repository the host serves is read from there (`source`); both have
 * `hasContent` false.
 */
export function artifactDetails(
  value: unknown,
): (ShowArtifactDetails & { hasContent: boolean }) | undefined {
  const details = asRecord(value);
  const path = nonEmpty(details?.path);
  if (!details || !path) return undefined;
  const kinds: readonly ArtifactKind[] = ["markdown", "html", "text", "file"];
  const kind = kinds.includes(details.kind as ArtifactKind)
    ? (details.kind as ArtifactKind)
    : artifactKind(path);
  const git = asRecord(details.git);
  const branch = nonEmpty(git?.branch);
  const diff = asRecord(details.diff);
  const diffText = typeof diff?.text === "string" ? diff.text : undefined;
  const language = nonEmpty(details.language);
  const ref = nonEmpty(details.ref);
  const file = asRecord(details.file);
  const fileId = nonEmpty(file?.id);
  const source = asRecord(details.source);
  const repositoryId = nonEmpty(source?.repository_id);
  const sourceCommit = nonEmpty(source?.commit);
  const sourcePath = nonEmpty(source?.path);
  const fromRepository = Boolean(repositoryId && sourceCommit && sourcePath);
  return {
    path,
    shown: details.shown === true,
    kind,
    ...(language ? { language } : {}),
    ...(ref ? { ref } : {}),
    content: typeof details.content === "string" ? details.content : "",
    hasContent:
      typeof details.content === "string" && !fileId && !fromRepository,
    ...(fileId ? { file: { id: fileId, bytes: count(file?.bytes) } } : {}),
    ...(fromRepository
      ? {
          source: {
            repository_id: repositoryId!,
            commit: sourceCommit!,
            path: sourcePath!,
          },
        }
      : {}),
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
