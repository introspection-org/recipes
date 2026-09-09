import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadRecipeConnectors } from "../src/connector-tools.js";
import {
  readPiPackageManifest,
} from "../src/recipe-package.js";

describe("Recipe connector packages", () => {
  const cleanups: string[] = [];

  afterEach(() => {
    for (const path of cleanups.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("loads provider and tool metadata from the declared package", async () => {
    const recipeDir = mkdtempSync(join(tmpdir(), "recipe-channel-package-"));
    cleanups.push(recipeDir);
    const channelPackage = "@introspection-ai/recipe-channel-custom";
    const channelDir = join(
      recipeDir,
      "node_modules",
      "@introspection-ai",
      "recipe-channel-custom"
    );
    mkdirSync(channelDir, { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "custom-connector-recipe",
        version: "0.1.0",
        dependencies: { [channelPackage]: "0.1.0" },
        pi: {
          channels: [{ provider: "custom", commands: ["ping"], requireReply: true }],
        },
      })
    );
    writeFileSync(
      join(channelDir, "package.json"),
      JSON.stringify({
        name: channelPackage,
        version: "0.1.0",
        type: "module",
        exports: { import: "./index.js" },
      })
    );
    writeFileSync(
      join(channelDir, "index.js"),
      [
        "export default {",
        '  provider: "custom",',
        "  tools: [",
        '    { id: "ping", name: "package_owned_ping", defaultActive: false },',
        "  ],",
        '  createExtension(options) { if (!options.requireReply) throw new Error("requireReply not forwarded"); if (options.commands?.join() !== "ping" && options.commands?.length !== 0) throw new Error("commands not forwarded"); return () => {}; },',
        "};",
        "",
      ].join("\n")
    );

    const loaded = await loadRecipeConnectors(
      readPiPackageManifest(recipeDir),
      ["package_owned_ping"],
      { recipeDir }
    );

    expect(loaded.loadout).toEqual({
      toolNames: ["package_owned_ping"],
      initialActiveToolNames: [],
      deferredToolNames: ["package_owned_ping"],
    });
    expect(loaded.extensions).toHaveLength(1);
    const manifest = readPiPackageManifest(recipeDir);
    expect(manifest.channels?.[0]?.commands).toEqual(["ping"]);
    manifest.channels![0]!.commands = [];
    const empty = await loadRecipeConnectors(manifest, ["package_owned_ping"], { recipeDir });
    expect(empty.loadout.toolNames).toEqual([]);
    expect(empty.loadout.initialActiveToolNames).toEqual([]);
  });
});
