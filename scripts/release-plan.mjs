#!/usr/bin/env node

// Decides what the release workflow publishes: every package whose manifest
// version has been released (its tag exists) but is not on its registry yet.
//
// The manifests say which version should exist; the registry says whether it
// does. release-please writes the manifest and cuts the tag before anything is
// published, so a publish that fails leaves a tagged version the registry
// lacks, and the next run picks it up here.
//
// Usage: node scripts/release-plan.mjs
// Prints the plan, and writes `<key>=true|false`, `npm=true|false` and
// `python_wheels=<wheels.json>` (the wheel build matrix) to $GITHUB_OUTPUT
// when set.
//
// npm and crates.io hold one file per version, so a version check is enough;
// each mcp-client platform package is its own npm package and checked on its
// own. A PyPI release holds many files and its version exists once any one is
// uploaded, so the Python package counts as published only when the sdist and
// every wheel in packages/recipe-check-python/wheels.json are there.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USER_AGENT = "recipes-release (github.com/introspection-org/recipes)";

/** Every published artifact, by the manifest entry that versions it. */
export function readArtifacts(repo) {
  const json = (file) =>
    JSON.parse(readFileSync(path.join(repo, file), "utf8"));
  const root = json(".release-please-manifest.json");
  const checker = json(".release-please-checker-manifest.json");
  const npmName = (dir) => json(path.join(dir, "package.json")).name;
  const npmVersion = (dir) => json(path.join(dir, "package.json")).version;
  const wheels = json("packages/recipe-check-python/wheels.json");
  const mcpClients = json("packages/mcp-client/npm/targets.json").map(
    (t) => `@introspection-ai/mcp-client-${t.pkg}`,
  );

  const npmPackage = (key, dir, tagPrefix, extraNames = []) => ({
    key,
    version: root[dir],
    // The publish step reads the version from package.json, so the two must agree.
    packageVersion: npmVersion(dir),
    tag: `${tagPrefix}${root[dir]}`,
    registry: "npm",
    names: [npmName(dir), ...extraNames],
  });

  return [
    // The platform binaries ship at the root's version; any one missing means
    // the root release has to run again (each publish skips what exists).
    npmPackage("root", ".", "v", mcpClients),
    npmPackage("slack", "packages/channels/slack", "recipe-channel-slack-v"),
    npmPackage("docx", "packages/documents/docx", "recipe-documents-docx-v"),
    npmPackage("pdf", "packages/documents/pdf", "recipe-documents-pdf-v"),
    npmPackage("html", "packages/documents/html", "recipe-documents-html-v"),
    npmPackage(
      "google",
      "packages/productivity/google",
      "recipe-productivity-google-v",
    ),
    npmPackage(
      "microsoft",
      "packages/productivity/microsoft",
      "recipe-productivity-microsoft-v",
    ),
    npmPackage("search", "packages/search", "recipe-search-v"),
    npmPackage("issues", "packages/issues", "recipe-issues-v"),
    npmPackage("signature", "packages/signature", "recipe-signature-v"),
    {
      key: "crate",
      version: checker["packages/recipe-check"],
      tag: `introspection-recipe-check-v${checker["packages/recipe-check"]}`,
      registry: "crates.io",
      names: ["introspection-recipe-check"],
    },
    {
      key: "python",
      version: checker["packages/recipe-check-python"],
      tag: `introspection-recipe-check-python-v${checker["packages/recipe-check-python"]}`,
      registry: "pypi",
      names: ["introspection-recipe-check"],
      wheels,
    },
    // A package's manifest version is its last release, so a package that
    // has never been released has none, and nothing to publish yet.
  ].filter((artifact) => artifact.version !== undefined);
}

/**
 * A SemVer version as Python packaging spells it (PEP 440), which is what
 * PyPI's URLs and distribution filenames use: `0.17.0-beta.0` is `0.17.0b0`,
 * `-alpha.N` is `aN`, `-rc.N` is `rcN`. A plain release is unchanged.
 */
