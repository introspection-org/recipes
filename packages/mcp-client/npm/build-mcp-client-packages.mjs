// Assemble the publishable per-platform mcp-client packages from compiled
// binaries, and stamp their optionalDependencies onto the root manifest.
//
//   node npm/build-mcp-client-packages.mjs <version> [artifactsDir]
//
// Expects binaries staged as <artifactsDir>/<rustTarget>/mcp-client (the layout
// the release workflow assembles from its build matrix). Produces, under
// npm/dist/:
//
//   mcp-client-<os>-<cpu>/   one per target, gated by npm `os`/`cpu` so a
//                            consumer downloads only the binary it can run.
//
// This mirrors npm/build-platform-packages.mjs in introspection-cli, with one
// difference: the CLI stages a separate launcher package, while recipes
// publishes the repository root, so the optionalDependencies map is written
// back into the root package.json rather than into a staged copy.
//
// CI publishes every platform package first, then the root package, so the
// optionalDependencies it names already resolve.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const version = process.argv[2];
const artifactsDir = path.resolve(process.argv[3] ?? path.join(here, "artifacts"));
if (!version) {
  console.error("usage: build-mcp-client-packages.mjs <version> [artifactsDir]");
  process.exit(1);
}

const SCOPE = "@introspection-ai";
const targets = JSON.parse(fs.readFileSync(path.join(here, "targets.json"), "utf8"));

const distDir = path.join(here, "dist");
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

const optionalDependencies = {};

for (const t of targets) {
  const exe = t.os === "win32" ? "mcp-client.exe" : "mcp-client";
  const src = path.join(artifactsDir, t.rustTarget, exe);
  if (!fs.existsSync(src)) {
    throw new Error(`missing compiled binary for ${t.rustTarget}: ${src}`);
  }

  const pkgName = `${SCOPE}/mcp-client-${t.pkg}`;
  const pkgDir = path.join(distDir, `mcp-client-${t.pkg}`);
  const binDir = path.join(pkgDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  fs.copyFileSync(src, path.join(binDir, exe));
  if (t.os !== "win32") fs.chmodSync(path.join(binDir, exe), 0o755);

  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: pkgName,
        version,
        description: `${t.pkg} native MCP client binary for @introspection-ai/recipes`,
        license: "Apache-2.0",
        repository: {
          type: "git",
          url: "git+https://github.com/introspection-org/recipes.git",
        },
        os: [t.os],
        cpu: [t.cpu],
        files: ["bin"],
      },
      null,
      2
    ) + "\n"
  );

  optionalDependencies[pkgName] = version;
  console.log(`packaged ${pkgName}@${version}`);
}

const rootPkgPath = path.join(repoRoot, "package.json");
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
rootPkg.optionalDependencies = optionalDependencies;
fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, "\t") + "\n");
console.log(`stamped optionalDependencies onto ${rootPkg.name}`);
console.warn(
  "\nNote: package.json has been modified in place — that stamp belongs to a\n" +
    "release, not to the repository. Outside CI, `git checkout -- package.json`\n" +
    "before committing."
);

console.log(`\nDone. ${targets.length} platform packages in ${distDir}`);
