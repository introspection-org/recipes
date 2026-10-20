import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The *.eval.ts files are the docs' eval suites: they need a model, so they
    // are typechecked, never run.
    include: ["test/**/*.test.ts"],
  },
});
