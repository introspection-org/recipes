# Productivity tools

**Status: proposed.** Nothing on this page is built yet. It records the design
for review, and each section names the contract a first build would ship.

A Recipe that works with a person's mail, calendar and files declares a
**productivity provider**. The host then registers up to three tools, `mail`,
`calendar` and `drive`, each with a `command` discriminator, shaped
identically for every provider. A provider package supplies the transport and
a capability descriptor; the commands, their schemas and the handle rules
live in the host, as they do for [channels](channels.md) and
[documents](documents.md).

The same properties follow:

- **A command a provider cannot support is absent, not failing.** Each
  provider declares what it supports per tool, and registration filters on
  it. A provider with no free/busy API has no `calendar free_busy`.
- **The vocabulary is neutral.** A Recipe written against `mail search` runs
  against Microsoft 365 or Google Workspace by changing the `provider`, not
  the prompt. There is no raw provider payload in a command's arguments or
  results.
- **The model can act only on what a tool returned.** Messages, events and
  files are addressed by opaque handles the host mints for the session, never
  by a provider ID the model could have read or invented.

## Declare a productivity provider

```json
{
  "pi": {
    "productivity": [
      {
        "provider": "microsoft",
        "tools": {
          "mail": ["search", "read", "draft"],
          "calendar": ["list", "create", "respond"],
          "drive": ["search", "read"]
        }
      }
    ]
  }
}
```

```yaml
tools: [mail, calendar, drive]
```

- `provider` is served by the package
  `@introspection-ai/recipe-productivity-<provider>`. The first two are
  `microsoft` (Outlook mail, Outlook calendar, OneDrive and SharePoint) and
  `google` (Gmail, Google Calendar, Google Drive).
- `tools` is an optional allowlist per tool, like the channels `commands`
  list. Omitting a tool exposes all of its supported commands; an empty list
  exposes none of that tool. Unknown or unsupported commands fail at
  registration, and commands outside the allowlist are rejected before any
  provider call.
- One declaration per Recipe. Two providers in one Recipe would give the
  model two mailboxes behind one tool name, so it is refused at registration
  rather than resolved by an argument.
- The packages follow the companion rule in `AGENTS.md`: a peer by default
  (the platform provides it), a dependency with an exact version only to pin
  it, and listed in Recipes' `optionalDependencies` so the copy beside
  Recipes is used when the Recipe lists neither. They join
  `src/recipe/companions.ts` and its tests.

The host fails when an agent selects a tool that the declaration does not
enable.

## Commands

### `mail`

| Command | Arguments | Returns | Effect |
| --- | --- | --- | --- |
| `mail search` | `query`, `folder?`, `from?`, `after?`, `before?`, `unread?`, `limit?`, `cursor?` | message summaries with `msg_…` handles | read |
| `mail read` | `message` or `thread` | headers, plain-text body, attachment list with `att_…` handles | read |
| `mail fetch_attachment` | `attachment` | a file under the session's downloads | read |
| `mail draft` | `to`, `cc?`, `subject`, `body` (Markdown), `reply_to?` (a `msg_…` handle) | a draft handle | reversible |
| `mail update_draft` | `draft`, any of the draft fields | the draft | reversible |
| `mail send` | `draft` | the sent message handle | **irreversible** |
| `mail move` | `message`, `folder` | the message | reversible |
| `mail label` | `message`, `add?`, `remove?` | the message | reversible |

