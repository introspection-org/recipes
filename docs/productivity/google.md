# Google productivity provider

**Status: built** (`packages/productivity/google`), not yet published or
tested against a live Workspace domain. [As built](#as-built) lists where it
differs from the design below. Facts marked *to confirm* come from Google's
documentation as summarised in design review, and are checked against a live
Workspace domain before the package ships.

**REST-only for now.** Every command is served by Google's REST APIs. See
[MCP later](#mcp-later).

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

Every command is served by Google's REST APIs, and the descriptor declares
each `rest`. The mapping is static and versioned: the package's contract
tests pin each request and result shape.

| Command | REST |
| --- | --- |
| `mail search` | `GET gmail/v1/users/me/messages?q=` |
| `mail read` | `users.messages.get`, `users.threads.get` (`format=full`) |
| `mail fetch_attachment` | `users.messages.attachments.get` |
| `mail draft` / `update_draft` | `users.drafts.create`, `users.drafts.update` |
| `mail send` | `users.drafts.send` |
| `mail label` / `move` | `users.messages.modify` |
| `calendar list` / `read` | `GET calendar/v3/calendars/{id}/events`, `events.get` |
| `calendar free_busy` | `POST calendar/v3/freeBusy` |
| `calendar create` / `update` / `respond` / `cancel` | `events.insert`, `events.patch` (own attendee `responseStatus`), `events.delete`, with `sendUpdates=all` |
| `drive search` | `GET drive/v3/files?q=` |
| `drive read` | `files.export` (native formats), `files.get?alt=media` |
| `drive download` | `files.export`, `files.get?alt=media` |
| `drive upload` | `POST upload/drive/v3/files` (multipart; resumable above 5 MB) |

### MCP later

Google publishes a remote MCP server per Workspace product, but they are a
developer preview: the Calendar and Drive hosts and every tool name are
unconfirmed. Once they are generally available and the tool names are
confirmed, an MCP path can return as a Recipe's own MCP servers kept behind
the productivity tools with `mcp.servers.<id>.behind: [mail|calendar|drive]`
([MCP configuration](../mcp-configuration.md#keep-a-server-behind-a-tool),
[#459](https://github.com/introspection-org/recipes/pull/459)).

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

- `gmail.googleapis.com`;
- `www.googleapis.com`, **path-limited** to `/calendar/v3/`, `/drive/v3/`
  and `/upload/drive/v3/`, because that host serves every other Google API
  too.

What a Workspace admin sets up once, in their own Google Cloud project:

1. **Enable the APIs** (Gmail, Calendar, Drive).
2. **Create an OAuth client** of type Web application, with the connector
   callback as its redirect URI.
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

- **Unit:** a fake HTTP server for the REST calls, covering paging
  (`nextPageToken`), backoff, error mapping, export types and the
  placeholder credential.
- **Live:** `introspection dev` against a Workspace test domain, with a test
  person connected.

## As built

- **Retries.** The host's `http` retries a read
  ([Write a provider](README.md#write-a-provider)); the package adds `403`
  `rateLimitExceeded` / `userRateLimitExceeded` as throttled. A rate limit
  the host stops retrying comes back as `rate_limited` with
  `retry_after_seconds`. A write is sent once, even on a rate limit.
- **Errors.** As the table above, plus: `400` is `invalid_request`; `403`
  `exportSizeLimitExceeded` is `invalid_request` stating the 10 MB limit (the
  limit is printed on `files.export` in Drive's discovery document).
- **Mail.** `mail search` builds a Gmail query from the neutral filters
  (`from:`, `after:`/`before:` as epoch seconds, `is:unread`) and maps
  `folder` to a label ID. Summaries come from `format=full` reads with a
  `fields` mask that keeps the headers and part structure but no part data
  (`format=metadata` has no parts, so it cannot tell attachments). Bodies
  are the `text/plain` part, else the HTML part, which the host converts to
  text as it does Microsoft's (`src/productivity/content.ts`). No part inside an attachment or an attached message
  is read as the body. A body part Gmail stores apart (`body.attachmentId`)
  is fetched up to 5 MB; a larger one, or one that cannot be fetched, is
  named in `unavailable`. An attachment's ID is its `partId`, since Gmail's
  `attachmentId` changes between reads. Draft bodies are sent as
  `text/plain` (the Markdown as written); `update_draft` without `body` keeps
  the draft's body (an HTML one as HTML, a stored one fetched) and refuses
  the update when that body cannot be read. A header value containing a line break is
  refused. A reply drafted with no `to` goes to the parent's
  `Reply-To`, else its `From`, or to its `To` when the person sent it, as
  Gmail's own Reply does; it never adds the other recipients. `mail move` adds the label and removes `INBOX`;
  `archive` only removes `INBOX`; `SENT` and `DRAFT` cannot be set.
- **Calendar.** `calendar` names a calendar by its title on the person's
  list (`calendarList.list`). An event listed from another calendar than the
  primary one carries that calendar in its provider id, so `read`, `update`,
  `respond` and `cancel` address the calendar it came from (`create` always
  writes to the primary calendar). An event without its own zone is shown in
  its calendar's zone: `list` takes it from `events.list`, and `read` and
  `update` from `calendars.get`, read once per calendar per session. When
  `calendars.get` is refused (a connection with only `calendar.events`), the
  zone is the fixed one of the event's own offset (`Etc/GMT-1` for
  `+01:00`), or UTC, so neither a read nor a write that already happened
  fails on it.
  `create` and `update` send local times with
  `timeZone`, which Calendar reads in that zone. `respond` patches the
  attendee list with only the person's own `responseStatus` and comment
  changed. `cancel` deletes with `sendUpdates=all`; Google sends attendees
  its own notice, so a cancellation comment is not delivered.
- **Drive.** `drive read` exports Docs and Slides as `text/plain` and Sheets
  as `text/csv` (the first sheet; the sheet list the design names needs the
  Sheets API and is not returned), and reads only text files of other types,
  with a `Range` request cut at `max_bytes`. `drive upload` uses a multipart upload, or a resumable
  one above 5 MB whose session URI must stay on `/upload/drive/v3/`.
- **Tests.** The REST commands run against Vercel Labs' Google emulator
  (`@emulators/google`) where it serves them, and against fakes for the rest
  (`events.get`, `events.patch`, `files.export`, resumable uploads) and for
  error injection.
- **Telemetry.** The host's `http` records each request (each retried
  attempt included) as a client span, a child of the tool call's
  `execute_tool` span, on the tracer scope
  `@introspection-ai/recipe-productivity-google`. The package names each
  request by the discovery document's path from the host's root, such as
  `GET /gmail/v1/users/{userId}/messages/{id}`, and its method id as
  `introspection.api.operation_id` (such as `gmail.users.messages.get`). A
  read's JSON answer up to 256 KiB is recorded under
  `gen_ai.tool.call.result`, so the Introspection processor seals it as it
  seals tool results; a write's answer, bytes, headers, paths and queries
  never are. The resumable upload's session URI comes back in a header, and
  the Drive fields the package asks for carry no signed link.
- **Not yet:** a live-domain test.

Request and response shapes come from Google's discovery documents as
published in `googleapis/google-api-go-client` at `b6ee70b`:
`gmail/v1/gmail-api.json` (revision 20261005),
`calendar/v3/calendar-api.json` (20261030) and `drive/v3/drive-api.json`
(20261023).