export function pythonVersion(version) {
  const match = /^(\d+\.\d+\.\d+)-(alpha|beta|rc)\.?(\d+)$/.exec(version);
  if (!match) return version;
  const [, release, label, number] = match;
  return `${release}${{ alpha: "a", beta: "b", rc: "rc" }[label]}${number}`;
}

/** The sdist and wheel files of a PyPI release that `files` lacks. */
export function missingDistributions(name, version, wheels, files) {
  const stem = `${name.replace(/[-.]+/g, "_")}-${pythonVersion(version)}`;
  const missing = files.includes(`${stem}.tar.gz`) ? [] : [`${stem}.tar.gz`];
  for (const { platform } of wheels) {
    const tag = new RegExp(`-${platform.replaceAll("*", "[^-]*")}\\.whl$`);
    if (!files.some((file) => file.startsWith(`${stem}-`) && tag.test(file))) {
      missing.push(`${stem}-*-${platform}.whl`);
    }
  }
  return missing;
}

/**
 * For each artifact: `publish` when its tag exists and some name lacks the
 * version on its registry (for PyPI, some distribution file). An untagged
 * manifest version is never published.
 */
export async function plan(artifacts, { tags, isPublished, pypiFiles }) {
  const result = [];
  for (const a of artifacts) {
    if (a.packageVersion !== undefined && a.packageVersion !== a.version) {
      throw new Error(
        `${a.key}: manifest says ${a.version} but package.json says ${a.packageVersion}`,
      );
    }
    const missing = [];
    for (const name of a.names) {
      if (a.registry === "pypi") {
        const files = await pypiFiles(name, a.version);
        missing.push(...missingDistributions(name, a.version, a.wheels, files));
      } else if (!(await isPublished(a.registry, name, a.version))) {
        missing.push(name);
      }
    }
    const tagged = tags.has(a.tag);
    result.push({
      ...a,
      missing,
      tagged,
      publish: tagged && missing.length > 0,
    });
  }
  return result;
}

function remoteTags(repo) {
  const out = execFileSync("git", ["ls-remote", "--tags", "--refs", "origin"], {
    cwd: repo,
    encoding: "utf8",
  });
  return new Set(
    out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\trefs/tags/")[1]),
  );
}

async function get(url) {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (response.ok) return response;
  if (response.status === 404) return undefined;
  throw new Error(`${url}: HTTP ${response.status}`);
}

/** Filenames PyPI holds for a release; empty when the version does not exist. */
async function pypiFiles(name, version) {
  const response = await get(
    `https://pypi.org/pypi/${name}/${pythonVersion(version)}/json`,
  );
  if (!response) return [];
  return (await response.json()).urls.map((file) => file.filename);
}

/** The same checks the npm and crates publish steps run before publishing. */
async function isPublished(registry, name, version) {
  switch (registry) {
    case "npm":
      try {
        execFileSync("npm", ["view", `${name}@${version}`, "version"], {
          stdio: "pipe",
        });
        return true;
      } catch {
        return false;
      }
    case "crates.io":
      return (
        (await get(`https://crates.io/api/v1/crates/${name}/${version}`)) !==
        undefined
      );
    default:
      throw new Error(`unknown registry ${registry}`);
  }
}

async function main() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const artifacts = readArtifacts(repo);
  const results = await plan(artifacts, {
    tags: remoteTags(repo),
    isPublished,
    pypiFiles,
  });

  const outputs = [];
  for (const r of results) {
    let status = "published";
    if (r.publish) status = `PUBLISH (missing: ${r.missing.join(", ")})`;
    else if (r.missing.length > 0) {
      status = `not released: tag ${r.tag} does not exist`;
      console.log(
        `::warning::${r.key} ${r.version} is in the manifest but ${r.tag} is not tagged`,
      );
    }
    console.log(
      `${r.key.padEnd(7)} ${r.version.padEnd(10)} ${r.registry.padEnd(10)} ${status}`,
    );
    outputs.push(`${r.key}=${r.publish}`);
  }
  const npm = results.some((r) => r.registry === "npm" && r.publish);
  outputs.push(`npm=${npm}`);
  const wheels = artifacts.find((a) => a.key === "python").wheels;
  outputs.push(`python_wheels=${JSON.stringify(wheels)}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join("\n")}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
