import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Metafile } from "esbuild";
import { describe, expect, it } from "vitest";

import {
  DISMISSED_TEXT,
  formatInteractionResume,
  lineDiff,
  tabWindow,
  tabName,
} from "../src/review.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe("the review core", () => {
  it("imports nothing from Node, Pi, typebox or a renderer, however deep", async () => {
    const result = await build({
      entryPoints: ["src/review.ts"],
      absWorkingDir: root,
      bundle: true,
      write: false,
      metafile: true,
      platform: "neutral",
      format: "esm",
      logLevel: "silent",
      // Mark every bare import external so it shows up in the metafile rather than being bundled.
      plugins: [
        {
          name: "record-bare-imports",
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => ({
              path: args.path,
              external: true,
            }));
          },
        },
      ],
    });
    const metafile: Metafile = result.metafile;
    const imports = Object.values(metafile.inputs).flatMap((input) =>
      input.imports.map((imported) => imported.path),
    );
    expect(imports.filter((path) => !path.startsWith("src/"))).toEqual([]);
    const modules = Object.keys(metafile.inputs);
    expect(modules.some((path) => /-tui\.ts$/.test(path))).toBe(false);
  });

  it("bundles for a browser through the package subpath alone", async () => {
    const result = await build({
      stdin: {
        resolveDir: root,
        contents: `import { formatReviews } from "@introspection-ai/recipes/review"; console.log(formatReviews([]));`,
      },
      absWorkingDir: root,
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      logLevel: "silent",
    });
    expect(result.errors).toEqual([]);
    expect(result.outputFiles[0]!.text).toContain("Reviewed ");
  });

  it("tells the model to wait when a cancelled resume says the user dismissed it", () => {
    expect(
      formatInteractionResume({
        status: "cancelled",
        payload: { dismissed: true },
      }),
    ).toBe(DISMISSED_TEXT);
    expect(formatInteractionResume({ status: "cancelled" })).toBe(
      "User declined to answer. Proceed with your best judgment.",
    );
  });

  it("names a tab from a path without Node's path module", () => {
    expect(tabName("Four questions", "outputs/C1-1-transcript.md", 0)).toBe(
      "C1-1",
    );
    expect(tabName("Design", "docs/DESIGN.md", 2)).toBe("DESIGN");
    expect(tabName("Something", "a/very-long-file-name.md", 3)).toBe("4");
  });

  it("diffs a file's previous review against now, line by line", () => {
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
  });

  it("slides the tabs to keep the current one in view", () => {
    const widths = Array.from({ length: 21 }, () => 10);
    // Room for 5 tabs with both marks: the current one sits at the right.
    expect(tabWindow(widths, 20, 54)).toEqual({ start: 16, end: 21 });
    expect(tabWindow(widths, 0, 54)).toEqual({ start: 0, end: 5 });
    expect(tabWindow(widths, 10, 54)).toEqual({ start: 6, end: 11 });
    expect(tabWindow(widths, 3, 1000)).toEqual({ start: 0, end: 21 });
    expect(tabWindow([], 0, 10)).toEqual({ start: 0, end: 0 });
  });

  it("keeps a large, mostly unchanged review's diff bounded", () => {
    const before = Array.from({ length: 5000 }, (_, i) => `- item ${i}`).join(
      "\n",
    );
    const after = before.replace("- item 2500", "- item 2500 (edited)");
    const lines = lineDiff(before, after);
    expect(lines.filter((line) => line.kind !== "same")).toEqual([
      { kind: "removed", text: "- item 2500" },
      { kind: "added", text: "- item 2500 (edited)" },
    ]);
    expect(lines).toHaveLength(5001);
  });

  it("reads a changed middle too large to diff as removed, then added", () => {
    const before = Array.from({ length: 2000 }, (_, i) => `a${i}`).join("\n");
    const after = Array.from({ length: 2000 }, (_, i) => `b${i}`).join("\n");
    const lines = lineDiff(before, after);
    expect(lines.slice(0, 2000).every((line) => line.kind === "removed")).toBe(
      true,
    );
    expect(lines.slice(2000).every((line) => line.kind === "added")).toBe(true);
  });
});
