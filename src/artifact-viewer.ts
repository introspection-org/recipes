/**
 * The first-party artifact viewer: a `show_artifact` tool, `/recipe view` and `/recipe close`
 * and a focus shortcut that show a markdown file the agent wrote in a panel on
 * the right of Pi's terminal, so the user can read it before approving it.
 *
 * An agent gets it by listing `show_artifact` in its `tools`, like
 * `ask_user_question`. Only markdown is shown for now; the tool is named for
 * artifacts so other formats can join it without renaming a tool Recipes
 * already list. The panel exists only in Pi's interactive terminal; anywhere
 * else the tool returns the path as text.
 */

import { spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync, watch } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

import type {
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

import {
  ARTIFACT_PANEL_OVERLAY_OPTIONS,
  ArtifactPanel,
  type ArtifactDocument,
} from "./artifact-viewer-tui.js";
import type { RecipeExtensionRegistrationRegistry } from "./extensions.js";

export const SHOW_ARTIFACT_TOOL_NAME = "show_artifact";
/** The viewer's commands, as subcommands of Recipes' own `/recipe` so they
 * never clash with another extension's or the user's commands. */
export const VIEW_ARTIFACT_COMMAND = "recipe view";
export const CLOSE_ARTIFACT_COMMAND = "recipe close";

/** A `/recipe` subcommand an optional built-in adds: `/recipe <name> <args>`. */
export type RecipeSubcommand = (args: string, ctx: ExtensionContext) => Promise<void>;

const recipeSubcommands = new WeakMap<object, Map<string, RecipeSubcommand>>();

/** The `/recipe` subcommand `name` registered for this Pi instance, if any. */
export function recipeSubcommand(pi: object, name: string): RecipeSubcommand | undefined {
  return recipeSubcommands.get(pi)?.get(name);
}

/** The `/recipe` subcommand names registered for this Pi instance. */
export function recipeSubcommandNames(pi: object): string[] {
  return [...(recipeSubcommands.get(pi)?.keys() ?? [])];
}

function addRecipeSubcommand(pi: object, name: string, handler: RecipeSubcommand): void {
  const commands = recipeSubcommands.get(pi) ?? new Map<string, RecipeSubcommand>();
  commands.set(name, handler);
  recipeSubcommands.set(pi, commands);
}

/**
 * Moves input between the editor and the panel. Alt+R ("recipe") is unbound
 * in Pi's defaults; plain Ctrl letters are all taken, and Ctrl+Shift letters
 * are indistinguishable from Ctrl letters in terminals without the Kitty
 * keyboard protocol.
 */
export const ARTIFACT_PANEL_FOCUS_KEY = "alt+r" as const;
const FOCUS_KEY_LABEL = "Alt+R";

/** File extensions the panel renders. */
export const ARTIFACT_MARKDOWN_EXTENSIONS: readonly string[] = [".md", ".markdown"];

const BUILTIN_OWNER = "<builtin:show_artifact>";
const DEFAULT_DEBOUNCE_MS = 100;

const description = [
  "Show a markdown file to the user in a panel on the right of the terminal, rendered as markdown.",
  "Call this when you want the user to read a markdown file you wrote (a brief, test cases, a report), especially before asking them to approve it, instead of only printing its path.",
  "`path` is relative to the working directory. Only markdown files (.md, .markdown) can be shown for now.",
  "The panel opens without taking the user's keyboard and re-renders when the file changes, so you don't need to call this again after editing a file it already shows.",
  "Outside Pi's interactive terminal there is no panel: the result says so, and you should tell the user where the file is.",
].join("\n");

const parameters = Type.Object(
  {
    path: Type.String({
      description:
        "The markdown file to show, relative to the working directory (e.g. \"evals/cases/refund.md\").",
    }),
  },
  { additionalProperties: false }
);

export type ShowArtifactToolParams = Static<typeof parameters>;

/** Structured `details` of a `show_artifact` result. */
export interface ShowArtifactDetails {
  /** The file, relative to the working directory. */
  path: string;
  /** Whether the panel is showing it (false outside the interactive terminal). */
  shown: boolean;
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
export function isMarkdownPath(path: string): boolean {
  return ARTIFACT_MARKDOWN_EXTENSIONS.includes(extname(path).toLowerCase());
}

/**
 * Resolve `path` against `cwd` and check that it names an existing markdown
 * file inside `cwd`, following symlinks. Throws an error the model or user can
 * act on.
 */
export function resolveArtifactPath(cwd: string, path: string): ResolvedArtifactPath {
  const input = path.trim();
  if (!input) throw new Error("Give the path of a markdown file to show.");
  const root = resolve(cwd);
  const absolutePath = resolve(root, input);
  if (!isInside(root, absolutePath)) {
    throw new Error(
      `${input} is outside the working directory; only files under ${root} can be shown.`
    );
  }
  if (!isMarkdownPath(absolutePath)) {
    throw new Error(
      `${input} is not a markdown file; only ${ARTIFACT_MARKDOWN_EXTENSIONS.join(" and ")} files can be shown for now.`
    );
  }
  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    throw new Error(`${input} does not exist. Write the file first, then show it.`);
  }
  if (!stats.isFile()) throw new Error(`${input} is not a file.`);
  // A symlink inside the working directory may still point outside it.
  if (!isInside(realpathSync(root), realpathSync(absolutePath))) {
    throw new Error(
      `${input} links outside the working directory; only files under ${root} can be shown.`
    );
  }
  return {
    absolutePath,
    relativePath: relative(root, absolutePath).split(sep).join("/"),
  };
}

/** The default `o` action: the platform's "open with default app" command. */
export function openWithSystemApp(absolutePath: string): Promise<void> {
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

/** The default watcher: the file's folder, filtered to the file's name. */
export function watchFileWithFs(absolutePath: string, onChange: () => void): () => void {
  const name = basename(absolutePath);
  try {
    const watcher = watch(dirname(absolutePath), (_event, filename) => {
      if (!filename || filename.toString() === name) onChange();
    });
    watcher.on("error", () => {});
    return () => watcher.close();
  } catch {
    return () => {};
  }
}

function readDocument(target: ResolvedArtifactPath): ArtifactDocument {
  let markdown: string | undefined;
  try {
    markdown = readFileSync(target.absolutePath, "utf8");
  } catch {
    markdown = undefined;
  }
  return { title: target.relativePath, markdown };
}

interface OpenPanel {
  panel: ArtifactPanel | undefined;
  handle: OverlayHandle | undefined;
  target: ResolvedArtifactPath;
  close(): void;
  stopWatching(): void;
}

/**
 * One session's viewer: at most one panel, the file it shows, and the last
 * markdown file the agent showed or wrote (for `/recipe view` with no argument).
 */
export class ArtifactViewer {
  private open: OpenPanel | undefined;
  private last: string | undefined;
  private readonly openExternal: (absolutePath: string) => Promise<void> | void;
  private readonly watchFile: (absolutePath: string, onChange: () => void) => () => void;
  private readonly debounceMs: number;

  constructor(options: ArtifactViewerOptions = {}) {
    this.openExternal = options.openExternal ?? openWithSystemApp;
    this.watchFile = options.watchFile ?? watchFileWithFs;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** The last markdown file shown or written, relative to the working directory. */
  get lastPath(): string | undefined {
    return this.last;
  }

  get isOpen(): boolean {
    return this.open !== undefined;
  }

  /** Remember a markdown file the agent wrote, for `/recipe view` with no argument. */
  remember(cwd: string, path: string): void {
    if (!isMarkdownPath(path)) return;
    try {
      this.last = resolveArtifactPath(cwd, path).relativePath;
    } catch {
      // Not a file we could show; keep the previous one.
    }
  }

  /**
   * Show `target` in the panel, opening it if needed. The panel never takes
   * focus unless `focus` is set.
   */
  show(ctx: ExtensionContext, target: ResolvedArtifactPath, focus = false): void {
    this.last = target.relativePath;
    if (this.open) {
      this.open.target = target;
      // Before Pi builds the panel, the factory picks up the new target.
      if (!this.open.panel) return;
      this.open.stopWatching();
      this.open.panel.setDocument(readDocument(target));
      this.open.stopWatching = this.watch(target);
      if (focus) this.focus();
      return;
    }

    let done: ((result: undefined) => void) | undefined;
    const state: OpenPanel = {
      panel: undefined,
      handle: undefined,
      target,
      close: () => done?.(undefined),
      stopWatching: () => {},
    };
    this.open = state;
    void ctx.ui
      .custom<undefined>(
        (tui, theme, _keybindings, finish) => {
          done = finish;
          state.panel = new ArtifactPanel(
            tui,
            theme,
            readDocument(state.target),
            {
              openExternal: () => this.openCurrent(ctx),
              unfocus: () => this.unfocus(),
              close: () => state.close(),
              disposed: () => this.release(state),
            },
            ARTIFACT_PANEL_FOCUS_KEY,
            FOCUS_KEY_LABEL
          );
          state.stopWatching = this.watch(state.target);
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
        }
      )
      .then(
        () => this.release(state),
        (error: unknown) => {
        this.release(state);
        ctx.ui.notify(
          `Could not open the artifact panel: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      }
      );
  }

  /** The shortcut: move input to the panel, or back to the editor. */
  toggleFocus(ctx: ExtensionContext): void {
    if (this.open?.handle) {
      if (this.open.handle.isFocused()) this.unfocus();
      else this.focus();
      return;
    }
    if (this.open) return;
    if (!this.last) {
      ctx.ui.notify(
        `No artifact to show yet. Use /${VIEW_ARTIFACT_COMMAND} <file.md>.`,
        "info"
      );
      return;
    }
    try {
      this.show(ctx, resolveArtifactPath(ctx.cwd, this.last), true);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    }
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
    const target = this.open?.target;
    if (!target) return;
    Promise.resolve()
      .then(() => this.openExternal(target.absolutePath))
      .catch((error: unknown) => {
        ctx.ui.notify(
          `Could not open ${target.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      });
  }

  private watch(target: ResolvedArtifactPath): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = this.watchFile(target.absolutePath, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (this.open?.target !== target) return;
        this.open.panel?.setDocument(readDocument(target), true);
      }, this.debounceMs);
    });
    return () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      stop();
    };
  }

  private release(state: OpenPanel): void {
    state.stopWatching();
    state.stopWatching = () => {};
    if (this.open === state) this.open = undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build the tool over a session's viewer. */
export function createShowArtifactTool(viewer: ArtifactViewer): ToolDefinition {
  const tool: ToolDefinition<typeof parameters, ShowArtifactDetails> = {
    name: SHOW_ARTIFACT_TOOL_NAME,
    label: "Show artifact",
    description,
    promptSnippet:
      "Show the user a markdown file you wrote, rendered in a panel beside the conversation",
    promptGuidelines: [
      "When you write a markdown file the user should read or approve (a brief, test cases, a report), show it with show_artifact instead of only printing its path.",
    ],
    parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const target = resolveArtifactPath(ctx.cwd, params.path);
      if (ctx.mode !== "tui") {
        return {
          content: [
            {
              type: "text",
              text: `The file is at ${target.relativePath}. The artifact panel is only available in Pi's interactive terminal, so tell the user where the file is.`,
            },
          ],
          details: { path: target.relativePath, shown: false },
        };
      }
      viewer.show(ctx, target);
      return {
        content: [
          {
            type: "text",
            text: `Showing ${target.relativePath} in the panel on the right. The user keeps typing in the editor, closes it with /${CLOSE_ARTIFACT_COMMAND}, and can press ${FOCUS_KEY_LABEL} to scroll it.`,
          },
        ],
        details: { path: target.relativePath, shown: true },
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
 * An extension factory registering the tool, `/recipe view` and `/recipe close`, and the focus shortcut,
 * unless a Recipe or host extension already registered a `show_artifact`
 * tool. Callers add it only when the agent lists `show_artifact` in `tools`,
 * after the Recipe's own extensions.
 */
export function artifactViewerExtension(
  registrations?: RecipeExtensionRegistrationRegistry,
  options: ArtifactViewerOptions = {}
): ExtensionFactory {
  return (pi) => {
    if (registrations?.owner("tool", SHOW_ARTIFACT_TOOL_NAME)) return;
    registrations?.claim("tool", SHOW_ARTIFACT_TOOL_NAME, BUILTIN_OWNER);
    const viewer = new ArtifactViewer(options);
    pi.registerTool(createShowArtifactTool(viewer));

    addRecipeSubcommand(pi, "view", async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`/${VIEW_ARTIFACT_COMMAND} needs Pi's interactive terminal.`, "warning");
        return;
      }
      const path = commandPath(args) || viewer.lastPath;
      if (!path) {
        ctx.ui.notify(
          `Usage: /${VIEW_ARTIFACT_COMMAND} <file.md>. With no file, it shows the last markdown file the agent showed or wrote.`,
          "info"
        );
        return;
      }
      try {
        viewer.show(ctx, resolveArtifactPath(ctx.cwd, path));
      } catch (error) {
        ctx.ui.notify(errorText(error), "warning");
      }
    });
    addRecipeSubcommand(pi, "close", async () => {
      viewer.close();
    });

    pi.registerShortcut(ARTIFACT_PANEL_FOCUS_KEY, {
      description: "Move the keyboard between the editor and the artifact panel",
      handler: (ctx) => {
        if (ctx.mode === "tui") viewer.toggleFocus(ctx);
      },
    });

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

/** Whether the agent opted into the built-in viewer. */
export function wantsArtifactViewer(agentTools: readonly string[]): boolean {
  return agentTools.includes(SHOW_ARTIFACT_TOOL_NAME);
}
