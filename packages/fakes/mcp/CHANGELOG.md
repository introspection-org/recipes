# Changelog

## [0.3.0](https://github.com/introspection-org/introspection-cli/compare/mcp-fakes-v0.2.2...mcp-fakes-v0.3.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* **mcp-fakes:** a Fake must export `contract`; `checkRecipeFakes` no longer reads `fakes/mcp/<id>/tools.json` and its `fakesDir` option is gone; `typebox` 1 is a peer dependency.
* **mcp-fakes:** `mcp-fakes bundle` and `checkRecipeFakes`' `bundle` option are removed, and `introspection local` no longer runs `fakes/dist/sidecar.js`. A Recipe installs its fakes' dependencies and runs `mcp-fakes serve`; its fakes import each other with `.ts` specifiers.

### Features

* **bindings:** write tools.ts and observed.ts, type mcp-fakes fakes by their contract, and drop observe --verify ([#619](https://github.com/introspection-org/introspection-cli/issues/619)) ([47b6e9a](https://github.com/introspection-org/introspection-cli/commit/47b6e9a938cfbfa0e6b0999c108d8f7d2d098fe7))
* **harbor:** read MCP fakes' answers and one server's calls in a verifier ([#620](https://github.com/introspection-org/introspection-cli/issues/620)) ([0088438](https://github.com/introspection-org/introspection-cli/commit/0088438b5a908db3e961d1f0c81b4c10e4420cd6))
* **local:** run a Recipe against its MCP fakes with --scenario and --fakes ([#563](https://github.com/introspection-org/introspection-cli/issues/563)) ([591f702](https://github.com/introspection-org/introspection-cli/commit/591f70283a6734ed7a4eb4ba1fdc439ec147ea6f))
* **mcp-fakes:** serve a Recipe's fakes with `mcp-fakes serve`, and drop the sidecar bundle ([#616](https://github.com/introspection-org/introspection-cli/issues/616)) ([5847edf](https://github.com/introspection-org/introspection-cli/commit/5847edfa4afa020630ef38b6ec41041f21987414))


### Bug Fixes

* **mcp-fakes:** check masked values only after enough samples ([#631](https://github.com/introspection-org/introspection-cli/issues/631)) ([1f26372](https://github.com/introspection-org/introspection-cli/commit/1f26372cbe163a9d5ee797e2894db2a92402b01e))
* **mcp-fakes:** write TOON empty arrays in the length form the real server writes ([#630](https://github.com/introspection-org/introspection-cli/issues/630)) ([b68cea3](https://github.com/introspection-org/introspection-cli/commit/b68cea3964fbec7e0ba0b925d5af0102c7f09b74))

## [0.2.2](https://github.com/introspection-org/introspection-cli/compare/mcp-fakes-v0.2.1...mcp-fakes-v0.2.2) (2026-10-19)


### Bug Fixes

* **mcp-fakes:** accept "*" in a Recipe's tools.include ([#555](https://github.com/introspection-org/introspection-cli/issues/555)) ([ecf38e4](https://github.com/introspection-org/introspection-cli/commit/ecf38e4120099ef352177066cf9a0e687a0ac04f))

## [0.2.1](https://github.com/introspection-org/introspection-cli/compare/mcp-fakes-v0.2.0...mcp-fakes-v0.2.1) (2026-10-16)


### Bug Fixes

* **mcp-fakes:** serve Attio's tools, a manifest imported from JSON, and a layout-independent sidecar bundle ([#536](https://github.com/introspection-org/introspection-cli/issues/536)) ([6e387df](https://github.com/introspection-org/introspection-cli/commit/6e387dfbd41cfdbc9f3c37ee555e829b9595dfaf))

## [0.2.0](https://github.com/introspection-org/introspection-cli/compare/mcp-fakes-v0.1.0...mcp-fakes-v0.2.0) (2026-10-15)


### Features

* **mcp-fakes:** the fakes' checks on a /verify subpath, and mcpServers() for a harness's beforeRun ([#526](https://github.com/introspection-org/introspection-cli/issues/526)) ([f5a3744](https://github.com/introspection-org/introspection-cli/commit/f5a37444f72b80812a2be235d5f5089a1f75f68a))

## 0.1.0 (2026-10-15)


### Features

* **mcp-fakes:** add the @introspection-ai/mcp-fakes host package ([#519](https://github.com/introspection-org/introspection-cli/issues/519)) ([e7acc36](https://github.com/introspection-org/introspection-cli/commit/e7acc366101f22c1e981281d5587bdf1b35ff1ae))
