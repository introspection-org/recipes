# Recipe Format

**Status:** Open format, version 1  
**Reference implementation:** `@introspection-ai/recipes`  
**Validator:** `introspection check`

The Recipe Format is a Git-native package contract for complete Pi agents. It
defines the agent-owned inputs that a compatible host must interpret the same
way. It does not define deployment infrastructure or a network protocol.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## Compatibility scope

A conforming Recipe is **Pi-native and host-portable**:

- it MUST produce the same resolved agent configuration in compatible Pi hosts;
- it MUST NOT depend on an Introspection-managed runtime;
- it MAY declare host requirements that a particular host cannot satisfy;
- a host MUST fail closed when a required capability cannot be bound.

This format does not claim interoperability with non-Pi agent harnesses.

## Package root

A Recipe MUST be a directory containing `package.json`. At minimum, its
manifest contains a package name and a `pi` object:

```json
{
  "name": "acme-research",
  "pi": {}
}
```

A fuller package may declare distribution metadata and explicit resource
paths:

```json
{
  "name": "acme-research",
  "version": "1.0.0",
  "description": "Research an account and produce a sourced brief.",
  "pi": {
    "agents": ["agents/*.yaml"],
    "skills": ["skills/**/SKILL.md"],
    "extensions": ["extensions/*.ts"],
    "prompts": ["prompts/*.md"]
  }
}
```

`name` is the package identity. `version` is optional distribution metadata and
defaults to `0.0.0` when omitted. `description` is optional human-facing
metadata. When resource arrays are omitted, conventional `agents/`, `skills/`,
and `prompts/` directories are discovered when present. Executable extensions
and MCP servers are never discovered by convention and MUST be declared
explicitly.

Omission and an explicit empty array are different:

- an omitted `agents`, `skills`, or `prompts` key opts into its documented
  conventional directory;
- an explicit `[]` resolves no resources of that kind;
- every explicitly authored path or glob MUST match.

Resource paths:

- MUST be relative to the package root;
- MUST NOT resolve outside the package, including through symlinks;
- MAY be files, directories, or supported glob patterns;
- preserve declaration order, with matches inside each glob ordered
  lexically.

Unknown top-level `package.json` fields retain normal npm semantics. Unknown
Recipe fields inside supported `pi` structures are validation errors unless a
later format version explicitly defines them.

When a Recipe declares non-empty `dependencies` or `optionalDependencies`, it
SHOULD commit `pnpm-lock.yaml`; without one the check warns and each install
resolves the declared ranges afresh. A `packageManager` field, if present, MUST
be a complete `pnpm@<version>` descriptor; Corepack refuses a bare name, a
partial version, or another manager. A Recipe installs with pnpm, so
`package-lock.json`,
`npm-shrinkwrap.json` and `yarn.lock` are rejected: they pin nothing that is
read. An npm lockfile left in the tree MUST still carry the same package name
and version as `package.json`.

## Agents

`pi.agents` may declare YAML agent definitions explicitly. When omitted,
direct `.yaml` and `.yml` children of `agents/` are discovered. A resolved
Recipe MUST contain at least one agent.

```yaml
name: agent
description: Produce a sourced research brief.
ai:
  model: <provider>/<model>  # one Pi has credentials for: pi --list-models
  thinking_level: high
  options:
    max_tokens: 4096
session:
  steering_mode: one-at-a-time
  follow_up_mode: one-at-a-time
  tool_execution: parallel
tools: [read, bash]
skills: [research]
subagents: [reviewer]
system_instructions:
  mode: append
  content: Verify every material claim.
```

An agent MAY inherit from another named agent with `from`. Inheritance MUST be
acyclic. Child fields override inherited scalar fields; documented collection
fields use the merge or replacement behavior in
[Agent composition](agent-composition.md).

Every agent YAML MUST declare a package-unique lowercase kebab-case `name`.
This is its
stable identity for selection, subagent references, artifacts, and telemetry;
the filename has no semantic meaning.

Every fully resolved agent MUST also define `ai.model` as
`<provider>/<model_id>`. The model may be declared directly or inherited with
`from`. The legacy `model.name` form remains accepted for backwards
compatibility, but an agent MUST NOT declare both `ai` and `model`.

All remaining agent fields are optional. Omitted `tools`, `skills`, and
`subagents` resolve to empty lists. Omitted `ai.thinking_level` preserves the
provider or session default. Omitted agent instructions preserve `SYSTEM.md`
when present, or Pi's normal base prompt otherwise.

