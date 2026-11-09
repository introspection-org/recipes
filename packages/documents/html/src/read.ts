import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

import type {
  DocumentReadInput,
  DocumentResult,
} from "@introspection-ai/recipes/documents";

import { loadPage } from "./page.js";

const TEXT_BUDGET = 30_000;
const REMOVED = "script, style, noscript, template, link, meta";

function markdownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  });
  service.use(gfm);
  return service;
}

/** The page as markdown: headings, lists and tables kept, each chart a `[chart N: label]` line. */
export async function readHtml(
  input: DocumentReadInput,
): Promise<DocumentResult> {
  const page = await loadPage(input.path);
  const { document, charts, elements } = page;
  for (const element of document.querySelectorAll(REMOVED)) element.remove();
  // A token survives turndown unescaped; the marker's brackets would not.
  elements.forEach((element, index) => {
    const marker = document.createElement("p");
    marker.textContent = `RECIPECHARTMARKER${index + 1}X`;
    element.parentNode?.insertBefore(marker, element);
    if (element.localName.toLowerCase() === "svg") element.remove();
    else for (const svg of element.querySelectorAll("svg")) svg.remove();
  });
  // turndown parses the markup itself: linkedom's tables lack `rows`, which the GFM table rule reads.
  const body = document.querySelector("body")?.innerHTML ?? document.toString();
  const markdown = markdownService()
    .turndown(body)
    .replace(/RECIPECHARTMARKER(\d+)X/g, (_, number: string) => {
      const label = charts[Number(number) - 1]?.label;
      return label ? `[chart ${number}: ${label}]` : `[chart ${number}]`;
    });

  const lines = [page.title ? `Title: ${page.title}` : "", markdown].filter(
    Boolean,
  );
  const text = lines.join("\n\n");
  const offset = Math.max(input.offset ?? 0, 0);
  const budget = input.budget ?? TEXT_BUDGET;
  if (offset && offset >= text.length)
    throw new Error(
      `offset ${offset} is past the end: the text is ${text.length} characters`,
    );
  const end = Math.min(offset + budget, text.length);
  let part = text.slice(offset, end);
  if (end < text.length)
    part += `\n[... ${text.length - end} more characters: pass offset ${end}]`;
  const notes =
    charts.length > 0
      ? [
          `${charts.length} chart(s), marked [chart N] in the text: render them with documents render (pages "N" picks charts) and open each PNG it returns with the read tool.`,
        ]
      : ["No charts (<figure> or <svg>) on this page."];
  return {
    text: ["Path: markdown.", part, ...notes].join("\n"),
    details: {
      kind: page.kind,
      path: ["markdown"],
      title: page.title,
      charts: charts.length,
    },
  };
}
