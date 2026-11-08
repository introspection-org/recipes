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

## Releases

- Follow SemVer for all package releases.
- Use `MAJOR.MINOR.PATCH` for stable releases.
- Use SemVer prerelease identifiers for beta releases, for example `0.1.0-beta.0`, `0.1.0-beta.1`, then `0.1.0` for the stable release.
- **At or above 1.0**, treat breaking changes as major version bumps, new backwards-compatible features as minor bumps, and backwards-compatible bug fixes as patch bumps. Below 1.0, read the next bullet first — every package here is still `0.x`, so it governs.
- **Below 1.0 the minor IS the breaking boundary.** Every package here sets
  `bump-minor-pre-major: true`, so `feat!:` publishes 0.25.1 -> 0.26.0, not
  1.0.0 — and that is the SemVer fence, because a caret on a `0.x` version pins
  the minor (`^0.25.1` does not accept `0.26.0`, in npm and in Cargo). Shipping
  1.0.0 is a decision to declare the API stable, never a side effect of a
  breaking change. Precedent: #229 released as 0.21.0, #255 as 0.24.0.
- Use Conventional Commit prefixes so release-please can infer release notes and version bumps:
  - `fix:` for patch changes.
  - `feat:` for minor changes.
  - `feat!:` or a `BREAKING CHANGE:` footer for breaking changes — which release-please publishes as a **minor** bump while the package is `0.x`, not a major one.
- Do not manually bump `package.json` for routine releases unless the task is explicitly setting up or correcting release metadata. Let release-please update versions through its release PRs.
- Keep npm dist-tags aligned with release stability: beta prereleases use `beta`, stable releases use `latest`.
- **Publishing follows the registries, not the release run.** Every
  `release-please` workflow run (push or manual dispatch) runs
  `scripts/release-plan.mjs`, which publishes each manifest version that is
  tagged but missing from npm, crates.io or PyPI. A failed publish is finished
  by the next run; to finish it now, dispatch the workflow. Never publish a
  version by hand that has no tag.
- **Adding a package:** list it in `release-please-config.json` and
  `scripts/release-plan.mjs`, and before its first release reserve its npm
  name and add the package's trusted publisher on npm. Without that, its first
  publish fails with `E404 Not Found - PUT`.

## Dependencies

