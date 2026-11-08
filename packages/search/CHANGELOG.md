# Changelog

## 0.1.0 (2026-11-08)


### ⚠ BREAKING CHANGES

* **search:** @introspection-ai/recipes/search no longer exports the provider modules or BUILTIN_SEARCH_PROVIDERS; load them with loadSearchProviders and pass them as `providers`.

### Features

* **search:** one web_search tool across providers ([#464](https://github.com/introspection-org/recipes/issues/464)) ([1e1395b](https://github.com/introspection-org/recipes/commit/1e1395bfc8831af638eb8050f4ccbc36c5090eb6))


### Bug Fixes

* **search:** keep error text out of span status, and send Tavily its own country names ([#472](https://github.com/introspection-org/recipes/issues/472)) ([e4280fc](https://github.com/introspection-org/recipes/commit/e4280fc446c19deff047c0de0a820aabcfecac10))
