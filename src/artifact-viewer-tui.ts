/**
 * The right-hand artifact panel: a non-capturing Pi overlay that renders one
 * file (markdown rendered, other text highlighted) or a diff, with a title
 * line, a scroll position and a key hint.
 *
 * The panel owns no file access. `./artifact-viewer.ts` reads and watches the
 * file and calls `setDocument()`; the panel only draws and handles keys.
 */

import {
  highlightCode,
  renderDiff,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type MarkdownTheme,
  type OverlayHandle,
  type OverlayOptions,
} from "@earendil-works/pi-tui";

/** Where the panel sits: the top-right corner, 45% wide, full height. */
/** Below this many columns the panel isn't drawn. */
export const ARTIFACT_PANEL_MIN_TERMINAL_COLUMNS = 100;

export const ARTIFACT_PANEL_OVERLAY_OPTIONS: OverlayOptions = {
  anchor: "top-right",
  width: "45%",
  minWidth: 30,
  maxHeight: "100%",
  margin: 1,
  // Opening the panel never takes input from the editor.
  nonCapturing: true,
  // It draws over the conversation, so on a narrow terminal it would hide most of it.
  visible: (termWidth) => termWidth >= ARTIFACT_PANEL_MIN_TERMINAL_COLUMNS,
};

/** The document the panel shows. */
export interface ArtifactDocument {
  /** The path shown in the title, relative to the working directory. */
  title: string;
  /** Markdown renders; HTML and text are highlighted. */
  kind: "markdown" | "html" | "text";
  /** The file, or undefined when it is gone. */
  text: string | undefined;
  /** The highlighting language. */
  language?: string;
  /** The working directory's git branch, and whether its tree has uncommitted changes. */
  git?: { branch: string; dirty: boolean };
  /** How the file differs from its base, which `d` shows, drawn as Pi's edit tool draws a diff. */
  diff?: { against: string; text: string; added: number; removed: number };
  /** Open on the diff rather than the file. */
  diffFirst?: boolean;
}

/** What the panel asks its owner to do in response to a key. */
export interface ArtifactPanelActions {
  /** Open the file with the system opener (`o`). */
  openExternal(): void;
  /** Move input back to the editor (the focus shortcut, pressed in the panel). */
  unfocus(): void;
  /** Close the panel (Esc or `q`). */
  close(): void;
  /** Pi removed the overlay; release the file watcher. */
  disposed(): void;
}

interface PanelTui {
  requestRender(): void;
  terminal?: { rows?: number };
}

/** Pi's theme tokens for markdown, taken from the theme the overlay was given. */
export function artifactMarkdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    underline: (text) => theme.underline(text),
    strikethrough: (text) => theme.strikethrough(text),
  };
}

