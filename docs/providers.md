# Provider modules

**Status: proposed.** One way for every provider-neutral tool family (search,
productivity, issues) to take its providers: first-party ones by id, and a
Recipe's own by package or by path. Adds the `issues` family, served by Linear's
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
      { "provider": "jira" }
    ],
    "search": [
      { "provider": "brave" },
      { "provider": "acme", "module": "./providers/acme-search.ts" }
    ],
    "productivity": [
      { "provider": "google" },
      { "provider": "acme-mail", "package": "@acme/recipe-productivity-mail" }
    ]
  }
}
```

A declaration names one provider id and at most one source:

| Source | Resolves to |
| --- | --- |
| none | the first-party package: `@introspection-ai/recipe-<family>-<id>`, or the family's bundle (`@introspection-ai/recipe-search`, `@introspection-ai/recipe-issues`) |
| `package` | that package, which the Recipe lists in `dependencies` |
| `module` | a file in the Recipe, relative to its root, like a document profile |

Ids are open: any slug, unique within the family. A first-party id with a
`package` or `module` replaces the first-party provider. Family-specific options
stay beside the provider (productivity's `tools` allowlist, for example).

`pi.search` is new. Without it, a Recipe keeps today's behaviour: the providers
the runtime binds, from `@introspection-ai/recipe-search`.

## 3. Loading and checking

One loader serves every family, `loadProviderModules(family, declarations, {
recipeDir })`, replacing `loadSearchProviders` and the productivity loader. For
each declaration it imports the module and refuses one whose `kind` is not the
family, whose `apiVersion` differs from the host's, or whose `id` differs from
the declaration's. There is no fixed list of ids.

`introspection check` loads every declared provider and reports one that does
not load, a duplicate id, a `module` path outside the Recipe, a `package` not in
`dependencies`, and an MCP-backed provider (5) whose server the Recipe does not
bind.

## 4. Credentials

A provider module never holds a credential. It sends a placeholder, and the
egress attaches the real one for the hosts it calls. Each module declares those
hosts in `capabilities.hosts`, so a provider the platform does not know is still
explicit about where it sends a member's data:

| Provider | Credential |
| --- | --- |
| First-party SaaS (Google, Microsoft, Linear, Atlassian) | the platform's integrations and members' own connections |
| A Recipe's own (`package` or `module`) | a project endpoint or connector for its declared hosts |
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
path: a bound MCP server, a connection, or an endpoint. A call names one when
several are on offer, and the tool's schema lists only those.

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

- **Comments:** Linear and Jira have them. Introspection's issues keep their
  history as `introspection.issue` events, and comments belong there too,
  behind the issues API: a `PATCH /v1/issues/{id}` with a nested `comment`
  appends one, as a nested `request` appends a request, and the issue's
  history reads them back. Until `/v1/issues` has them, its provider does not
  offer `comment`. `open_requests` are questions put to a person, not comments.
- **Assignee:** Introspection's issues have an owner (`member_id`), not an
  assignee, so `update` takes no assignee there.
- **Moving an issue:** `transition` takes a status name or category. Linear
  sets the state, Jira applies the workflow transition that reaches it, and
  Introspection sets `status`.
- **Where to create:** Linear needs a team and Jira a project and issue type,
  from the declaration (`{ "provider": "jira", "project": "OPS", "issueType":
  "Task" }`) or the call. Introspection creates in the Recipe's project, on the
  calling task.

The `introspection` provider calls `/v1/issues` through the JavaScript SDK
(`@introspection-sdk/introspection-node`) on the task's own session, not
through the CLI: it runs in the agent's process, with typed responses and no
CLI to install.

All three ship in one package, `@introspection-ai/recipe-issues`, a companion of
Recipes like `@introspection-ai/recipe-search`. Nothing about issues loads, and
no `issues` tool is offered, unless a Recipe declares `pi.issues`; most Recipes
don't, and the Operator does.

| Provider | Transport | Server |
| --- | --- | --- |
| `linear` | MCP adapter | Linear's remote MCP server (`mcp.linear.app`) |
| `jira` | MCP adapter | Atlassian's Rovo MCP server (`mcp.atlassian.com`), its Jira tools |
| `introspection` | REST | the data plane's `/v1/issues` |

Linear and Atlassian are OAuth MCP servers, connected per member through an MCP
connector binding; an agent asks a member to connect with `introspection_open`.
Each adapter maps commands to the server's tools as its live tool list names
them (`introspection bindings mcp capture`), not as its documentation does, and
the adapter's tests run against a captured tool list.

## 8. What changes per family

| Family | Change |
| --- | --- |
| `search` | the fixed `SEARCH_PROVIDER_IDS` filter goes; `pi.search` is added; `recipe-search` serves the first-party providers through the shared loader |
| `productivity` | gains `package` and `module` sources; loads through the shared loader |
| `issues` | new: the contract and the tool in Recipes, and `@introspection-ai/recipe-issues` with `linear`, `jira` and `introspection` |

The contract version of each family stays separate, so a breaking change to one
family's contract does not bump another's.

## 9. Open questions

1. Whether a `module` provider is TypeScript compiled by the host, or must be
   JavaScript in the Recipe.
2. Whether one Recipe may declare the same first-party id twice under different
   sources (for example two Jira sites); assumed no.
