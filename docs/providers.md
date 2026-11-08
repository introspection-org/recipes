# Provider modules

**Status: proposed.** One way for every provider-neutral tool family (search,
productivity, issues) to take its providers: first-party ones by id, and a
Recipe's own by package. Adds the `issues` family, served by Linear's
and Atlassian's MCP servers, or by Introspection's own issues when neither is
connected.

## 1. Families and providers

A **family** is a set of provider-neutral tools that Recipes owns, with one
versioned contract for the providers behind them:

| Family | Tools | First-party providers |
| --- | --- | --- |
| `search` | `web_search` | tavily, exa, brave, keenable, parallel, perplexity |
| `productivity` | `mail`, `calendar`, `drive` | google, microsoft |
| `issues` | `issues` | linear, jira, introspection |

A **provider module** implements one family's contract: `{ kind, apiVersion,
id, capabilities, … }` plus the family's calls (`search` for search,
`createSession` for productivity and issues). It imports only types from
`@introspection-ai/recipes`; the host holds credentials, transports, spans and
usage. Documents are not a family here: a format is a package and a profile is
guidance, not a provider.

## 2. Declaring providers

Every family is declared the same way, in `package.json#pi`:

```json
{
  "pi": {
    "issues": [
      { "provider": "linear" },
      { "provider": "acme-tracker", "package": "@acme/recipe-issues-tracker", "options": { "queue": "support" } }
    ],
    "search": [
      { "provider": "brave" },
      { "provider": "acme", "package": "@acme/recipe-search" }
    ],
    "productivity": [
      { "provider": "acme-mail", "package": "@acme/recipe-productivity-mail" }
    ]
  }
}
```

A declaration names one provider id and at most one source. A provider is
always a compiled package resolved from `node_modules`, like any other
dependency; nothing is loaded from a file in the Recipe at run time.

| Source | Resolves to |
| --- | --- |
| none | the first-party package: `@introspection-ai/recipe-<family>-<id>`, or the family's bundle (`@introspection-ai/recipe-search`, `@introspection-ai/recipe-issues`) |
| `package` | an installed package by name, such as `@acme/recipe-search`, which the Recipe lists in `dependencies` with a version, never only as a peer |

A provider kept with the Recipe's own code is a local package inside the
Recipe that it depends on (`"@acme/recipe-search": "file:./providers/search"`,
or a workspace package), built like any other. Loading or checking fails when the package does not
resolve from the Recipe's `node_modules`; there is no fallback to a path.

Ids are open: any slug, unique within the family, because a handle such as
`jira:PROJ-45` must route to exactly one provider. A first-party id with a
`package` replaces the first-party provider. Productivity takes one provider
per Recipe; search and issues take several.

The top level of a declaration holds only what the platform reads: `provider`,
`package`, a fallback's `enabled` (6) and productivity's `tools` allowlist,
which the host enforces before any call; any other field is an error. Anything
the provider itself reads goes in `options`, passed to the provider unchanged
when it creates a session. Each provider declares the options it takes, by
name and type, in `capabilities.options`, and a declaration may set only
those: `introspection check` holds the first-party providers' schemas, and
loading a Recipe's own provider fails on an option it does not declare.

`pi.search` is new. Without it, a Recipe keeps today's behaviour: the providers
the runtime binds, from `@introspection-ai/recipe-search`.

## 3. Loading and checking

One loader serves every family, `loadProviderModules(family, declarations, {
recipeDir })`, replacing `loadSearchProviders` and the productivity loader. For
each declaration it imports the module and refuses one whose `kind` is not the
family, whose `apiVersion` differs from the host's, or whose `id` differs from
the declaration's. There is no fixed list of ids.

`introspection check` loads every declared provider and reports one that does
not load, a duplicate id, a `package` not in `dependencies`, and an MCP-backed provider (5) whose server the Recipe does not
bind.

## 4. Credentials

A provider module never holds a credential. It sends a placeholder, and the
egress attaches the real one for the hosts it calls. Each module declares those
hosts in `capabilities.hosts`, so a provider the platform does not know is still
explicit about where it sends a member's data:

| Provider | Credential |
| --- | --- |
| First-party SaaS (Google, Microsoft, Linear, Atlassian) | the platform's integrations and members' own connections |
| A Recipe's own (`package`) | a project endpoint or connector for its declared hosts |
| `introspection` | the task's own session against the Introspection API; no third-party key |

## 5. Transports: REST and MCP

