# Changelog

## [0.8.0](https://github.com/introspection-org/recipes/compare/recipe-channel-slack-v0.7.0...recipe-channel-slack-v0.8.0) (2026-11-09)


### Features

* bind a Recipe's vendor API hosts with .pi/api.local.json ([#496](https://github.com/introspection-org/recipes/issues/496)) ([2479127](https://github.com/introspection-org/recipes/commit/24791277dd22f4fe200cecd8dd6da2f71377426c))

## [0.7.0](https://github.com/introspection-org/recipes/compare/recipe-channel-slack-v0.6.0...recipe-channel-slack-v0.7.0) (2026-11-03)


### ⚠ BREAKING CHANGES

* the packages no longer depend on or peer on @introspection-ai/recipes, and need a Recipes host that implements module API version 1 (the release that ships with this change). docx and pdf no longer re-export runHelper or pythonExecutable (use runDocumentHelper and documentPythonExecutable from @introspection-ai/recipes/documents), and DocxDocumentAdapter and PdfDocumentAdapter take an options object ({ runHelper, env?, script?, python? }). createSlackChannelSession no longer reads the channel config from the environment when none is passed; pass config: resolveChannelConfig(env).

### Features

* install first-party tool packages alongside Recipes, with no dependency back on it ([#399](https://github.com/introspection-org/recipes/issues/399)) ([b6249d6](https://github.com/introspection-org/recipes/commit/b6249d6535a8831e84ca1aeb8f4d299502b3c347))

## [0.6.0](https://github.com/introspection-org/recipes/compare/recipe-channel-slack-v0.5.0...recipe-channel-slack-v0.6.0) (2026-10-20)


### Features

* **channels:** reach Slack through the env proxy on proxy-native runtimes ([#332](https://github.com/introspection-org/recipes/issues/332)) ([7cf0cce](https://github.com/introspection-org/recipes/commit/7cf0cceb15a3f6379eb7f1c66e9915adff7f6b39))

## [0.5.0](https://github.com/introspection-org/recipes/compare/recipe-channel-slack-v0.4.1...recipe-channel-slack-v0.5.0) (2026-10-11)


### ⚠ BREAKING CHANGES

* requires Pi 1.1. Tool search ranks by whole words, so queries that only matched substrings before may find nothing.

### Features

* move to Pi 1.1 with native deferred tools (peer &gt;=1.1.0 &lt;2.0.0) ([#312](https://github.com/introspection-org/recipes/issues/312)) ([60595e5](https://github.com/introspection-org/recipes/commit/60595e5010becceabd14ea1d1c946eb7e58c2e04))

## [0.4.1](https://github.com/introspection-org/recipes/compare/recipe-channel-slack-v0.4.0...recipe-channel-slack-v0.4.1) (2026-09-22)


### Bug Fixes

* **channels:** publish an open SDK peer range ([#281](https://github.com/introspection-org/recipes/issues/281)) ([a1f5a47](https://github.com/introspection-org/recipes/commit/a1f5a47021bb6d2e173f1b5f6ad93326ae7d95e7))

## [0.4.0](https://github.com/introspection-org/recipes/compare/recipe-channel-slack-v0.3.0...recipe-channel-slack-v0.4.0) (2026-09-20)


### ⚠ BREAKING CHANGES

* only pnpm-lock.yaml satisfies the Recipe lockfile requirement ([#278](https://github.com/introspection-org/recipes/issues/278))
* run on Pi 0.86.1 with no upper bound ([#280](https://github.com/introspection-org/recipes/issues/280))

### Features

* only pnpm-lock.yaml satisfies the Recipe lockfile requirement ([#278](https://github.com/introspection-org/recipes/issues/278)) ([144e356](https://github.com/introspection-org/recipes/commit/144e356e83e0ad1f58c6833b786453b5be549789))
* run on Pi 0.86.1 with no upper bound ([#280](https://github.com/introspection-org/recipes/issues/280)) ([d8d5ec2](https://github.com/introspection-org/recipes/commit/d8d5ec2901c628982abd7273fda9fccdbdc4ac2e))

## [0.3.0](https://github.com/introspection-org/recipes/compare/recipe-channel-slack-v0.2.0...recipe-channel-slack-v0.3.0) (2026-09-07)


### Features

* **slack:** register issue thread routing after channel sends ([#261](https://github.com/introspection-org/recipes/issues/261)) ([19c8987](https://github.com/introspection-org/recipes/commit/19c89870bc756e8a37d64212e7c9fb91239fb131))

## [0.2.0](https://github.com/introspection-org/recipes/compare/recipe-channel-slack-v0.1.1...recipe-channel-slack-v0.2.0) (2026-09-04)


### ⚠ BREAKING CHANGES

* **channels:** Slack thread reads start with the oldest page and paginate forward rather than starting with the latest page and paginating backward.

### Features

* **channels:** unify channel commands and explicit targets ([#255](https://github.com/introspection-org/recipes/issues/255)) ([81e5f00](https://github.com/introspection-org/recipes/commit/81e5f003a4ef554ffd63786e26dcceb34f1015e5))

## [0.1.1](https://github.com/introspection-org/recipes/compare/recipe-channel-slack-v0.1.0...recipe-channel-slack-v0.1.1) (2026-09-01)


### Bug Fixes

* **release:** publish workspace channel package ([#243](https://github.com/introspection-org/recipes/issues/243)) ([0d147a3](https://github.com/introspection-org/recipes/commit/0d147a3ce4bdab58c8d25015d608d9f554ba1b7f))

## 0.1.0 (2026-08-31)


### Features

* add Slack Bot API tools to Recipes ([#233](https://github.com/introspection-org/recipes/issues/233)) ([3944dac](https://github.com/introspection-org/recipes/commit/3944dacfa6d69043b45cf359b6aa6a2276b1e568))
* **channels:** provider-neutral channel_* tools bound to the task's conversation ([#234](https://github.com/introspection-org/recipes/issues/234)) ([f49a194](https://github.com/introspection-org/recipes/commit/f49a1948d3a9e7df5d9f2e6194e577a5350511cb))
