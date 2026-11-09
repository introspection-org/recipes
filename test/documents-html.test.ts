import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";

import { beforeAll, describe, expect, it } from "vitest";

import { registerDocumentTools } from "../src/documents/index.js";
import {
  HtmlDocumentAdapter,
  resolveBrowser,
  type BrowserLauncher,
} from "../packages/documents/html/src/index.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

type Tool = {
  execute(
    id: string,
    params: Record<string, unknown>,
  ): Promise<{ content: Array<{ text?: string }>; details: any }>;
};

const fixtures = resolve("test/fixtures/documents");
let cwd = "";

function documents(adapter: HtmlDocumentAdapter): Tool {
  const pi = createMockExtensionAPI();
  registerDocumentTools(pi, [adapter], {
    cwd,
    pagesDir: join(cwd, "pages"),
  });
  return pi.tools.get("documents") as unknown as Tool;
}

const text = (result: { content: Array<{ text?: string }> }) =>
  result.content.at(-1)?.text ?? "";

/** Decode a PNG far enough to prove it is whole: chunks, then the inflated pixel rows. */
function decodePng(path: string): { width: number; height: number } {
  const png = readFileSync(path);
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let depth = 0;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[body[9]!]!;
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(data));
  expect(rows.length).toBe(
    height * (1 + Math.ceil((width * channels * depth) / 8)),
  );
  return { width, height };
}

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "documents-html-"));
  for (const name of [
    "results.html",
    "no-charts.html",
    "panels.html",
    "scripted.html",
    "hidden.html",
    "trend.svg",
  ])
    copyFileSync(join(fixtures, name), join(cwd, name));
});

describe("html adapter: read", () => {
  it("reads a page as markdown with headings, lists, a table and chart markers", async () => {
    const result = await documents(new HtmlDocumentAdapter()).execute("1", {
      command: "read",
      path: "results.html",
    });
    const body = text(result);
    expect(body.split("\n")[0]).toBe("Path: markdown.");
    expect(body).toContain("Title: Eval results");
    expect(body).toContain("# Eval results");
    expect(body).toContain("## Scores");
    expect(body).toContain("-   Run A passed 9 of 10 trials.");
    expect(body).toContain(
      "| Run | Pass rate | Median latency |\n| --- | --- | --- |\n| A | 0.90 | 1.2 s |\n| B | 0.70 | 1.8 s |",
    );
    expect(body).toContain("[chart 1: Pass rate by run]");
    expect(body).toContain("[chart 2: Latency over trials]");
    expect(body).not.toContain("dataset.ready");
    expect(body).not.toContain(".bar");
    expect(body).toContain("2 chart(s), marked [chart N]");
    expect(result.details).toMatchObject({
      kind: "html",
      path: ["markdown"],
      charts: 2,
    });
  });

  it("says when a page has no charts", async () => {
    const body = text(
      await documents(new HtmlDocumentAdapter()).execute("2", {
        command: "read",
        path: "no-charts.html",
      }),
    );
    expect(body).toContain("A page with prose and no charts.");
    expect(body).toContain("No charts (<figure> or <svg>) on this page.");
  });
});

