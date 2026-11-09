import { mkdir } from "node:fs/promises";
import { basename, extname } from "node:path";

// Types only: this package has no run-time dependency on @introspection-ai/recipes.
import type {
  DocumentAdapter,
  DocumentAdapterContext,
  DocumentCapabilities,
  DocumentReadInput,
  DocumentRenderInput,
  DocumentResult,
  RecipeDocumentFormatModule,
} from "@introspection-ai/recipes/documents";

import {
  BROWSER_CDP_URL_ENV,
  BROWSER_EXECUTABLE_ENV,
  resolveBrowser,
  type ResolvedBrowser,
} from "./browser.js";
import { chartNumbers, loadPage } from "./page.js";
import { readHtml } from "./read.js";
import {
  BrowserHtmlRenderer,
  RENDER_SCALE,
  ResvgHtmlRenderer,
  type HtmlRenderer,
} from "./render.js";

export {
  BROWSER_CDP_URL_ENV,
  BROWSER_EXECUTABLE_ENV,
  BROWSER_TOKEN_ENV,
  resolveBrowser,
  type BrowserLauncher,
  type ResolvedBrowser,
} from "./browser.js";
export { findCharts, type HtmlChart } from "./page.js";
export {
  BrowserHtmlRenderer,
  RENDER_SCALE,
  ResvgHtmlRenderer,
  type HtmlRenderedImage,
  type HtmlRenderer,
  type HtmlRenderRequest,
  type HtmlRenderResult,
} from "./render.js";

/** At most this many images per `render` call, as for PDF pages. */
export const MAX_IMAGES = 10;

/** What an `HtmlDocumentAdapter` runs with. */
export interface HtmlDocumentAdapterOptions {
  env?: NodeJS.ProcessEnv;
  /** Finds the browser to render with. Default `resolveBrowser`; return undefined to render without one. */
  resolveBrowser?: (
    env: NodeJS.ProcessEnv,
  ) => Promise<ResolvedBrowser | undefined>;
}

/**
 * HTML pages and SVG files are read and rendered here, never changed.
 * read: the page as markdown (linkedom, turndown), each chart a `[chart N]` line.
 * render: the full page light and dark and each chart as PNG files, with a
 * browser; without one, each inline `<svg>` chart through resvg.
 */
export const HTML_DOCUMENT_CAPABILITIES: DocumentCapabilities = {
  read: true,
  revise: false,
  proposeEdits: false,
  comment: false,
  respond: false,
  removeSection: false,
  render: true,
};

const EXTENSIONS = [".html", ".htm", ".svg"] as const;

export class HtmlDocumentAdapter implements DocumentAdapter {
  readonly format = "html";
  readonly extensions = EXTENSIONS;
  readonly capabilities = HTML_DOCUMENT_CAPABILITIES;

  constructor(private readonly options: HtmlDocumentAdapterOptions = {}) {}

  read(
    _ctx: DocumentAdapterContext,
    input: DocumentReadInput,
  ): Promise<DocumentResult> {
    return readHtml(input);
  }

  async render(
    _ctx: DocumentAdapterContext,
    input: DocumentRenderInput,
  ): Promise<DocumentResult> {
    const page = await loadPage(input.path);
    const numbers = chartNumbers(input.pages, page.charts.length);
    const fullPage = !input.pages && page.kind === "html";
    const room = MAX_IMAGES - (fullPage ? 2 : 0);
    const charts = numbers
      .slice(0, room)
      .map((number) => page.charts[number - 1]!);
    await mkdir(input.outputDir, { recursive: true });

    const env = this.options.env ?? process.env;
    const browser = await (this.options.resolveBrowser ?? resolveBrowser)(env);
    const renderer: HtmlRenderer = browser
      ? new BrowserHtmlRenderer(browser.browser, browser.source)
      : new ResvgHtmlRenderer();
    let result;
    try {
      result = await renderer.render({
        kind: page.kind,
        markup: page.renderMarkup,
        charts,
        fullPage,
        outputDir: input.outputDir,
        stem: basename(input.path, extname(input.path)),
        maxImages: room,
      });
    } finally {
      await browser?.close();
    }

    const lines = [`Path: ${renderer.description}.`];
    if (page.charts.length === 0)
      lines.push(
        page.kind === "html"
          ? "No charts on this page: no <figure> or inline <svg>."
          : "The file has no <svg> element.",
      );
    if (result.images.length > 0)
      lines.push(
        `Rendered ${result.images.length} image(s) at ${RENDER_SCALE}x; open each with the read tool.`,
        ...result.images.map(
          (image) =>
            `${image.label}: ${image.path} (${image.width}x${image.height})`,
        ),
      );
    else lines.push("Rendered no images.");
    if (numbers.length > charts.length)
      lines.push(
        `Only the first ${charts.length} of ${numbers.length} chart(s) were rendered: pass pages (chart numbers, like 2-4,9) for the others.`,
      );
    for (const { label, reason } of result.skipped)
      lines.push(`Not rendered: ${label}, ${reason}.`);
    if (!browser && result.skipped.length > 0)
      lines.push(
        `No browser was found: set ${BROWSER_CDP_URL_ENV} or ${BROWSER_EXECUTABLE_ENV}, or install Chrome, to render the page itself. Read its text with documents read.`,
      );
    return {
      text: lines.join("\n"),
      details: {
        path: [browser ? "page images" : "svg charts"],
        renderer: browser ? `browser:${browser.source}` : "resvg",
        charts: page.charts.length,
        images: result.images.map((image) => image.path),
        skipped: result.skipped.map((entry) => entry.label),
      },
    };
  }
}

/** HTML as a document format: `{ "pi": { "documents": [{ "format": "html" }] } }`. */
export const htmlDocumentFormatModule: RecipeDocumentFormatModule = {
  kind: "documents",
  apiVersion: 1,
  format: "html",
  extensions: EXTENSIONS,
  capabilities: HTML_DOCUMENT_CAPABILITIES,
  createAdapter: ({ env }) => new HtmlDocumentAdapter({ env }),
};

export default htmlDocumentFormatModule;