function padToWidth(line: string, width: number): string {
  const clipped = truncateToWidth(line, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/**
 * The panel component. Pi gives it input only while it has focus; the owner
 * moves focus with the overlay handle.
 */
export class ArtifactPanel implements Component {
  private document: ArtifactDocument;
  private readonly markdown: Markdown;
  private scrollTop = 0;
  /** Showing the diff rather than the file; each keeps its own scroll. */
  private showingDiff = false;
  private otherScrollTop = 0;
  private lastBodyHeight = 1;
  private lastMaxScroll = 0;
  private handle: OverlayHandle | undefined;

  constructor(
    private readonly tui: PanelTui,
    private readonly theme: Theme,
    document: ArtifactDocument,
    private readonly actions: ArtifactPanelActions,
  ) {
    this.document = document;
    this.showingDiff = Boolean(document.diffFirst && document.diff);
    this.markdown = new Markdown(
      document.kind === "markdown" ? (document.text ?? "") : "",
      0,
      0,
      artifactMarkdownTheme(theme),
    );
  }

  /** Called once Pi has shown the overlay. */
  attach(handle: OverlayHandle): void {
    this.handle = handle;
  }

  isFocused(): boolean {
    return this.handle?.isFocused() ?? false;
  }

  /** Replace what the panel shows; `keepScroll` holds the position on a re-render of the same file. */
  setDocument(document: ArtifactDocument, keepScroll = false): void {
    this.document = document;
    this.markdown.setText(
      document.kind === "markdown" ? (document.text ?? "") : "",
    );
    if (!keepScroll) {
      this.scrollTop = 0;
      this.otherScrollTop = 0;
      this.showingDiff = Boolean(document.diffFirst && document.diff);
    } else if (!document.diff) this.showingDiff = false;
    this.tui.requestRender();
  }

  get scrollPosition(): number {
    return this.scrollTop;
  }

  private height(): number {
    const rows = this.tui.terminal?.rows ?? 24;
    // The overlay keeps a one-row margin top and bottom.
    return Math.max(5, rows - 2);
  }

  private bodyLines(contentWidth: number): string[] {
    const { kind, text, language, diff } = this.document;
    if (this.showingDiff && diff) {
      return diff.text.trim() === ""
        ? [this.theme.fg("muted", `(no changes against ${diff.against})`)]
        : renderDiff(diff.text).split("\n");
    }
    if (text === undefined) {
      return [
        this.theme.fg("warning", "This file was removed or cannot be read."),
      ];
    }
    if (text.trim() === "") {
      return [this.theme.fg("muted", "(empty file)")];
    }
    if (kind === "markdown") return this.markdown.render(contentWidth);
    // Long lines are cut at the panel's edge rather than wrapped, as an editor shows code.
    return highlightCode(
      text,
      language ?? (kind === "html" ? "html" : undefined),
    );
  }

  render(width: number): string[] {
    const height = this.height();
    const bodyHeight = Math.max(1, height - 2);
    this.lastBodyHeight = bodyHeight;
    const border = (text: string) => this.theme.fg("border", text);
    const contentWidth = Math.max(1, width - 2);
    const body = this.bodyLines(contentWidth);
    const maxScroll = Math.max(0, body.length - bodyHeight);
    this.lastMaxScroll = maxScroll;
    this.scrollTop = Math.min(this.scrollTop, maxScroll);
    const first = body.length === 0 ? 0 : this.scrollTop + 1;
    const last = Math.min(body.length, this.scrollTop + bodyHeight);
    const position = ` ${first}-${last}/${body.length} `;

    const focused = this.isFocused();
    // A zsh-style git prompt after the path: `git:(main) ✗`, then `+2 −0 vs HEAD`.
    const { git, diff } = this.document;
    const titleText =
      ` ${this.theme.fg(focused ? "accent" : "text", this.theme.bold(this.document.title))}` +
      (git
        ? `  ${this.theme.fg("muted", "git:(")}${this.theme.fg("accent", git.branch)}${this.theme.fg("muted", ")")}` +
          (git.dirty ? ` ${this.theme.fg("warning", "✗")}` : "")
        : "") +
      (diff
        ? diff.added + diff.removed === 0
          ? `  ${this.theme.fg("muted", `no changes vs ${diff.against}`)}`
          : `  ${this.theme.fg("success", `+${diff.added}`)} ${this.theme.fg("error", `−${diff.removed}`)} ${this.theme.fg("muted", `vs ${diff.against}`)}`
        : "") +
      (this.showingDiff ? `  ${this.theme.fg("accent", "[diff]")}` : "") +
      " ";
    const fill = Math.max(
      1,
      width - 1 - visibleWidth(titleText) - visibleWidth(position),
    );
    const title = truncateToWidth(
      border("─") +
        titleText +
        border("─".repeat(fill)) +
        this.theme.fg("muted", position),
      width,
    );

    const lines = [padToWidth(title, width)];
    const visible = body.slice(this.scrollTop, this.scrollTop + bodyHeight);
    for (let index = 0; index < bodyHeight; index += 1) {
      lines.push(padToWidth(`${border("│")} ${visible[index] ?? ""}`, width));
    }
    const toggle = diff ? ` · d ${this.showingDiff ? "file" : "diff"}` : "";
    const hint = focused
      ? `↑↓ PgUp/PgDn scroll${toggle} · o open · q/Esc close`
      : (this.dialogHint ?? "Esc close");
    lines.push(padToWidth(this.theme.fg("dim", ` ${hint}`), width));
    return lines;
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  requestRender(): void {
    this.tui.requestRender();
  }

  dispose(): void {
    this.actions.disposed();
  }

  private dialogHint: string | undefined;

  /** While a dialog holds the keyboard, its scroll keys replace the footer's. */
  setDialogHint(hint: string | undefined): void {
    if (hint === this.dialogHint) return;
    this.dialogHint = hint;
    this.tui.requestRender();
  }

  /** Lines a page scroll moves: the body's last height, less one for context. */
  get pageLines(): number {
    return Math.max(1, this.lastBodyHeight - 1);
  }

  /** Switch between the file and its diff, each keeping its own scroll. */
  toggleDiff(): void {
    if (!this.document.diff) return;
    this.showingDiff = !this.showingDiff;
    [this.scrollTop, this.otherScrollTop] = [
      this.otherScrollTop,
      this.scrollTop,
    ];
    this.tui.requestRender();
  }

  scrollBy(lines: number): void {
    const next = Math.min(
      this.lastMaxScroll,
      Math.max(0, this.scrollTop + lines),
    );
    if (next === this.scrollTop) return;
    this.scrollTop = next;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    const page = this.pageLines;
    if (matchesKey(data, Key.up) || data === "k") {
      this.scrollBy(-1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.scrollBy(1);
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollBy(-page);
    } else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) {
      this.scrollBy(page);
    } else if (matchesKey(data, Key.home) || data === "g") {
      this.scrollBy(-this.scrollTop);
    } else if (matchesKey(data, Key.end) || data === "G") {
      this.scrollBy(this.lastMaxScroll - this.scrollTop);
    } else if (data === "d" && this.document.diff) {
      this.toggleDiff();
    } else if (data === "o") {
      this.actions.openExternal();
    } else if (matchesKey(data, Key.escape) || data === "q") {
      this.actions.close();
    }
  }
}
