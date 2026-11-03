import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (file: string) => fileURLToPath(new URL(`./src/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@introspection-ai\/mcp-fakes\/checks$/, replacement: src("checks.ts") },
      { find: /^@introspection-ai\/mcp-fakes\/verify$/, replacement: src("verify.ts") },
      { find: /^@introspection-ai\/mcp-fakes\/answers$/, replacement: src("answers.ts") },
      { find: /^@introspection-ai\/mcp-fakes\/testing$/, replacement: src("testing.ts") },
      { find: /^@introspection-ai\/mcp-fakes$/, replacement: src("index.ts") },
    ],
  },
  test: {
    // The bundler resolves the package by name, from dist.
    globalSetup: ["./test/build.ts"],
  },
});
