import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // examples/ runs its own tests on the vitest its eval packages support.
    exclude: [...configDefaults.exclude, "examples/**"],
    env: {
      // The judges read their definitions through recipe-check's native
      // validator, which `pnpm test` builds.
      INTROSPECTION_RECIPE_CHECK: fileURLToPath(
        new URL("./target/debug/introspection-recipe-check", import.meta.url),
      ),
    },
  },
  resolve: {
    alias: {
      // The workspace connector packages import the channel contract the way a
      // published package does. Inside this repo that specifier has nothing to
      // resolve against, because the repo *is* that package — so point it at
      // source, mirroring what the recipe extension loader does at runtime
      // (it aliases the package prefix to the host's resolved module root and
      // appends the subpath).
      "@introspection-ai/recipes/documents": fileURLToPath(
        new URL("./src/documents/index.ts", import.meta.url),
      ),
      "@introspection-ai/recipes/productivity": fileURLToPath(
        new URL("./src/productivity/index.ts", import.meta.url),
      ),
      "@introspection-ai/recipes/search": fileURLToPath(
        new URL("./src/search/index.ts", import.meta.url),
      ),
      "@introspection-ai/recipes/issues": fileURLToPath(
        new URL("./src/issues/index.ts", import.meta.url),
      ),
      "@introspection-ai/recipes/signature": fileURLToPath(
        new URL("./src/signature/index.ts", import.meta.url),
      ),
      "@introspection-ai/recipes/channels": fileURLToPath(
        new URL("./src/channels/index.ts", import.meta.url),
      ),
    },
  },
});
