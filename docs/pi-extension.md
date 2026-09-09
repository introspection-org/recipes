# Recipes extension for Pi

The Recipes extension teaches [Pi](https://pi.dev/docs/latest) to load a
Recipe package with:

```bash
pi --recipe ./path/to/recipe --agent agent
```

Pi is the harness. The extension resolves the selected Recipe, configures its
model and tools, loads its skills and extensions, materializes its declared
capabilities, and registers its subagents. Every launch with `--recipe`
validates the authored package first.

## Installation

The recommended workflow lets the Introspection CLI provision compatible
versions:

```bash
npm install -g @introspection-ai/cli
introspection init
introspection local
```

For direct Pi use:

```bash
pi install npm:@introspection-ai/recipes
```

Recipes currently requires Node.js 24 or later and Pi `^0.82`.

## Selection

`--recipe` accepts a local directory:

```bash
pi --recipe . --agent agent
pi --recipe ./recipes/research --agent researcher
```

The extension no longer maintains a separate installed-Recipe store. Git,
package managers, and ordinary paths own distribution.

The selected path and agent are exposed to Recipe-owned tools as
`PI_RECIPE_DIR` and `PI_AGENT_NAME`.

## What is loaded

For the selected agent, the extension:

1. reads the root `package.json#pi` resource declarations;
2. resolves the agent YAML, including `from:` inheritance;
3. selects the model, thinking level, and tool allowlist;
4. loads providers from `pi.channels` and registers the tools selected by the agent;
5. loads selected skills, package prompts, and the complete Recipe extension closure;
6. materializes declared MCP bindings from host or local configuration;
7. exposes only the declared subagents through the shared `agent` tool.

See [Recipe Format](recipe-format.md) for the authored contract and
[Agent composition](agent-composition.md) for inheritance and selection.

## Structured child events

Pi's JSON mode emits root session events directly. Recipes appends one Pi
custom entry for every canonical event emitted by a delegated child. Pi emits
that entry as an `entry_appended` event; its `data` is an `agent_run_event`
envelope carrying the child run id, root parent, agent identity, depth, and
unchanged Pi session event. Custom entries are part of Pi's canonical session
stream but do not participate in model context. Consumers can attribute cost,
messages, and tool calls across the run tree without a second transcript store.

## Local capability bindings

Recipe source may include `.pi/mcp.local.example.json`, but secrets belong in
the environment or an ignored `.pi/mcp.local.json`. A host may synthesize the
same bindings in memory.

Bindings are resolved fail-closed for required servers. Optional servers may
remain unavailable. See [MCP configuration](mcp-configuration.md).

## Recipe-owned extensions

TypeScript extension sources declared by `package.json#pi.extensions` are
resolved deterministically and loaded for every Recipe session. This complete
set is one executable closure; agent YAML only controls which registered tools
the model may call.

Recipe extensions can import `forAgent`, `forRecipeSession`, and
`getRecipeSessionContext` from `@introspection-ai/recipes/extensions` for
session-local conditional behavior:

```ts
import { forAgent } from "@introspection-ai/recipes/extensions";

export default function reviewerHooks(pi) {
  forAgent(pi, "reviewer", () => {
    pi.on("tool_call", reviewPolicy);
  });
}
```

The context distinguishes `root` and `subagent` roles. Conditional behavior is
not code isolation: the extension module still executes with the Pi process's
authority. `forAgent` matches the final resolved `agent.name` exactly; `from`
is configuration inheritance and does not make a derived agent match its
ancestor's hooks.

The closure contains every extension declared by the Recipe. It does not claim
exclusive ownership of the surrounding Pi process: trusted global or project
extensions already loaded by interactive Pi may still run hooks, providers,
commands, and other non-tool behavior. Recipe `tools` remains the exact
model-callable allowlist. Embedded Recipe sessions disable ambient extensions,
skills, prompt templates, and context files by default.

## Validation

A `pi --recipe` launch does **not** validate the Recipe. Validation runs where
it can be acted on: while authoring, and in whatever host starts the session.

For an explicit manual or CI check, run:

```bash
introspection check
```

That command uses the Rust validation core (`introspection-recipe-check`),
which is also published as a crate and a Python binding so a host can embed it
- the Introspection platform validates there, and blocks task creation on a
failure. This npm package no longer ships a validator binary: a launch-time
check was a third run of the same engine in the one place whose failure mode is
a dead session, including when the binary simply could not be spawned.

## Host parity

The Pi extension and embedded hosts consume the same resolver. Both apply model
metadata and provider payload policy, including OpenRouter routing, Anthropic
context management, and Vercel AI Gateway routing. Embedded Recipe sessions
also apply `ai.options` and `session` directly to the live Pi agent and a
session-local settings manager. Pi's current extension API exposes provider
payload hooks but not request-default or session-policy setters, so
`pi --recipe` fails closed only when it cannot reproduce those authored
behaviors instead of silently ignoring them. Use the embedded Recipe session
API for Recipes that declare `ai.options` or `session` until Pi exposes the
required setters. Hosts should run the conformance
cases exported from `@introspection-ai/recipes/test-utils`.
