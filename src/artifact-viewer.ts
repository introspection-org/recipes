/**
 * The first-party artifact viewer: a `show_artifact` tool and `/recipe view`
 * and a focus shortcut that show a markdown file the agent wrote in a panel on
 * the right of Pi's terminal, so the user can read it before approving it.
 *
 * An agent gets it by listing `show_artifact` in its `tools`, like
 * `ask_user_question`. Any text file can be shown: markdown renders, code and
 * other text are highlighted, and a file can be shown as of a git commit or
 * as a diff against one (or against the version this session last showed).
 * The panel exists only in Pi's interactive terminal; elsewhere the result's
 * `details` carry the file and the diff, so a host such as a browser can
 * render them itself.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  watch,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  generateDiffString,
  getLanguageFromPath,
  type ExtensionContext,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, OverlayHandle } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  ARTIFACT_PANEL_MIN_TERMINAL_COLUMNS,
  ARTIFACT_PANEL_OVERLAY_OPTIONS,
  ArtifactPanel,
  type ArtifactDocument,
} from "./artifact-viewer-tui.js";
import {
  artifactDiffCounts,
  artifactKind,
  SHOW_ARTIFACT_TOOL_NAME,
  type ArtifactKind,
  type ArtifactRepositoryResolver,
  type ArtifactRepositorySource,
  type ArtifactStore,
  type ShowArtifactDetails,
} from "./artifact.js";
import {
  createReviewArtifactsTool,
  REVIEW_ARTIFACTS_TOOL_NAME,
} from "./artifact-review.js";
import type { RecipeExtensionRegistrationRegistry } from "./extensions.js";
import {
  artifactPanelControl,
  setArtifactPanelControl,
  type ArtifactPanelControl,
  type ArtifactPanelScrollBy,
} from "./interaction-tui.js";

export { SHOW_ARTIFACT_TOOL_NAME } from "./artifact.js";
/** The viewer's commands, as subcommands of Recipes' own `/recipe` so they
 * never clash with another extension's or the user's commands. */
const VIEW_ARTIFACT_COMMAND = "recipe view";

/** A `/recipe` subcommand an optional built-in adds: `/recipe <name> <args>`. */
export type RecipeSubcommand = (
  args: string,
  ctx: ExtensionContext,
) => Promise<void>;

const recipeSubcommands = new WeakMap<object, Map<string, RecipeSubcommand>>();

/** The `/recipe` subcommand `name` registered for this Pi instance, if any. */
export function recipeSubcommand(
  pi: object,
  name: string,
): RecipeSubcommand | undefined {
  return recipeSubcommands.get(pi)?.get(name);
}

/**
 * Split `/recipe` arguments into the subcommand name and the rest, which keeps
 * its own whitespace so a path such as `"a  b.md"` reaches the handler intact.
 */
export function splitRecipeSubcommand(action: string): {
  name: string;
  args: string;
} {
  const name = /^\S*/.exec(action)?.[0] ?? "";
  return { name, args: action.slice(name.length).trimStart() };
}

/** The `/recipe` subcommand names registered for this Pi instance. */
export function recipeSubcommandNames(pi: object): string[] {
  return [...(recipeSubcommands.get(pi)?.keys() ?? [])];
}

interface RecipeSubcommandInfo {
  description: string;
  /** Completions for the subcommand's argument, given what's typed so far. */
  complete?: (argument: string, cwd: string) => AutocompleteItem[];
}

const recipeSubcommandInfo = new WeakMap<
  object,
  Map<string, RecipeSubcommandInfo>
>();

function addRecipeSubcommand(
  pi: object,
  name: string,
  handler: RecipeSubcommand,
  info: RecipeSubcommandInfo,
): void {
  const commands =
    recipeSubcommands.get(pi) ?? new Map<string, RecipeSubcommand>();
  commands.set(name, handler);
  recipeSubcommands.set(pi, commands);
  const infos =
    recipeSubcommandInfo.get(pi) ?? new Map<string, RecipeSubcommandInfo>();
  infos.set(name, info);
  recipeSubcommandInfo.set(pi, infos);
}

/**
 * Completions for `/recipe <prefix>` from the optional built-ins: their
 * subcommand names while the first word is typed, then the subcommand's own
 * argument completions (for `view`, the workspace's markdown files).
 */
export function recipeSubcommandCompletions(
  pi: object,
  prefix: string,
  cwd: string,
): AutocompleteItem[] {
  const infos = recipeSubcommandInfo.get(pi);
  if (!infos) return [];
  const space = prefix.indexOf(" ");
  if (space < 0) {
    return [...infos.entries()]
      .filter(([name]) => name.startsWith(prefix.trim()))
      .map(([name, info]) => ({
        value: `${name} `,
        label: name,
        description: info.description,
      }));
  }
  const name = prefix.slice(0, space);
  const argument = prefix.slice(space + 1);
  const complete = infos.get(name)?.complete;
  if (!complete) return [];
  return complete(argument, cwd).map((item) => ({
    ...item,
    value: `${name} ${item.value}`,
  }));
}

/** Folders the file list never walks into. */
const SKIPPED_FOLDERS = new Set([
  "node_modules",
  ".git",
  "dist",
  "eval-runs",
  "target",
]);
/** Where an owner's reviewable files usually live, listed first. */
const PREFERRED_PARTS = ["docs/", "evals/cases/", "prompts/", "outputs/"];
const MAX_LISTED_FILES = 50;

