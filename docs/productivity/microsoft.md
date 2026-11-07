# Microsoft productivity provider

**Status: built** (`packages/productivity/microsoft`), not yet published or
tested against a live tenant. [As built](#as-built) lists where it differs from
the design below.

The `microsoft` provider serves the `mail`, `calendar` and `drive` tools from
a person's Outlook mail, Outlook calendar and OneDrive or SharePoint files,
over Microsoft Graph v1.0. It is the package
`@introspection-ai/recipe-productivity-microsoft`.

```json
{
  "peerDependencies": {
    "@introspection-ai/recipe-productivity-microsoft": ">=X.Y.Z"
  },
  "pi": {
    "productivity": [{ "provider": "microsoft" }]
  }
}
```

## Graph client

A small fetch client over Graph v1.0, not the Microsoft Graph TypeScript SDK,
which is pre-release (`1.0.0-preview.*`) and large. The client handles
`@odata.nextLink` paging, `429`, `503` and `504` with `Retry-After`, and error
mapping. The Graph types it uses are written by hand from Graph's OpenAPI
description (`microsoftgraph/msgraph-metadata`, `openapi/v1.0/openapi.yaml`),
so nothing extra ships at run time.

| Command | Graph | Delegated scope |
| --- | --- | --- |
| `mail search` | `GET /me/messages?$search=` or `$filter=` | `Mail.Read` |
| `mail read` | `GET /me/messages/{id}`, `/me/messages?$filter=conversationId eq`, with `$expand=attachments` | `Mail.Read` |
| `mail fetch_attachment` | `GET /me/messages/{id}/attachments/{id}`, then `/$value` | `Mail.Read` |
| `mail draft` / `update_draft` | `POST /me/messages`, `POST /me/messages/{id}/createReply`, `PATCH /me/messages/{id}` | `Mail.ReadWrite` |
| `mail send` | `POST /me/messages/{id}/send` | `Mail.Send` |
| `mail move` / `mail label` | `POST /me/messages/{id}/move`, `PATCH` `categories` | `Mail.ReadWrite` |
| `calendar list` | `GET /me/calendarView?startDateTime=&endDateTime=` | `Calendars.Read` |
| `calendar free_busy` | `POST /me/calendar/getSchedule`, 20 addresses per call | `Calendars.Read` |
| `calendar create` / `update` / `cancel` | `POST /me/events`, `PATCH /me/events/{id}`, `POST /me/events/{id}/cancel` | `Calendars.ReadWrite` |
| `calendar respond` | `POST /me/events/{id}/accept`, `tentativelyAccept`, `decline` | `Calendars.ReadWrite` |
| `calendar read` | `GET /me/events/{id}` | `Calendars.Read` |
| `drive search` / `read` / `download` | `GET /me/drive/root/search(q=)`, `GET /me/drive/items/{id}/content` | `Files.Read` |
| `drive upload` | `PUT /me/drive/items/{parent}:/{name}:/content`, upload sessions above 4 MB | `Files.ReadWrite` |

`mail label` maps to Outlook categories, and `mail move` to folders. The
descriptor states this, since Outlook has no labels in Gmail's sense.

## As built

- **Retries.** The host's `http` retries a read (`GET`s and `getSchedule`)
  ([Write a provider](README.md#write-a-provider)). A write is sent once,
  even on a `429`, and a wait the host will not sleep through comes back as
  `rate_limited` with `retry_after_seconds`. `$batch` is not used.
- **Errors.** `401` is `not_connected`; `403` is `missing_scope`, naming the
  command's scope from the table (Graph does not say which was missing);
  `404` and `410` are `not_found`; `429` is `rate_limited`; other `4xx` are
  `invalid_request`; `5xx` and network failures are `provider_error`.
- **Mail.** `mail search` uses `$filter` and `$orderby` without text and a
  KQL `$search` with it (Graph combines neither with the other), filtering
  `unread` from the page in that case. KQL's `received` takes only a date in
  the mailbox's zone, so with text the dates are widened a day each way and
  the exact `after` and `before` instants filter the page, as `$filter`
  applies them without text. A thread read follows every page, newest first,
  up to 500 messages; a longer thread returns its latest 500 and says so in
  `unavailable`. `folder` and `mail move` take a
  well-known folder (`inbox`, `archive`, `sent`, `drafts`, `trash`, `junk`)
  or a top-level folder's display name. Draft bodies are sent as plain text;
  a reply's text goes in `createReply`'s `comment`, so the quoted thread is
  kept. `mail send` returns no sent-message id, since Graph answers `202`.
  `mail label` reads the message's categories and writes the new set.
- **Calendar.** `calendar list` and `read` return times in UTC. An event
  listed from a named calendar carries that calendar in its id
  (`<calendarId>/<eventId>`), so `read`, `update`, `respond` and `cancel`
  reach it through `/me/calendars/{id}/events/{id}`, as a calendar shared from
  another mailbox needs. `update` refuses a `body` change on an online
  meeting: Graph replaces the whole body, which holds the Teams join details,
  so the change would disable the meeting (`event-update.md`), and the
  details have no documented delimiter to keep them by.
  `create` and `update` send wall-clock times in the event's IANA zone (a
  time with an offset is converted to it). `free_busy` treats
  `workingElsewhere` as busy and drops `free` slots.
- **Drive.** A file id carries its drive (`<driveId>/<itemId>`), so items
  in another drive resolve. `drive read` returns text only for text files;
  Word, Excel and PowerPoint files say to use `drive download`. Downloads
  follow Graph's `302` to the pre-authenticated URL without the bearer.
  `drive upload` never overwrites (`conflictBehavior=rename`) and uses an
  upload session in 10 MiB ranges (a 320 KiB multiple) above 4 MiB.
- **Telemetry.** The host's `http` records each Graph request, each retried
  attempt and each redirect or upload-range request as a client span, a child
  of the tool call's `execute_tool` span, on the tracer scope
  `@introspection-ai/recipe-productivity-microsoft`. The package names each
  request by the path template in Graph's OpenAPI description, such as
  `GET /me/messages/{message-id}` (a request to a pre-authenticated URL is
  named by its method alone). A JSON response body up to 256 KiB is recorded
  under `gen_ai.tool.call.result`; bytes, headers, paths and queries never
  are, since a bearer, an id or a pre-authenticated link can be in them.
- **Not yet:** a live-tenant test; `Files.Read` reaches the person's own
  OneDrive, and SharePoint results may need `Files.Read.All` or
  `Sites.Read.All`. A download's pre-authenticated host
  (`*.sharepoint.com`) must be reachable through the egress.

Endpoint references, from `MicrosoftDocs/microsoft-graph-docs-contrib`
(`api-reference/v1.0/api/`): `user-list-messages.md`, `message-get.md`,
`message-list-attachments.md`, `attachment-get.md`, `user-post-messages.md`,
`message-createreply.md`, `message-update.md`, `message-send.md`,
`message-move.md`, `user-list-mailfolders.md`, `user-list-calendarview.md`,
`calendar-list-calendarview.md`, `user-list-calendars.md`, `event-get.md`,
`calendar-getschedule.md`, `user-post-events.md`, `event-update.md`,
`event-accept.md`, `event-tentativelyaccept.md`, `event-decline.md`,
`event-cancel.md`, `driveitem-search.md`, `driveitem-get.md`,
`driveitem-get-content.md`, `driveitem-put-content.md` and
`driveitem-createuploadsession.md`.

## Why Graph rather than Work IQ

Microsoft's Work IQ MCP server reaches the same data through generic path
tools, is delegated-only, and may need a Microsoft 365 Copilot licence per
person (*to confirm*). Graph serves every command here with delegated scopes
alone. A Recipe that wants Work IQ's Copilot tools (`ask`, `retrieve`) binds
it as an ordinary MCP server beside these tools.

## Authentication and setup

The package sends a placeholder bearer to `graph.microsoft.com`, and the host
attaches the person's token
([productivity tools, Authentication](README.md#authentication)).

A tenant admin registers one Entra app with the connector callback as its
redirect URI, adds the delegated scopes for the commands the Recipe enables
(`Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.Read`,
`Calendars.ReadWrite`, `Files.Read`, `Files.ReadWrite`, plus
`offline_access`), and grants admin consent for the tenant, so people connect
without a consent screen.

## Docs, Sheets and Slides equivalents

Word, Excel and PowerPoint files are [documents](../documents/README.md) work, as for
Google: `drive download` fetches them and `drive upload` returns the result.
