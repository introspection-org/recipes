# Google productivity provider

**Status: proposed,** with the [productivity tools](README.md). Facts
marked *to confirm* come from Google's documentation as summarised in design
review, and are checked against a live Workspace domain before the package
ships.

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

## Open questions

- Which tools each Workspace MCP server exposes, and whether their results
  carry what the commands return (thread grouping, attachment metadata).
- Whether one connector can declare the REST and MCP hosts together, so one
  consent covers every backend.
- The preview's terms for production use, and its quotas.
