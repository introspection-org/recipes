# Changelog

## [0.3.0](https://github.com/introspection-org/recipes/compare/recipe-documents-pdf-v0.2.0...recipe-documents-pdf-v0.3.0) (2026-11-03)


### ⚠ BREAKING CHANGES

* the packages no longer depend on or peer on @introspection-ai/recipes, and need a Recipes host that implements module API version 1 (the release that ships with this change). docx and pdf no longer re-export runHelper or pythonExecutable (use runDocumentHelper and documentPythonExecutable from @introspection-ai/recipes/documents), and DocxDocumentAdapter and PdfDocumentAdapter take an options object ({ runHelper, env?, script?, python? }). createSlackChannelSession no longer reads the channel config from the environment when none is passed; pass config: resolveChannelConfig(env).

### Features

* install first-party tool packages alongside Recipes, with no dependency back on it ([#399](https://github.com/introspection-org/recipes/issues/399)) ([b6249d6](https://github.com/introspection-org/recipes/commit/b6249d6535a8831e84ca1aeb8f4d299502b3c347))

## [0.2.0](https://github.com/introspection-org/recipes/compare/recipe-documents-pdf-v0.1.0...recipe-documents-pdf-v0.2.0) (2026-11-03)


### Features

* prepare pi.runtime.python for Recipes and their packages ([#393](https://github.com/introspection-org/recipes/issues/393)) ([de35a67](https://github.com/introspection-org/recipes/commit/de35a676407565090ab95d96fffd2cb8a855f5ce))


### Bug Fixes

* **documents:** require Recipes 0.38.0 for docx profiles, and export the pdf adapter's package.json ([#391](https://github.com/introspection-org/recipes/issues/391)) ([5852182](https://github.com/introspection-org/recipes/commit/58521826989410af39fb47f9bf34b1385ca7b9bb))

## 0.1.0 (2026-11-03)


### Features

* documents tool with docx and pdf adapters ([#382](https://github.com/introspection-org/recipes/issues/382)) ([2f4e49c](https://github.com/introspection-org/recipes/commit/2f4e49c7169314cb71936de4d8735006c2206c44))
