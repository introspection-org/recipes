# Microsoft productivity provider

**Status: proposed,** with the [productivity tools](productivity.md).

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
`@odata.nextLink` paging, `429` and `503` with `Retry-After`, and `$batch`
where a command reads several items. Types are generated from Graph's OpenAPI
description (`microsoftgraph/msgraph-metadata`) or imported as type-only from
the SDK, so nothing extra ships at run time.

| Command | Graph | Delegated scope |
| --- | --- | --- |
| `mail search` | `GET /me/messages?$search=` or `$filter=` | `Mail.Read` |
| `mail read` | `GET /me/messages/{id}`, `/me/messages?$filter=conversationId eq` | `Mail.Read` |
| `mail draft` | `POST /me/messages`, `POST /me/messages/{id}/createReply` | `Mail.ReadWrite` |
| `mail send` | `POST /me/messages/{id}/send` | `Mail.Send` |
| `mail move` / `mail label` | `POST /me/messages/{id}/move`, `PATCH` `categories` | `Mail.ReadWrite` |
| `calendar list` | `GET /me/calendarView?startDateTime=&endDateTime=` | `Calendars.Read` |
| `calendar free_busy` | `POST /me/calendar/getSchedule` | `Calendars.Read` |
| `calendar create` / `update` / `cancel` | `POST /me/events`, `PATCH /me/events/{id}`, `POST /me/events/{id}/cancel` | `Calendars.ReadWrite` |
| `calendar respond` | `POST /me/events/{id}/accept`, `tentativelyAccept`, `decline` | `Calendars.ReadWrite` |
| `drive search` / `read` | `GET /me/drive/root/search(q=)`, `GET /me/drive/items/{id}/content` | `Files.Read` |
| `drive upload` | `PUT /me/drive/items/{parent}:/{name}:/content`, upload sessions above 4 MB | `Files.ReadWrite` |

`mail label` maps to Outlook categories, and `mail move` to folders. The
descriptor states this, since Outlook has no labels in Gmail's sense.

## Why Graph rather than Work IQ

Microsoft's Work IQ MCP server reaches the same data through generic path
tools, is delegated-only, and may need a Microsoft 365 Copilot licence per
person (*to confirm*). Graph serves every command here with delegated scopes
alone. A Recipe that wants Work IQ's Copilot tools (`ask`, `retrieve`) binds
it as an ordinary MCP server beside these tools.

## Authentication and setup

The package sends a placeholder bearer to `graph.microsoft.com`, and the host
attaches the person's token
([productivity tools, Authentication](productivity.md#authentication)).

A tenant admin registers one Entra app with the connector callback as its
redirect URI, adds the delegated scopes for the commands the Recipe enables
(`Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.Read`,
`Calendars.ReadWrite`, `Files.Read`, `Files.ReadWrite`, plus
`offline_access`), and grants admin consent for the tenant, so people connect
without a consent screen.

## Docs, Sheets and Slides equivalents

Word, Excel and PowerPoint files are [documents](documents.md) work, as for
Google: `drive download` fetches them and `drive upload` returns the result.