`mail send` sends only a draft the session created. There is no
`send`-with-a-body command, so every sent message existed first as a draft a
person or a policy could review. Recipes that need a person's approval before
sending gate `mail send` (see [Policy](#policy-and-approvals)).

### `calendar`

| Command | Arguments | Returns | Effect |
| --- | --- | --- | --- |
| `calendar list` | `from`, `to`, `calendar?`, `limit?`, `cursor?` | events with `evt_…` handles | read |
| `calendar read` | `event` | the event, attendees and their responses | read |
| `calendar free_busy` | `attendees`, `from`, `to` | busy intervals per attendee | read |
| `calendar create` | `title`, `start`, `end`, `time_zone`, `attendees?`, `location?`, `body?`, `online_meeting?` | the event | **sends invitations** when it has attendees |
| `calendar update` | `event`, any of the create fields | the event | sends updates when it has attendees |
| `calendar respond` | `event`, `response` (`accept`, `tentative`, `decline`), `comment?` | the event | sends the response |
| `calendar cancel` | `event`, `comment?` | none | **irreversible**, notifies attendees |

Times are RFC 3339 with an explicit `time_zone` (IANA name). The host never
guesses a zone from the model's text.

### `drive`

| Command | Arguments | Returns | Effect |
| --- | --- | --- | --- |
| `drive search` | `query`, `folder?`, `modified_after?`, `limit?`, `cursor?` | file summaries with `file_…` handles | read |
| `drive read` | `file` | metadata and text content, exported from native formats, size-limited | read |
| `drive download` | `file` | the file under the session's downloads, for the [documents](documents.md) tool | read |
| `drive upload` | `path` (under `outputs/`), `folder?`, `name?` | the new file's handle | creates a file |

Editing inside a file is the [documents](documents.md) tool's job:
`drive download` exports Google Docs, Sheets and Slides (and fetches Word,
Excel and PowerPoint files) into the session for it, and `drive upload` puts
the result back. Sharing and permission changes are deferred (see
[Deferred](#deferred)).

## Handles and the access boundary

Handles work as they do for channels: `msg_…`, `thr_…`, `att_…`, `evt_…` and
`file_…` are minted by the host for the current session, resolve only within
it, and come back only from a command that returned the item. A command never
accepts a provider ID, so the model cannot act on a message it never saw.

Each provider session belongs to **one person's connection**: the member the
task runs for. No argument selects another mailbox, calendar or drive.
Shared mailboxes, delegated calendars and other people's drives are deferred
until a host can say which a person may reach.

Like channels, this is a **tool-layer policy, not a sandbox-wide security
boundary**. The boundaries that hold against code in the sandbox are the
host's: which hosts the session may reach, which credential is attached, and
the policy evaluated on each request (see [Authentication](#authentication)).

## Content is data

Message bodies, event descriptions, file contents and every name and subject
come from people outside the Recipe. Results carry them as data in typed
fields, never as instructions. Mail bodies are converted from HTML to plain
text, stripped of tracking pixels and remote content, and cut to a size limit
that the result states. Text in a message that asks the agent to act is
content to report, not a request. Recipes keep their own guardrails for
this, as the outbound review in `recipe-crm-agent` does.

## Authentication

A provider package holds **no credential**. It calls the provider's API
(`graph.microsoft.com`, `gmail.googleapis.com`, a Google Workspace MCP server)
with a placeholder bearer, exactly as the Slack package does
(`packages/channels/slack/src/client.ts`), and the host replaces it on the
way out:

- **On Introspection**, the egress admits the request only for a host the
  session's connector declares, evaluates the session's policy, and then
  attaches the **task member's own** token from their connection. The
  sandbox never sees it. A person who has not connected gets a
  `not_connected` result naming the connect step, and the host can open the
  connection flow and continue the run.
- **Other hosts** supply the same seam: a request hook that attaches the
  credential for the session's person. A host that cannot keep the
  credential out of the agent's process must not offer these tools.

Connecting a person is a host concern. On Introspection, one connector per
provider holds the OAuth client and scopes (per-product, never the broad
directory scopes), and each person connects once.

## Backends per command

A provider package chooses, per command, which backend serves it, and its
capability descriptor records the choice so a review can see it:

| Provider | Default backend | Fallback |
| --- | --- | --- |
| `google` | Google's Workspace MCP servers (Gmail, Calendar, Drive), through `packages/mcp-client` | Google's REST APIs for a command the MCP servers do not cover |
| `microsoft` | Microsoft Graph REST v1.0, through a small client shaped like Slack's | None. Work IQ MCP stays available to a Recipe as an ordinary MCP binding |

Both backends of one provider use the same connection, so a command can move
from REST to MCP when the provider's server gains it, without a Recipe
noticing. Contract tests pin each backend's request and response shapes,
because Google's MCP servers are a developer preview and Graph changes by
version.

Each provider's guide gives its command-to-API mapping, scopes, setup and
errors: [Google](productivity-google.md) and
[Microsoft](productivity-microsoft.md).

## Policy and approvals

Every command has a fixed effect class (read, reversible, irreversible,
sends to others), shown in the tables above and carried in the capability
descriptor. A host can gate on it:

- **On Introspection**, a Recipe's `policies/routes.yaml` can name these
  commands, so a Cedar rule or an approved mission decides `mail send` or
  `calendar cancel` the same way for both providers. The rule names `mail
  send`, never a vendor's tool name.
- A host without a policy engine can require an interaction
  ([interactions](interactions.md)) before an irreversible command.

## Test productivity Recipes

- **Unit:** each provider package tests its transport against a fake HTTP
  server (and a fake MCP server for Google's), covering paging,
  `Retry-After`, error mapping and the placeholder credential.
- **Recipe:** MCP fakes and recorded HTTP fixtures (as `recipe-crm-agent`
  does for its servers) let evals run a Recipe against a known mailbox and
  calendar without a real account.
- **Live:** `introspection dev` with a connected test account: a Microsoft
  365 developer tenant with its sample data, and a Google Workspace test
  domain in the MCP developer preview.

## Write a provider

A provider package exports a plain descriptor, `RecipeProductivityModule`,
and the host builds the tools from it, as for channels:

- `apiVersion` (`PRODUCTIVITY_MODULE_API_VERSION`), checked when the module
  loads;
- `capabilities`: per tool, the commands it supports, each with its effect
  class and backend;
- `createSession({ config, env, cwd })`: returns the transport for one
  person's connection, which receives handle resolution from the host and
  never mints handles itself.

It imports only Recipes' types (`import type`, Recipes in
`devDependencies`), and needs no run-time dependency on Recipes.

## Deferred

- **Triggers** (new mail, new event, a file changed). They need provider
  change notifications or polling into the host, which is host work, not a
  tool.
- **Shared and delegated access**: shared mailboxes, delegated calendars,
  shared drives.
- **Sharing and permissions** on files.
- **Contacts and directory lookup.**
- **Tenant-wide access** (Google domain-wide delegation, Microsoft
  application permissions). These need a host decision about whose data a
  task may reach, and a security review, before any tool offers them.
- **Teams and Google Chat.** Chat belongs to [channels](channels.md).

## Migrating from Pipedream tools

Recipes that call Pipedream's per-app tools (`gmail-find-email`,
`microsoft_outlook-find-email`, `google_calendar-create-event`, …) move to the
neutral commands. Most map one to one (`*-find-email` to `mail search`,
`*-create-draft*` to `mail draft`, `*-send-email` to a draft plus `mail
send`); Pipedream's triggers have no equivalent until triggers are designed.
Recipes that wrap those tools in their own adapters, as Ark's `mail.js`,
`calendar.js` and `drive.js` do, replace each adapter call with one command.
