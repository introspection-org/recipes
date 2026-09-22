import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

import {
  mcpCliEntrypointPath,
  mcpClientEntrypointPath,
  mcporterCliEntrypointPath,
} from "../src/mcp.js";

/**
 * The session shim `exec`s these by absolute path, resolved from a string at
 * run time (`compiledEntrypoint`). Nothing else checks them: a moved source
 * file still typechecks and still passes every other test, and the break only
 * shows up inside a sandbox when an agent runs `mcp`. `pnpm test` builds
 * first, so these assert against a real `dist/`.
 */
describe("the entrypoints the mcp shim execs", () => {
  it.each([
    ["mcp CLI", mcpCliEntrypointPath],
    ["mcp client supervisor", mcpClientEntrypointPath],
    ["mcporter CLI", mcporterCliEntrypointPath],
  ])("%s resolves to a file that exists", (_name, resolve) => {
    const path = resolve();
    expect(path).toMatch(/\.(js|mjs|cjs)$/);
    expect(existsSync(path), path).toBe(true);
  });
});

/**
 * `build-mcp-daemon.mjs` bundles the daemon and the run worker as flat
 * siblings in dist, while their sources sit in different folders. The daemon
 * reaches the worker by `new URL(...)` against its own bundled location, so
 * the specifier names the OUTPUT layout — rewrite it to match the source tree
 * and it typechecks, builds, and fails only when a run starts a worker.
 */
describe("the bundled daemon and its run worker", () => {
  const dist = join(import.meta.dirname, "..", "dist");

  it.each([["mcp-daemon.js"], ["mcp-run-worker.js"]])(
    "emits %s at the dist root",
    (name) => {
      expect(existsSync(join(dist, name)), name).toBe(true);
    }
  );

  it("resolves the worker as its own sibling", () => {
    const bundle = readFileSync(join(dist, "mcp-daemon.js"), "utf8");
    expect(bundle).toContain('"./mcp-run-worker.js"');
  });

  // Imported from dist, not from source: run from `src/`, both branches of
  // `daemonPath` miss and fall through to the same answer, so only the built
  // layout can tell the bundle from the tsc tree beside it.
  it("spawns the bundled daemon, not the tsc tree", async () => {
    const built = (await import(
      pathToFileURL(join(dist, "mcp", "daemon", "client.js")).href
    )) as { daemonPath: () => string };
    expect(built.daemonPath()).toBe(join(dist, "mcp-daemon.js"));
  });
});
