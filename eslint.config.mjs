// Copied from introspection-js-sdk packages/eslint-config/base.js, a private
// workspace package there, so it can't be installed. eslint-plugin-turbo is
// left out: this repository doesn't use turbo.
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import onlyWarn from "eslint-plugin-only-warn";

/** @type {import("eslint").Linter.Config[]} */
export default [
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `const { a: _, ...rest } = x` drops a key on purpose, and a leading
      // `_` marks a parameter a callback signature requires but this code
      // doesn't read.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ignoreRestSiblings: true, argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Plain Node scripts; TypeScript files get these from @types/node.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly" },
    },
  },
  {
    // Tests stand in for Pi's extension API and its events with partial
    // fakes, which `any` types without restating Pi's whole surface.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // A docs snippet (#region docs:improve/eval-cases/expected-values) that
    // shows the values a reader grades; its body is left for the reader.
    files: ["examples/improve/eval-cases/evals/vitest/refund-policy.eval.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Size limits ratchet: each limit sits at this repository's worst value
    // today, so the current code passes. Only ever lower a limit, toward the
    // target in its comment (js-sdk's targets); never raise one. If new code
    // exceeds a limit, split it.
    rules: {
      complexity: ["error", 127], // target 10
      "max-lines": [
        "error",
        { max: 2269, skipBlankLines: true, skipComments: true }, // target 400
      ],
      "max-lines-per-function": [
        "error",
        { max: 1958, skipBlankLines: true, skipComments: true }, // target 80
      ],
      "max-params": ["error", 8], // target 4
      "max-depth": ["error", 5], // target 4
    },
  },
  {
    // Turns every finding into a warning; `pnpm lint` fails on any with
    // --max-warnings 0.
    plugins: {
      onlyWarn,
    },
  },
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "target/**",
      "vendor/**",
      "scripts/**",
      "coverage/**",
    ],
  },
];