/** Extensions of files that are never text, left out of the file list without reading them. */
const BINARY_EXTENSIONS = new Set(
  [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "ico",
    "bmp",
    "tiff",
    "pdf",
    "zip",
    "gz",
    "tgz",
    "bz2",
    "xz",
    "7z",
    "tar",
    "jar",
    "wasm",
    "so",
    "dylib",
    "dll",
    "exe",
    "bin",
    "woff",
    "woff2",
    "ttf",
    "otf",
    "mp3",
    "mp4",
    "mov",
    "wav",
    "parquet",
    "sqlite",
    "db",
    "docx",
    "xlsx",
    "pptx",
  ].map((extension) => `.${extension}`),
);

/**
 * The text files under `cwd` matching `query` (a substring of the path,
 * case-insensitive): the usual review folders first, then markdown, then the
 * rest. Bounded in depth and count so a large workspace stays quick; hidden
 * folders, build output and binary file types are skipped.
 */
export function artifactFilesFor(
  cwd: string,
  query: string,
): AutocompleteItem[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || found.length >= 1000) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) walk(path, depth + 1);
      } else if (
        entry.isFile() &&
        !BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())
      ) {
        found.push(relative(cwd, path).split(sep).join("/"));
      }
    }
  };
  walk(cwd, 0);
  const needle = query.trim().toLowerCase();
  const rank = (path: string) => {
    const index = PREFERRED_PARTS.findIndex((part) => path.includes(part));
    return index < 0 ? PREFERRED_PARTS.length : index;
  };
  return found
    .filter((path) => path.toLowerCase().includes(needle))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Number(!isMarkdownPath(a)) - Number(!isMarkdownPath(b)) ||
        a.localeCompare(b),
    )
    .slice(0, MAX_LISTED_FILES)
    .map((path) => ({ value: path, label: path }));
}

/** File extensions the panel renders. */
const ARTIFACT_MARKDOWN_EXTENSIONS: readonly string[] = [".md", ".markdown"];

/** The largest file the viewer reads. */
const ARTIFACT_MAX_BYTES = 1024 * 1024;
/** The largest file the viewer reads for a host that keeps large files in its store. */
const STORED_ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;
/** The most of a file (and of its diff) a result's `details` carry, as a review's interrupt does. */
const ARTIFACT_DETAILS_MAX_BYTES = 1024 * 1024;
/** The bytes read to tell a text file from a binary one. */
const BINARY_SNIFF_BYTES = 8192;
/** `diff` against the version this session last showed. */
const DIFF_PREVIOUS = "previous";
/** A git revision: a name, a hash, or one with `~`/`^`/`@{…}`; never an option. */
const GIT_REF = /^[A-Za-z0-9_][\w./~^@{}-]*$/;

const BUILTIN_OWNER = "<builtin:show_artifact>";
const DEFAULT_DEBOUNCE_MS = 100;

const description = [
  "Show a file to the user beside the conversation: markdown rendered, code and other text highlighted, HTML as source (a browser host renders it).",
  "Call this when you want the user to read a file you wrote (a brief, test cases, a report, code), especially before asking them to approve it, instead of only printing its path.",
  "`path` is relative to the working directory and must be a text file. `ref` and `diff` work like git, in the working directory's repository:",
  "- `{ path }`: the file as it is now.",
  '- `{ path, ref: "HEAD~1" }`: the file at a commit, like `git show HEAD~1:path`.',
  '- `{ path, diff: "HEAD" }`: what changed since a commit, like `git diff HEAD -- path`.',
  '- `{ path, ref: "HEAD", diff: "main" }`: what changed between two commits, like `git diff main HEAD -- path`.',
  '- `{ path, diff: "previous" }`: what changed since you last showed it in this session; use it after revising a file the user is reading.',
  "The panel re-renders when the file changes, so you don't need to call this again after editing a file it already shows.",
].join("\n");

const parameters = Type.Object(
  {
    path: Type.String({
      description:
        'The file to show, relative to the working directory (e.g. "evals/cases/refund.md").',
    }),
    ref: Type.Optional(
      Type.String({
        description:
          "Show the file as of this git commit (a hash, a branch, HEAD~1) instead of as it is now.",
      }),
    ),
    diff: Type.Optional(
      Type.String({
        description: `Show a diff instead of the whole file: "${DIFF_PREVIOUS}" for what changed since you last showed it, or a git ref to compare against.`,
      }),
    ),
  },
  { additionalProperties: false },
);

/** A validated artifact path. */
export interface ResolvedArtifactPath {
  absolutePath: string;
  /** Relative to the working directory, with `/` separators. */
  relativePath: string;
}

