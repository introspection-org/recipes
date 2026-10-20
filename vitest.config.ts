import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // examples/docs runs its own tests on the vitest its eval packages support.
    exclude: [...configDefaults.exclude, "examples/**"],
  },
  resolve: {
    alias: {
      // The workspace connector packages import the channel contract the way a
      // published package does. Inside this repo that specifier has nothing to
      // resolve against, because the repo *is* that package — so point it at
      // source, mirroring what the recipe extension loader does at runtime
      // (it aliases the package prefix to the host's resolved module root and
      // appends the subpath).
      "@introspection-ai/recipes/channels": fileURLToPath(
        new URL("./src/channels/index.ts", import.meta.url),
      ),
    },
  },
});
