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

export const SHOW_ARTIFACT_TOOL_NAME = "show_artifact";
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
/** The most of a file (and of its diff) a result's `details` carry, as a review's interrupt does. */
const ARTIFACT_DETAILS_MAX_BYTES = 256 * 1024;
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

/** Structured `details` of a `show_artifact` result, enough for a host without the panel to render it. */
interface ShowArtifactDetails {
  /** The file, relative to the working directory. */
  path: string;
  /** Whether the panel is showing it (false outside the interactive terminal). */
  shown: boolean;
  kind: ArtifactKind;
  /** The highlighting language, when the path names one. */
  language?: string;
  /** The commit shown, when not the working tree. */
  ref?: string;
  /** The file as shown, up to `ARTIFACT_DETAILS_MAX_BYTES`. */
  content: string;
  /** The content was cut to the cap. */
  truncated?: true;
  /** With `diff`: what it was compared against, and the diff. */
  diff?: { against: string; text: string; truncated?: true };
}

/** How the file renders. */
type ArtifactKind = "markdown" | "html" | "text";

const HTML_EXTENSIONS: readonly string[] = [".html", ".htm"];

/** How a path's file renders: markdown, HTML, or highlighted text. */
function artifactKind(path: string): ArtifactKind {
  const extension = extname(path).toLowerCase();
  if (ARTIFACT_MARKDOWN_EXTENSIONS.includes(extension)) return "markdown";
  return HTML_EXTENSIONS.includes(extension) ? "html" : "text";
}

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
  { anyText = false }: { anyText?: boolean } = {},
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
  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    throw new Error(
      `${input} does not exist. Write the file first, then show it.`,
    );
  }
  if (!stats.isFile()) throw new Error(`${input} is not a file.`);
  if (anyText && stats.size > ARTIFACT_MAX_BYTES) {
    throw new Error(
      `${input} is ${Math.ceil(stats.size / 1024)} KB, over the ${ARTIFACT_MAX_BYTES / 1024} KB the viewer reads; show a smaller file or a part of it.`,
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
  return {
    absolutePath,
    relativePath: relative(root, absolutePath).split(sep).join("/"),
  };
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

/** A file at `ref` in the working directory's git repository. */
function gitVersion(target: ResolvedArtifactPath, ref: string): string {
  if (!GIT_REF.test(ref)) {
    throw new Error(
      `${ref} is not a git ref; give a commit hash, a branch or tag, or one like HEAD~1.`,
    );
  }
  try {
    // `./` resolves the path against the working directory, wherever the repository's root is.
    return execFileSync("git", ["show", `${ref}:./${target.relativePath}`], {
      cwd: workspaceRoot(target),
      encoding: "utf8",
      maxBuffer: ARTIFACT_MAX_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(
      `${target.relativePath} has no version at ${ref} in the working directory's git repository.`,
    );
  }
}

/** What the panel shows: a file, as of a commit or now, and what to diff it against. */
interface ArtifactSource {
  target: ResolvedArtifactPath;
  ref?: string;
  base?: { label: string; text: string };
}

/** The file as `source` names it: at its ref, or as it is now. */
function readSource(source: ArtifactSource): string {
  if (source.ref) return gitVersion(source.target, source.ref);
  // A re-read re-checks the path: the file may since have become a link out of the working directory.
  resolveArtifactPath(
    workspaceRoot(source.target),
    source.target.relativePath,
    {
      anyText: true,
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
  if (source.base && text !== undefined) {
    return {
      title: `${title} vs ${source.base.label}`,
      kind: "diff",
      text: generateDiffString(source.base.text, text).diff,
      language,
    };
  }
  return { title, kind: artifactKind(path), text, language };
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
): { source: ArtifactSource; current: string; note: string } {
  const source: ArtifactSource = { target, ...(ref ? { ref } : {}) };
  const current = readSource(source);
  const against = diff?.trim();
  let note = "";
  if (against === DIFF_PREVIOUS) {
    const previous = viewer.shownVersion(target.relativePath);
    if (previous === undefined)
      note = ` Nothing of ${target.relativePath} was shown earlier in this session, so the whole file is shown.`;
    else source.base = { label: "the version shown before", text: previous };
  } else if (against) {
    source.base = { label: against, text: gitVersion(target, against) };
  }
  viewer.recordShown(target.relativePath, current);
  return { source, current, note };
}

const COMMAND_OPTION = (name: string) =>
  new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)(\\S+)`);

/** `/recipe view`'s arguments: a path, `--diff <ref|previous>` and `--ref <ref>`. */
function commandArgs(args: string): {
  path: string;
  ref?: string;
  diff?: string;
} {
  let rest = args;
  const option = (name: string) => {
    const match = COMMAND_OPTION(name).exec(rest);
    if (!match) return undefined;
    rest = rest.replace(match[0], " ");
    return match[1];
  };
  const diff = option("diff");
  const ref = option("ref");
  return {
    path: commandPath(rest),
    ...(ref ? { ref } : {}),
    ...(diff ? { diff } : {}),
  };
}

/** Build the tool over a session's viewer. */
function createShowArtifactTool(viewer: ArtifactViewer): ToolDefinition {
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
      const target = resolveArtifactPath(ctx.cwd, params.path, {
        anyText: true,
      });
      const ref = params.ref?.trim() || undefined;
      const { source, current, note } = artifactSourceFor(
        viewer,
        target,
        ref,
        params.diff,
      );
      const document = readDocument(source);
      const content = capped(current);
      const details: ShowArtifactDetails = {
        path: target.relativePath,
        shown: false,
        kind: artifactKind(target.relativePath),
        ...(document.language ? { language: document.language } : {}),
        ...(ref ? { ref } : {}),
        content: content.text,
        ...(content.truncated ? { truncated: true as const } : {}),
        ...(source.base &&
        document.kind === "diff" &&
        document.text !== undefined
          ? (() => {
              const diff = capped(document.text);
              return {
                diff: {
                  against: source.base.label,
                  text: diff.text,
                  ...(diff.truncated ? { truncated: true as const } : {}),
                },
              };
            })()
          : {}),
      };
      const what = source.base
        ? `the diff of ${document.title}`
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
    pi.registerTool(createShowArtifactTool(viewer));

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
        const parsed = commandArgs(args);
        const path = parsed.path || viewer.lastPath;
        if (!path) {
          ctx.ui.notify(
            `Usage: /${VIEW_ARTIFACT_COMMAND} <file> [--diff <ref|previous>] [--ref <ref>]. With no file, it shows the last file the agent showed or wrote.`,
            "info",
          );
          return;
        }
        try {
          const target = resolveArtifactPath(ctx.cwd, path, { anyText: true });
          const { source, note } = artifactSourceFor(
            viewer,
            target,
            parsed.ref,
            parsed.diff,
          );
          viewer.show(ctx, source, true);
          if (note) ctx.ui.notify(note.trim(), "info");
        } catch (error) {
          ctx.ui.notify(errorText(error), "warning");
        }
      },
      {
        description:
          "Show a file in the panel on the right (--diff <ref|previous> for what changed, --ref <ref> for a commit's version)",
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
