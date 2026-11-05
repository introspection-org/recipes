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

Nothing need be declared for it. The step is the agent's skill it last read, among the skills of the phase it lists first (`build-*` for an agent listing `build-brainstorm` first; others it consults, such as `eval-case`, don't move it): a skill named `<phase>-<step>` shows its phase's steps in the order the agent lists them, done ticked, the current one marked and the rest to come; any other skill shows by its name. The clock is the agent's working time from the start of the session, across every step, redrawn every second. It pauses while the person is in the loop, when the agent's turn has ended or a question or review is open, and the current step then shows ⏸ in place of ▸. It's never an estimate of what's left. Pi's "Working" line and the terminal title are left as they are. A resumed session shows its step at once, from its earlier reads.

An agent that moves through several phases declares them in its agent file, in order:

```yaml
skills: [build-brainstorm, build-draft, build-review, build-deploy, improve-collect, improve-classify, improve-propose, eval-run]
phases: [build, improve]
```

The phase is then that of the last step skill it read, a skill named `<phase>-<step>` of a declared phase, and its steps and ticks are that phase's skills in the order listed. Reading `improve-classify` shows:

```text
⧈ Introspection improve ✓ collect ▸ classify ○ propose · 31:40
```

Any other of the agent's skills is a helper: reading it never changes the phase, and it shows after the current step, its first dash as a space (`eval-run` as `eval run`, a name without a dash as it is), until the agent next reads a step:

```text
⧈ Introspection build ✓ brainstorm ▸ draft · eval run ○ review ○ deploy · 12:04
```

A helper read counts the same way a step read does: a glance at its top (fewer than 100 lines, or `head`) doesn't. While the clock is paused the step shows ⏸ as before, and a resumed session restores phase, step and helper from its earlier reads. Without `phases`, the footer works as described above.

A host that draws its own line (the platform's task chat) passes `onRecipeStep` to `createAgentSession`, with or without a UI. It receives the same step as data, `{ skill, phase?, steps: [{ name, state: "done" | "current" | "todo" }], paused, worked_ms }`, whenever the step changes or the clock starts or stops, not every second; the host runs the clock on from `worked_ms` while `paused` is false. A skill outside a phase has no `steps` and shows by `skill`.

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
show_artifact({ path: "evals/cases/refund.md" }); // relative to the working directory
```

The tool refuses a path outside the working directory (including a symlink
that leads out of it), a missing file, and anything that is not `.md` or
`.markdown`. The panel takes the top-right 45% of the terminal at full height
and shows the file name and the visible line range. It draws over the
conversation, so it isn't drawn on a terminal narrower than 100 columns. It opens without taking
the keyboard, so the user keeps typing in the editor. Showing another file
replaces the content, and the panel re-renders when the file changes on disk.

| Key                                            | Where                               | Does                                                                         |
| ---------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| `Up` / `Down`, `PgUp` / `PgDn`, `Home` / `End` | panel                               | Scroll                                                                       |
| `o`                                            | panel                               | Opens the file with the system's default app (`open`, `xdg-open` or `start`) |
| `Esc` / `q`                                    | panel                               | Closes the panel                                                             |
| `PgUp` / `PgDn`                                | a question from `ask_user_question` | Scroll the panel without moving the keyboard to it                           |

`/recipe view <file>` opens a file the same way; `/recipe view` on its own opens
the last markdown file the agent showed or wrote with `write` or `edit` in this
session, and `Esc` closes the panel from the editor. They are
subcommands of `/recipe`, so they never clash with another extension's or your
own commands.

The panel exists only in Pi's interactive terminal. In print, RPC and embedded
sessions the tool returns `The file is at <path>. The artifact panel is only
available in Pi's interactive terminal, ...` so the model can tell the user
where to look. If a Recipe extension registers its own `show_artifact`, the
host keeps it and registers neither the built-in tool nor `/recipe view`.

### Reviewing several files

List `review_artifacts` and the agent can ask the user to review several
markdown files it wrote, one decision per file, as in a pull request review:
approve, with an optional comment, or request changes, saying what to change.

```ts
review_artifacts({
  title: "The interview agent's cases",
  items: [
    // 1 to 20, in reading order
    { path: "evals/cases/C1.md", label: "C1: four questions" },
    { path: "evals/cases/C2.md", label: "C2: a vague answer" },
    { path: "docs/DESIGN.md", label: "The brief", section: "Part A" }, // only that part
  ],
});
```

A case's front matter shows as one line (its check, inputs and approval), and `section` shows only the part under that heading, so the review holds what is being approved.

In Pi's terminal the review is inline, in place of the editor: a tab per file
and a Submit tab across the top (a single file has none), the file itself in a
box, and the choices under it. The artifact panel isn't used; `show_artifact`
is for showing a file without asking for a decision.

| Key                                                                        | Does                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Left` / `Right`, `Tab` / `Shift+Tab`                                      | Previous or next file, then Submit                                                                                        |
| `Up` / `Down`, `Enter`, or a number                                        | Pick a choice: `Approve`, `Approve with a comment` (optional), or `Request changes` and say what should change (required) |
| `j` / `k`, `Space` / `b` (also `PgUp` / `PgDn`, `Shift+Up` / `Shift+Down`) | Scroll a file longer than the box, which takes at most half the terminal                                                  |
| `Esc`                                                                      | Cancel the review; nothing is approved                                                                                    |

After a decision the review moves to the next undecided file, and once every
file has one, to the Submit tab; nothing is sent until the user submits there
(a single file submits with its decision). The Submit tab lists the decisions and offers
`Submit` (files left undecided are `not reviewed`) or `Approve the rest and submit`.

It is an interaction ([Interactions](interactions.md)), so it works on every
host: over RPC each file is a select (`Approve`, `Request changes`, `Skip`),
then a comment (required for changes); on a pause/resume host it pauses with
`details.interrupt.metadata` `{ kind: "review_artifacts", items: [...] }` for
the host to render its own review, and resumes with `{ answer }` in the format
below; headless runs and child agents decline, so nothing is approved without a
person.
`@introspection-ai/recipes/review` exports what a host needs to render it the
way the terminal does (`formatReviews`, `parseReviews`, `tabName`, `lineDiff`
for the changes since `previous_content`), with no Node or Pi imports.

Each item carries what the reviewer is shown, so the host needs no access to
the files:

| Field | What it is |
| --- | --- |
| `path`, `label`, `section` | As given; `section` only when one was |
| `content` | The file as the terminal review shows it: front matter folded into one line, only `section` when given |
| `sha256` | Of the whole file on disk when asked (`null` when it doesn't exist), so a record of approval can say exactly which file was approved |
| `previous_content` | What this session's last review of the path showed, when the file has changed since; kept in memory only, so a restarted session sends none |
| `truncated` | `true` when `content` was cut to the interrupt's cap (256 KB of content across the review); the host lets such a file be read but not approved |

`details.files` holds `{ path, sha256 }` for every item, on every host. The model sees, after `Answer: `:

```text
Reviewed 2 files: 1 approved, 1 with changes requested, 0 not reviewed.
evals/cases/C1.md: approved
evals/cases/C2.md: changes requested — "make the question count a code check"
```

A file approved with `A` before the user opened it says `(not opened)`, so a
record of approvals can say so. `details.reviews` holds the same decisions as
`{ path, decision, comment?, opened }`.

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
