import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * scripts/release-plan.mjs decides what the release workflow publishes. Only a
 * real release runs it, so pin the decision here against the real manifests
 * and a fake registry.
 */
interface Artifact {
  key: string;
  version: string;
  packageVersion?: string;
  tag: string;
  registry: string;
  names: string[];
  wheels?: Array<{ target: string; platform: string }>;
}
interface Planned extends Artifact {
  missing: string[];
  tagged: boolean;
  publish: boolean;
}
interface ReleasePlan {
  readArtifacts(repo: string): Artifact[];
  pythonVersion(version: string): string;
  plan(
    artifacts: Artifact[],
    deps: {
      tags: Set<string>;
      isPublished(
        registry: string,
        name: string,
        version: string,
      ): Promise<boolean>;
      pypiFiles(name: string, version: string): Promise<string[]>;
    },
  ): Promise<Planned[]>;
}

// A non-literal specifier keeps tsc from demanding declarations for the .mjs.
const scriptPath: string = "../scripts/release-plan.mjs";
const { readArtifacts, plan, pythonVersion } = (await import(
  scriptPath
)) as ReleasePlan;

const artifacts = readArtifacts(join(import.meta.dirname, ".."));
const allTags = new Set(artifacts.map((a) => a.tag));
const python = artifacts.find((a) => a.key === "python")!;
const stem = `introspection_recipe_check-${python.version}`;
// What PyPI lists for a complete release, as the 0.16.0 upload named them.
const pythonFiles = [
  `${stem}-cp310-abi3-macosx_10_12_x86_64.whl`,
  `${stem}-cp310-abi3-macosx_11_0_arm64.whl`,
  `${stem}-cp310-abi3-manylinux_2_28_aarch64.whl`,
  `${stem}-cp310-abi3-manylinux_2_28_x86_64.whl`,
  `${stem}-cp310-abi3-win_amd64.whl`,
  `${stem}.tar.gz`,
];
// A fake registry holding `published` ("<registry>:<name>@<version>") and, for
// PyPI, `files`.
const registry = (published: string[], files = pythonFiles) => ({
  isPublished: async (r: string, name: string, version: string) =>
    published.includes(`${r}:${name}@${version}`),
  pypiFiles: async () => files,
});
const everything = artifacts.flatMap((a) =>
  a.names.map((n) => `${a.registry}:${n}@${a.version}`),
);
const toPublish = (results: Planned[]) =>
  results.filter((r) => r.publish).map((r) => r.key);

