import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Metafile } from "esbuild";
import { describe, expect, it } from "vitest";

import {
  DISMISSED_TEXT,
  formatInteractionResume,
  lineDiff,
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
});
