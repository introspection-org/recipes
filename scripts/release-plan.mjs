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
// Prints the plan, and writes `<key>=true|false` plus `npm=true|false` to
// $GITHUB_OUTPUT when set.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USER_AGENT = "recipes-release (github.com/introspection-org/recipes)";

/** Every published artifact, by the manifest entry that versions it. */
export function readArtifacts(repo) {
  const json = (file) => JSON.parse(readFileSync(path.join(repo, file), "utf8"));
  const root = json(".release-please-manifest.json");
  const checker = json(".release-please-checker-manifest.json");
  const npmName = (dir) => json(path.join(dir, "package.json")).name;
  const npmVersion = (dir) => json(path.join(dir, "package.json")).version;
  const mcpClients = json("packages/mcp-client/npm/targets.json").map(
    (t) => `@introspection-ai/mcp-client-${t.pkg}`
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
    },
  ];
}

/**
 * For each artifact: `publish` when its tag exists and some name lacks the
 * version on its registry. An untagged manifest version is never published.
 */
export async function plan(artifacts, { tags, isPublished }) {
  const result = [];
  for (const a of artifacts) {
    if (a.packageVersion !== undefined && a.packageVersion !== a.version) {
      throw new Error(
        `${a.key}: manifest says ${a.version} but package.json says ${a.packageVersion}`
      );
    }
    const missing = [];
    for (const name of a.names) {
      if (!(await isPublished(a.registry, name, a.version))) missing.push(name);
    }
    const tagged = tags.has(a.tag);
    result.push({ ...a, missing, tagged, publish: tagged && missing.length > 0 });
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
      .map((line) => line.split("\trefs/tags/")[1])
  );
}

async function httpOk(url) {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (response.ok) return true;
  if (response.status === 404) return false;
  throw new Error(`${url}: HTTP ${response.status}`);
}

/** The same checks the publish jobs run before publishing. */
async function isPublished(registry, name, version) {
  switch (registry) {
    case "npm":
      try {
        execFileSync("npm", ["view", `${name}@${version}`, "version"], { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    case "crates.io":
      return httpOk(`https://crates.io/api/v1/crates/${name}/${version}`);
    case "pypi":
      return httpOk(`https://pypi.org/pypi/${name}/${version}/json`);
    default:
      throw new Error(`unknown registry ${registry}`);
  }
}

async function main() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const results = await plan(readArtifacts(repo), { tags: remoteTags(repo), isPublished });

  const outputs = [];
  for (const r of results) {
    let status = "published";
    if (r.publish) status = `PUBLISH (missing: ${r.missing.join(", ")})`;
    else if (r.missing.length > 0) {
      status = `not released: tag ${r.tag} does not exist`;
      console.log(`::warning::${r.key} ${r.version} is in the manifest but ${r.tag} is not tagged`);
    }
    console.log(`${r.key.padEnd(7)} ${r.version.padEnd(10)} ${r.registry.padEnd(10)} ${status}`);
    outputs.push(`${r.key}=${r.publish}`);
  }
  const npm = results.some((r) => r.registry === "npm" && r.publish);
  outputs.push(`npm=${npm}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join("\n")}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
