# DocSend link provider

**Status: blocked.** DocSend publishes no REST API. Its remote MCP server is
the only programmatic route, and its tool list has not been captured, so no
command below is committed yet.

The `docsend` provider would serve the [`links`](signature.md#links) tool
from a person's DocSend account, as the package
`@introspection-ai/recipe-productivity-docsend`.

## What exists

- **No public REST API.** DocSend's help centre documents integrations
  (Zapier triggers for a new visit and a new link, Salesforce visit sync),
  not an API, and has no developer portal. Endpoints that third-party
  directories list are not documented by DocSend.
- **A remote MCP server** at `https://docsend.com/mcp`, with OAuth, for
  accounts on the Advanced Data Rooms plan, which an admin can turn off. It
  exposes what the account's plan already allows. Its tools are not
  published (*to capture*).
- **eSignature** is a DocSend feature in its own UI. Whether the MCP server
  exposes it is unknown; if it does not, signing goes through the
  `signature` tool and a signature provider, not `links`.

## Before building

Following [Wiring a provider](../providers.md#10-wiring-a-provider):

1. Capture the server's tools from an Advanced Data Rooms test account
   (`introspection bindings mcp capture docsend`), paging to the end, and
   commit them as `test/fixtures/productivity/docsend-tools.json`.
2. Map each `links` command to a captured tool, and mark the map `verified`
   only against the capture. The design wants, in order of value:

   | Command | Needs |
   | --- | --- |
   | `links share` | upload a document and create a link with `require_email`, `allow_download`, `expires_at`, `passcode` |
   | `links views` | visits per link: viewer, time, duration, pages |
   | `links list` | links the person created |
   | `links revoke` | disable a link |

   A command the server cannot serve is absent from the descriptor. If the
   server cannot upload a document, `links share` is absent and the
   provider is not worth shipping: sharing a file already in DocSend would
   bypass the [document checks](signature.md#the-document).
3. Record against dummy documents in a dedicated test space, and never share
   a link with an address outside the test account.

The package then keeps the server behind the tool, as the
[MCP configuration](../mcp-configuration.md#keep-a-server-behind-a-tool)
describes, so the model sees `links`, never DocSend's tool names.
