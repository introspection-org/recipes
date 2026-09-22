# Agent Instructions

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

## Dependencies

- **Declare a peer only for what the host imports too.** The runtime imports
  `@introspection-ai/recipes` and the Pi packages, and a Recipe's agent runs
  inside the runtime's module graph — so those must resolve to one shared
  instance, and the runtime supplies them. Anything the host does not import is
  an ordinary dependency the Recipe brings. ⚠️ **One carve-out**: an extension
  needing a helper subpath newer than the active host declares
  `@introspection-ai/recipes` as an ordinary dependency too. The loader prefers
  a Recipe-installed copy for exactly this reason
  (`src/recipe-extensions.ts::recipeExtensionAliases`), and a peer alone is
  never installed, so the import would silently resolve to the older host copy
  and fail.
- **A channel adapter is a dependency, not a peer.** There is one per provider,
  so the runtime carries none. A peer declaration fails `recipes check`, and
  would not load even if it passed: the managed install runs `pnpm install
  --prod` with `auto-install-peers=false`, so a peer the runtime lacks is never
  installed.
- **First-party packages take an open lower bound; third-party take a caret.**
  ⚠️ A caret on a `0.x` version pins the MINOR — `^0.26.0` rejects `0.27.0` — so
  it is a ceiling, not a floor. For our own packages (`@introspection-ai/*`,
  `@introspection/*`) that ceiling buys nothing and costs a republish every
  time a sibling ticks: the lockfile already pins what installs, and CI gates
  every relock. The shape is an open lower bound with a **major** cap —
  `>=0.26.0 <1.0.0`, in `dependencies` and `peerDependencies` alike, which is
  what `packages/channels/slack/package.json` ships. The cap is not a ceiling
  anything hits: below 1.0 nothing crosses it, and 1.0.0 will be a deliberate
  declaration that the API is stable, so leaving the range unbounded would
  claim compatibility with a release nobody has reviewed. Note `workspace:^`
  publishes as `^`, so a published peer must be written out. Keep the caret for
  third-party packages, where an unreviewed relock would take someone else's
  breaking change. ⚠️ **Pi is the exception, and takes no cap either**: third
  party, but the host supplies it, so the SDK declares a bare `>=0.86.1` and
  lets the runtime image resolve the version. `test/pi-floor-parity.test.ts`
  asserts that exact shape (`/^>=\d+\.\d+\.\d+$/`), so a `<1.0.0` bound fails
  it just as a caret does — and a caret would also restore the upper bound #280
  removed.
- **A version written in two places will drift.** Derive it. The supported Pi
  floor is read out of `peerDependencies` by the `pi-minimum` CI job and pinned
  by `test/pi-floor-parity.test.ts`; copying it into a job or a doc is how it
  went stale twice in one change.
- **Where the packages come from.** `@introspection-ai/recipes`,
  `@introspection-ai/recipe-channel-*`, `@introspection-ai/mcp-client-*` and
  `introspection-recipe-check` are all published from THIS repository, but on
  **two release trains**: `release-please-config.json` covers the npm packages
  and `release-please-checker-config.json` the checker and its Python binding,
  each with its own manifest and release PR. A change spanning both publishes
  twice and needs coordinating; it is not atomic.
  `@introspection-ai/cli` comes from `introspection-cli`, the language SDKs
  (`@introspection-sdk/*`) from `introspection-js-sdk`, and `@earendil-works/*`
  (Pi) is third-party.
- **Recipes commit `pnpm-lock.yaml` and nothing else.** The managed install runs
  `--frozen-lockfile`; `package-lock.json`, `npm-shrinkwrap.json` and
  `yarn.lock` are rejected, as is a `packageManager` field that is not a
  complete `pnpm@<version>`.
