# Changelog

## [0.18.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.17.0...introspection-recipe-check-v0.18.0) (2026-11-04)


### Features

* **recipe-check:** list a Recipe's suggestions from a file snapshot ([#413](https://github.com/introspection-org/recipes/issues/413)) ([b8b468f](https://github.com/introspection-org/recipes/commit/b8b468f155d2f02f691fddde5f4ed0900bd2d9de))

## [0.17.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.16.0...introspection-recipe-check-v0.17.0) (2026-11-04)


### Features

* offer a Recipe's prompt templates as suggestions ([#411](https://github.com/introspection-org/recipes/issues/411)) ([eb089a7](https://github.com/introspection-org/recipes/commit/eb089a70184436bfc2e0aed166778d23a544b25f))


### Bug Fixes

* **release:** keep the companion packages when stamping the MCP client binaries ([#403](https://github.com/introspection-org/recipes/issues/403)) ([427bb43](https://github.com/introspection-org/recipes/commit/427bb43a64e79627147a8cea9887e563830ba063))

## [0.16.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.15.0...introspection-recipe-check-v0.16.0) (2026-11-03)


### ⚠ BREAKING CHANGES

* **recipe:** `pi.runtime.system` is removed from the Recipe format. No published Recipe used it. A Recipe that still declares it is now rejected as an unknown field: "package.json#pi.runtime contains unknown field 'system'". `RecipeRuntimeRequirements` no longer carries `system`, and `RecipeSystemPackageRequirement` is no longer exported.
* the packages no longer depend on or peer on @introspection-ai/recipes, and need a Recipes host that implements module API version 1 (the release that ships with this change). docx and pdf no longer re-export runHelper or pythonExecutable (use runDocumentHelper and documentPythonExecutable from @introspection-ai/recipes/documents), and DocxDocumentAdapter and PdfDocumentAdapter take an options object ({ runHelper, env?, script?, python? }). createSlackChannelSession no longer reads the channel config from the environment when none is passed; pass config: resolveChannelConfig(env).

### Features

* install first-party tool packages alongside Recipes, with no dependency back on it ([#399](https://github.com/introspection-org/recipes/issues/399)) ([b6249d6](https://github.com/introspection-org/recipes/commit/b6249d6535a8831e84ca1aeb8f4d299502b3c347))
* prepare pi.runtime.python for Recipes and their packages ([#393](https://github.com/introspection-org/recipes/issues/393)) ([de35a67](https://github.com/introspection-org/recipes/commit/de35a676407565090ab95d96fffd2cb8a855f5ce))
* **recipe:** offer skills from dependency packages ([#398](https://github.com/introspection-org/recipes/issues/398)) ([1dd9b14](https://github.com/introspection-org/recipes/commit/1dd9b1404508d939ddfc23de13dba63b7c40bfaf))
* **recipe:** remove pi.runtime.system ([#402](https://github.com/introspection-org/recipes/issues/402)) ([175fa9c](https://github.com/introspection-org/recipes/commit/175fa9cda2df5f56e3f41180dee30e522f3ab2b6))

## [0.15.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.14.0...introspection-recipe-check-v0.15.0) (2026-11-03)


### Features

* **documents:** profiles: a skill a format ships, or the Recipe brings by path ([#385](https://github.com/introspection-org/recipes/issues/385)) ([0893892](https://github.com/introspection-org/recipes/commit/08938923f4daeda41df97c2a5131cf2ed953320a))

## [0.14.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.13.0...introspection-recipe-check-v0.14.0) (2026-11-03)


### Features

* declare where a Recipe's evals live with pi.evals ([#381](https://github.com/introspection-org/recipes/issues/381)) ([13d1b01](https://github.com/introspection-org/recipes/commit/13d1b01ed55429569085babf9617f6c077ce7552))
* documents tool with docx and pdf adapters ([#382](https://github.com/introspection-org/recipes/issues/382)) ([2f4e49c](https://github.com/introspection-org/recipes/commit/2f4e49c7169314cb71936de4d8735006c2206c44))

## [0.13.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.12.0...introspection-recipe-check-v0.13.0) (2026-10-29)


### ⚠ BREAKING CHANGES

* **recipe-check:** a committed evaluation binding naming an id that package.json#pi.mcp.servers does not declare, naming one twice, or omitting the id is now rejected.

### Features

* **recipe-check:** accept compose-service hosts in a committed evaluation binding ([#369](https://github.com/introspection-org/recipes/issues/369)) ([9a0105f](https://github.com/introspection-org/recipes/commit/9a0105f55246da8c0e3cb224aa38c9047654bc60))

## [0.12.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.11.0...introspection-recipe-check-v0.12.0) (2026-10-19)


### Features

* **mcp:** let a Recipe mark a required server that only working sessions must discover ([#346](https://github.com/introspection-org/recipes/issues/346)) ([244f207](https://github.com/introspection-org/recipes/commit/244f207030fa7cc81d70709d44e01243fd0253a2))

## [0.11.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.10.0...introspection-recipe-check-v0.11.0) (2026-10-14)


### ⚠ BREAKING CHANGES

* **recipe-check:** a mission judge's `attrs` key is now `attributes`; a judge still using `attrs` fails validation as an unknown field.

### Features

* **recipe-check:** name a mission judge's request attributes `attributes` ([#342](https://github.com/introspection-org/recipes/issues/342)) ([fa78f2f](https://github.com/introspection-org/recipes/commit/fa78f2ff8f52d8868ba58db7ba768735e9869426))

## [0.10.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.9.0...introspection-recipe-check-v0.10.0) (2026-10-11)


### ⚠ BREAKING CHANGES

* **recipe-check:** judge types online, offline and mission ([#325](https://github.com/introspection-org/recipes/issues/325))

### Features

* **recipe-check:** judge types online, offline and mission ([#325](https://github.com/introspection-org/recipes/issues/325)) ([fde59ae](https://github.com/introspection-org/recipes/commit/fde59ae480fca71db29707fbee81e725bab13599))

## [0.9.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.8.0...introspection-recipe-check-v0.9.0) (2026-10-10)


### ⚠ BREAKING CHANGES

* **recipe-check:** add a required `severity` to `Diagnostic` (set it in struct literals; add `..` to exhaustive patterns), and warn rather than fail on a missing lockfile

### Features

* **recipe-check:** add a required `severity` to `Diagnostic` (set it in struct literals; add `..` to exhaustive patterns), and warn rather than fail on a missing lockfile ([d0b1b0d](https://github.com/introspection-org/recipes/commit/d0b1b0df0ff4edb21a7b6c385d075551011fb9ca))
* **session:** accept session.retry.max_agent_delay_ms and cover every Pi setting ([0df1219](https://github.com/introspection-org/recipes/commit/0df12199351f5b10cbf1bd3208faaab48debc897))


### Bug Fixes

* **session:** keep host settings under an agent's session policy ([0df1219](https://github.com/introspection-org/recipes/commit/0df12199351f5b10cbf1bd3208faaab48debc897))

## [0.8.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.7.0...introspection-recipe-check-v0.8.0) (2026-09-28)


### Features

* **recipe-check:** accept a committed .pi/mcp.local.json as a loopback evaluation binding ([#305](https://github.com/introspection-org/recipes/issues/305)) ([973a0be](https://github.com/introspection-org/recipes/commit/973a0bee59779e6b3c97d82ee84f90a867df7e08))

## [0.7.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.6.0...introspection-recipe-check-v0.7.0) (2026-09-20)


### ⚠ BREAKING CHANGES

* only pnpm-lock.yaml satisfies the Recipe lockfile requirement ([#278](https://github.com/introspection-org/recipes/issues/278))

### Features

* only pnpm-lock.yaml satisfies the Recipe lockfile requirement ([#278](https://github.com/introspection-org/recipes/issues/278)) ([144e356](https://github.com/introspection-org/recipes/commit/144e356e83e0ad1f58c6833b786453b5be549789))


### Bug Fixes

* **recipe-check:** ensure_identity renames the lockfile root with the package ([#276](https://github.com/introspection-org/recipes/issues/276)) ([7d8a8be](https://github.com/introspection-org/recipes/commit/7d8a8be9e43d325442e201d57df7da683dddd11d))

## [0.6.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.5.0...introspection-recipe-check-v0.6.0) (2026-09-11)


### Features

* **template:** render a template repository into a Recipe ([#270](https://github.com/introspection-org/recipes/issues/270)) ([0f33c0b](https://github.com/introspection-org/recipes/commit/0f33c0b6115e536209f59a14c66a9e27f8702b1b))

## [0.5.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.4.0...introspection-recipe-check-v0.5.0) (2026-09-04)


### ⚠ BREAKING CHANGES

* **channels:** Slack thread reads start with the oldest page and paginate forward rather than starting with the latest page and paginating backward.

### Features

* **channels:** unify channel commands and explicit targets ([#255](https://github.com/introspection-org/recipes/issues/255)) ([81e5f00](https://github.com/introspection-org/recipes/commit/81e5f003a4ef554ffd63786e26dcceb34f1015e5))

## [0.4.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.3.0...introspection-recipe-check-v0.4.0) (2026-08-31)


### Features

* add Slack Bot API tools to Recipes ([#233](https://github.com/introspection-org/recipes/issues/233)) ([3944dac](https://github.com/introspection-org/recipes/commit/3944dacfa6d69043b45cf359b6aa6a2276b1e568))

## [0.3.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.2.0...introspection-recipe-check-v0.3.0) (2026-08-10)


### Features

* add transparent AI and session configuration ([#208](https://github.com/introspection-org/recipes/issues/208)) ([a86a08d](https://github.com/introspection-org/recipes/commit/a86a08d74d053afc991a1bc7fc977892a29bf4e5))


### Bug Fixes

* complete provider policy support ([#212](https://github.com/introspection-org/recipes/issues/212)) ([e2a3fca](https://github.com/introspection-org/recipes/commit/e2a3fcaef04f12f6ec426a876464e6ea68d241aa))

## [0.2.0](https://github.com/introspection-org/recipes/compare/introspection-recipe-check-v0.1.0...introspection-recipe-check-v0.2.0) (2026-08-03)


### Features

* align judge identity with recipe names ([#190](https://github.com/introspection-org/recipes/issues/190)) ([166c40d](https://github.com/introspection-org/recipes/commit/166c40d4a10a274d163873326f054ffccad4a652))
* publish introspection recipe checker ([#153](https://github.com/introspection-org/recipes/issues/153)) ([b8be591](https://github.com/introspection-org/recipes/commit/b8be5914aa05ecb144110cd4f6831222cd79c7b5))

## 0.1.0 (2026-07-28)


### Features

* publish introspection recipe checker ([#153](https://github.com/introspection-org/recipes/issues/153)) ([b8be591](https://github.com/introspection-org/recipes/commit/b8be5914aa05ecb144110cd4f6831222cd79c7b5))

## 0.1.0

- Initial release of `introspection-recipe-check`, continuing the portable
  Recipe validation engine previously published as `recipe-check`.

## [0.2.0](https://github.com/introspection-org/recipes/compare/recipe-check-v0.1.1...recipe-check-v0.2.0) (2026-07-27)


### Features

* declare portable runtime requirements ([#151](https://github.com/introspection-org/recipes/issues/151)) ([ad91ed6](https://github.com/introspection-org/recipes/commit/ad91ed680bace8d059b57c89a364a959f02aa7b1))


### Bug Fixes

* allow blank agent system instructions ([#148](https://github.com/introspection-org/recipes/issues/148)) ([b279365](https://github.com/introspection-org/recipes/commit/b2793651b7e3830f38b5959e0c3f948eda6b92be))

## [0.1.1](https://github.com/introspection-org/recipes/compare/recipe-check-v0.1.0...recipe-check-v0.1.1) (2026-07-27)


### Bug Fixes

* **recipe-check:** restore portable validation contracts ([#143](https://github.com/introspection-org/recipes/issues/143)) ([fdb065e](https://github.com/introspection-org/recipes/commit/fdb065e6967781742965670e1aba3e3a864b0ca6))

## 0.1.0 (2026-07-27)


### Features

* add MCP tools mode with deferred discovery ([#129](https://github.com/introspection-org/recipes/issues/129)) ([82a270c](https://github.com/introspection-org/recipes/commit/82a270c92c9fe4bc23b1b73abe03dc6480a20eb8))
* establish portable Recipe validation ([#138](https://github.com/introspection-org/recipes/issues/138)) ([3c14388](https://github.com/introspection-org/recipes/commit/3c14388eabbbc2f09cb33a0858f70ca443e618cb))
* finalize the portable Recipes API and checker ([#142](https://github.com/introspection-org/recipes/issues/142)) ([fc56118](https://github.com/introspection-org/recipes/commit/fc561181c204b3d5e54d39339c0a1eb445ac6312))

## Changelog

## Unreleased

- Introduce the I/O-free `check_recipe_files` API for validating the portable
  Recipe package contract.