Recipe-authored configuration uses `snake_case`. `ai.options` is normalized at
the Pi boundary to Pi's camelCase portable `streamSimple` request options, so
newly added portable Pi options do not require a Recipe schema release. It is
not an alias for every provider adapter's lower-level options. Nested option
values, `ai.providers.openrouter.routing`, and
`ai.providers.vercel_ai_gateway.routing` are opaque provider data and are not
renamed or field-allowlisted. Host-owned request controls are rejected,
including credentials and SDK clients; headers and hooks; fetch, environment,
abort signals, telemetry, and session identity; cloud project, location,
region, and profile selection; and Azure endpoint/deployment configuration.

The checker validates the provider envelope: OpenRouter and Vercel AI Gateway
`routing` and Anthropic `context_management` must be objects, and Anthropic
`betas` must be non-empty strings. Fields inside the routing and
context-management objects remain transparent provider payloads, except that
Vercel request-scoped `byok` credentials are host-owned and rejected. Vercel
routing is serialized as `providerOptions.gateway` only for the
`vercel-ai-gateway` provider.

The checker does not predict live provider compatibility inside those
transparent payloads. For example, OpenRouter's `require_parameters` policy
depends on the parameters emitted by the selected model adapter and the
capabilities of currently available endpoints. Recipes preserves the authored
value; endpoint compatibility must be verified against the provider.

`session` owns portable Pi session behavior. Queue modes accept `all` or
`one-at-a-time`; `tool_execution` accepts `parallel` or `sequential`. The
`retry`, `compaction`, and `images` use the managed runtime's corresponding Pi
settings with snake_case keys. Each session gets a session-local copy of the
host's effective settings, including overrides the host applied to the
settings manager it passes (Pi >=0.99; older Pi exposes only the file-backed
settings and drops those overrides when it reloads the manager), with the
agent's `session` values layered on top;
a key the agent omits keeps the host's value, then Pi's default. Host settings
are left unmodified, and subagents layer their own `session` over the same host
settings. Their nested keys, types, enums, and integer ranges are closed and
validated. Interactive tree navigation and
branch summaries, UI, shell, resource loading, persistence, networking,
analytics, telemetry, and model-default settings are
not portable session policy and remain host-owned or belong under `ai`.

`tools` MUST NOT contain `agent`. The host materializes that session-generated
tool for a session whose effective `subagents` list is non-empty and whose
delegation depth allows it (see below).

The default agent is named `agent`. If no `agent` exists, a host MAY select the
only declared agent. When multiple agents exist without `agent`, the caller
MUST select one explicitly.

## First-party packages

Some tools come from packages we publish: **channel tools**
(`@introspection-ai/recipe-channel-<provider>`, such as Slack) and
**document tools** (`@introspection-ai/recipe-documents-<format>`, docx and
pdf). A Recipe turns one on with a `pi` declaration.

These are **companion packages**: Recipes installs them alongside itself, as
its `optionalDependencies`, so wherever Recipes is installed (Pi, a runtime
image, npm) they are there too.

- **Declare them as peers by default**, or omit them. The Recipe then uses the
  copy beside the running Recipes and never brings a second one.
- **Pin one only when needed**, by listing it in `dependencies` with an exact
  version. The Recipe's own copy then wins.
- **Any other package** the Recipe uses is a `dependency`, unless the platform
  running it provides that package, in which case it is a peer. `recipes check`
  warns about a peer a standard platform does not provide.

