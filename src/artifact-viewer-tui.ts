/**
 * The right-hand artifact panel: a non-capturing Pi overlay that renders one
 * markdown file with a title line, a scroll position and a key hint.
 *
 * The panel owns no file access. `./artifact-viewer.ts` reads and watches the
 * file and calls `setDocument()`; the panel only draws and handles keys.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  type KeyId,
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
export const ARTIFACT_PANEL_OVERLAY_OPTIONS: OverlayOptions = {
  anchor: "top-right",
  width: "45%",
  minWidth: 30,
  maxHeight: "100%",
  margin: 1,
  // Opening the panel never takes input from the editor.
  nonCapturing: true,
};

/** The document the panel shows. */
export interface ArtifactDocument {
  /** The path shown in the title, relative to the working directory. */
  title: string;
  /** Markdown source, or undefined when the file is gone. */
  markdown: string | undefined;
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
  private lastBodyHeight = 1;
  private lastMaxScroll = 0;
  private handle: OverlayHandle | undefined;

  constructor(
    private readonly tui: PanelTui,
    private readonly theme: Theme,
    document: ArtifactDocument,
    private readonly actions: ArtifactPanelActions,
    /** The focus shortcut, so pressing it in the panel returns to the editor. */
    private readonly focusKey: KeyId,
    private readonly focusKeyLabel: string
  ) {
    this.document = document;
    this.markdown = new Markdown(
      document.markdown ?? "",
      0,
      0,
      artifactMarkdownTheme(theme)
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
    this.markdown.setText(document.markdown ?? "");
    if (!keepScroll) this.scrollTop = 0;
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
    if (this.document.markdown === undefined) {
      return [this.theme.fg("warning", "This file was removed or cannot be read.")];
    }
    if (this.document.markdown.trim() === "") {
      return [this.theme.fg("muted", "(empty file)")];
    }
    return this.markdown.render(contentWidth);
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
    const titleText = ` ${this.document.title} `;
    const fill = Math.max(
      1,
      width - 1 - visibleWidth(titleText) - visibleWidth(position)
    );
    const title = truncateToWidth(
      border("─") +
        this.theme.fg(focused ? "accent" : "text", this.theme.bold(titleText)) +
        border("─".repeat(fill)) +
        this.theme.fg("muted", position),
      width
    );

    const lines = [padToWidth(title, width)];
    const visible = body.slice(this.scrollTop, this.scrollTop + bodyHeight);
    for (let index = 0; index < bodyHeight; index += 1) {
      lines.push(padToWidth(`${border("│")} ${visible[index] ?? ""}`, width));
    }
    const hint = focused
      ? `↑↓ PgUp/PgDn scroll · o open · q/Esc close · ${this.focusKeyLabel} editor`
      : `/recipe close to close · ${this.focusKeyLabel} to scroll`;
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

  private scrollBy(lines: number): void {
    const next = Math.min(
      this.lastMaxScroll,
      Math.max(0, this.scrollTop + lines)
    );
    if (next === this.scrollTop) return;
    this.scrollTop = next;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    const page = Math.max(1, this.lastBodyHeight - 1);
    if (matchesKey(data, this.focusKey)) {
      this.actions.unfocus();
    } else if (matchesKey(data, Key.up) || data === "k") {
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
    } else if (data === "o") {
      this.actions.openExternal();
    } else if (matchesKey(data, Key.escape) || data === "q") {
      this.actions.close();
    }
  }
}