export interface ArtifactViewerOptions {
  /**
   * Opens a file with the system's default app (`o` in the panel). Defaults
   * to `open` on macOS, `start` on Windows and `xdg-open` elsewhere.
   */
  openExternal?: (absolutePath: string) => Promise<void> | void;
  /**
   * Calls `onChange` when the file may have changed and returns a function
   * that stops watching. Defaults to `fs.watch` on the file's folder, which
   * also sees editors that save by replacing the file.
   */
  watchFile?: (absolutePath: string, onChange: () => void) => () => void;
  /** How long to wait for a burst of changes to settle before re-rendering. */
  debounceMs?: number;
  /**
   * The host's store for a shown file past the inline cap (1 MB): with it, the
   * tool reads files up to 25 MB and records the store's id instead of the
   * content. Pi's terminal has none; its panel reads the file itself.
   */
  storeArtifact?: ArtifactStore;
  /**
   * The host's id for a git repository it serves. With it, a file unchanged
   * against a pushed commit of such a repository is named by repository,
   * commit and path instead of carried or stored. Pi's terminal has none.
   */
  artifactRepository?: ArtifactRepositoryResolver;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Whether a path names a file the panel can render. */
function isMarkdownPath(path: string): boolean {
  return ARTIFACT_MARKDOWN_EXTENSIONS.includes(extname(path).toLowerCase());
}

/** Whether a file's first bytes hold a NUL, as a binary file's do. */
function looksBinary(absolutePath: string): boolean {
  const fd = openSync(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).includes(0);
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolve `path` against `cwd` and check that it names an existing markdown
 * file inside `cwd`, following symlinks; with `anyText`, any text file up to
 * `ARTIFACT_MAX_BYTES`. Throws an error the model or user can act on.
 */
export function resolveArtifactPath(
  cwd: string,
  path: string,
  {
    anyText = false,
    inWorkingTree = true,
    maxBytes = ARTIFACT_MAX_BYTES,
  }: {
    anyText?: boolean;
    /** The largest file accepted. */
    maxBytes?: number;
    /** False for a path read from a git commit: it need not exist now, and git's version is checked instead. */
    inWorkingTree?: boolean;
  } = {},
): ResolvedArtifactPath {
  const input = path.trim();
  if (!input)
    throw new Error(
      `Give the path of a ${anyText ? "" : "markdown "}file to show.`,
    );
  const root = resolve(cwd);
  const absolutePath = resolve(root, input);
  if (!isInside(root, absolutePath)) {
    throw new Error(
      `${input} is outside the working directory; only files under ${root} can be shown.`,
    );
  }
  if (!anyText && !isMarkdownPath(absolutePath)) {
    throw new Error(
      `${input} is not a markdown file; only ${ARTIFACT_MARKDOWN_EXTENSIONS.join(" and ")} files can be shown for now.`,
    );
  }
  const resolved = {
    absolutePath,
    relativePath: relative(root, absolutePath).split(sep).join("/"),
  };
  if (!inWorkingTree) return resolved;
  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    throw new Error(
      `${input} does not exist. Write the file first, then show it.`,
    );
  }
  if (!stats.isFile()) throw new Error(`${input} is not a file.`);
  if (anyText && stats.size > maxBytes) {
    throw new Error(
      `${input} is ${Math.ceil(stats.size / 1024)} KB, over the ${maxBytes / 1024} KB the viewer reads; show a smaller file or a part of it.`,
    );
  }
  if (anyText && looksBinary(absolutePath)) {
    throw new Error(`${input} is not a text file, so it can't be shown.`);
  }
  // A symlink inside the working directory may still point outside it.
  if (!isInside(realpathSync(root), realpathSync(absolutePath))) {
    throw new Error(
      `${input} links outside the working directory; only files under ${root} can be shown.`,
    );
  }
  return resolved;
}

/** The default `o` action: the platform's "open with default app" command. */
function openWithSystemApp(absolutePath: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [absolutePath]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", absolutePath]]
        : ["xdg-open", [absolutePath]];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

/**
 * The default watcher: the file's folder, filtered to the file's name. When
 * the path is a symlink, the folder of the file it points to is watched too,
 * so an edit to the target is seen; replacing or retargeting the link is seen
 * through its own folder, which moves the target watch along.
 */
export function watchFileWithFs(
  absolutePath: string,
  onChange: () => void,
): () => void {
  const watchName = (path: string, changed: () => void): (() => void) => {
    const name = basename(path);
    try {
      const watcher = watch(dirname(path), (_event, filename) => {
        if (!filename || filename.toString() === name) changed();
      });
      watcher.on("error", () => {});
      return () => watcher.close();
    } catch {
      return () => {};
    }
  };
  const realPath = () => {
    try {
      return realpathSync(absolutePath);
    } catch {
      return absolutePath;
    }
  };
  let target = realPath();
  let stopTarget =
    target === absolutePath ? () => {} : watchName(target, onChange);
  const stopLink = watchName(absolutePath, () => {
    const next = realPath();
    if (next !== target) {
      stopTarget();
      target = next;
      stopTarget =
        target === absolutePath ? () => {} : watchName(target, onChange);
    }
    onChange();
  });
  return () => {
    stopLink();
    stopTarget();
  };
}

/** The working directory `target` was resolved against. */
function workspaceRoot(target: ResolvedArtifactPath): string {
  return resolve(
    target.absolutePath,
    ...target.relativePath.split("/").map(() => ".."),
  );
}

/**
 * Where git runs for `target`, and how it names the file from there: the
 * file's own folder (or its nearest existing parent, for a deleted file), so
 * a repository nested below the working directory, such as a hosted
 * workspace's `repos/<name>`, is the one asked.
 */
function gitLocation(target: ResolvedArtifactPath): {
  dir: string;
  path: string;
} {
  const root = workspaceRoot(target);
  let dir = dirname(target.absolutePath);
  while (!existsSync(dir) && dir !== root && dirname(dir) !== dir) {
    dir = dirname(dir);
  }
  return {
    dir,
    path: `./${relative(dir, target.absolutePath).split(sep).join("/")}`,
  };
}

/** A file at `ref` in its git repository. */
function gitVersion(
  target: ResolvedArtifactPath,
  ref: string,
  maxBytes = ARTIFACT_MAX_BYTES,
): string {
  if (!GIT_REF.test(ref)) {
    throw new Error(
      `${ref} is not a git ref; give a commit hash, a branch or tag, or one like HEAD~1.`,
    );
  }
  let text: string;
  try {
    // `./` resolves the path against git's folder, wherever the repository's root is.
    const at = gitLocation(target);
    text = execFileSync("git", ["show", `${ref}:${at.path}`], {
      cwd: at.dir,
      encoding: "utf8",
      maxBuffer: maxBytes,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOBUFS") {
      throw new Error(
        `${target.relativePath} at ${ref} is over the ${maxBytes / 1024} KB the viewer reads.`,
      );
    }
    if (git(target, ["rev-parse", "--git-dir"]) === undefined) {
      throw new Error(
        `${target.relativePath} isn't in a git repository, so it has no version at ${ref}.`,
      );
    }
    throw new Error(
      `${target.relativePath} has no version at ${ref} in the working directory's git repository.`,
    );
  }
  // The version at the ref gets the checks a working-tree file gets on disk.
  if (text.includes("\0")) {
    throw new Error(
      `${target.relativePath} at ${ref} is not a text file, so it can't be shown.`,
    );
  }
  return text;
}

/**
 * The file at `ref` as a diff's base: empty when the commit exists but the
 * file was added since, as `git diff <ref> -- path` shows it all as added.
 * A ref naming no commit still fails.
 */
function gitBaseVersion(target: ResolvedArtifactPath, ref: string): string {
  try {
    return gitVersion(target, ref);
  } catch (error) {
    const commit = GIT_REF.test(ref)
      ? git(target, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
      : undefined;
    const inCommit =
      commit === undefined
        ? undefined
        : git(target, ["cat-file", "-e", `${ref}:${gitLocation(target).path}`]);
    if (commit !== undefined && inCommit === undefined) return "";
    throw error;
  }
}

/** What the panel shows: a file, as of a commit or now, and what to diff it against. */
interface ArtifactSource {
  target: ResolvedArtifactPath;
  ref?: string;
  /** What `d` diffs against: a fixed text, or a git ref re-read on each refresh. */
  base?: { label: string; text?: string; ref?: string };
  /** Open on the diff rather than the file (`diff` was asked for). */
  diffFirst?: boolean;
  /** Gone from the working tree, shown as a diff against a base that has it: its content reads as empty. */
  deleted?: boolean;
  /** The largest file read; larger for a host that stores large files. */
  maxBytes?: number;
}

/** Run git in the file's repository; undefined outside one or on failure. */
function git(target: ResolvedArtifactPath, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: gitLocation(target).dir,
      encoding: "utf8",
      maxBuffer: ARTIFACT_MAX_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Run git in `dir`; undefined outside a repository or on failure (a non-zero exit). */
function gitIn(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: ARTIFACT_MAX_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Where a host can read the shown file itself: its repository, commit and
 * path, when the repository is one the host serves (`resolve`), the file is
 * unchanged against that commit (`ref`, or HEAD for the working tree), and the
 * commit is on a remote, so the host has it. Undefined otherwise; the result
 * then carries the file.
 */
function repositorySource(
  target: ResolvedArtifactPath,
  ref: string | undefined,
  resolve: ArtifactRepositoryResolver | undefined,
): ArtifactRepositorySource | undefined {
  if (!resolve) return undefined;
  const dir = dirname(target.absolutePath);
  if (!existsSync(dir)) return undefined;
  const root = gitIn(dir, ["rev-parse", "--show-toplevel"]);
  if (!root) return undefined;
  const repository = resolve(root);
  if (!repository) return undefined;
  const path = relative(
    realpathSync(root),
    join(realpathSync(dir), basename(target.absolutePath)),
  )
    .split(sep)
    .join("/");
  if (!path || path.startsWith("..")) return undefined;
  const commit = gitIn(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref ?? "HEAD"}^{commit}`,
  ]);
  if (!commit) return undefined;
  if (gitIn(root, ["cat-file", "-e", `${commit}:${path}`]) === undefined)
    return undefined;
  // The working tree's file must be the committed one, or the host would show another version.
  if (
    !ref &&
    gitIn(root, ["diff", "--quiet", commit, "--", path]) === undefined
  )
    return undefined;
  if (!gitIn(root, ["branch", "-r", "--contains", commit])) return undefined;
  return { repository_id: repository.id, commit, path };
}

/** The branch (or short commit when detached) and whether the tree has uncommitted changes, as a zsh git prompt shows them. */
function gitState(
  target: ResolvedArtifactPath,
): { branch: string; dirty: boolean } | undefined {
  const branch = git(target, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === undefined) return undefined;
  const name =
    branch === "HEAD"
      ? (git(target, ["rev-parse", "--short", "HEAD"]) ?? branch)
      : branch;
  const status = git(target, ["status", "--porcelain", "--untracked-files=no"]);
  return { branch: name, dirty: Boolean(status) };
}

/** The file as `source` names it: at its ref, or as it is now. */
function readSource(source: ArtifactSource): string {
  if (source.ref) return gitVersion(source.target, source.ref, source.maxBytes);
  if (source.deleted && !existsSync(source.target.absolutePath)) return "";
  // A re-read re-checks the path: the file may since have become a link out of the working directory.
  resolveArtifactPath(
    workspaceRoot(source.target),
    source.target.relativePath,
    {
      anyText: true,
      ...(source.maxBytes ? { maxBytes: source.maxBytes } : {}),
    },
  );
  return readFileSync(source.target.absolutePath, "utf8");
}

/** Read an open file for the panel; a file that no longer passes reads as unreadable. */
function readDocument(source: ArtifactSource): ArtifactDocument {
  const path = source.target.relativePath;
  const language = getLanguageFromPath(path);
  const title = source.ref ? `${path} @ ${source.ref}` : path;
  let text: string | undefined;
  try {
    text = readSource(source);
  } catch {
    text = undefined;
  }
  const state = gitState(source.target);
  let diff: ArtifactDocument["diff"];
  // A diff of a file past the inline cap is too large to draw or carry.
  const diffable =
    text !== undefined &&
    new TextEncoder().encode(text).length <= ARTIFACT_DETAILS_MAX_BYTES;
  if (source.base && text !== undefined && diffable) {
    let baseText = source.base.text;
    if (baseText === undefined && source.base.ref) {
      try {
        baseText = gitBaseVersion(source.target, source.base.ref);
      } catch {
        baseText = undefined;
      }
    }
    if (baseText !== undefined) {
      const diffText = generateDiffString(baseText, text).diff;
      diff = {
        against: source.base.label,
        text: diffText,
        ...artifactDiffCounts(diffText),
      };
    }
  }
  return {
    title,
    kind: artifactKind(path),
    text,
    language,
    ...(state ? { git: state } : {}),
    ...(diff ? { diff } : {}),
    ...(diff && source.diffFirst ? { diffFirst: true } : {}),
  };
}

/** A document's diff for `details`, its text capped. */
function cappedDiff(diff: NonNullable<ArtifactDocument["diff"]>) {
  const text = capped(diff.text);
  return {
    against: diff.against,
    text: text.text,
    added: diff.added,
    removed: diff.removed,
    ...(text.truncated ? { truncated: true as const } : {}),
  };
}

/** `text` cut to `ARTIFACT_DETAILS_MAX_BYTES`, on a character boundary. */
function capped(text: string): { text: string; truncated?: true } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= ARTIFACT_DETAILS_MAX_BYTES) return { text };
  const kept = new TextDecoder()
    .decode(bytes.subarray(0, ARTIFACT_DETAILS_MAX_BYTES))
    .replace(/\uFFFD$/, "");
  return { text: kept, truncated: true };
}

interface OpenPanel {
  panel: ArtifactPanel | undefined;
  handle: OverlayHandle | undefined;
  source: ArtifactSource;
  close(): void;
  stopWatching(): void;
}

/**
 * One session's viewer: at most one panel, the file it shows, and the last
 * markdown file the agent showed or wrote (for `/recipe view` with no argument).
 */
class ArtifactViewer {
  private open: OpenPanel | undefined;
  private last: string | undefined;
  /** What the tool last showed of each path, for `diff: "previous"`. */
  private readonly shownVersions = new Map<string, string>();
  private readonly openExternal: (absolutePath: string) => Promise<void> | void;
  private readonly watchFile: (
    absolutePath: string,
    onChange: () => void,
  ) => () => void;
  private readonly debounceMs: number;

  constructor(options: ArtifactViewerOptions = {}) {
    this.openExternal = options.openExternal ?? openWithSystemApp;
    this.watchFile = options.watchFile ?? watchFileWithFs;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** The last file shown or written, relative to the working directory. */
  get lastPath(): string | undefined {
    return this.last;
  }

  get isOpen(): boolean {
    return this.open !== undefined;
  }

  get isHidden(): boolean {
    return this.open?.handle?.isHidden() ?? false;
  }

  /** What the tool last showed of `path`, if anything. */
  shownVersion(path: string): string | undefined {
    return this.shownVersions.get(path);
  }

  /** Record what the tool showed of `path`. */
  recordShown(path: string, text: string): void {
    this.shownVersions.set(path, text);
  }

  /** Remember a file the agent wrote, for `/recipe view` with no argument. */
  remember(cwd: string, path: string): void {
    try {
      this.last = resolveArtifactPath(cwd, path, {
        anyText: true,
      }).relativePath;
    } catch {
      // Not a file we could show; keep the previous one.
    }
  }

  /**
   * Show `source` in the panel, opening it if needed. The panel never takes
   * focus unless `focus` is set.
   */
  show(ctx: ExtensionContext, source: ArtifactSource, focus = false): void {
    this.last = source.target.relativePath;
    if (this.open) {
      this.open.source = source;
      // Before Pi builds the panel, the factory picks up the new source.
      if (!this.open.panel) return;
      this.open.stopWatching();
      this.open.panel.setDocument(readDocument(source));
      this.open.stopWatching = this.watch(source);
      if (focus) this.focus();
      return;
    }

    let done: ((result: undefined) => void) | undefined;
    const state: OpenPanel = {
      panel: undefined,
      handle: undefined,
      source,
      close: () => done?.(undefined),
      stopWatching: () => {},
    };
    this.open = state;
    setArtifactPanelControl(this.panelControl);
    void ctx.ui
      .custom<undefined>(
        (tui, theme, _keybindings, finish) => {
          done = finish;
          state.panel = new ArtifactPanel(
            tui,
            theme,
            readDocument(state.source),
            {
              openExternal: () => this.openCurrent(ctx),
              unfocus: () => this.unfocus(),
              close: () => state.close(),
              disposed: () => this.release(state),
            },
          );
          state.stopWatching = this.watch(state.source);
          return state.panel;
        },
        {
          overlay: true,
          overlayOptions: ARTIFACT_PANEL_OVERLAY_OPTIONS,
          onHandle: (handle) => {
            state.handle = handle;
            state.panel?.attach(handle);
            if (focus) this.focus();
          },
        },
      )
      .then(
        () => this.release(state),
        (error: unknown) => {
          this.release(state);
          ctx.ui.notify(
            `Could not open the artifact panel: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        },
      );
  }

  /** Scroll the open panel without taking focus. */
  scroll(by: ArtifactPanelScrollBy): void {
    const panel = this.open?.panel;
    if (!panel) return;
    const lines = {
      "line-up": -3,
      "line-down": 3,
      "page-up": -panel.pageLines,
      "page-down": panel.pageLines,
    }[by];
    panel.scrollBy(lines);
  }

  /** Hide or show the open panel, so the user can read the conversation under it. Returns whether it is now hidden. */
  toggleHidden(): boolean {
    const handle = this.open?.handle;
    if (!handle) return false;
    handle.setHidden(!handle.isHidden());
    return handle.isHidden();
  }

  /** While a dialog holds the keyboard, its keys replace the panel footer's; when it ends, the panel takes the keyboard back. */
  setDialogHint(hint: string | undefined): void {
    this.open?.panel?.setDialogHint(hint);
    if (hint === undefined && this.open?.handle) this.focus();
  }

  /** Close the panel, if it is open. */
  close(): void {
    this.open?.close();
  }

  private focus(): void {
    if (!this.open?.handle) return;
    this.open.handle.focus();
    this.open.panel?.requestRender();
  }

  private unfocus(): void {
    if (!this.open?.handle) return;
    // With no target, Pi returns input to whatever had it before: the editor.
    this.open.handle.unfocus();
    this.open.panel?.requestRender();
  }

  private openCurrent(ctx: ExtensionContext): void {
    const target = this.open?.source.target;
    if (!target) return;
    Promise.resolve()
      .then(() => this.openExternal(target.absolutePath))
      .catch((error: unknown) => {
        ctx.ui.notify(
          `Could not open ${target.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      });
  }

  private watch(source: ArtifactSource): () => void {
    // A commit's version never changes, and its file may be gone from the working tree.
    if (source.ref) return () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = this.watchFile(source.target.absolutePath, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (this.open?.source !== source) return;
        this.open.panel?.setDocument(readDocument(source), true);
      }, this.debounceMs);
    });
    return () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      stop();
    };
  }

  private readonly panelControl: ArtifactPanelControl = {
    scroll: (by) => this.scroll(by),
    setDialogHint: (hint) => this.setDialogHint(hint),
  };

  private release(state: OpenPanel): void {
    state.stopWatching();
    state.stopWatching = () => {};
    if (this.open === state) this.open = undefined;
    if (!this.open && artifactPanelControl() === this.panelControl)
      setArtifactPanelControl(undefined);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What to show of `target`: at `ref` or as it is now, diffed against `diff`
 * (`previous` or a git ref) when given. Records what is shown, for the next
 * `previous`; `note` says when there was nothing earlier to compare against.
 */
function artifactSourceFor(
  viewer: ArtifactViewer,
  target: ResolvedArtifactPath,
  ref: string | undefined,
  diff: string | undefined,
  deleted = false,
  maxBytes?: number,
): { source: ArtifactSource; current: string; note: string } {
  const source: ArtifactSource = {
    target,
    ...(ref ? { ref } : {}),
    ...(deleted ? { deleted } : {}),
    ...(maxBytes ? { maxBytes } : {}),
  };
  const current = readSource(source);
  const against = diff?.trim();
  const previous = viewer.shownVersion(target.relativePath);
  const previousBase =
    previous === undefined
      ? undefined
      : { label: "the version shown before", text: previous };
  let note = "";
  if (against === DIFF_PREVIOUS) {
    if (previousBase) source.base = previousBase;
    else
      note = ` Nothing of ${target.relativePath} was shown earlier in this session, so the whole file is shown.`;
  } else if (against) {
    // Fails here, with the reason, when the ref names no commit.
    const base = gitBaseVersion(target, against);
    if (deleted && base === "") {
      throw new Error(
        `${target.relativePath} does not exist, and isn't in ${against} either.`,
      );
    }
    source.base = { label: against, ref: against };
  } else if (!ref || diff !== undefined) {
    // With no diff named, `d` still offers one: against HEAD for a tracked file, else the version shown before.
    const tracked =
      git(target, ["cat-file", "-e", `HEAD:${gitLocation(target).path}`]) !==
      undefined;
    if (tracked) source.base = { label: "HEAD", ref: "HEAD" };
    else if (previousBase) source.base = previousBase;
    if (deleted && !tracked) {
      throw new Error(
        `${target.relativePath} does not exist, and isn't in HEAD either.`,
      );
    }
  }
  // A bare `diff` (`""`) opens on the diff `d` would show.
  if (diff !== undefined && source.base) source.diffFirst = true;
  else if (diff !== undefined && !against && !source.base)
    note = ` ${target.relativePath} isn't tracked by git and wasn't shown earlier in this session, so there is nothing to diff against.`;
  viewer.recordShown(target.relativePath, current);
  return { source, current, note };
}

/** `--name value`, `--name=value`, or a bare `--name` (value undefined). */
const COMMAND_OPTION = (name: string) =>
  new RegExp(`(?:^|\\s)--${name}(?:(?:=|\\s+)(?!--)(\\S+))?(?=\\s|$)`);

/**
 * Resolve a path to show. A file gone from the working tree passes only when
 * a git base is asked for (`diff` other than `previous`, or a bare one, which
 * diffs against HEAD): it then shows as removed, as `git diff <ref> -- path` does.
 */
function resolveShownPath(
  cwd: string,
  path: string,
  ref: string | undefined,
  diff: string | undefined,
  maxBytes = ARTIFACT_MAX_BYTES,
): { target: ResolvedArtifactPath; deleted: boolean } {
  if (ref) {
    return {
      target: resolveArtifactPath(cwd, path, {
        anyText: true,
        inWorkingTree: false,
        maxBytes,
      }),
      deleted: false,
    };
  }
  try {
    return {
      target: resolveArtifactPath(cwd, path, { anyText: true, maxBytes }),
      deleted: false,
    };
  } catch (error) {
    const gitBase = diff !== undefined && diff.trim() !== DIFF_PREVIOUS;
    if (!gitBase) throw error;
    const target = resolveArtifactPath(cwd, path, {
      anyText: true,
      inWorkingTree: false,
      maxBytes,
    });
    // A file that exists but fails a check (binary, too large) still fails.
    if (existsSync(target.absolutePath)) throw error;
    return { target, deleted: true };
  }
}

/**
 * `/recipe view`'s arguments: a path, `--ref <ref>` and `--diff [<ref|previous>]`.
 * A bare `--diff` (`diff: ""`) opens on the diff `d` would show.
 */
function commandArgs(
  args: string,
  cwd: string,
): {
  path: string;
  ref?: string;
  diff?: string;
} {
  let rest = args;
  let spaced = false;
  const option = (name: string) => {
    const match = COMMAND_OPTION(name).exec(rest);
    if (!match) return undefined;
    rest = rest.replace(match[0], " ");
    if (name === "diff")
      spaced = match[1] !== undefined && !match[0].includes("=");
    return match[1] ?? "";
  };
  let diff = option("diff");
  const ref = option("ref");
  let path = commandPath(rest);
  // `--diff <file>` with no other path, when that names a file: a bare `--diff` on it.
  // `--diff=<ref>`, and a value naming no file, stay a base for the last file shown.
  if (
    !path &&
    diff &&
    diff !== DIFF_PREVIOUS &&
    spaced &&
    existsSync(resolve(cwd, commandPath(diff)))
  ) {
    path = commandPath(diff);
    diff = "";
  }
  return {
    path,
    ...(ref ? { ref } : {}),
    ...(diff !== undefined ? { diff } : {}),
  };
}

const ARTIFACT_MIME_TYPES: Record<ArtifactKind, string> = {
  markdown: "text/markdown",
  html: "text/html",
  text: "text/plain",
};

/**
 * Build the tool over a session's viewer. With `store`, a file past the
 * inline cap is kept in the host's store during the call, so the result the
 * conversation records names it (`file`) instead of carrying it.
 */
function createShowArtifactTool(
  viewer: ArtifactViewer,
  store?: ArtifactStore,
  resolveRepository?: ArtifactRepositoryResolver,
): ToolDefinition {
  const tool: ToolDefinition<typeof parameters, ShowArtifactDetails> = {
    name: SHOW_ARTIFACT_TOOL_NAME,
    label: "Show artifact",
    description,
    promptSnippet:
      "Show the user a file you wrote, or what changed in it, beside the conversation",
    promptGuidelines: [
      "When you write a file the user should read or approve (a brief, test cases, a report, code), show it with show_artifact instead of only printing its path; after revising one, show it with diff to point at what changed.",
    ],
    parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ref = params.ref?.trim() || undefined;
      const maxBytes =
        store || resolveRepository
          ? STORED_ARTIFACT_MAX_BYTES
          : ARTIFACT_MAX_BYTES;
      const { target, deleted } = resolveShownPath(
        ctx.cwd,
        params.path,
        ref,
        params.diff,
        maxBytes,
      );
      const { source, current, note } = artifactSourceFor(
        viewer,
        target,
        ref,
        params.diff,
        deleted,
        maxBytes,
      );
      const document = readDocument(source);
      const kind = artifactKind(target.relativePath);
      const bytes = new TextEncoder().encode(current).length;
      // A committed file the host serves is read from its repository; otherwise it rides along, or is stored.
      const committed = deleted
        ? undefined
        : repositorySource(target, ref, resolveRepository);
      // Stored now, so the recorded result names the file; a host's own sync recognises the same upload.
      const stored =
        !committed && store && bytes > ARTIFACT_DETAILS_MAX_BYTES
          ? await store({
              path: target.relativePath,
              content: current,
              mimeType: ARTIFACT_MIME_TYPES[kind],
            })
          : undefined;
      const content = stored || committed ? { text: "" } : capped(current);
      const details: ShowArtifactDetails = {
        path: target.relativePath,
        shown: false,
        kind,
        ...(document.language ? { language: document.language } : {}),
        ...(ref ? { ref } : {}),
        content: content.text,
        ...("truncated" in content && content.truncated
          ? { truncated: true as const }
          : {}),
        ...(stored ? { file: { id: stored.id, bytes } } : {}),
        ...(committed ? { source: committed } : {}),
        ...(document.git ? { git: document.git } : {}),
        ...(document.diff ? { diff: cappedDiff(document.diff) } : {}),
        ...(document.diffFirst ? { opens: "diff" as const } : {}),
      };
      const what = document.diffFirst
        ? `the diff of ${document.title} against ${document.diff!.against}`
        : document.title;
      if (ctx.mode !== "tui") {
        return {
          content: [
            {
              type: "text",
              text: `There is no artifact panel here; the result carries ${what} for a host that displays it (a browser does). If the user may not see it, tell them where the file is.${note}`,
            },
          ],
          details,
        };
      }
      // It takes the keyboard as it opens, so Esc or q closes it without a shortcut first.
      viewer.show(ctx, source, true);
      const columns = process.stdout.columns;
      if (
        columns !== undefined &&
        columns < ARTIFACT_PANEL_MIN_TERMINAL_COLUMNS
      ) {
        return {
          content: [
            {
              type: "text",
              text: `The terminal is ${columns} columns wide, too narrow for the panel (it needs ${ARTIFACT_PANEL_MIN_TERMINAL_COLUMNS}), so the user can't see ${target.relativePath}: tell them where the file is, or put what they need in your message. The panel appears if they widen the terminal.${note}`,
            },
          ],
          details,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Showing ${what} in the panel on the right, which has the keyboard: the user scrolls it and closes it with Esc or q, which returns them to the editor; /${VIEW_ARTIFACT_COMMAND} reopens it.${note}`,
          },
        ],
        details: { ...details, shown: true },
      };
    },
  };
  return tool as unknown as ToolDefinition;
}

/** Strip the decorations a user may type around a path: quotes or a leading `@`. */
function commandPath(args: string): string {
  const trimmed = args.trim().replace(/^@/, "");
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2]! : trimmed;
}

/**
 * An extension factory registering the tool and `/recipe view`,
 * unless a Recipe or host extension already registered a `show_artifact`
 * tool. Callers add it only when the agent lists `show_artifact` in `tools`,
 * after the Recipe's own extensions.
 */
export function artifactViewerExtension(
  registrations?: RecipeExtensionRegistrationRegistry,
  options: ArtifactViewerOptions = {},
  agentTools: readonly string[] = [SHOW_ARTIFACT_TOOL_NAME],
  env?: NodeJS.ProcessEnv,
): ExtensionFactory {
  return (pi) => {
    const viewer = new ArtifactViewer(options);
    // review_artifacts shows each file in the same panel, so it shares the viewer.
    if (
      agentTools.includes(REVIEW_ARTIFACTS_TOOL_NAME) &&
      !registrations?.owner("tool", REVIEW_ARTIFACTS_TOOL_NAME)
    ) {
      registrations?.claim("tool", REVIEW_ARTIFACTS_TOOL_NAME, BUILTIN_OWNER);
      pi.registerTool(createReviewArtifactsTool(env, () => viewer.close()));
    }
    if (!agentTools.includes(SHOW_ARTIFACT_TOOL_NAME)) return;
    if (registrations?.owner("tool", SHOW_ARTIFACT_TOOL_NAME)) return;
    registrations?.claim("tool", SHOW_ARTIFACT_TOOL_NAME, BUILTIN_OWNER);
    pi.registerTool(
      createShowArtifactTool(
        viewer,
        options.storeArtifact,
        options.artifactRepository,
      ),
    );

    addRecipeSubcommand(
      pi,
      "view",
      async (args, ctx) => {
        if (ctx.mode !== "tui") {
          ctx.ui.notify(
            `/${VIEW_ARTIFACT_COMMAND} needs Pi's interactive terminal.`,
            "warning",
          );
          return;
        }
        const parsed = commandArgs(args, ctx.cwd);
        const path = parsed.path || viewer.lastPath;
        if (!path) {
          ctx.ui.notify(
            `Usage: /${VIEW_ARTIFACT_COMMAND} <file> [--diff [<ref|previous>]] [--ref <ref>]. With no file, it shows the last file the agent showed or wrote.`,
            "info",
          );
          return;
        }
        try {
          const { target, deleted } = resolveShownPath(
            ctx.cwd,
            path,
            parsed.ref,
            parsed.diff,
          );
          const { source, note } = artifactSourceFor(
            viewer,
            target,
            parsed.ref,
            parsed.diff,
            deleted,
          );
          viewer.show(ctx, source, true);
          if (note) ctx.ui.notify(note.trim(), "info");
        } catch (error) {
          ctx.ui.notify(errorText(error), "warning");
        }
      },
      {
        description:
          "Show a file in the panel on the right (--diff for what changed since HEAD, or --diff <ref|previous>; --ref <ref> for a commit's version)",
        complete: (argument, cwd) => artifactFilesFor(cwd, argument),
      },
    );

    pi.on("tool_result", (event, ctx) => {
      if (event.isError) return;
      if (event.toolName !== "write" && event.toolName !== "edit") return;
      const path = event.input.path;
      if (typeof path === "string") viewer.remember(ctx.cwd, path);
    });

    pi.on("session_shutdown", () => {
      viewer.close();
    });
  };
}

/** Whether the agent opted into the built-in viewer, directly or through review_artifacts. */
export function wantsArtifactViewer(agentTools: readonly string[]): boolean {
  return (
    agentTools.includes(SHOW_ARTIFACT_TOOL_NAME) ||
    agentTools.includes(REVIEW_ARTIFACTS_TOOL_NAME)
  );
}
