# Google productivity provider

**Status: built** (`packages/productivity/google`), not yet published or
tested against a live Workspace domain. [As built](#as-built) lists where it
differs from the design below. Facts marked *to confirm* come from Google's
documentation as summarised in design review, and are checked against a live
Workspace domain before the package ships.

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
- **A missing MCP tool falls back to REST at session start.** The package
  lists the MCP server's tools when the session opens; a command whose tool
  is absent is served by its REST fallback, so a narrower server, or one
  still in preview for a domain, costs nothing but the REST call.
- **Both backends use the same connection.** The MCP servers sit on the same
  APIs and take the same OAuth token, so one consent serves both (*to
  confirm*: Google also requires each MCP service to be enabled in the
  Cloud project).

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
`tools/list`; the table names the intent, and the contract tests name the
tools.

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

- `gmail.googleapis.com` and the Workspace MCP hosts;
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

- **Unit:** a fake HTTP server for the REST calls and a fake MCP server for
  the Workspace servers, covering paging (`nextPageToken`), backoff, error
  mapping, export types, the placeholder credential, and the session-start
  fallback when an MCP tool is missing.
- **Live:** `introspection dev` against a Workspace test domain enrolled in
  the developer preview, with a test person connected.

## As built

- **Backends.** Every command the table above maps to MCP is declared `mcp`
  in the descriptor; the rest are `rest`. At session start the package lists
  the tools of each MCP server an enabled command needs, and serves a command
  over MCP only when its expected tool is listed. A server that fails to
  connect or list serves nothing, so its commands use REST. A `mail draft`
  that replies always uses REST, since only the REST draft sets
  `In-Reply-To` and `References`; a thread read uses REST too.
- **Expected MCP tools** (`EXPECTED_MCP_TOOLS`, all *to confirm*). Gmail
  (`gmailmcp.googleapis.com`): `search_messages`, `get_message`,
  `create_draft`, `update_draft`, `modify_message_labels` (label and move).
  Calendar (`calendarmcp.googleapis.com`, host *to confirm*): `list_events`,
  `get_event`, `create_event`, `update_event`, `respond_to_event`,
  `delete_event`. Drive (`drivemcp.googleapis.com`, host *to confirm*):
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
  is `provider_error` with its message.
- **Mail.** `mail search` builds a Gmail query from the neutral filters
  (`from:`, `after:`/`before:` as epoch seconds, `is:unread`) and maps
  `folder` to a label ID. Summaries come from `format=metadata` reads. Bodies
  are returned as text: the `text/plain` part, else the HTML part converted
  with images, scripts, styles, frames and embeds dropped and link targets
  kept in angle brackets. An attachment's ID is its `partId`, since Gmail's
  `attachmentId` changes between reads. Draft bodies are sent as
  `text/plain` (the Markdown as written), and a header value containing a
  line break is refused. `mail move` adds the label and removes `INBOX`;
  `archive` only removes `INBOX`; `SENT` and `DRAFT` cannot be set.
- **Calendar.** `calendar` names a calendar by its title on the person's
  list (`calendarList.list`). `create` and `update` send local times with
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
  error injection; the MCP backend runs against fake MCP servers built on the
  MCP SDK.
- **Telemetry.** Each REST request (each retried attempt included) and each
  MCP request the package makes (`initialize`, `tools/list`, `tools/call`)
  is an OpenTelemetry client span on the globally registered tracer (scope
  `@introspection-ai/recipe-productivity-google`), a child of the tool
  call's `execute_tool` span. A REST span is named `METHOD /template` after
  the discovery document's path from the host's root, such as
  `GET /gmail/v1/users/{userId}/messages/{id}`, and carries
  `http.request.method`, `server.address`, `server.port`, `url.template`,
  the discovery method id as `introspection.api.operation_id` (such as
  `gmail.users.messages.get`), `http.response.status_code`,
  `http.response.body.size` and `error.type`. An MCP span is named
  `tools/call <tool>` (or its method) and carries `mcp.method.name`,
  `gen_ai.tool.name`, `server.address` and `server.port`. A JSON answer, or
  an MCP result, up to 256 KiB is recorded under `gen_ai.tool.call.result`,
  the attribute the tool result itself uses, so the Introspection processor
  seals it as it seals tool results; bytes are never recorded. No header,
  path or query is recorded. With no tracer provider registered the spans
  are no-ops.
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