- **A peer means the platform provides it; a dependency means the Recipe
  brings and pins it.** The runtime imports `@introspection-ai/recipes` and the
  Pi packages, and a Recipe's agent runs inside the runtime's module graph — so
  those must be peers, resolving to one shared instance the runtime supplies.
  The companion packages (Recipes' `optionalDependencies`) may also be peers:
  they install alongside Recipes wherever Recipes installs, and a runtime
  image puts them in a `node_modules` above the Recipe; the image build fails
  if one is missing. The managed install never
  installs peers (`auto-install-peers=false`), while local pnpm and npm do, so
  any other peer is a promise only a platform that provides it can keep:
  `recipes check` warns (`package.peer_not_provided_by_default`). Anything
  else the Recipe needs is an ordinary dependency it brings. ⚠️ **One carve-out**: an extension
  needing a helper subpath newer than the active host declares
  `@introspection-ai/recipes` as an ordinary dependency too. The loader prefers
  a Recipe-installed copy for exactly this reason
  (`src/recipe/extensions.ts::recipeExtensionAliases`), and a peer alone is
  never installed, so the import would silently resolve to the older host copy
  and fail.
- **A channel adapter, document format or productivity provider is a peer by
  default when it is a companion package** (or omitted), **and a dependency with an exact version
  only to pin it.** Third-party ones are dependencies. The companions are the
  first-party ones published here (`recipe-channel-*`, `recipe-documents-*`,
  `recipe-productivity-*`, `recipe-search`, `recipe-issues`),
  listed in Recipes' `optionalDependencies` so installing Recipes installs
  them beside it. A Recipe may declare one as a peer (the platform provides
  it) or omit it (the copy beside Recipes is used); listing one in
  `dependencies` pins it (the Recipe's copy wins, as in
  `recipeExtensionAliases`). Any other channel, format or provider package must be
  declared, and a third-party one belongs in `dependencies`. The list is read
  at run time by `src/recipe/companions.ts`; `test/companions.test.ts` and the
  checker's `COMPANION_PACKAGES` and `HOST_PEER_PACKAGES` tests keep the
  copies in step, and a new channel, format or provider package here must
  join it.
- **Companions never depend on Recipes at run time.** Recipes depends on
  them, so a dependency or peer back would be a cycle. A companion imports
  only Recipes' types (`import type`, with Recipes in `devDependencies`), and
  the host injects what it runs: a document format exports a plain
  `RecipeDocumentFormatModule` whose `createAdapter` receives `runHelper`; a
  channel exports a plain `RecipeChannelModule` the host builds the connector
  from. `test/companions.test.ts` fails on a run-time import or a
  dependency or peer on Recipes. Compatibility is the module's `apiVersion`
  (`DOCUMENT_FORMAT_API_VERSION`, `CHANNEL_MODULE_API_VERSION`), checked when
  it loads; bump it on a breaking contract change. A third-party package that
  declares a Recipes peer range is checked against it with semver. Never add
  minimum-version constants.
- **First-party packages take an open lower bound; third-party take a caret.**
  ⚠️ A caret on a `0.x` version pins the MINOR — `^0.26.0` rejects `0.27.0` — so
  it is a ceiling, not a floor. For our own packages (`@introspection-ai/*`,
  `@introspection/*`) that ceiling buys nothing and costs a republish every
  time a sibling ticks: the lockfile already pins what installs, and CI gates
  every relock. The shape is an open lower bound and nothing else —
  `>=0.39.0`, in `dependencies` and `peerDependencies` alike. No `<1.0.0` cap
  for now: we will move off pre-release, and a cap would make every 1.0.0
  package unusable with every Recipe and package that still declares the 0.x
  range until each is republished. Note `workspace:^` publishes as `^`, so a
  published range must be written out (`workspace:>=0.6.0` publishes as
  `>=0.6.0`, as Recipes' `optionalDependencies` do). Keep the caret for
  third-party packages, where an unreviewed relock would take someone else's
  breaking change. Pi keeps a major cap, written out as `>=1.1.0 <2.0.0` because the
  host supplies it and the runtime image resolves the version. Pi crossing a
  major is a deliberate migration (fix the SDK, move the floor, and move the
  host's runtime image with it), never a Dependabot bump.
  `test/pi-floor-parity.test.ts` asserts that exact shape.
- **A version written in two places will drift.** Derive it. The supported Pi
  floor is read out of `peerDependencies` by the `pi-minimum` CI job and pinned
  by `test/pi-floor-parity.test.ts`; copying it into a job or a doc is how it
  went stale twice in one change.
- **Where the packages come from.** `@introspection-ai/recipes`,
  `@introspection-ai/recipe-channel-*`, `@introspection-ai/recipe-documents-*`,
  `@introspection-ai/recipe-productivity-*`, `@introspection-ai/recipe-search`,
  `@introspection-ai/recipe-issues`, `@introspection-ai/mcp-client-*` and
  `introspection-recipe-check` are all published from THIS repository, but on
  **two release trains**: `release-please-config.json` covers the npm packages
  and `release-please-checker-config.json` the checker and its Python binding,
  each with its own manifest and release PR. A change spanning both publishes
  twice and needs coordinating; it is not atomic.
  `@introspection-ai/cli` is the CLI's own package, the language SDKs
  (`@introspection-sdk/*`) come from `introspection-js-sdk`, and `@earendil-works/*`
  (Pi) is third-party.
- **pnpm is the only JavaScript lockfile a Recipe commits.** The managed install
  honours `pnpm-lock.yaml` when present and resolves the declared ranges when it
  is absent (`recipes check` warns); `package-lock.json`, `npm-shrinkwrap.json` and
  `yarn.lock` are rejected, as is a `packageManager` field that is not a
  complete `pnpm@<version>`. This is about npm and yarn, not about lockfiles in
  general — a Recipe declaring `pi.runtime.python` MUST also commit the
  `uv.lock` its `python.lockfile` names, and `recipes check` rejects it when
  that file is missing.

## Pull Requests

1. Fork the repository and create a branch.
2. Keep the verification commands above green.
3. Open a pull request with a Conventional Commit title and make sure CI
   passes.

## Reporting Issues

Open a GitHub issue with a descriptive title, reproduction steps (recipe
layout and the command you ran), the expected and actual behaviour, and any
relevant output from `introspection check`.
