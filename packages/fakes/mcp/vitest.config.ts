import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (file: string) => fileURLToPath(new URL(`./src/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@introspection-ai\/recipe-fakes-mcp\/checks$/, replacement: src("checks.ts") },
      { find: /^@introspection-ai\/recipe-fakes-mcp\/verify$/, replacement: src("verify.ts") },
      { find: /^@introspection-ai\/recipe-fakes-mcp\/answers$/, replacement: src("answers.ts") },
      { find: /^@introspection-ai\/recipe-fakes-mcp\/testing$/, replacement: src("testing.ts") },
      { find: /^@introspection-ai\/recipe-fakes-mcp$/, replacement: src("index.ts") },
    ],
  },
  test: {
    // serve.test.ts runs dist/cli.js and copies.test.ts copies dist/, so build it first.
    globalSetup: ["./test/build.ts"],
  },
});