A provider calls its service over REST, through an MCP server, or both. An
MCP-backed provider carries an **adapter**: it names the server it adapts (by
URL) and maps each of the family's commands to one call to that server's tools,
then parses the result into the family's shape. `web_search` already works this
way for providers with a hosted MCP server (`SearchMcpAdapter`); the adapter
becomes part of every family's contract. When the server is bound to the
runtime, the call goes through it; otherwise through REST if the provider has
it, else the provider is not offered.

## 6. Choosing a provider at run time

The providers a call may name are the declared ones with a working credential
path: a bound MCP server, a connection, or an endpoint. MCP servers connect
after the tool is registered, so availability is checked on each call: the
tool's schema lists every declared provider, and a call to one that is not
connected fails with `not_connected`, naming `introspection_open` as the way to
connect it. A call names a provider when several are on offer; a command on an
existing issue goes to the provider its handle names.

A family may have a **fallback**: a provider offered only when no other
provider of the family is. For issues it is `introspection`, included whenever
a Recipe declares `pi.issues` without being listed, so a Recipe always has
somewhere to track work, and the same commands reach Linear or Jira once
someone connects one. A Recipe excludes it with `{ "provider":
"introspection", "enabled": false }`.

## 7. The `issues` family

One `issues` tool with these commands:

| Command | Does |
| --- | --- |
| `search` | find issues by text, status, assignee, project or label |
| `get` | one issue with its comments |
| `create` | a new issue |
| `update` | title, description, assignee, labels, priority |
| `comment` | add a comment |
| `transition` | move to another status |

