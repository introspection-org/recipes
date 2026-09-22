# Contributing to Recipes

Contributions are welcome — bug reports, docs improvements, new checks for the
validator, and recipe tooling features alike.

## Development Setup

The repository is a pnpm workspace with a Rust crate alongside it. Install and
verify with:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` builds the TypeScript sources and native MCP client before running
vitest, so a working Rust toolchain (stable) is required.

Install from a local clone into Pi:

```bash
pnpm build
pi install "$(pwd)"
```

Pi records the local package path in `~/.pi/agent/settings.json`. Re-run
`pnpm build` after changing extension source.

## Validation library

The pure validation library used by `introspection check` lives in
[`packages/recipe-check`](packages/recipe-check). For changes there, also
run:

```bash
cargo fmt --all --check
cargo clippy -p introspection-recipe-check --all-targets
cargo test -p introspection-recipe-check
```

Recipes does not expose a standalone validation command. Run
`introspection check` for the supported user-facing workflow.

## Commits and Releases

- Use [Conventional Commit](https://www.conventionalcommits.org) messages:
  `fix:` for patches, `feat:` for minor changes, `feat!:` or a
  `BREAKING CHANGE:` footer for major changes.
- Releases follow SemVer and are cut automatically by release-please for the
  npm package and its validation-library dependency — never bump package
  versions by hand; let the release PRs do it.
- Beta prereleases use the `beta` npm dist-tag, stable releases use `latest`.

## Pull Requests

1. Fork the repository and create a branch.
2. Keep the verification commands above green.
3. Open a pull request with a Conventional Commit title and make sure CI
   passes.

## Reporting Issues

Open a GitHub issue with a descriptive title, reproduction steps (recipe
layout and the command you ran), the expected and actual behaviour, and any
relevant output from `introspection check`.