A package can also ship skills a Recipe uses; see
[Shipping skills in a package](#shipping-skills-in-a-package).
[Channel tools](channels.md) and [Document tools](documents.md) show full
examples, and how a loaded package is checked against the running Recipes.

### Channel tools

`pi.channels` declares official provider tools that the host may register for
the Recipe. The declaration does not contain a connector ID, workspace ID, or
credential. A host binds those values when it starts a task.

```json
{
  "pi": {
    "channels": [
      {
        "provider": "slack"
      }
    ]
  }
}
```

Each provider may appear once. The host derives the package name from the
provider. For example, `slack` resolves to
`@introspection-ai/recipe-channel-slack`. The package owns its tool catalog
and marks which tools are active by default.

The Slack package is a companion package (see above). The host imports it
only when the Recipe declares the provider. An agent lists each allowed tool by its full name, such as
`channels`, in its `tools` list. The host fails when the agent names a
tool that the connector does not register.

Chat providers share one connector shape. A channel connector registers the
provider-neutral `channels` tool with commands for supported operations. An
optional `commands` array on the connector restricts these operations for all
agents using it, for example `{"provider":"slack","commands":["read","reply"]}`.
Omitting it allows supported commands; an empty list exposes no channel tool.
`requireReply` is an optional boolean that defaults to `true` when channel tools
are enabled. Incoming turns then require a successful final `reply`, so an
enabled command allowlist must include `reply`. Set `requireReply: false` for
intentional silence, such as a read-only allowlist. See [Channel tools](channels.md).

### Document tools

`pi.documents` lists the document formats the `documents` tool opens, each as
`{"format": "<format>"}` served by the companion package
`@introspection-ai/recipe-documents-<format>`, with an optional `commands`
allowlist and `profile`. A profile is a skill with guidance for one
kind of work, such as `legal-redlining-en-US`, which the docx package ships.

```json
{
  "peerDependencies": {
    "@introspection-ai/recipe-documents-docx": ">=X.Y.Z",
    "@introspection-ai/recipe-documents-pdf": ">=X.Y.Z"
  },
  "pi": {
    "documents": [
      { "format": "docx", "profile": "legal-redlining-en-US" },
      { "format": "pdf" }
    ]
  }
}
```

See [Document tools](documents.md).

## Judges

A Recipe MAY include portable LLM grading definitions as direct `.yaml` or
`.yml` children of `judges/`. Nested files are not judge sources. Every judge
YAML MUST declare a package-unique lowercase kebab-case `name`. As with agent
definitions, this is the stable authored identity and the filename has no
semantic meaning.

For backwards compatibility, parsers accept legacy `judge:` as a deprecated
alias and normalize it to `name`. A definition cannot declare both fields.

The authored schema, defaults, applicability gates, and model configuration are
defined in [Recipe judges](recipe-judges.md). The Recipe Format owns this
declarative evaluation contract; hosts own transcript assembly, execution,
credentials, retries, persistence, and result processing.

## Instructions, skills, prompts, and extensions

`SYSTEM.md`, when present, is package-wide instruction source. Agent
`system_instructions.mode` determines whether agent instructions append to or
replace the current prompt. On `pi --recipe`, Recipes then appends Pi's skills
prompt when the selected agent has model-invocable skills and a `read` or
`bash` tool.

Skills follow the [Agent Skills](https://agentskills.io) directory convention
and are selected from the resources declared by `pi.skills` and by the
Recipe's dependencies (see [Shipping skills in a package](#shipping-skills-in-a-package)).
A skill is named by its `SKILL.md` frontmatter `name`, then by its containing
directory; a root-level unnamed `SKILL.md` uses the portable fallback name
`skill`.

In recipe mode the agent sees only the Recipe's skills: the ones its agent
selects from the Recipe and its dependency and peer packages, plus the
`documents` tool's core skill and profile, wherever the format package comes
from (a dependency, a peer, or the copy beside Recipes). These arrive through
Recipes' own resolution, so Pi's `--no-skills` does not remove them. Skills
Pi discovers anywhere else (an installed Pi package, the user or project
skills folder, `--skill <path>`) never reach the prompt or a `/skill:`
command, under `pi --recipe` and the session API alike. To use a skill, add
it to the Recipe or a package it depends on.

Prompt templates are declared by `pi.prompts`. They retain Pi's normal SDK and
TUI behavior: hosts expose them through `AgentSession.promptTemplates`, and a
caller invokes one by prompting with its slash command and arguments.

### Prompt templates are suggestions

A Recipe's suggestions are the things a new user can ask it to do. They are
the prompt templates marked with `suggest: true` in their frontmatter; there
is no separate manifest field. Templates without the mark still work as
`/name` commands and are never suggested. Give each suggested template a
short `description` (ten words or fewer), because that is what people see:

```markdown
---
suggest: true
description: Redline a contract against our playbook
argument-hint: "[contract]"
---
Redline ${1:-the attached contract} against the playbook. Today is {{today}}.
```

- **In Pi.** A new session in the terminal (`pi --recipe <dir>`, or
  `introspection local`) with no messages asks once, "What would you like to
  do?", with up to three marked templates (a random three, in file order,
  when more are marked) and a row to type your own request. With none
  marked, it does not ask. Picking one sends it as the first message;
  a template whose `argument-hint` has a required `<argument>` is put in the
  editor instead, for you to finish. Typing sends what you typed, and Esc
  leaves the empty prompt. Set `PI_RECIPES_SUGGESTIONS_SEED` to pin which
  three show. The picker never appears on resume, outside the terminal UI,
  or when Pi starts with a message.
- **Starting with one.** Pi expands a template given as the initial message,
  so `pi --recipe <dir> "/redline nda.docx"` (or
  `introspection local -- "/redline nda.docx"`) starts with it expanded.
- **Placeholders.** Besides Pi's `$1` and `${1:-default}` arguments, a
  template may use `{{member.name}}`, `{{member.email}}`, `{{org.name}}` and
  `{{today}}` (an ISO date). A host fills the ones it knows and leaves the rest
  as written. Pi's picker fills `{{today}}`, and `{{member.name}}` from
  `git config user.name`; a template typed as `/name` is sent unfilled.
- **Other surfaces.** `listRecipeSuggestions(recipeDir)` returns the marked
  templates as `{ name, description, argumentHint?, text, placeholders }[]`, and
  `fillSuggestion(text, values)` fills placeholders; both are exported from
  `@introspection-ai/recipes/suggestions`.
  `inspectRecipe` includes the same list as `suggestions`. A host that holds
  the Recipe's files rather than a directory, such as the control plane when
  it validates a version, reads the same list with `list_recipe_suggestions`
  from `introspection-recipe-check` (Rust or Python).
- **YAML 1.2.** Only `suggest: true` marks a template. As in Pi, `yes`, `on`
  and `"true"` are not booleans, so they don't count.
- **Checks.** For a marked template, the checker warns when it has no
  `description` (`prompts.description_missing`), when the description is over
  ten words (`prompts.description_long`), or when it uses a placeholder outside
  the list above (`prompts.placeholder_unknown`). A `suggest` value that is not
  a boolean is also a warning (`prompts.suggest_invalid`).

Recipe-owned Pi extensions are declared by `pi.extensions`. The deterministically
resolved set forms the package's executable trust boundary and loads for every
root and child session. Package membership means execution; agent YAML cannot
select or remove extensions.

An extension declaration may name a module or directory. A directory index
(`index.ts`, `index.tsx`, `index.js`, `index.jsx`, `index.mjs`, or `index.cjs`,
in that precedence order) owns the directory. Without an index, Recipes loads
its direct extension modules and the indexes of its immediate child
directories, both in lexical order. Discovery is intentionally shallow;
declare deeper modules explicitly.

Programmatic root and child sessions invoke the closure's factories for their
own Pi runtime. Interactive Pi keeps one extension runtime for the selected
Recipe launch and does not retry a partially failed closure without rebuilding
that runtime. Extension load failures stop the agent before a model call.
Recipe extensions MUST NOT override host or Pi built-in tool names; use a
distinct tool name when behavior differs. The one exception is
`ask_user_question` (see [Tools](#tools-subagents-and-capabilities)). Extension code retains its non-tool
behavior even when none of its tools appear in the selected agent's `tools`
allowlist.

The package extension closure is complete with respect to Recipe source, not
the surrounding host process. A host MAY supply extensions, settings, or other
runtime policy. Interactive Pi may already have trusted global or project
resources loaded; compatible hosts MUST keep those additions distinguishable
from Recipe-owned inputs. `tools` limits model-callable tools, not extension
hook execution.

## Shipping skills in a package

An npm package ships skills by declaring them in its own `package.json`, with
the same `pi.skills` key a Recipe uses:

```json
{
  "name": "@acme/contract-skills",
  "version": "1.2.0",
  "files": ["skills"],
  "pi": { "skills": ["skills"] }
}
```

A Recipe uses those skills by listing the package in `dependencies` (or in
`peerDependencies`, when the platform provides it) and selecting them by name
in an agent's `skills`, like its own:

```json
{
  "name": "contracts",
  "dependencies": { "@acme/contract-skills": "^1.2.0" },
  "pi": {}
}
```

```yaml
name: agent
skills: [review-nda]
```

The rules:

- Hosts read `pi.skills` from each direct `dependencies` and
  `peerDependencies` entry, found with Node's package resolution from the
  Recipe directory: in the Recipe's own `node_modules`, or in one above it,
  where an npm install hoists a dependency beside the Recipe and a platform
  image installs the peers it provides. One that is not installed is skipped.
  `devDependencies` and transitive dependencies are not read.
- Only an explicit `pi.skills` counts. A dependency's `skills/` folder is not
  discovered by convention, and a dependency without `pi.skills` contributes
  no skills.
- Paths are relative to the dependency package, MUST NOT resolve outside it
  (including through symlinks, compared by real path), and every explicit path
  MUST match. A violation is an error naming the package.
- Dependency skills join the Recipe's own skills. An agent's `skills` list
  selects among all of them; an agent gets no skill it does not list.
- A name an agent selects MUST resolve to exactly one `SKILL.md` across the
  Recipe and its dependencies. Two with the same name are an error naming
  both. Give each skill a unique frontmatter `name`.

These skills arrive with the install: the build installs the Recipe's
dependencies from its lockfile, and nothing is fetched at run time. A check
run without `node_modules` cannot see dependency skills, so a skill an agent
selects that is not in the Recipe is a warning there rather than an error.

Document profiles use a different path. A Recipe such as
[`introspection-org/recipe-redlining`](https://github.com/introspection-org/recipe-redlining)
selects a profile in `pi.documents`, from a pinned docx package or the host
default (see [First-party packages](#first-party-packages)); the `documents`
tool delivers the core `documents` skill and that profile itself, for agents
that list the tool.

## Tools, subagents, and capabilities

`tools` is an allowlist. A host MUST expose no undeclared Pi or extension tool
through this field.

Besides Pi's own tools (`read`, `bash`, `edit`, `write`, `grep`, `find`,
`ls`), Recipes provides these built-in tools, available only to an agent that
lists them in `tools`:

| Tool | What it does |
| --- | --- |
| `ask_user_question` | Asks the user one to four multiple-choice questions and waits for the answers; the user can always type their own answer. Works in Pi's terminal, on pause/resume hosts and headless. See [Interactions](interactions.md#the-built-in-ask_user_question-tool). |
| `show_artifact` | Shows a markdown file the agent wrote (a brief, test cases, a report) in a panel on the right of Pi's terminal, and adds `/recipe view`; Esc closes it. Elsewhere it returns the file's path as text. See [Pi extension](pi-extension.md#artifact-panel). |
| `review_artifacts` | Asks the user to review several markdown files the agent wrote, one decision per file (approve, or request changes saying what to change). In Pi's terminal each file shows in the artifact panel; other hosts render their own review. See [Pi extension](pi-extension.md#reviewing-several-files). |

```yaml
tools: [read, bash, ask_user_question, show_artifact]
```

If a Recipe extension registers its own `ask_user_question`, the host keeps
the Recipe's tool and does not register the built-in one. This exception to
the rule below lets a Recipe migrate from its own question tool without a
coordinated release; new Recipes list the built-in tool instead.

`subagents` names agents the selected agent may invoke. A host MUST expose only
those resolved definitions through the shared `agent` tool. How child work is
scheduled or isolated belongs to the host.

Delegation is two levels deep. A delegated child (depth 1) whose effective
`subagents` list is non-empty receives its own `agent` tool; a child of a
child (depth 2) MUST NOT receive one, which also bounds recursive references
such as `a -> b -> a`. A delegating child's run completes only after the runs
it started have settled and it has processed their results, and interrupting
or closing a run interrupts or closes the runs beneath it.

The `pi.mcp` package block declares capability servers and package-level tool
policy. Agent `mcp` blocks narrow those declarations. Credentials and concrete
endpoint bindings MUST NOT be required in distributable Recipe source. A host
MUST reject an unbound required server before the session begins. A host
preparing a session that does no work MAY start it without the discovered
catalog of a required server declared `"discovery": "defer"`.

See [MCP configuration](mcp-configuration.md) for the complete authored and
binding grammar.

## Host responsibilities

The Recipe Format owns:

- package and agent interpretation;
- instruction composition;
- model and tool selection;
- skill and prompt selection plus the package extension closure;
- subagent visibility;
- capability policy;

The host owns:

- credentials and secret resolution;
- workspaces and filesystem isolation;
- task and process lifecycle;
- persistence and recovery;
- scheduling and concurrency enforcement;
- network protocols and user authentication;
- telemetry export policy;
- deployment.

Those host concerns MUST NOT become mandatory Recipe source fields.

## Runtime requirements

A Recipe MAY declare portable runtime requirements under `pi.runtime`. These
requirements are fail-closed: a host MUST satisfy every declaration before the
first model call or reject the Recipe with an actionable diagnostic.

```json
{
  "pi": {
    "runtime": {
      "python": {
        "project": "python",
        "lockfile": "python/uv.lock",
        "version": ">=3.12,<3.15",
        "imports": ["pandas", "openpyxl"]
      }
    }
  }
}
```

`python.project` names a Recipe-relative Python project directory and
`python.lockfile` names its committed `uv.lock`, which must be the
`uv.lock` beside the project's `pyproject.toml`. Hosts MUST install with
frozen resolution (`uv sync --frozen --no-dev`) and MUST NOT install into
system Python or resolve an unlocked dependency graph. `version` is passed to
uv as the interpreter request. `imports` are optional boot preflights, each a
dotted Python module name (`docx`, `paper_docx.api`); hosts import them with
`PYTHONHOME` removed.

`pi.runtime.python` is the only runtime key; any other key under `pi.runtime`
is rejected. PDF and Word work goes through the `documents` tool (`pi.documents`
with the `pdf` or `docx` format), not shell utilities. A Recipe that only uses
the `documents` tool needs no `pi.runtime.python`; the format packages bring
their own.

### Package declarations

A package the Recipe depends on MAY declare `pi.runtime.python` in its own
`package.json`, with the same fields relative to the package. Hosts read it
from each direct `dependencies` or `peerDependencies` entry, found with Node's
package resolution from the Recipe directory (the Recipe's own `node_modules`,
or one above it when an npm install hoists the dependency beside the Recipe);
`devDependencies` and transitive dependencies are
not read, and a declared dependency that is not installed is skipped. A
package declaring it MUST ship the project's `pyproject.toml` and `uv.lock`:
when its `package.json` lists `files`, both must be covered.

Each declaration gets its own environment:

- **The Recipe's own declaration is the shell environment.** Hosts activate
  it for the agent's shell tools: `VIRTUAL_ENV` and `UV_PROJECT_ENVIRONMENT`
  name it, its `bin` (`Scripts` on Windows) comes first on `PATH`, and
  `PYTHONHOME` is removed.
- **Each package's declaration gets a separate environment**, installed with
  `--no-editable` and never activated or put on `PATH`. The host hands the
  package its interpreter; a documents format receives it as
  `createAdapter({ env, cwd, python })`.

A package extension asks for a package's interpreter with
`packagePython(name)` on its session context, by the package's name; it is
`undefined` when that package declares no `pi.runtime.python` or is not a
direct dependency. `@introspection-ai/recipes/python` runs a script with it:
`pythonExecutable({ python, env, override })` picks the interpreter
(`env[override]`, then `python`, then `VIRTUAL_ENV`, then `python3`), and
`runPythonJson(script, request, { python, env, cwd, signal, timeoutMs })`
runs `python -I <script>` with the request as JSON on stdin and resolves its
stdout parsed as JSON (default timeout 300 s, 64 MB output):

```ts
import { getRecipeSessionContext } from "@introspection-ai/recipes/extensions";
import { pythonExecutable, runPythonJson } from "@introspection-ai/recipes/python";

export default function tables(pi) {
  const python = pythonExecutable({
    python: getRecipeSessionContext(pi).packagePython("@acme/recipe-tables"),
    override: "ACME_TABLES_PYTHON",
  });
  // ... later, in a tool:
  // await runPythonJson(helperScript, { path }, { python, cwd: ctx.cwd });
}
```

No declaration has to agree with another: two packages may lock different
versions of the same library.

### Preparing environments

`prepareRecipePython(recipeDir, options)` from
`@introspection-ai/recipes/recipe` finds every declaration and prepares it:

- `mode: "check"` runs `uv sync --frozen --no-dev --check --offline`, then
  `uv python find` with the environment active, and the import preflight. The
  second step catches an environment whose interpreter no longer satisfies the
  declared version or `requires-python`, which uv's check passes. It writes
  nothing and uses no network.
- `mode: "sync"` checks first and installs only a missing or outdated
  environment, with `uv sync --frozen --no-dev --compile-bytecode`. A current
  environment is never recompiled.
- uv runs with `--no-python-downloads` unless `allowPythonDownloads` is set.

By default environments live in a shared cache,
`~/.introspection/python/<hash>`, keyed by the environment kind (shell or
package), platform and architecture, the `uv.lock` and `pyproject.toml`
contents, and the declared `version`. Without a declared `version` it also
keys on what uv would pick the interpreter from: `UV_PYTHON`, every
`.python-version` or `.python-versions` file from the project directory up to
the filesystem root, and uv's global pin. A Recipe project that is itself a
package (it has `[build-system]`, so it installs editable) also keys on its
directory. `environmentRoot` (or `PI_RECIPES_PYTHON_ROOT`) fixes the
location instead: the shell environment is `<root>/python` and each package's
`<root>/python-packages/<name>`, so a host baking environments into a Recipe
image passes `<recipe>/.pi`. Concurrent preparations of one environment are
serialised by a lock file beside it.

Each prepared environment reports its directory and interpreter, plus the
activation for the shell environment. Failures are named errors:
`RecipePythonUvMissingError` (uv not installed), `RecipePythonVersionError`
(no interpreter satisfies the version), `RecipePythonOutdatedError` (check
mode found an environment missing or not matching its lock) and
`RecipePythonImportError`.

**Hosts fail closed.** Pi's extension prepares in sync mode with interpreter
downloads allowed when it loads a Recipe, tells the user when a first build
downloads packages, and refuses to start the session if any environment fails.
The session API (`createAgentSession`) only checks: it never installs, so the
host prepares the environments before it creates sessions, and an unprepared
one fails construction.

Recipe packages are trusted application code. In particular, authored
TypeScript extensions execute inside the Pi process with its authority. A host
that accepts third-party Recipes MUST review or isolate them before execution;
the format and Host API are not a sandbox boundary.

## Evaluations

A Recipe's evaluations live under `evals/` by default, with its fakes at the
Recipe root:

```text
evals/
  cases/<id>.md        one case file per case: the owner's words and approval
  cases/inputs/        optional: synthetic inputs only
  vitest/              vitest-evals suites; each *.eval.jsonl row names its case
  harbor/<id>/         one Harbor task per folder; the folder name is the case id
  lib/                 code shared by several tasks or suites
  sources/             pinned generators of derived eval data
fakes/<server>/        MCP fakes and their scenarios, also used for local testing
```

`pi.evals` is optional and overrides those locations. Absent, hosts and tools
discover `evals/vitest` and `evals/harbor` when they exist.

```json
{
  "pi": {
    "evals": {
      "suites": [
        { "type": "harbor", "path": "evals/harbor" },
        { "type": "vitest", "path": "evals/vitest" }
      ],
      "lib": "evals/lib",
      "sources": "evals/sources",
      "fakes": "fakes",
      "cases": "evals/cases"
    }
  }
}
```

`suites[].type` is `harbor` or `vitest`; several suites of one type may exist,
and no two share a path. Every path is Recipe-relative, uses `/`, and stays
inside the package. Unknown keys are errors. `fakes` defaults to `fakes` at the
Recipe root; a Recipe that keeps its fakes under `evals/fakes` names that path
(`"fakes": "evals/fakes"`). `cases` is newer than the other keys, and an older
`recipe-check` rejects it as unknown, so declare it only for a path other than
`evals/cases`.

### Cases

A case is one situation in the owner's words, in its case file
`evals/cases/<id>.md`. An implementation is how one runner executes a case: a
Vitest row or a Harbor task. Implementations point to their case, never the
other way round, so a case file never names a path.

A case file is YAML front matter, then a body. The front matter:

| Field | Meaning |
| --- | --- |
| `id` | The file name without `.md`. Unique across the Recipe and never reused. Any name safe as a file name. |
| `title` | One line in the owner's words. |
| `check` | `code` (a verifier), `person` (the owner or a reviewer) or `later` (left for a later improvement pass). Only `code` cases get an implementation. |
| `inputs` | A list of `{ name, sha256, location }`: each input by its hash and where it came from. The case file never holds an input; the implementation carries the copy it runs on, such as a Harbor task's `environment/`. |
| `sources` | What the agent must reach for this case, such as `[documents]`. |
| `approved_by`, `approved_at`, `approved_in` | Who approved the case, when, and in which message. All empty means a draft. |
| `conversation` | Optional: `{ id, task_id, turn }` of the real conversation the case came from, `task_id` only when it ran as a platform task. Provenance only: a run never fetches it. |
| `issue` | Optional: the UUID of the issue recording the hypothesis the case tests. |

Unknown keys are allowed: the other fields and the body are for people. By
convention the body has the sections Situation, A good result and A bad
result, and optionally Verification. `evals/cases/inputs/` holds only
synthetic inputs; real inputs stay where `location` says.

```markdown
---
id: C3
title: Refund for a late delivery
check: code
sources: [orders]
approved_by: owner@example.com
approved_at: 2026-11-04
approved_in: msg_01
---

## Situation
...
```

A case has zero or one implementation per runner: zero for `check: person`,
`check: later` and drafts, and one Vitest and one Harbor implementation at
most for a `code` case. A case that must run against a deployed version or a
pushed commit needs a Harbor implementation. Case ids are unique across the
Recipe, not per suite.

- **Vitest.** Each `.eval.jsonl` row names its case with `"case": "<id>"`.
  Rows with a `case` are at `schema_version: 3`, and version 3 requires
  `case`. A row at `schema_version: 2` may carry `case` too, for helpers that
  only read version 2. A row built inline in an `.eval.ts` must still carry
  `case`; the runner checks it there.
- **Harbor.** A task names its case with `case = "<id>"` in the `[metadata]`
  table of its `task.toml`. Without it, the task's folder name is the case id,
  so a task folder named after its case needs no key. The same table declares
  the scoring contract version the verifier writes, `contract = <n>`; absent
  means 1.

### Scoring

Both runners produce the same two objects for a case, whatever language the
verifier is written in:

- **Scores** (`reward.json`): a flat object of finite numbers from 0 to 1,
  booleans rejected. `reward` is the case's score; every other key is one
  dimension. With no `reward`, tooling derives the plain mean of the
  dimensions. A plain `reward.txt` counts as `{"reward": n}`. Counts and other
  numbers that are not scores stay in the verifier's own artifacts.
- **Reasons** (`reward-details.json`, optional): one entry per key of the
  scores, each with `score` and a `criteria[]` of `name`, `value`, `reasoning`
  and, for a criterion that did not apply, `optional: true` with an `error`.
  It is read tolerantly; without it a case just has no reasoning.

A Harbor verifier writes both files to `/logs/verifier/`; a Vitest test hands
the same objects over in its test metadata. A malformed score object makes the
case incomplete, never a score of 0, and a criterion that did not apply has no
score. The contract has an integer version, starting at 1, that changes only
on a breaking change.

### Packaging and checks

Nothing eval-only reaches a running agent: every suite, `lib`, `sources`,
`fakes` and `cases` path MUST be excluded by `.recipeignore` (an `evals/` line
and a `fakes/` line do it), and in a Harbor trial only a task's `environment/`
reaches the agent. Hosts accept `pi.evals` without reading it; it is for
evaluation tooling and `recipe-check`.

`recipe-check` warns about eval paths missing from `.recipeignore` for every
Recipe. It checks the rest of the layout only for a Recipe that declares
`pi.evals`; an empty `{}` adopts those checks with the default paths. Those
checks are Harbor task folders without `task.toml`, eval files outside the
eval paths, and the links between cases and implementations, all as warnings:

| Code | Rule |
| --- | --- |
| `pi.evals_case_unknown` | A Vitest row or Harbor task names a case with no case file. |
| `pi.evals_case_duplicate` | A case has more than one implementation on one runner. |
| `pi.evals_case_unapproved` | A case with an implementation has an empty approval field. It stays a warning: a draft case is how one is proposed, and the owner approves it in review. |
| `pi.evals_case_row_missing_id` | A `.eval.jsonl` row has no `case`. |
| `pi.evals_case_invalid` | A case file has no readable front matter, an `id` other than its file name, or an `issue` that is not a UUID. |

## Conformance

There are two conformance layers:

1. A Recipe checker validates authored Recipe source without executing it.
2. `@introspection-ai/recipes/test-utils` verifies that a host constructs and
   disposes Recipe sessions with the required semantics.

Pi also runs the same validator automatically whenever it launches with
`--recipe`. Other hosts SHOULD run both layers in CI.

## Evolution

The format follows additive evolution while version 1 is active:

- new optional fields MAY be added;
- existing field meaning MUST NOT change incompatibly;
- required fields MUST NOT be added without a new major format version;
- hosts MUST ignore only extension points explicitly documented as open.

The implementation package follows SemVer independently. Package version and
format version are not the same thing.
