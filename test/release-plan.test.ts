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
}
interface Planned extends Artifact {
  missing: string[];
  tagged: boolean;
  publish: boolean;
}
interface ReleasePlan {
  readArtifacts(repo: string): Artifact[];
  plan(
    artifacts: Artifact[],
    deps: {
      tags: Set<string>;
      isPublished(registry: string, name: string, version: string): Promise<boolean>;
    },
  ): Promise<Planned[]>;
}

// A non-literal specifier keeps tsc from demanding declarations for the .mjs.
const scriptPath: string = "../scripts/release-plan.mjs";
const { readArtifacts, plan } = (await import(scriptPath)) as ReleasePlan;

const artifacts = readArtifacts(join(import.meta.dirname, ".."));
const allTags = new Set(artifacts.map((a) => a.tag));
const registry = (published: string[]) => async (r: string, name: string, version: string) =>
  published.includes(`${r}:${name}@${version}`);
const everything = artifacts.flatMap((a) => a.names.map((n) => `${a.registry}:${n}@${a.version}`));
const toPublish = (results: Planned[]) => results.filter((r) => r.publish).map((r) => r.key);

describe("release plan", () => {
  it("covers every package with release-please's tag names", () => {
    const byKey = Object.fromEntries(artifacts.map((a) => [a.key, a]));
    expect(Object.keys(byKey)).toEqual(["root", "slack", "docx", "pdf", "crate", "python"]);
    expect(byKey.root.tag).toBe(`v${byKey.root.version}`);
    expect(byKey.root.names).toEqual([
      "@introspection-ai/recipes",
      "@introspection-ai/mcp-client-linux-x64",
      "@introspection-ai/mcp-client-linux-arm64",
      "@introspection-ai/mcp-client-darwin-arm64",
      "@introspection-ai/mcp-client-darwin-x64",
    ]);
    expect(byKey.docx.tag).toBe(`recipe-documents-docx-v${byKey.docx.version}`);
    expect(byKey.crate.tag).toBe(`introspection-recipe-check-v${byKey.crate.version}`);
    expect(byKey.python.tag).toBe(`introspection-recipe-check-python-v${byKey.python.version}`);
  });

  it("publishes nothing when every registry has its version", async () => {
    const results = await plan(artifacts, { tags: allTags, isPublished: registry(everything) });
    expect(toPublish(results)).toEqual([]);
  });

  it("finishes companions a failed run left unpublished", async () => {
    const companions = new Set(["slack", "docx", "pdf"]);
    const published = artifacts
      .filter((a) => !companions.has(a.key))
      .flatMap((a) => a.names.map((n) => `${a.registry}:${n}@${a.version}`));
    const results = await plan(artifacts, { tags: allTags, isPublished: registry(published) });
    expect(toPublish(results)).toEqual(["slack", "docx", "pdf"]);
  });

  it("reruns the root release when one platform binary is missing", async () => {
    const published = everything.filter((p) => !p.includes("mcp-client-darwin-x64"));
    const results = await plan(artifacts, { tags: allTags, isPublished: registry(published) });
    expect(toPublish(results)).toEqual(["root"]);
    expect(results[0].missing).toEqual(["@introspection-ai/mcp-client-darwin-x64"]);
  });

  it("never publishes a manifest version that has no tag", async () => {
    const tags = new Set([...allTags].filter((t) => !t.startsWith("introspection-recipe-check-v")));
    const results = await plan(artifacts, { tags, isPublished: registry([]) });
    expect(toPublish(results)).toEqual(["root", "slack", "docx", "pdf", "python"]);
    expect(results.find((r) => r.key === "crate")).toMatchObject({ tagged: false, publish: false });
  });

  it("refuses a manifest that disagrees with package.json", async () => {
    const drifted = artifacts.map((a) => (a.key === "slack" ? { ...a, packageVersion: "0.0.1" } : a));
    await expect(plan(drifted, { tags: allTags, isPublished: registry(everything) })).rejects.toThrow(
      /slack: manifest says/,
    );
  });
});