An Introspection issue is like a task: a row the issues API changes (title,
status, priority, tags), with immutable values attached to it, its conversation
(the issue's worker task chat) and its events (history, requests, comments).
The issues API writes the events for every change through one command writer;
a comment is one more, never a change to the row, and not a message in the
issue's chat, which its worker agent would answer.

Every issue is returned in one shape, with a provider-scoped handle that every
later command takes:

| Field | Linear | Jira | Introspection (`/v1/issues`) |
| --- | --- | --- | --- |
| `handle` | `linear:ENG-123` (identifier) | `jira:PROJ-45` (key) | `introspection:<display index>` |
| `title` | title | summary | title |
| `description` (markdown) | description | description, from Atlassian Document Format | description |
| `status.name` | workflow state | status | status |
| `status.category` (`open`, `in_progress`, `done`, `cancelled`) | state type: backlog and unstarted → open, started → in_progress, completed → done, canceled → cancelled | status category: To Do → open, In Progress → in_progress, Done → done | open → open, waiting → in_progress, closed → done, cancelled → cancelled |
| `priority` (`none`, `low`, `medium`, `high`, `urgent`) | 0–4 | Highest → urgent … Lowest → low | the same scale, without `none` |
| `assignee` | assignee | assignee | none |
| `labels` | labels | labels | tags |
| `container` | team | project and issue type | the Recipe's project |
| `url`, `created_at`, `updated_at` | ✓ | ✓ | ✓ |

The providers differ, so each declares the commands and fields it supports in
`capabilities`, as productivity providers do:

- **Comments:** Linear and Jira have them. An Introspection comment is an
  attached event, written like every other change to an issue: `PATCH
  /v1/issues/{id}` with a nested `comment`, which the issue command writer
  records as an `introspection.issue.comment` event (introspection-cloud#3863).
  The issues API stays CRUD on Postgres and never returns comments; the
  provider reads them straight from the event log
  (`GET /v1/events?event_name=introspection.issue&issue_id=…`, `payload.comment`)
  through the SDK's events client, with no helper of its own. Until the
  platform accepts `comment`, the provider does not offer it. `open_requests`
  are questions put to a person, not comments.
- **Assignee:** Introspection's issues have an owner (`member_id`), not an
  assignee, so `update` takes no assignee there.
- **Moving an issue:** `transition` takes a status name or category. Linear
  sets the state, Jira applies the workflow transition that reaches it, and
  Introspection sets `status`.
- **Where to create:** Linear needs a team and Jira a project and issue type,
  from the declaration's options (`{ "provider": "jira", "options": {
  "project": "OPS", "issueType": "Task" } }`) or the call. Introspection creates in the Recipe's project, on the
  calling task.

Introspection issues have no `url` yet, and `/v1/issues` has no text filter, so
the `introspection` provider's `search` matches text against the most recent
issues it lists. The `introspection` provider uses the JavaScript SDK
(`@introspection-sdk/introspection-node`) on the task's own session, not the
CLI: its issues client for the row and its events client for comments and
history. It runs in the agent's process, with typed responses and no CLI to
install.

All three ship in one package, `@introspection-ai/recipe-issues`, a companion of
Recipes like `@introspection-ai/recipe-search`. Nothing about issues loads, and
no `issues` tool is offered, unless a Recipe declares `pi.issues`; most Recipes
don't, and the Operator does.

| Provider | Transport | Server |
| --- | --- | --- |
| `linear` | MCP adapter | Linear's remote MCP server (`mcp.linear.app`) |
| `jira` | MCP adapter | Atlassian's Rovo MCP server (`mcp.atlassian.com`), its Jira tools |
| `introspection` | REST | the data plane's `/v1/issues` |

Linear and Atlassian are OAuth MCP servers. A declaration names the Recipe's
MCP server for its provider with the `server` option (default `linear`,
`atlassian`), since
a Recipe names its servers freely. An agent asks a person to connect with
`introspection_open`.
Each adapter maps commands to the server's tools as its live tool list names
them (`introspection bindings mcp capture`), not as its documentation does, and
the adapter's tests run against a captured tool list.

## 8. What changes per family

| Family | Change |
| --- | --- |
| `search` | the fixed `SEARCH_PROVIDER_IDS` filter goes; `pi.search` is added; `recipe-search` serves the first-party providers through the shared loader |
| `productivity` | gains the `package` source; loads through the shared loader |
| `issues` | new: the contract and the tool in Recipes, and `@introspection-ai/recipe-issues` with `linear`, `jira` and `introspection` |

The contract version of each family stays separate, so a breaking change to one
family's contract does not bump another's.

## 9. Decisions

- **Providers are compiled packages.** There is no source for a file in the
  Recipe: everything a Recipe uses is built and resolved from `node_modules`,
  and nothing is loaded dynamically.
- **One declaration per id.** A Recipe does not declare the same id twice.
  Several Jira sites do not need it: Atlassian's server reaches every site the
  person's account can, and the adapter chooses one per call (`container`, or a
  `site` option). If two separate servers or accounts are ever needed, an `id`
  alias on the declaration (`{ "provider": "jira", "id": "jira-eu", "options":
  { "server": "atlassian-eu" } }`, handles `jira-eu:PROJ-1`) adds it
  without changing anything here.

## 10. Wiring a provider

What wiring Linear and Jira taught, in the order to do it. Each step names the
code that does it.

1. **Capture the server's tool list before writing the adapter**
   (`introspection bindings mcp capture <id>`) and commit the tools it calls as
   its fixture ([`linear-tools.json`](../test/fixtures/issues/linear-tools.json)).
   A map written from the vendor's docs named a comment tool Linear does not have.
2. **Map each command to the captured names and arguments**, and mark the map
   `verified` only against a capture
   ([`LINEAR_MCP_TOOLS`](../packages/issues/src/linear.ts)). Translate the
   family's words into the vendor's before the call: a status category becomes
   the state types it spans, not a filter applied afterwards.
3. **Page by the rules below**, with the package's own helper
   ([`common.ts`](../packages/issues/src/common.ts)).
4. **Declare every host and option in `capabilities`** (sections 2 and 4).
5. **Test against a fake built from the capture** that refuses an argument the
   schema lacks or a value of the wrong type, including one that pages
   (`fakeServer` and "pages and status categories" in
   [`issues-providers.test.ts`](../test/issues-providers.test.ts)).
6. **Record once against real, dummy data** with Polly
   ([`linear.recording.test.ts`](../packages/issues/test/linear.recording.test.ts),
   [`polly.ts`](../test/helpers/polly.ts)). Scope every request to the dummy
   items (a label, a separate calendar, a named folder), let the helper
   anonymize, read the cassette before committing it, and replay it in CI.

### Paging

A result that silently stops at the first page is the bug reviews kept finding.

- **A read the model treats as complete follows every page:** an issue's
  comments, a thread's messages. Bound it with a page cap; never return the
  first page alone.
- **A search or list returns up to `limit`** and, when more were available,
  the vendor's cursor as the family's `cursor`, so the model can ask again.
- **The server's metadata ends a list:** `isLast`, a reported `total`,
  `hasNextPage`. A page shorter than asked ends it only when the server
  reports none of these, since servers cap a page below what was asked.
- **An offset advances by the rows the server returned,** not by how many
  survived conversion or filtering.
- **Filtering after the fetch keeps paging** until `limit` matches or the
  pages run out, then cuts to `limit`.
- **Guard every loop:** stop on an empty page, on a cursor or token equal to
  the last one, and at the page cap.
- **Each package pages its vendor's way once** (`packages/issues/src/common.ts`,
  Google's `collectPages`, Microsoft's `@odata.nextLink`): use that package's
  helper rather than a new loop, and test each rule above against a fake that
  pages.