describe("html adapter: render without a browser (resvg)", () => {
  const tool = () =>
    documents(
      new HtmlDocumentAdapter({ resolveBrowser: async () => undefined }),
    );

  it("renders each inline SVG chart to a PNG at 2x and says only SVG charts were drawn", async () => {
    const result = await tool().execute("3", {
      command: "render",
      path: "results.html",
    });
    const body = text(result);
    expect(body.split("\n")[0]).toBe(
      "Path: SVG charts only (no browser; inline <svg> drawn by resvg).",
    );
    expect(body).toContain(
      "Not rendered: full page, drawing the whole page needs a browser.",
    );
    expect(body).toContain("No browser was found");
    expect(result.details).toMatchObject({
      renderer: "resvg",
      charts: 2,
      skipped: ["full page"],
    });
    const [bars, latency] = result.details.images as string[];
    expect(decodePng(bars!)).toEqual({ width: 600, height: 300 });
    // width="100%" resolves against the viewBox: 200x100 at 2x.
    expect(decodePng(latency!)).toEqual({ width: 400, height: 200 });
  });

  it("renders the charts pages names", async () => {
    const result = await tool().execute("4", {
      command: "render",
      path: "results.html",
      pages: "2",
    });
    expect(result.details.images).toHaveLength(1);
    expect(result.details.images[0]).toMatch(/results-chart-2\.png$/);
    expect(result.details.skipped).toEqual([]);
  });

  it("renders every panel of a figure that holds several SVGs", async () => {
    const result = await tool().execute("4b", {
      command: "render",
      path: "panels.html",
    });
    expect(result.details.images).toHaveLength(2);
    expect(result.details.images[0]).toMatch(/panels-chart-1-panel-1\.png$/);
    expect(result.details.images[1]).toMatch(/panels-chart-1-panel-2\.png$/);
    expect(decodePng(result.details.images[0])).toEqual({
      width: 400,
      height: 200,
    });
    expect(decodePng(result.details.images[1])).toEqual({
      width: 600,
      height: 300,
    });
    expect(text(result)).toContain("panel 2 of 2");
  });

  it("holds the image limit across panels and reports the rest", async () => {
    const panel = (i: number) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="#${(i * 111111).toString(16).padStart(6, "0").slice(0, 6)}"/></svg>`;
    writeFileSync(
      join(cwd, "many-panels.html"),
      `<!doctype html><html><body><figure>${Array.from({ length: 12 }, (_, i) => panel(i)).join("")}<figcaption>Twelve panels</figcaption></figure></body></html>`,
    );
    const result = await tool().execute("4c", {
      command: "render",
      path: "many-panels.html",
      pages: "1",
    });
    expect(result.details.images).toHaveLength(10);
    expect(result.details.skipped).toHaveLength(2);
    expect(text(result)).toContain("over the 10-image limit");
  });

  it("renders a standalone .svg file", async () => {
    const result = await tool().execute("5", {
      command: "render",
      path: "trend.svg",
    });
    expect(decodePng(result.details.images[0])).toEqual({
      width: 240,
      height: 120,
    });
  });

  it("reports a page with no SVG and no browser clearly", async () => {
    const result = await tool().execute("6", {
      command: "render",
      path: "no-charts.html",
    });
    const body = text(result);
    expect(body).toContain(
      "No charts on this page: no <figure> or inline <svg>.",
    );
    expect(body).toContain("Rendered no images.");
    expect(body).toContain("No browser was found");
    expect(result.details.images).toEqual([]);
  });
});

const probe = await resolveBrowser(process.env);
await probe?.close();

describe.skipIf(!probe)(
  "html adapter: render with a browser",
  { timeout: 60_000 },
  () => {
    it("renders the full page light and dark, and each chart as its own element", async () => {
      const result = await documents(new HtmlDocumentAdapter()).execute("7", {
        command: "render",
        path: "results.html",
      });
      expect(text(result)).toMatch(/^Path: page images \(browser: /);
      const images = result.details.images as string[];
      expect(images.map((path) => path.split("/").at(-1))).toEqual([
        "results-page-light.png",
        "results-page-dark.png",
        "results-chart-1.png",
        "results-chart-2.png",
      ]);
      const light = decodePng(images[0]!);
      expect(light.width).toBe(1280 * 2);
      expect(decodePng(images[1]!).width).toBe(1280 * 2);
      // The figure, with its caption, is at least the 300px SVG wide.
      expect(decodePng(images[2]!).width).toBeGreaterThanOrEqual(600);
      expect(decodePng(images[3]!).width).toBeGreaterThan(0);
      expect(result.details.skipped).toEqual([]);
    });

    it("draws the chart it numbered when the page's scripts add or remove charts", async () => {
      const result = await documents(new HtmlDocumentAdapter()).execute("8", {
        command: "render",
        path: "scripted.html",
        pages: "1-2",
      });
      const images = result.details.images as string[];
      expect(images.map((path) => path.split("/").at(-1))).toEqual([
        "scripted-chart-1.png",
      ]);
      expect(decodePng(images[0]!).width).toBe(300 * 2);
      expect(text(result)).toContain("chart 2: Time per task");
    });

    it("draws what sits behind collapsed toggles, accordions included, and skips a chart the page hides", async () => {
      const result = await documents(new HtmlDocumentAdapter()).execute("9", {
        command: "render",
        path: "hidden.html",
        pages: "1-3",
      });
      const images = result.details.images as string[];
      expect(images.map((path) => path.split("/").at(-1))).toEqual([
        "hidden-chart-1.png",
        "hidden-chart-2.png",
      ]);
      expect(decodePng(images[0]!).width).toBe(300 * 2);
      expect(decodePng(images[1]!).width).toBe(240 * 2);
      expect(text(result)).toContain("chart 3: Never shown");
    });
  },
);

type Browser = Awaited<ReturnType<BrowserLauncher["launch"]>>;

describe("resolveBrowser", () => {
  const fake = (name: string) =>
    ({ name, close: async () => {} }) as unknown as Browser;
  const missing = (where: string) =>
    new Error(`browserType.launch: Executable doesn't exist at ${where}`);

  function launcher(
    launches: Array<Browser | Error>,
  ): BrowserLauncher & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      connectOverCDP: async (url, options) => {
        calls.push({ cdp: url, ...options });
        return fake("cdp");
      },
      launch: async (options) => {
        calls.push(options);
        const next = launches.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
    };
  }

  it("connects to the host's DevTools endpoint first, with its bearer token", async () => {
    const fakes = launcher([]);
    const resolved = await resolveBrowser(
      {
        INTROSPECTION_TASK_BROWSER_CDP_URL: "ws://browser:9222",
        INTROSPECTION_TASK_BROWSER_TOKEN: "secret",
        RECIPE_DOCUMENTS_CHROME: "/usr/bin/chromium",
      },
      fakes,
    );
    expect(resolved?.source).toBe("cdp");
    expect(fakes.calls).toEqual([
      {
        cdp: "ws://browser:9222",
        headers: { Authorization: "Bearer secret" },
      },
    ]);
  });

  it("connects without a header when there is no token", async () => {
    const fakes = launcher([]);
    await resolveBrowser(
      { INTROSPECTION_TASK_BROWSER_CDP_URL: "http://localhost:9222" },
      fakes,
    );
    expect(fakes.calls).toEqual([{ cdp: "http://localhost:9222" }]);
  });

  it("launches the configured executable next", async () => {
    const fakes = launcher([fake("exe")]);
    const resolved = await resolveBrowser(
      { RECIPE_DOCUMENTS_CHROME: "/usr/bin/chromium" },
      fakes,
    );
    expect(resolved?.source).toBe("executable");
    expect(fakes.calls).toEqual([{ executablePath: "/usr/bin/chromium" }]);
  });

  it("then installed Chrome, then Playwright's Chromium", async () => {
    const fakes = launcher([
      missing("/Applications/Google Chrome"),
      fake("pw"),
    ]);
    const resolved = await resolveBrowser({}, fakes);
    expect(resolved?.source).toBe("chromium");
    expect(fakes.calls).toEqual([{ channel: "chrome" }, {}]);
  });

  it("finds none when neither is installed", async () => {
    const fakes = launcher([missing("chrome"), missing("chromium")]);
    expect(await resolveBrowser({}, fakes)).toBeUndefined();
  });

  it("throws a launch failure that is not a missing browser", async () => {
    const fakes = launcher([new Error("browserType.launch: Target crashed")]);
    await expect(resolveBrowser({}, fakes)).rejects.toThrow("Target crashed");
  });
});
