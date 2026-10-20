import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// tsconfig.json maps each public specifier to the source its "exports" entry is
// built from. A map written by hand drifts, so derive it and compare.
test("tsconfig paths are the root package's exports, at source", () => {
  const root = JSON.parse(read("../../../package.json")) as {
    name: string;
    exports: Record<string, { types: string }>;
  };
  const expected = Object.fromEntries(
    Object.entries(root.exports).map(([subpath, entry]) => [
      root.name + subpath.slice(1),
      [`../../${entry.types.replace(/^\.\/dist\//, "src/").replace(/\.d\.ts$/, ".ts")}`],
    ]),
  );
  const tsconfig = JSON.parse(
    read("../tsconfig.json")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n"),
  ) as { compilerOptions: { paths: Record<string, string[]> } };
  expect(tsconfig.compilerOptions.paths).toEqual(expected);
});
