import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Resvg } from "@resvg/resvg-js";
import type { Browser, Page } from "playwright-core";

import { CHART_ATTRIBUTE, type HtmlChart } from "./page.js";

/** Pixels per CSS pixel in every image. */
export const RENDER_SCALE = 2;
const VIEWPORT = { width: 1280, height: 800 };

export interface HtmlRenderRequest {
  kind: "html" | "svg";
  /** The page's markup with its charts marked by `CHART_ATTRIBUTE`; a renderer loads it as is, so the page must be self-contained. */
  markup: string;
  /** The charts to render, each its own image. */
  charts: readonly HtmlChart[];
  /** Also render the whole page, light and dark. */
  fullPage: boolean;
  outputDir: string;
  /** File name prefix for the images. */
  stem: string;
  /** The most chart images to write; panels count one each. */
  maxImages: number;
}

export interface HtmlRenderedImage {
  label: string;
  path: string;
  width: number;
  height: number;
}

export interface HtmlRenderResult {
  images: HtmlRenderedImage[];
  /** What this renderer could not draw, and why. */
  skipped: Array<{ label: string; reason: string }>;
}

/**
 * Draws a page and its charts to PNG files. `BrowserHtmlRenderer` draws
 * everything; `ResvgHtmlRenderer`, the fallback with no browser, draws only
 * inline SVG and reports the rest as skipped.
 */
export interface HtmlRenderer {
  /** Names the path in the result, as `Path: <description>.` */
  readonly description: string;
  render(request: HtmlRenderRequest): Promise<HtmlRenderResult>;
}

const chartLabel = (chart: HtmlChart) =>
  chart.label
    ? `chart ${chart.number}: ${chart.label}`
    : `chart ${chart.number}`;

function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export class BrowserHtmlRenderer implements HtmlRenderer {
  readonly description: string;

  constructor(
    private readonly browser: Browser,
    source: string,
  ) {
    this.description = `page images (browser: ${source})`;
  }

  private async capture(
    request: HtmlRenderRequest,
    colorScheme: "light" | "dark",
    shoot: (page: Page) => Promise<HtmlRenderedImage[]>,
  ): Promise<HtmlRenderedImage[]> {
    const context = await this.browser.newContext({
      colorScheme,
      deviceScaleFactor: RENDER_SCALE,
      viewport: VIEWPORT,
    });
    try {
      const page = await context.newPage();
      // setContent, not goto: an endpoint's browser may not share this filesystem.
      await page.setContent(request.markup, { waitUntil: "load" });
      // What sits behind a collapsed toggle is part of the page to review; a
      // shared `name` makes an accordion, which would close all but the last.
      await page.evaluate(
        'document.querySelectorAll("details").forEach((d) => { d.removeAttribute("name"); d.open = true; })',
      );
      return await shoot(page);
    } finally {
      await context.close();
    }
  }

  async render(request: HtmlRenderRequest): Promise<HtmlRenderResult> {
    const images: HtmlRenderedImage[] = [];
    const save = async (label: string, name: string, png: Buffer) => {
      const path = join(request.outputDir, `${request.stem}-${name}.png`);
      await writeFile(path, png);
      return { label, path, ...pngSize(png) };
    };
    if (request.fullPage && request.kind === "html") {
      for (const scheme of ["light", "dark"] as const) {
        images.push(
          ...(await this.capture(request, scheme, async (page) => [
            await save(
              `full page (${scheme})`,
              `page-${scheme}`,
              await page.screenshot({ fullPage: true }),
            ),
          ])),
        );
      }
    }
    const skipped: HtmlRenderResult["skipped"] = [];
    if (request.charts.length > 0) {
      images.push(
        ...(await this.capture(request, "light", async (page) => {
          const shots: HtmlRenderedImage[] = [];
          for (const chart of request.charts) {
            const located = page.locator(
              `[${CHART_ATTRIBUTE}="${chart.number}"]`,
            );
            if ((await located.count()) !== 1) {
              skipped.push({
                label: chartLabel(chart),
                reason:
                  "the page's scripts removed or copied it, so its image can't be matched to it",
              });
              continue;
            }
            if (!(await located.isVisible())) {
              skipped.push({
                label: chartLabel(chart),
                reason: "it is hidden on the page, so there is nothing to draw",
              });
              continue;
            }
            shots.push(
              await save(
                chartLabel(chart),
                `chart-${chart.number}`,
                await located.screenshot(),
              ),
            );
          }
          return shots;
        })),
      );
    }
    return { images, skipped };
  }
}

export class ResvgHtmlRenderer implements HtmlRenderer {
  readonly description =
    "SVG charts only (no browser; inline <svg> drawn by resvg)";

  async render(request: HtmlRenderRequest): Promise<HtmlRenderResult> {
    const images: HtmlRenderedImage[] = [];
    const skipped: HtmlRenderResult["skipped"] = [];
    if (request.fullPage && request.kind === "html")
      skipped.push({
        label: "full page",
        reason: "drawing the whole page needs a browser",
      });
    for (const chart of request.charts) {
      if (chart.svgs.length === 0) {
        skipped.push({
          label: chartLabel(chart),
          reason: "a figure with no inline <svg>, which needs a browser",
        });
        continue;
      }
      for (const [index, svg] of chart.svgs.entries()) {
        const many = chart.svgs.length > 1;
        const label = many
          ? `${chartLabel(chart)}, panel ${index + 1} of ${chart.svgs.length}`
          : chartLabel(chart);
        if (images.length >= request.maxImages) {
          skipped.push({
            label,
            reason:
              chart.svgs.length > request.maxImages
                ? `over the ${request.maxImages}-image limit; a browser draws the whole figure as one image`
                : `over the ${request.maxImages}-image limit; render it on its own with pages: "${chart.number}"`,
          });
          continue;
        }
        let rendered;
        try {
          rendered = new Resvg(svg, {
            fitTo: { mode: "zoom", value: RENDER_SCALE },
            background: "white",
          }).render();
        } catch (error) {
          skipped.push({
            label,
            reason: `resvg could not draw it: ${error instanceof Error ? error.message : String(error)}`,
          });
          continue;
        }
        const path = join(
          request.outputDir,
          `${request.stem}-chart-${chart.number}${many ? `-panel-${index + 1}` : ""}.png`,
        );
        await writeFile(path, rendered.asPng());
        images.push({
          label,
          path,
          width: rendered.width,
          height: rendered.height,
        });
      }
    }
    return { images, skipped };
  }
}