describe("release plan", () => {
  it("covers every package with release-please's tag names", () => {
    const byKey = Object.fromEntries(artifacts.map((a) => [a.key, a]));
    // Every package release-please versions has exactly one npm artifact.
    const manifest = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", ".release-please-manifest.json"),
        "utf8",
      ),
    ) as Record<string, string>;
    const npm = artifacts.filter((a) => a.registry === "npm");
    expect(npm).toHaveLength(Object.keys(manifest).length);
    for (const dir of Object.keys(manifest)) {
      const { name } = JSON.parse(
        readFileSync(
          join(import.meta.dirname, "..", dir, "package.json"),
          "utf8",
        ),
      ) as { name: string };
      expect(npm.find((a) => a.names[0] === name)?.version).toBe(manifest[dir]);
    }
    expect(byKey.crate.registry).toBe("crates.io");
    expect(byKey.python.registry).toBe("pypi");
    expect(byKey.root.tag).toBe(`v${byKey.root.version}`);
    expect(byKey.root.names).toEqual([
      "@introspection-ai/recipes",
      "@introspection-ai/mcp-client-linux-x64",
      "@introspection-ai/mcp-client-linux-arm64",
      "@introspection-ai/mcp-client-darwin-arm64",
      "@introspection-ai/mcp-client-darwin-x64",
    ]);
    expect(byKey.docx.tag).toBe(`recipe-documents-docx-v${byKey.docx.version}`);
    expect(byKey.crate.tag).toBe(
      `introspection-recipe-check-v${byKey.crate.version}`,
    );
    expect(byKey.python.tag).toBe(
      `introspection-recipe-check-python-v${byKey.python.version}`,
    );
  });

  it("covers a package once release-please has released it", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", ".release-please-manifest.json"),
        "utf8",
      ),
    ) as Record<string, string>;
    const keys = artifacts.map((a) => a.key);
    for (const [path, key] of [
      ["packages/productivity/google", "google"],
      ["packages/productivity/microsoft", "microsoft"],
      ["packages/search", "search"],
      ["packages/documents/html", "html"],
      ["packages/issues", "issues"],
      ["packages/signature", "signature"],
    ]) {
      expect(keys.includes(key)).toBe(manifest[path] !== undefined);
    }
  });

  it("publishes nothing when every registry has its version", async () => {
    const results = await plan(artifacts, {
      tags: allTags,
      ...registry(everything),
    });
    expect(toPublish(results)).toEqual([]);
  });

  it("finishes companions a failed run left unpublished", async () => {
    const companions = new Set(["slack", "docx", "pdf"]);
    const published = artifacts
      .filter((a) => !companions.has(a.key))
      .flatMap((a) => a.names.map((n) => `${a.registry}:${n}@${a.version}`));
    const results = await plan(artifacts, {
      tags: allTags,
      ...registry(published),
    });
    expect(toPublish(results)).toEqual(["slack", "docx", "pdf"]);
  });

  it("reruns the root release when one platform binary is missing", async () => {
    const published = everything.filter(
      (p) => !p.includes("mcp-client-darwin-x64"),
    );
    const results = await plan(artifacts, {
      tags: allTags,
      ...registry(published),
    });
    expect(toPublish(results)).toEqual(["root"]);
    expect(results[0].missing).toEqual([
      "@introspection-ai/mcp-client-darwin-x64",
    ]);
  });

  it("checks each platform binary as its own npm package", async () => {
    const binaries = artifacts[0].names.filter((n) =>
      n.includes("/mcp-client-"),
    );
    expect(binaries).toHaveLength(4);
    for (const binary of binaries) {
      const published = everything.filter((p) => !p.includes(`${binary}@`));
      const results = await plan(artifacts, {
        tags: allTags,
        ...registry(published),
      });
      expect(toPublish(results)).toEqual(["root"]);
    }
  });

  it("finishes a PyPI release that is missing a wheel", async () => {
    // PyPI's version endpoint answers 200 once any one file is uploaded.
    const partial = pythonFiles.filter((f) => !f.includes("win_amd64"));
    const results = await plan(artifacts, {
      tags: allTags,
      ...registry(everything, partial),
    });
    expect(toPublish(results)).toEqual(["python"]);
    expect(results.find((r) => r.key === "python")?.missing).toEqual([
      `${stem}-*-win_amd64.whl`,
    ]);
  });

  it("matches a prerelease's files by Python's spelling of its version", async () => {
    expect(pythonVersion("0.17.0-beta.0")).toBe("0.17.0b0");
    expect(pythonVersion("0.17.0-alpha.2")).toBe("0.17.0a2");
    expect(pythonVersion("0.17.0-rc.1")).toBe("0.17.0rc1");
    expect(pythonVersion("0.17.0")).toBe("0.17.0");
    const beta = { ...python, version: "0.17.0-beta.0" };
    const betaFiles = pythonFiles.map((f) =>
      f.replace(python.version, "0.17.0b0"),
    );
    const asked: string[] = [];
    const results = await plan([beta], {
      tags: new Set([beta.tag]),
      isPublished: async () => true,
      pypiFiles: async (_name, version) => {
        asked.push(version);
        return betaFiles;
      },
    });
    expect(toPublish(results)).toEqual([]);
    expect(asked).toEqual(["0.17.0-beta.0"]);
  });

  it("finishes a PyPI release that is missing its sdist", async () => {
    const partial = pythonFiles.filter((f) => !f.endsWith(".tar.gz"));
    const results = await plan(artifacts, {
      tags: allTags,
      ...registry(everything, partial),
    });
    expect(toPublish(results)).toEqual(["python"]);
  });

  it("expects one wheel per build-python-wheels matrix entry", () => {
    // The workflow builds the matrix from this same file (python_wheels output).
    expect(python.wheels?.map((w) => w.target)).toEqual([
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
      "x86_64-pc-windows-msvc",
    ]);
  });

  it("never publishes a manifest version that has no tag", async () => {
    const tags = new Set(
      [...allTags].filter((t) => !t.startsWith("introspection-recipe-check-v")),
    );
    const results = await plan(artifacts, { tags, ...registry([], []) });
    expect(toPublish(results)).toEqual(
      artifacts.map((a) => a.key).filter((key) => key !== "crate"),
    );
    expect(results.find((r) => r.key === "crate")).toMatchObject({
      tagged: false,
      publish: false,
    });
  });

  it("refuses a manifest that disagrees with package.json", async () => {
    const drifted = artifacts.map((a) =>
      a.key === "slack" ? { ...a, packageVersion: "0.0.1" } : a,
    );
    await expect(
      plan(drifted, { tags: allTags, ...registry(everything) }),
    ).rejects.toThrow(/slack: manifest says/);
  });
});
