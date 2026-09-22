import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Nothing else runs this script: it assembles the per-platform mcp-client
 * packages and only a real release invokes it. It located the repository root
 * by a fixed `..`, which was correct at the repo root and silently became the
 * mcp-client crate once it moved under `packages/` — the 0.27.0 publish failed
 * on it with the tag already cut.
 *
 * Run against a fake tree, never the real one: the script's job includes
 * stamping optionalDependencies onto the root manifest it finds, so pointing it
 * at this repository rewrites `package.json` and breaks `--frozen-lockfile`.
 */
const repo = join(import.meta.dirname, "..");
const npmDir = join(repo, "packages", "mcp-client", "npm");
const targets = JSON.parse(readFileSync(join(npmDir, "targets.json"), "utf8")) as Array<{
  rustTarget: string;
  os: string;
  cpu: string;
  pkg: string;
}>;

let sandbox: string | undefined;
afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

describe("the per-platform mcp-client packaging", () => {
  it("walks up to the root manifest and emits one package per target", () => {
    sandbox = mkdtempSync(join(tmpdir(), "mcp-client-pack-"));
    // The same depth the real tree has, so the walk is what is under test.
    const nested = join(sandbox, "packages", "mcp-client", "npm");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(sandbox, "package.json"),
      JSON.stringify({
        name: "@introspection-ai/recipes",
        version: "0.0.0",
        repository: { type: "git", url: "git+https://example.invalid/r.git" },
      })
    );
    for (const file of ["build-mcp-client-packages.mjs", "targets.json"]) {
      copyFileSync(join(npmDir, file), join(nested, file));
    }

    const artifacts = join(sandbox, "artifacts");
    for (const target of targets) {
      mkdirSync(join(artifacts, target.rustTarget), { recursive: true });
      writeFileSync(
        join(artifacts, target.rustTarget, target.os === "win32" ? "mcp-client.exe" : "mcp-client"),
        "#!/bin/sh\n"
      );
    }

    execFileSync(
      process.execPath,
      [join(nested, "build-mcp-client-packages.mjs"), "9.9.9", artifacts],
      { stdio: "pipe" }
    );

    for (const target of targets) {
      const manifest = JSON.parse(
        readFileSync(join(nested, "dist", `mcp-client-${target.pkg}`, "package.json"), "utf8")
      ) as { name: string; version: string; os: string[]; repository?: unknown };
      expect(manifest.name).toBe(`@introspection-ai/mcp-client-${target.pkg}`);
      expect(manifest.version).toBe("9.9.9");
      expect(manifest.os).toEqual([target.os]);
    }

    // The read that broke on the move, and the write it exists for.
    const stamped = JSON.parse(readFileSync(join(sandbox, "package.json"), "utf8")) as {
      optionalDependencies: Record<string, string>;
    };
    expect(Object.keys(stamped.optionalDependencies)).toEqual(
      targets.map((target) => `@introspection-ai/mcp-client-${target.pkg}`)
    );
  });
});
