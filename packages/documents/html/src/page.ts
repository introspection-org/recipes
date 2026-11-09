import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { parseHTML } from "linkedom";

/** A chart on the page: an outermost `<figure>`, or an outermost `<svg>` outside any figure. */
export interface HtmlChart {
  /** 1-based, in document order; `read` marks it `[chart N]` and `render` takes it in `pages`. */
  number: number;
  label: string;
  /** Each panel's SVG to render without a browser, with the page's `<style>` rules copied in; empty for a figure with no inline SVG. */
  svgs: string[];
}

/** Marks each chart element in `renderMarkup` with its number. */
export const CHART_ATTRIBUTE = "data-recipe-chart";

export interface HtmlPage {
  kind: "html" | "svg";
  /** The file's markup. */
  markup: string;
  /** The markup with each chart marked by number, so a page's scripts can't renumber them before a browser draws it. */
  renderMarkup: string;
  title: string;
  document: Document;
  charts: HtmlChart[];
  /** The page's chart elements, in the same order as `charts`. */
  elements: Element[];
}

/**
 * The charts on a page, as one rule for linkedom and for a browser: `render`
 * runs this function's source in the page, so it uses only the DOM.
 */
export function findCharts(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll("figure, svg")).filter((element) => {
    const outer = element.parentElement?.closest(
      element.localName.toLowerCase() === "svg" ? "figure, svg" : "figure",
    );
    return !outer;
  });
}

const SVG_NS = "http://www.w3.org/2000/svg";
const LABEL_LENGTH = 80;

function clean(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function chartLabel(element: Element): string {
  const svg =
    element.localName.toLowerCase() === "svg"
      ? element
      : element.querySelector("svg");
  const label =
    clean(element.querySelector("figcaption")?.textContent) ||
    clean(element.getAttribute("aria-label")) ||
    clean(svg?.getAttribute("aria-label")) ||
    clean(svg?.querySelector("title")?.textContent);
  return label.length > LABEL_LENGTH
    ? `${label.slice(0, LABEL_LENGTH - 1)}…`
    : label;
}

function standaloneSvg(svg: Element, styles: string): string {
  const copy = svg.cloneNode(true) as Element;
  if (!copy.getAttribute("xmlns")) copy.setAttribute("xmlns", SVG_NS);
  if (styles) {
    const style = copy.ownerDocument.createElement("style");
    style.textContent = styles;
    copy.insertBefore(style, copy.firstChild);
  }
  return copy.outerHTML;
}

/** Parse an .html, .htm or .svg file and find its charts. */
export async function loadPage(path: string): Promise<HtmlPage> {
  const markup = await readFile(path, "utf8");
  const kind = extname(path).toLowerCase() === ".svg" ? "svg" : "html";
  const { document } = parseHTML(
    kind === "svg"
      ? `<!doctype html><html><body>${markup.replace(/^\s*<\?xml[^>]*\?>/, "")}</body></html>`
      : markup,
  );
  const styles = Array.from(document.querySelectorAll("style"))
    .map((style) => style.textContent ?? "")
    .join("\n");
  const elements = findCharts(document);
  const renderMarkup = (() => {
    elements.forEach((element, index) =>
      element.setAttribute(CHART_ATTRIBUTE, String(index + 1)),
    );
    const stamped = document.toString();
    elements.forEach((element) => element.removeAttribute(CHART_ATTRIBUTE));
    return stamped;
  })();
  const charts = elements.map((element, index): HtmlChart => {
    // A figure may hold several panels; an SVG nested inside another is part of it.
    const panels =
      element.localName.toLowerCase() === "svg"
        ? [element]
        : Array.from(element.querySelectorAll("svg")).filter(
            (svg) => !svg.parentElement?.closest("svg"),
          );
    return {
      number: index + 1,
      label: chartLabel(element),
      svgs: panels.map((svg) => standaloneSvg(svg, styles)),
    };
  });
  const title =
    clean(document.querySelector("title")?.textContent) ||
    (kind === "svg" ? (charts[0]?.label ?? "") : "");
  return { kind, markup, renderMarkup, title, document, charts, elements };
}

/** Chart numbers from a list like `2-4,9`; every chart when absent. */
export function chartNumbers(
  spec: string | undefined,
  total: number,
): number[] {
  if (!spec?.trim()) return Array.from({ length: total }, (_, i) => i + 1);
  const numbers = new Set<number>();
  for (const part of spec.split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new Error(`Charts must look like 2-4,9, not '${spec}'`);
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (first < 1 || last < first || last > total)
      throw new Error(
        `Chart ${part.trim()} is out of range: the page has ${total} chart(s)`,
      );
    for (let number = first; number <= last; number += 1) numbers.add(number);
  }
  return [...numbers].sort((a, b) => a - b);
}
