import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Nothing else runs this script: it assembles the per-platform mcp-client
 * packages and only a real release invokes it. It located the repository root
 * by a fixed `..`, which was correct at the repo root and silently became the
 * mcp-client crate once it moved under `packages/` — the 0.27.0 publish failed
 * on it with the tag already cut.
 */
const root = join(import.meta.dirname, "..");
const script = join(root, "packages", "mcp-client", "npm", "build-mcp-client-packages.mjs");
const targets = JSON.parse(
  readFileSync(join(root, "packages", "mcp-client", "npm", "targets.json"), "utf8")
) as Array<{ rustTarget: string; os: string; pkg: string }>;

let artifacts: string | undefined;
afterEach(() => {
  if (artifacts) rmSync(artifacts, { recursive: true, force: true });
  rmSync(join(root, "packages", "mcp-client", "npm", "dist"), { recursive: true, force: true });
});

describe("the per-platform mcp-client packaging", () => {
  it("finds the repo root and emits one package per target", () => {
    artifacts = mkdtempSync(join(tmpdir(), "mcp-client-artifacts-"));
    for (const target of targets) {
      const dir = join(artifacts, target.rustTarget);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, target.os === "win32" ? "mcp-client.exe" : "mcp-client"), "#!/bin/sh\n");
    }

    execFileSync(process.execPath, [script, "9.9.9", artifacts], { stdio: "pipe" });

    for (const target of targets) {
      const pkg = join(root, "packages", "mcp-client", "npm", "dist", `mcp-client-${target.pkg}`, "package.json");
      expect(existsSync(pkg), pkg).toBe(true);
      const manifest = JSON.parse(readFileSync(pkg, "utf8")) as {
        name: string;
        version: string;
        repository?: unknown;
      };
      expect(manifest.name).toBe(`@introspection-ai/mcp-client-${target.pkg}`);
      expect(manifest.version).toBe("9.9.9");
      // Carried from the root manifest — the read that broke on the move.
      expect(manifest.repository).toBeDefined();
    }
  });
});
