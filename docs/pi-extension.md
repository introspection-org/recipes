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

Recipes currently requires Node.js 24 or later and Pi `>=1.1.0`.

## Selection

`--recipe` accepts a local directory:

```bash
pi --recipe . --agent agent
pi --recipe ./recipes/research --agent researcher
```

The extension no longer maintains a separate installed-Recipe store. Git,
package managers, and ordinary paths own distribution.

The selected path and agent are exposed to Recipe-owned tools as
`PI_RECIPE_DIR` and `PI_AGENT_NAME`. A launch without `--recipe` or `--agent`
reads them as its defaults, but an agent name only counts for the Recipe it
came with: `pi --recipe <another Recipe>` run from a Recipe session's shell
selects that Recipe's default agent, not the parent's.

## Where the agent is

A Recipe agent's step shows in Pi's footer, with how long the agent has worked:

```text
⧈ Introspection build ✓ brainstorm ▸ draft ○ review · 12:04
```

Nothing is declared for it. The step is the agent's skill it last read: a skill named `<phase>-<step>` shows its phase's steps in the order the agent lists them, done ticked, the current one marked and the rest to come; any other skill shows by its name. The footer shows one phase at a time, like a section of a site: a phase is two or more skills sharing a prefix (`build-*`, `deploy-*`, `improve-*`, `optimize-*`), in the order the agent lists them, and it moves on to the next phase only when the agent reads that phase's first step after the last step of this one (`deploy ✓ runtime ▸ test` after `build … ✓ review`). It never moves back, and a skill read along the way, such as `eval-case` during build, leaves the step as it is. The clock is the agent's working time from the start of the session, across every step, redrawn every second. It pauses while the person is in the loop, when the agent's turn has ended or a question or review is open, and the current step then shows ⏸ in place of ▸. It's never an estimate of what's left. Pi's "Working" line and the terminal title are left as they are. A resumed session shows its step at once, from its earlier reads.

## The Recipe a session runs

When the extension starts a Recipe session it records the Recipe in the session file, as a custom entry of type `recipe_session`:

```json
{ "type": "custom", "customType": "recipe_session", "data": { "recipe_dir": "/abs/path/interviewer", "agent": "agent", "package": "interviewer", "version": "0.1.0" } }
```

It's written again only when the Recipe, agent or version changes, so the latest one is what the session runs now. Whoever continues the session (`introspection local`, a local task, a person) reads it to start the same Recipe and agent without being told. A session that can't record it still runs.

## GenAI spans

Set `PI_RECIPE_GENAI_SPANS_FILE` to a path and the extension writes the
session's GenAI spans there as JSON: one `chat` span per model call and one
`execute_tool` span per tool result.

The file is replaced when the session starts and after every turn, so a run
that is killed still leaves the turns it finished.

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

## Artifact panel

List `show_artifact` in an agent's `tools` and the agent can show the user a
markdown file it wrote, such as a design brief, `evals/cases/*.md` or a
report, rendered in a panel on the right of Pi's terminal, instead of only
printing its path. Agents that do not list it never see the tool or `/recipe view`.

```yaml
tools: [read, write, edit, ask_user_question, show_artifact]
```

```ts
show_artifact({ path: "evals/cases/refund.md" })  // relative to the working directory
```

The tool refuses a path outside the working directory (including a symlink
that leads out of it), a missing file, and anything that is not `.md` or
`.markdown`. The panel takes the top-right 45% of the terminal at full height
and shows the file name and the visible line range. It opens without taking
the keyboard, so the user keeps typing in the editor. Showing another file
replaces the content, and the panel re-renders when the file changes on disk.

| Key | Where | Does |
| --- | --- | --- |
| `Alt+R` | editor or panel | Moves the keyboard to the panel and back; with no panel open, reopens the last file |
| `Up` / `Down`, `PgUp` / `PgDn`, `Home` / `End` | panel | Scroll |
| `o` | panel | Opens the file with the system's default app (`open`, `xdg-open` or `start`) |
| `Esc` / `q` | panel | Closes the panel |

`/recipe view <file>` opens a file the same way; `/recipe view` on its own opens
the last markdown file the agent showed or wrote with `write` or `edit` in this
session, and `/recipe close` closes the panel from the editor. They are
subcommands of `/recipe`, so they never clash with another extension's or your
own commands.

The panel exists only in Pi's interactive terminal. In print, RPC and embedded
sessions the tool returns `The file is at <path>. The artifact panel is only
available in Pi's interactive terminal, ...` so the model can tell the user
where to look. If a Recipe extension registers its own `show_artifact`, the
host keeps it and registers neither the built-in tool nor `/recipe view`.

## Structured child events

Pi's JSON mode emits root session events directly. Recipes appends one Pi
custom entry for every canonical event emitted by a delegated child. Pi emits
that entry as an `entry_appended` event; its `data` is an `agent_run_event`
envelope carrying the child run id, parent run id (`root`, or the delegating
child's run id for a depth-2 run), agent identity, depth, and unchanged Pi
session event. Custom entries are part of Pi's canonical session
stream but do not participate in model context. Consumers can attribute cost,
messages, and tool calls across the run tree without a second transcript store.

## Local capability bindings

Recipe source may include `.pi/mcp.local.example.json`, but secrets belong in
the environment or an ignored `.pi/mcp.local.json`. A committed
`.pi/mcp.local.json` validates only as an evaluation binding, every server a
loopback streamable HTTP endpoint (see [MCP configuration](mcp-configuration.md)).
A host may synthesize the same bindings in memory.

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
