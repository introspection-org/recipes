# Agent Instructions

## Releases

- **Conventional Commits drive release-please; never bump a version by hand.**
  Below 1.0, `feat!:` publishes a minor, which is the breaking boundary. A new
  package needs its npm name reserved before its first release. The rest is in
  [CONTRIBUTING.md](CONTRIBUTING.md#releases).

## Dependencies

- **A peer means the platform provides it; a dependency means the Recipe
  brings it.** First-party ranges are open lower bounds (`>=x.y.z`),
  third-party ones carets, Pi `>=1.1.0 <2.0.0`; companions import only Recipes'
  types. The rest, including what a Recipe may commit as a lockfile, is in
  [CONTRIBUTING.md](CONTRIBUTING.md#dependencies).

## Provider modules

- **Before wiring or changing a provider, read
  [Wiring a provider](docs/providers.md#10-wiring-a-provider)**: capture the
  server's tools first, page to the end, and record against dummy data.

## Recipe isolation

- **A Recipe run sees only the Recipe's skills.** That means its own, its
  dependency and peer packages' `pi.skills`, the `documents` tool's core
  skill and profile, and the productivity tools' core skill, never a skill Pi discovered elsewhere (an installed Pi
  package, user or project skills, `--skill`). Pi still fills its resource
  loader, and an extension cannot replace that, so `src/pi-extension.ts`
  rebuilds the prompt's skills (`before_agent_start`) and `/skill:` commands
  (`input`) from the resolved paths. `src/session.ts` filters the loader with
  `skillsOverride`. Any new source of Recipe skills must join both, and
  `test/recipe-skill-isolation.test.ts` must cover it.

## Docs, skills and examples

- **`docs/` is for developers:** Recipe authors, host builders, and the
  coding agents helping them. It is the reference and contract, read at build
  time, on GitHub and in the npm package.
- **`skills/` is for agents:** the model running inside a Recipe. The host
  offers a tool's skill (`skills/<tool>/SKILL.md`) when an agent selects that
  tool, so a skill says how to use the tool well, never how to configure it.
  Format- or provider-specific guidance is a profile in that package's own
  `profiles/`.
- **`examples/` is for developers:** the code docs.introspection.dev
  shows, typechecked and tested here (see Docs regions below). It is never
  published and never offered to an agent.

## Docs regions

- **A docs region (`#region docs:…` under `examples/`) shows every helper
  it calls that the example file defines** — functions, consts, methods and
  closures alike — inside the region, before the code that uses them; a helper
  standing in for the reader's own code (`render`, `sendEventToBrowser`, ...)
  appears as a minimal stub with a one-line comment saying it is your app's code.
