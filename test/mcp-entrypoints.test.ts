import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
