#!/usr/bin/env node

import { readFileSync } from "node:fs";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const packed = JSON.parse(input);
  const entries = Array.isArray(packed) ? packed : [packed];
  const files = entries.flatMap((entry) =>
    Array.isArray(entry.files) ? entry.files.map((file) => file.path) : []
  );

  const forbidden = files.filter(
    (path) =>
      path.startsWith("packages/recipe-check-python/") ||
      path.startsWith("harbor/") ||
      path === "dist/testing.js" ||
      path === "dist/testing.d.ts"
  );
  if (forbidden.length > 0) {
    console.error("npm package includes a retired surface:");
    for (const path of forbidden) console.error(`- ${path}`);
    process.exitCode = 1;
  }

  const vendored = files.filter((path) => path.startsWith("vendor/"));
  if (vendored.length > 0) {
    console.error(
      "npm package vendors native binaries; they ship as os/cpu-gated platform packages:"
    );
    for (const path of vendored) console.error(`- ${path}`);
    process.exitCode = 1;
  }

  const brokenImports = missingRelativeImports(files);
  if (brokenImports.length > 0) {
    console.error(
      "npm package has relative imports pointing at unpacked modules:"
    );
    for (const message of brokenImports) console.error(`- ${message}`);
    process.exitCode = 1;
  }
});

// Every packed dist module must resolve its relative imports within the pack,
// or the published package throws ERR_MODULE_NOT_FOUND at import time.
function missingRelativeImports(files) {
  const packedJs = new Set(
    files.filter((path) => path.startsWith("dist/") && path.endsWith(".js"))
  );
  const missing = [];
  for (const file of packedJs) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      missing.push(`${file} is listed but not built`);
      continue;
    }
    const imports = source.matchAll(
      /(?:from\s+|import\s*\(\s*)["'](\.\.?\/[^"']+)["']/g
    );
    for (const match of imports) {
      const target = new URL(match[1], `file:///${file}`).pathname.slice(1);
      if (!target.endsWith(".js")) continue;
      if (!packedJs.has(target)) {
        missing.push(`${file} -> ${target}`);
      }
    }
  }
  return missing;
}
