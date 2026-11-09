import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Resvg } from "@resvg/resvg-js";
import type { Browser, Page } from "playwright-core";

import { findCharts, type HtmlChart } from "./page.js";

/** Pixels per CSS pixel in every image. */
export const RENDER_SCALE = 2;
const VIEWPORT = { width: 1280, height: 800 };
const CHART_ATTRIBUTE = "data-recipe-chart";

export interface HtmlRenderRequest {
  kind: "html" | "svg";
  /** The file's markup; a renderer loads it as is, so the page must be self-contained. */
  markup: string;
  /** The charts to render, each its own image. */
  charts: readonly HtmlChart[];
  /** Also render the whole page, light and dark. */
  fullPage: boolean;
  outputDir: string;
  /** File name prefix for the images. */
  stem: string;
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
    if (request.charts.length > 0) {
      images.push(
        ...(await this.capture(request, "light", async (page) => {
          await page.evaluate(
            `(${findCharts.toString()})(document).forEach((element, index) => element.setAttribute(${JSON.stringify(CHART_ATTRIBUTE)}, String(index + 1)))`,
          );
          const shots: HtmlRenderedImage[] = [];
          for (const chart of request.charts) {
            const png = await page
              .locator(`[${CHART_ATTRIBUTE}="${chart.number}"]`)
              .screenshot();
            shots.push(
              await save(chartLabel(chart), `chart-${chart.number}`, png),
            );
          }
          return shots;
        })),
      );
    }
    return { images, skipped: [] };
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
      if (!chart.svg) {
        skipped.push({
          label: chartLabel(chart),
          reason: "a figure with no inline <svg>, which needs a browser",
        });
        continue;
      }
      let rendered;
      try {
        rendered = new Resvg(chart.svg, {
          fitTo: { mode: "zoom", value: RENDER_SCALE },
          background: "white",
        }).render();
      } catch (error) {
        skipped.push({
          label: chartLabel(chart),
          reason: `resvg could not draw it: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      const path = join(
        request.outputDir,
        `${request.stem}-chart-${chart.number}.png`,
      );
      await writeFile(path, rendered.asPng());
      images.push({
        label: chartLabel(chart),
        path,
        width: rendered.width,
        height: rendered.height,
      });
    }
    return { images, skipped };
  }
}
