# Issues tool

**Status: built** (`@introspection-ai/recipes/issues` and
`@introspection-ai/recipe-issues`). The Linear and Jira adapters are written
against tool names and arguments from vendor documentation, not yet against a
captured tool list; see [Tool maps](#tool-maps).

One `issues` tool tracks work in whichever tracker a Recipe's members use:
Linear, Jira, or Introspection's own issues when neither is connected. It is
the `issues` family of [provider modules](../providers.md).

## Declare it

```json
{
  "pi": {
    "issues": [
      { "provider": "linear", "options": { "team": "ENG" } },
      {
        "provider": "jira",
        "options": { "project": "OPS", "issueType": "Task" }
      }
    ]
  }
}
```

and select the tool in the agent file:

```yaml
tools: [issues]
mcp:
  servers:
    linear:
      include: ["*"]
      behind: [issues]
    atlassian:
      include: ["*"]
      behind: [issues]
```

Nothing about issues loads, and no `issues` tool is offered, unless a Recipe
declares `pi.issues` and its agent selects `issues`.

A declaration takes only these fields:

| Field      | Applies to      | Meaning                                                                                   |
| ---------- | --------------- | ----------------------------------------------------------------------------------------- |
| `provider` | all             | `linear`, `jira`, `introspection`, or a Recipe's own id                                   |
| `package`  | a Recipe's own  | the installed package that serves it ([providers](../providers.md#2-declaring-providers)) |
| `options`  | all             | the provider's own settings, below                                                        |
| `enabled`  | `introspection` | `false` leaves out the fallback                                                           |

| Option                 | Provider         | Meaning                                                            |
| ---------------------- | ---------------- | ------------------------------------------------------------------ |
| `team`                 | `linear`         | the team `create` files into                                       |
| `project`, `issueType` | `jira`           | the project and issue type `create` files into                     |
| `server`               | `linear`, `jira` | the Recipe's MCP server id, when it is not `linear` or `atlassian` |

Validation (`pi.issues_invalid`) reports any other field, an option a
first-party provider does not take or of the wrong type, an unknown
first-party id, a duplicate, and a bad source. A Recipe's own provider
declares its options in `capabilities.options` (`{ queue: "string" }`), and
loading it fails on an option it does not declare.

## Providers

| Provider        | Transport | Server                                             | Credential                         |
| --------------- | --------- | -------------------------------------------------- | ---------------------------------- |
| `linear`        | MCP       | `https://mcp.linear.app/mcp`                       | the member's MCP connector binding |
| `jira`          | MCP       | `https://mcp.atlassian.com/v2/mcp`, its Jira tools | the member's MCP connector binding |
| `introspection` | REST      | the data plane's `/v1/issues`                      | the task's own session             |

**`introspection` is the fallback.** It is included whenever `pi.issues` is
declared, unless declared with `"enabled": false`, and is offered only while
no other declared provider has a working credential path. Once a member
connects Linear or Jira, `search` and `create` go there; an issue already
filed on Introspection stays readable by its handle.

**Choosing a provider.** A provider is on offer when it has a working
credential path: an MCP provider when its bound server offers one of its
adapter's tools, `introspection` when the runtime holds a data plane URL and
the task's token. `search` and `create` name a provider when several are on
offer; every other command takes a handle, which names its provider. The
tool's `provider` parameter lists the declared providers, since an MCP
server's tools are known only once it has connected; a call naming one that
is not on offer fails with `not_connected`.

**Connecting Linear or Jira.** Both are OAuth MCP servers, connected per
member through an MCP connector binding. When none is connected the tool
answers `not_connected`, and the agent asks the member to connect one with
`introspection_open`.

**Introspection's session.** The provider uses the JavaScript SDK
(`@introspection-sdk/introspection-node`): a `DataPlaneClient` on
`INTROSPECTION_DP_URL` (else `INTROSPECTION_BASE_API_URL`) with
`INTROSPECTION_TOKEN`, all of which the runtime injects into the task's
sandbox. `create` files the issue on the calling task
(`INTROSPECTION_TASK_ID`), in the Recipe's project.

## Commands

| Command      | Takes                                                                               | Does                        |
| ------------ | ----------------------------------------------------------------------------------- | --------------------------- |
| `search`     | `query`, `status`, `assignee`, `container`, `label`, `limit`                        | find issues                 |
| `get`        | `handle`                                                                            | one issue with its comments |
| `create`     | `title`, `description`, `priority`, `labels`, `assignee`, `container`, `issue_type` | a new issue                 |
| `update`     | `handle`, `title`, `description`, `priority`, `labels`, `assignee`                  | change fields               |
| `comment`    | `handle`, `body`                                                                    | add a comment               |
| `transition` | `handle`, `status` (a name or a category)                                           | move to another status      |

## The shape

Every issue comes back in one shape, with a handle every later command takes:

| Field                    | Linear                                                                                           | Jira                                                                                                                       | Introspection                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `handle`                 | `linear:ENG-123`                                                                                 | `jira:PROJ-45`                                                                                                             | `introspection:<display index>`                                          |
| `title`                  | title                                                                                            | summary                                                                                                                    | title                                                                    |
| `description` (markdown) | description                                                                                      | description, from Atlassian Document Format (best-effort)                                                                  | description                                                              |
| `status.name`            | workflow state                                                                                   | status                                                                                                                     | status                                                                   |
| `status.category`        | backlog, unstarted, triage → open; started → in_progress; completed → done; canceled → cancelled | To Do → open, In Progress → in_progress, Done → done; a done status named like cancelled, won't do or rejected → cancelled | open → open, waiting → in_progress, closed → done, cancelled → cancelled |
| `priority`               | 0 none, 1 urgent, 2 high, 3 medium, 4 low                                                        | Highest → urgent, High → high, Medium → medium, Low and Lowest → low                                                       | low to urgent, no `none`                                                 |
| `assignee`               | assignee                                                                                         | assignee                                                                                                                   | none                                                                     |
| `labels`                 | labels                                                                                           | labels                                                                                                                     | tags                                                                     |
| `container`              | team                                                                                             | project, with the issue type                                                                                               | the project                                                              |
| `url`                    | ✓                                                                                                | the site's `/browse/<key>`                                                                                                 | not yet                                                                  |
| `comments` (on `get`)    | ✓                                                                                                | ✓                                                                                                                          | from the issue's events                                                  |

## What each provider supports

|              | `linear`                                                       | `jira`                                                  | `introspection`                                                |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| `search`     | ✓                                                              | ✓ (JQL)                                                 | ✓; text matches the 200 most recent issues; no assignee filter |
| `get`        | ✓                                                              | ✓                                                       | ✓                                                              |
| `create`     | ✓, needs a team                                                | ✓, needs a project and issue type                       | ✓, on the calling task                                         |
| `update`     | ✓                                                              | ✓                                                       | ✓, no assignee                                                 |
| `comment`    | ✓                                                              | ✓                                                       | not yet                                                        |
| `transition` | sets the state; a category picks the team's state of that type | applies the workflow transition that reaches the status | sets `status`                                                  |

An Introspection comment is an event attached to the issue. The provider reads
comments from `GET /v1/events?event_name=introspection.issue&issue_id=…`
(`payload.comment`), and reads none from a data plane that does not record
that family yet. It does not offer `comment` until the platform accepts one
on `PATCH /v1/issues/{id}`.

## Tool maps

Each MCP adapter calls its server through one tool map
(`LINEAR_MCP_TOOLS`, `JIRA_MCP_TOOLS`), every entry with `verified: false`
until it is checked against the server's live tool list
(`introspection bindings mcp capture`). The adapters' tests run against
captured-tool-list fixtures in `test/fixtures/issues/`, authored from vendor
documentation; replace them with captured lists, fix the maps, and set
`verified: true`.

| Provider | Use                        | Tool                                                                                  | Arguments sent                                                                                                 |
| -------- | -------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `linear` | search                     | `list_issues`                                                                         | `query`, `state`, `assignee`, `team`, `label`, `limit`                                                         |
| `linear` | get                        | `get_issue`, `list_comments`                                                          | `id`; `issueId`                                                                                                |
| `linear` | create, update, transition | `save_issue` (else `create_issue`, `update_issue`)                                    | `id`, `team`, `title`, `description`, `priority` (0–4), `labels`, `assignee`, `state`                          |
| `linear` | comment                    | `create_comment`                                                                      | `issueId`, `body`                                                                                              |
| `linear` | transition by category     | `list_issue_statuses`                                                                 | `team`                                                                                                         |
| `jira`   | every call                 | `getAccessibleAtlassianResources`                                                     | none; the first site with Jira scopes gives `cloudId`                                                          |
| `jira`   | assignee by name           | `lookupJiraAccountId`                                                                 | `cloudId`, `searchString`                                                                                      |
| `jira`   | search                     | `searchJiraIssuesUsingJql`                                                            | `cloudId`, `jql`, `maxResults`, `fields`                                                                       |
| `jira`   | get                        | `getJiraIssue`, `listJiraIssueComments`                                               | `cloudId`, `issueIdOrKey`, `fields`                                                                            |
| `jira`   | create                     | `createJiraIssue`                                                                     | `cloudId`, `projectKey`, `issueTypeName`, `summary`, `description`, `assignee_account_id`, `additional_fields` |
| `jira`   | update                     | `editJiraIssue`                                                                       | `cloudId`, `issueIdOrKey`, `fields`                                                                            |
| `jira`   | comment                    | `addOrEditJiraIssueComment` (else `addCommentToJiraIssue`)                            | `cloudId`, `issueIdOrKey`, `commentBody`                                                                       |
| `jira`   | transition                 | `listJiraIssueTransitions` (else `getTransitionsForJiraIssue`), `transitionJiraIssue` | `cloudId`, `issueIdOrKey`, `transition: { id }`                                                                |

## A provider of your own

A provider module is `{ kind: "issues", apiVersion: 1, id, capabilities,
mcp?, available?, createSession }` (`RecipeIssuesProviderModule`), importing
only types from `@introspection-ai/recipes/issues`. `capabilities` lists the
commands it serves, the fields it fills, every host it calls, and the options
it takes. Its session receives the declaration's options as `config.options`.
`createSession` returns one method per command; each receives the provider's
own reference (the handle without its prefix) and, for an MCP provider, a
caller bound to its server. A failure the model should read throws an
`Error` carrying `issues: { code, message }`.
