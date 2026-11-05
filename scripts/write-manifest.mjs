// Writes the values Recipes reads from its own package.json into a module, so
// a host that bundles Recipes carries them instead of looking for the file.
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const COMPANION_PREFIX = "@introspection-ai/recipe-";

const manifest = {
  version: pkg.version,
  peerDependencies: pkg.peerDependencies ?? {},
  companions: Object.fromEntries(
    Object.entries(pkg.optionalDependencies ?? {})
      .filter(([name]) => name.startsWith(COMPANION_PREFIX))
      .map(([name, range]) => [name, range.replace(/^workspace:/, "")]),
  ),
};

writeFileSync(
  new URL("src/recipe/manifest.generated.ts", root),
  `// Generated from package.json by scripts/write-manifest.mjs; do not edit.\nexport const RECIPES_MANIFEST = ${JSON.stringify(manifest, null, 2)} as const;\n`,
);
