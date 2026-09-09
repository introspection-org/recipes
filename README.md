<div align="center">
  <a href="https://pi.recipes">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/images/logo-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset=".github/images/logo-light.svg">
      <img alt="Recipes" src=".github/images/logo-light.svg" width="165">
    </picture>
  </a>
</div>

<h4 align="center">The open format for vertical agents, built on Pi.</h4>

<div align="center">
  <a href="https://pi.recipes"><img src="https://img.shields.io/badge/website-pi.recipes-blue" alt="Website"></a>
  <a href="https://github.com/introspection-org/recipes/actions/workflows/ci.yml"><img src="https://github.com/introspection-org/recipes/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@introspection-ai/recipes"><img src="https://img.shields.io/npm/v/@introspection-ai/recipes?label=npm" alt="npm version"></a>
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img src="https://img.shields.io/badge/license-Apache%202.0-green" alt="License"></a>
</div>

<br>

**The model is interchangeable. Your definition of good is not.**

A Recipe keeps a complete Pi agent—its instructions, models, tools, skills,
package-wide executable extensions, subagents, and capability policy together as
ordinary source you can inspect, fork, validate, and own.

Run the same Recipe locally, on Introspection, or in another compatible Pi
host. The Recipe is portable; credentials, isolation, persistence, scheduling,
and deployment remain the host's responsibility.

## What Recipes is

Recipes combines two deliberately small contracts:

1. **The Recipe Format** is the open, Git-native package contract.
2. **The Host API** resolves that package into a complete live Pi session.

[Pi](https://pi.dev/docs/latest) is the minimal agent harness. A Recipe packages
the complete configured agent built on that harness. It is more than a prompt
template or a collection of Pi resources. Recipes runs the agent; the host
decides where and how that agent operates.

## Package anatomy

```text
my-recipe/
├── package.json          # identity and Pi resource declarations
├── SYSTEM.md             # optional shared instructions
├── agents/*.yaml         # models, tools, skills, subagents, policy
├── skills/**/SKILL.md    # reusable domain workflows
├── extensions/*.ts       # optional Recipe-owned Pi extensions
├── judges/*.yaml         # optional portable evaluation definitions
└── .pi/mcp.local.example.json # optional binding template
```

The normative contract is documented in [Recipe Format](docs/recipe-format.md).

## Use a Recipe

The [`introspection`](https://github.com/introspection-org/introspection-cli)
CLI owns the end-to-end local workflow:

```bash
npm install -g @introspection-ai/cli
introspection init
introspection check
introspection local
```

`introspection init` installs a compatible Pi and Recipes extension when they
are missing. `introspection local` launches the selected local Recipe directly
with Pi. It does not require an Introspection login or managed host.

To install the extension without the Introspection CLI:

```bash
pi install npm:@introspection-ai/recipes
pi --recipe ./path/to/recipe --agent agent
```

## Run in a host

Install Recipes in a Node.js host:

```bash
npm install @introspection-ai/recipes
```

```ts
import {
  createAgentSession,
  resolveRecipe,
} from "@introspection-ai/recipes";

const recipe = resolveRecipe({ recipeDir: "./my-recipe" });
const handle = await createAgentSession({
  recipe,
  agentName: "agent",
  cwd: "./workspace",
  credentials,
  mcpBindings,
  sessionManager,
  otel: { tracer, meta: { conversationId } },
});

await handle.session.prompt("Start the task");
await handle.session.prompt("/review src/auth.ts");
await handle.dispose();
```

`createAgentSession` is the single host boundary for an inspected Recipe.
It selects the requested agent from that immutable graph and constructs a
standard Pi `AgentSession`. The host still owns task
lifecycle, durable state, auth, networking, isolation, protocol translation,
and deployment.

See [Host API](docs/host-api.md) for the complete boundary and
[host conformance](docs/host-api.md#host-conformance) for compatibility
tests.

## Public exports

- `@introspection-ai/recipes` — the two primary operations:
  `resolveRecipe` and `createAgentSession`
- `@introspection-ai/recipes/recipe` — resolve a Recipe into session inputs
- `@introspection-ai/recipes/session` — create a live Pi Recipe session
- `@introspection-ai/recipes/mcp` — MCP declarations, bindings, and selection
- `@introspection-ai/recipes/pi-extension` — Pi extension entrypoint
- `@introspection-ai/recipes/extensions` — session identity and conditional
  Recipe extension helpers
- `@introspection-ai/recipes/channels` defines the provider-neutral `channels`
  tool, capability descriptors, and opaque message references. Replies answer
  the task's origin; capable adapters also support explicit read and send targets.
- `@introspection-ai/recipe-channel-slack` is the optional Slack adapter. A
  Recipe adds it as a dependency when it declares Slack in `pi.channels`.
- `@introspection-ai/recipes/agents` — portable agent-run controller and tool
  contract
- `@introspection-ai/recipes/interactions` — portable user-input and approval contract
- `@introspection-ai/recipes/inspect` — inspect resolved inheritance,
  capabilities, package closure, host requirements, and runtime boundaries
- `@introspection-ai/recipes/test-utils` — host conformance cases

The package intentionally has no `recipes` executable and no generic HTTP
server. The `introspection` CLI owns authoring and local operation. Hosting
adapters and deployment cookbooks belong outside this package.

## Validation

`introspection check` is the supported Recipe validation command:

```bash
introspection check
```

Validation is an authoring and host concern, not a launch-time one. Run
`introspection check` while authoring and in CI; a host that executes Recipes
should validate before it starts a session, as the Introspection platform does
when a task is created. A `pi --recipe` launch does **not** re-validate, so a
Recipe that was never checked can start with errors the validator would catch.

## Documentation

- [Recipe workflow](docs/recipe-flow.md)
- [Recipe Format](docs/recipe-format.md)
- [Host API](docs/host-api.md)
- [Pi extension](docs/pi-extension.md)
- [Agent composition](docs/agent-composition.md)
- [Interactions](docs/interactions.md)
- [MCP configuration](docs/mcp-configuration.md)
- [Recipe judges](docs/recipe-judges.md)

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0
