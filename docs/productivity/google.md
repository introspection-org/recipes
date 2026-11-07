# Google productivity provider

**Status: built** (`packages/productivity/google`), not yet published or
tested against a live Workspace domain. [As built](#as-built) lists where it
differs from the design below. Facts marked *to confirm* come from Google's
documentation as summarised in design review, and are checked against a live
Workspace domain before the package ships.

**The MCP backend depends on unmerged work.** It calls Google's MCP servers
through Pi's in-process MCP client, which Recipes runs under
`mcp.mode: codemode` ([#375](https://github.com/introspection-org/recipes/pull/375),
not yet merged) and which needs **Pi 1.3.0 or newer**. Until a Recipe runs
on both, every command is served over REST, which covers all of them.

The `google` provider serves the `mail`, `calendar` and `drive` tools from a
person's Gmail, Google Calendar and Google Drive. It is the package
`@introspection-ai/recipe-productivity-google`, a companion of Recipes like
the Slack channel package.

```json
{
  "peerDependencies": {
    "@introspection-ai/recipe-productivity-google": ">=X.Y.Z"
  },
  "pi": {
    "productivity": [{ "provider": "google" }]
  }
}
```

## Backends

Google publishes a remote MCP server per Workspace product, at
`https://<product>mcp.googleapis.com/mcp/v1` (Gmail's,
`gmailmcp.googleapis.com`, answers; Calendar's and Drive's names are *to
confirm*). The package uses them where they serve a command, and Google's
REST APIs where they do not:

- **The mapping is static and versioned.** Each command names its backend in
  the capability descriptor, and the package's contract tests pin the request
  and result shapes of both. A command moves from REST to MCP in a release,
  never at run time.
- **The MCP servers are the Recipe's, not the package's.** The Recipe
  declares them as MCP servers with the ids `gmail`, `calendar` and `drive`
  and binds them like any MCP server; Pi connects them in process, and the
  package calls a server's tool through the session's tools (Pi's
  `ctx.executeTool`), so every call passes Pi's `tool_call` and
  `tool_result` hooks and the agent's MCP policy. The package opens no MCP
  connection of its own.
- **A tool the session cannot call falls back to REST, per call.** A command
  goes to MCP when the session can call its tool (`mcp__<server>__<tool>`)
  at that moment, and to REST otherwise: a server the Recipe does not
  declare, a tool its policy leaves out, a server that did not connect, or a
  Pi without the in-process client. A narrower server, or one still in
  preview for a domain, costs nothing but the REST call.
- **Both backends use the same connection.** The MCP servers sit on the same
  APIs and take the same OAuth token, so one consent serves both (*to
  confirm*: Google also requires each MCP service to be enabled in the
  Cloud project).

### Declare the MCP servers

A Recipe that wants the MCP backend declares the three servers in
`package.json`, with the tools the commands call:

```json
{
  "pi": {
    "productivity": [{ "provider": "google" }],
    "mcp": {
      "servers": [
        {
          "id": "gmail",
          "tools": {
            "include": [
              "search_messages",
              "get_message",
              "create_draft",
              "update_draft",
              "modify_message_labels"
            ]
          }
        },
        {
          "id": "calendar",
          "tools": {
            "include": [
              "list_events",
              "get_event",
              "create_event",
              "update_event",
              "respond_to_event",
              "delete_event"
            ]
          }
        },
        {
          "id": "drive",
          "tools": { "include": ["search_files", "read_file_content"] }
        }
      ]
    }
  }
}
```

Name tools exactly rather than `"*"` in `package.json`: a tool the package
leaves out cannot be called, which keeps a server's send tool, if it has one,
from becoming a second way to send mail. The agent selects them in
`codemode`, the mode that runs them on Pi's
client. A tool the agent does not select is hidden, and a hidden tool cannot
be called, so the agent includes every tool a command it uses needs; it need
not declare any `eager`, since the package calls the tools itself. Codemode
also gives the model a `codemode` tool whose scripts can call the same
tools directly, outside the productivity tools' handles:

```yaml
tools: [mail, calendar, drive]
mcp:
  mode: codemode
  servers:
    gmail: { include: ["*"] }
    calendar: { include: ["*"] }
    drive: { include: ["*"] }
```

Each server is bound like any MCP server: on Introspection the platform's
binding names its URL and the egress attaches the person's Google token, as
for the REST hosts; locally, `.pi/mcp.local.json` names the URL and a header:

```json
{
  "servers": [
    {
      "id": "gmail",
      "transport": "streamable_http",
      "url": "https://gmailmcp.googleapis.com/mcp/v1",
      "headers": { "Authorization": "Bearer ${GOOGLE_ACCESS_TOKEN}" }
    }
  ]
}
```

`GOOGLE_MCP_SERVERS` exports each server's id and URL. Leave the servers
out, or the `mcp` block, and every command is served over REST. Each
productivity tool waits for a server still connecting before it runs
(Recipes gives extension tools `reachesTools: () => "all"` in codemode), so
the first command of a session does not fall back to REST only because Pi
had not connected yet.

| Command | MCP (preferred) | REST fallback |
| --- | --- | --- |
| `mail search` | Gmail MCP search | `GET gmail/v1/users/me/messages?q=` |
| `mail read` | Gmail MCP get message / thread | `users.messages.get`, `users.threads.get` (`format=full`) |
| `mail fetch_attachment` | none | `users.messages.attachments.get` |
| `mail draft` / `update_draft` | Gmail MCP drafts | `users.drafts.create`, `users.drafts.update` |
| `mail send` | none: sends only through REST, so a policy sees one path | `users.drafts.send` |
| `mail label` / `move` | Gmail MCP labels | `users.messages.modify` |
| `calendar list` / `read` | Calendar MCP | `GET calendar/v3/calendars/{id}/events`, `events.get` |
| `calendar free_busy` | none | `POST calendar/v3/freeBusy` |
| `calendar create` / `update` / `respond` / `cancel` | Calendar MCP where offered | `events.insert`, `events.patch` (own attendee `responseStatus`), `events.delete`, with `sendUpdates=all` |
| `drive search` | Drive MCP search | `GET drive/v3/files?q=` |
| `drive read` | Drive MCP read where offered | `files.export` (native formats), `files.get?alt=media` |
| `drive download` | none | `files.export`, `files.get?alt=media` |
| `drive upload` | none | `POST upload/drive/v3/files` (multipart; resumable above 5 MB) |

Which MCP tools exist per server is *to confirm* against each server's
`tools/list`; the table names the intent, and the contract tests and the
declaration above name the tools.

## Results

- **Mail.** A message's body is its `text/plain` part, or its `text/html`
  part converted to text when there is none; MIME is decoded and remote
  content dropped. Results carry `from`, `to`, `cc`, `subject`, `sent_at`,
  the thread handle, label names (not IDs) and the attachment list. A folder
  in `mail move` is a label, since Gmail has no folders; the descriptor says
  so.
- **Calendar.** Times are returned in RFC 3339 with the event's IANA time
  zone. All-day events carry dates, not times. `calendar respond` sets the
  person's own `responseStatus` and nothing else on the event.
- **Drive.** Google-native files have no bytes of their own, so `drive read`
  and `drive download` export them:

  | Native type | `drive read` (text) | `drive download` (file) |
  | --- | --- | --- |
  | Docs | `text/plain` | `.docx` |
  | Sheets | `text/csv`, first sheet, with the sheet list | `.xlsx` |
  | Slides | `text/plain` | `.pptx` |
  | Other files | the file's text, when it is text | the file |

  Google limits an export's size (*to confirm*: 10 MB); a larger file
  reports the limit instead of truncating silently.

## Authentication and setup

The package sends a placeholder bearer, and the host attaches the person's
token ([productivity tools, Authentication](README.md#authentication)).
On Introspection the connector declares these hosts, and the egress attaches
the credential only to them:

- `gmail.googleapis.com` and the Workspace MCP hosts, which the Recipe's
  MCP bindings name;
- `www.googleapis.com`, **path-limited** to `/calendar/v3/`, `/drive/v3/`
  and `/upload/drive/v3/`, because that host serves every other Google API
  too.

What a Workspace admin sets up once, in their own Google Cloud project:

1. **Enable the APIs** (Gmail, Calendar, Drive) and their MCP services. The
   MCP servers are a **developer preview**: the project needs membership in
   the Workspace Developer Preview Program, and preview terms apply (*to
   confirm* before production use).
2. **Create an OAuth client** of type Web application, with the connector
   callback as its redirect URI and, for the MCP servers, "Use this client
   for an AI-powered agent" selected.
3. **Keep the app internal to the domain** where possible. Gmail and Drive
   read scopes are *restricted*: an external app needs Google's verification
   and a yearly security assessment, which an internal app does not.

The connector requests offline access (`access_type=offline`,
`prompt=consent`), which the platform's Google connector OAuth already sends,
and only the scopes for the commands the Recipe enables:

| Tool | Read | Write |
| --- | --- | --- |
| `mail` | `gmail.readonly` | `gmail.compose` (drafts, send), `gmail.modify` (labels) |
| `calendar` | `calendar.readonly` | `calendar.events` |
| `drive` | `drive.readonly` | `drive.file` (files the agent creates) |

## Errors

| Provider answer | Command result |
| --- | --- |
| `401` | `not_connected`: the person reconnects |
| `403` `insufficientPermissions` | `missing_scope`, naming the scope the connector lacks |
| `403` `rateLimitExceeded`, `userRateLimitExceeded`, or `429` | retried with backoff, then `rate_limited` with the wait |
| `404` | `not_found`, and the handle is dropped |
| `5xx` | retried once for reads; writes are not retried |

A write is never retried automatically, because Gmail and Calendar writes are
not idempotent.

## Docs, Sheets and Slides

Working **inside** a document is the [documents](../documents/README.md) tool's job,
not productivity's. Productivity finds a file and moves it; documents reads
and marks it up. The split holds for both providers, since OneDrive's Word,
Excel and PowerPoint files are the same problem.

- **Now: round trip through files.** `drive download` exports a Doc to
  `.docx`, which the `docx` format already reads and redlines; the result
  goes back with `drive upload`. Sheets and Slides need `xlsx` and `pptx`
  formats in documents, which then serve Excel and PowerPoint too.
- **Later: live documents.** Comments and suggestions on the live Google Doc
  (Docs `batchUpdate`, Drive comments) are a documents format whose source is
  a `file_…` handle rather than a path under the workspace. That extends the
  documents contract (today a format works on local files by extension), so
  it is designed there, with Microsoft's Word and Excel APIs alongside.

## Test it

- **Unit:** a fake HTTP server for the REST calls and a fake `executeTool`
  standing in for Pi's MCP client, covering paging (`nextPageToken`),
  backoff, error mapping, export types, the placeholder credential, and the
  per-call fallback when an MCP tool cannot be called.
- **Live:** `introspection dev` against a Workspace test domain enrolled in
  the developer preview, with a test person connected, on a Recipe running
  `mcp.mode: codemode` on Pi 1.3.0 or newer.

## As built

- **Backends.** Every command the table above maps to MCP is declared `mcp`
  in the descriptor; the rest are `rest`. Each call to an `mcp` command asks
  the call context's `tools` (the host's wrapper over Pi's `ctx.tools` and
  `ctx.executeTool`) whether it can call the command's tool, and calls it
  with `executeTool("mcp__<server>__<tool>", args)` when it can; otherwise
  the command uses REST. A `mail draft` that replies always uses REST, since
  only the REST draft sets `In-Reply-To` and `References`; a thread read uses
  REST too. An earlier build opened its own MCP client; it was removed rather
  than kept as a fallback, since REST already serves every command and a
  second client would bypass the Recipe's MCP policy and bindings.
- **Expected MCP tools** (`EXPECTED_MCP_TOOLS`, all *to confirm*), each
  called as `mcp__<server id>__<tool>`. Gmail
  (`gmail`, `gmailmcp.googleapis.com`): `search_messages`, `get_message`,
  `create_draft`, `update_draft`, `modify_message_labels` (label and move).
  Calendar (`calendar`, `calendarmcp.googleapis.com`, host *to confirm*): `list_events`,
  `get_event`, `create_event`, `update_event`, `respond_to_event`,
  `delete_event`. Drive (`drive`, `drivemcp.googleapis.com`, host *to confirm*):
  `search_files`, `read_file_content`, the names a Drive MCP server publishes.
  Their results are read as the REST resources they wrap (`Message`, `Event`,
  `File`, or `{messages|items|files, nextPageToken}`); a result in another
  shape is a `provider_error`, never a guess. Drive's MCP search names a
  parent `parentId = '…'` where `files.list` takes `'…' in parents`.
- **Retries.** Reads are retried on `429` and `403` `rateLimitExceeded` /
  `userRateLimitExceeded` up to four attempts, waiting `Retry-After` or
  0.5, 1 and 2 seconds, and once on a `5xx`. A wait above 30 seconds comes
  back as `rate_limited` with `retry_after_seconds`. A write is sent once,
  even on a rate limit.
- **Errors.** As the table above, plus: `400` is `invalid_request`; `403`
  `exportSizeLimitExceeded` is `invalid_request` stating the 10 MB limit (the
  limit is printed on `files.export` in Drive's discovery document); an MCP
  `401` is `not_connected` and an MCP `403` is `missing_scope`, as MCP's
  authorization spec answers an insufficient scope; a tool's `isError` result
  is `provider_error` with its message. Pi reports a failed call only as its
  error's text, so the status is read from Pi's wording (`MCP server requires
  authentication`, `MCP HTTP request failed with status <n>`); any other
  failed call, such as one a hook blocked, is `provider_error` with Pi's
  message.
- **Mail.** `mail search` builds a Gmail query from the neutral filters
  (`from:`, `after:`/`before:` as epoch seconds, `is:unread`) and maps
  `folder` to a label ID. Summaries come from `format=metadata` reads. Bodies
  are returned as text: the `text/plain` part, else the HTML part converted
  with images, scripts, styles, frames and embeds dropped and link targets
  kept in angle brackets. An attachment's ID is its `partId`, since Gmail's
  `attachmentId` changes between reads. Draft bodies are sent as
  `text/plain` (the Markdown as written), and a header value containing a
  line break is refused. A reply drafted with no `to` goes to the parent's
  `Reply-To`, else its `From`, or to its `To` when the person sent it, as
  Gmail's own Reply does; it never adds the other recipients. `mail move` adds the label and removes `INBOX`;
  `archive` only removes `INBOX`; `SENT` and `DRAFT` cannot be set.
- **Calendar.** `calendar` names a calendar by its title on the person's
  list (`calendarList.list`). An event listed from another calendar than the
  primary one carries that calendar in its provider id, so `read`, `update`,
  `respond` and `cancel` address the calendar it came from (`create` always
  writes to the primary calendar). `create` and `update` send local times with
  `timeZone`, which Calendar reads in that zone. `respond` patches the
  attendee list with only the person's own `responseStatus` and comment
  changed. `cancel` deletes with `sendUpdates=all`; Google sends attendees
  its own notice, so a cancellation comment is not delivered.
- **Drive.** `drive read` exports Docs and Slides as `text/plain` and Sheets
  as `text/csv` (the first sheet; the sheet list the design names needs the
  Sheets API and is not returned), and reads only text files of other types,
  with a `Range` request cut at `max_bytes`. Over MCP it returns the server's
  own text rendering. `drive upload` uses a multipart upload, or a resumable
  one above 5 MB whose session URI must stay on `/upload/drive/v3/`.
- **Tests.** The REST commands run against Vercel Labs' Google emulator
  (`@emulators/google`) where it serves them, and against fakes for the rest
  (`events.get`, `events.patch`, `files.export`, resumable uploads) and for
  error injection; the MCP backend runs against a fake `executeTool` that
  answers as Pi does (the whole `CallToolResult` as `structuredContent`, a
  thrown error as an error outcome carrying its message).
- **Telemetry.** Each REST request the package makes (each retried attempt
  included) is an OpenTelemetry client span on the globally registered
  tracer (scope `@introspection-ai/recipe-productivity-google`), a child of
  the tool call's `execute_tool` span. A REST span is named
  `METHOD /template` after the discovery document's path from the host's
  root, such as `GET /gmail/v1/users/{userId}/messages/{id}`, and carries
  `http.request.method`, `server.address`, `server.port`, `url.template`,
  the discovery method id as `introspection.api.operation_id` (such as
  `gmail.users.messages.get`), `http.response.status_code`,
  `http.response.body.size` and `error.type`. A JSON answer up to 256 KiB is
  recorded under `gen_ai.tool.call.result`, the attribute the tool result
  itself uses, so the Introspection processor seals it as it seals tool
  results; bytes are never recorded. No header, path or query is recorded.
  With no tracer provider registered the spans are no-ops.
- **MCP telemetry.** The package records no MCP request: the Introspection
  runtime's fetch instrumentation already records each one Pi's client sends
  (`initialize`, `tools/list`, `tools/call <tool>`, with `mcp.method.name`
  and `gen_ai.tool.name`), without its result. Nothing else records the
  result: Pi keeps a bounded record of nested calls without it, and the
  session instrumentation (`instrumentSession` in `introspection-pi`, 0.45
  included) traces only the agent's own tool calls, not those made through
  `ctx.executeTool`. So each call through Pi is one internal span named
  `<server>/<tool>` (`mcp.server.id`, `mcp.tool.name`), active while Pi
  sends the request, with the `CallToolResult` up to 256 KiB under
  `gen_ai.tool.call.result` and `error.type` `tool_error` for an `isError`
  result or `call_failed` for a call Pi failed. It carries no
  `mcp.method.name` or `gen_ai.operation.name`, so it does not count as a
  second request or tool call; the runtime's `tools/call` span is its child.
  Once the session instrumentation records nested calls with their results,
  this span goes.
- **Not yet:** a live-domain test, and confirming the MCP hosts, tool names
  and result shapes.

Request and response shapes come from Google's discovery documents as
published in `googleapis/google-api-go-client` at `b6ee70b`:
`gmail/v1/gmail-api.json` (revision 20261005),
`calendar/v3/calendar-api.json` (20261030) and `drive/v3/drive-api.json`
(20261023).

## Open questions

- Which tools each Workspace MCP server exposes, and whether their results
  carry what the commands return (thread grouping, attachment metadata).
- Whether one connector can declare the REST and MCP hosts together, so one
  consent covers every backend.
- The preview's terms for production use, and its quotas.
