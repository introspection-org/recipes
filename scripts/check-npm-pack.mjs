#!/usr/bin/env node

import { existsSync } from "node:fs";

import { build } from "esbuild";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", async () => {
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

  const brokenImports = await missingRelativeImports(files);
  if (brokenImports.length > 0) {
    console.error(
      "npm package has relative imports pointing at unpacked modules:"
    );
    for (const message of brokenImports) console.error(`- ${message}`);
    process.exitCode = 1;
  }
});

// Every packed dist module must resolve its relative imports within the pack,
// or the published package throws ERR_MODULE_NOT_FOUND at import time. esbuild
// parses the imports, so an import-like string inside a bundled module (such as
// a runtime's source carried as text) is not mistaken for one.
async function missingRelativeImports(files) {
  const packedJs = new Set(
    files.filter((path) => path.startsWith("dist/") && path.endsWith(".js"))
  );
  const missing = [];
  const present = [...packedJs].filter((file) => {
    if (existsSync(file)) return true;
    missing.push(`${file} is listed but not built`);
    return false;
  });
  const relativeImports = [];
  await build({
    entryPoints: present,
    bundle: true,
    write: false,
    outdir: "pack-check-out",
    logLevel: "silent",
    platform: "node",
    format: "esm",
    packages: "external",
    plugins: [
      {
        name: "record-relative-imports",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^\.\.?\// }, (args) => {
            if (args.kind === "entry-point") return undefined;
            relativeImports.push({ importer: args.importer, path: args.path });
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });
  const root = `${process.cwd()}/`;
  for (const { importer, path } of relativeImports) {
    const file = importer.startsWith(root) ? importer.slice(root.length) : importer;
    const target = new URL(path, `file:///${file}`).pathname.slice(1);
    if (!target.endsWith(".js")) continue;
    if (!packedJs.has(target)) {
      missing.push(`${file} -> ${target}`);
    }
  }
  return missing;
}
