# Changelog

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
