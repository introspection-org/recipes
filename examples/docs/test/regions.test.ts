import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

// Every snippet the docs site includes from this repository, by region id. The
// docs fail to build on an id they cannot find, so renaming or dropping one here
// must be a deliberate change made together with the docs.
const IDS = [
  "build/sandbox/block-tool-call",
  "build/tools/write-tool",
  "build/tools/lifecycle-hook",
  "build/tools/python-script",
  "build/tools/custom-event",
  "improve/eval-cases/expected-values",
  "improve/eval-cases/per-case-files",
  "improve/evals/score-cases",
  "improve/fakes/handlers",
  "improve/fakes/scenarios",
  "improve/fakes/bind-fakes",
  "patterns/agent-follow-ups/scheduling-tool",
  "patterns/approve-outside/draft-tool",
  "patterns/ask-the-user/ask-tools",
  "patterns/structured-output/submit-tool",
  "patterns/memory-and-data/load-memory",
];

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SKIP = new Set([".git", "node_modules", "dist", "target", "vendor", ".turbo"]);
const MARKER = /^\s*(?:\/\/|#) #(region|endregion) docs:(\S+)\s*$/;

type Marker = { kind: "region" | "endregion"; id: string; file: string; line: number };

function markers(dir: string): Marker[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : markers(path);
    if (!entry.isFile()) return [];
    const text = readFileSync(path);
    if (text.includes(0)) return [];
    return text
      .toString("utf8")
      .split("\n")
      .flatMap((content, index) => {
        const match = MARKER.exec(content);
        return match
          ? [{ kind: match[1] as Marker["kind"], id: match[2]!, file: relative(ROOT, path), line: index + 1 }]
          : [];
      });
  });
}

const found = markers(ROOT);

test("every docs region id is known", () => {
  expect([...new Set(found.map((marker) => marker.id))].filter((id) => !IDS.includes(id))).toEqual([]);
});

test.each(IDS)("%s is one region, opened and closed in one file", (id) => {
  const regions = found.filter((marker) => marker.id === id && marker.kind === "region");
  const ends = found.filter((marker) => marker.id === id && marker.kind === "endregion");
  expect(regions, "#region").toHaveLength(1);
  expect(ends, "#endregion").toHaveLength(1);
  expect(ends[0]!.file).toBe(regions[0]!.file);
  expect(ends[0]!.line).toBeGreaterThan(regions[0]!.line + 1);
});

test("regions do not overlap", () => {
  const byFile = new Map<string, Marker[]>();
  for (const marker of found) byFile.set(marker.file, [...(byFile.get(marker.file) ?? []), marker]);
  for (const [file, list] of byFile) {
    let open: string | undefined;
    for (const marker of list) {
      if (marker.kind === "region") {
        expect(open, `${file}:${marker.line} opens ${marker.id} inside ${open}`).toBeUndefined();
        open = marker.id;
      } else {
        expect(marker.id, `${file}:${marker.line}`).toBe(open);
        open = undefined;
      }
    }
    expect(open, `${file} leaves ${open} open`).toBeUndefined();
  }
});
