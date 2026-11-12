# PandaDoc signature provider

**Status: proposed; blocked on a capture.** PandaDoc hosts an official remote
MCP server, `https://mcp.pandadoc.com/v1/mcp` (`mcp.pandadoc.eu` for EU
accounts). The tool names below come from PandaDoc's own skill files for it
([`PandaDoc/mcp-server-guide`](https://github.com/PandaDoc/mcp-server-guide)),
not from a captured tool list, and the API behind them from PandaDoc's
OpenAPI description
([`PandaDoc/pandadoc-openapi-specification`](https://github.com/PandaDoc/pandadoc-openapi-specification),
8.29.0). It is the low-cost option.

The `pandadoc` provider serves the [`signature` tool](README.md) through that
server, under the Recipe's server id `pandadoc`.

```yaml
mcp:
  servers:
    pandadoc:
      include: ["*"]
      behind: [signature]
```

## Commands

| Command | Tools (*to capture*) | Notes |
| --- | --- | --- |
| `send` | `documents_create` (`source: "file"`), `documents_status_get` until `draft`, then `documents_send` | `recipients[]` with `email`, `first_name`, `last_name` (split from `name`), `role` (`s1`, `s2`, … per signer; none for a cc) and `signing_order`; `parse_form_fields: false`. `subject`, `message` on send |
| `status` | `documents_details_get` | recipients' `has_completed` and `signature_date` |
| `void` | `documents_status_change` to Expired (`document.voided`) | only from sent or viewed |

- **Fields are field tags.** PandaDoc cannot anchor a field to existing text;
  it places one by page coordinates or by a tag typed into the document, and
  its MCP skills say its field tool only reassigns existing fields. Tags work
  in a `.docx`: `{signature:sn}` and `{date:sn}`, the role matching the
  recipient's. A role name takes no underscores.
- **Creation is asynchronous.** A new document is `document.uploaded` for a
  few seconds, then `document.draft`; `document.error` ends it. The provider
  polls for up to 30 seconds, well within the link's lifetime. If sending
  then fails, the provider deletes the document it created, when the server
  has a tool for that (*to capture*).
- **A cc** is a recipient without a role.

## Status mapping

| Document | Neutral |
| --- | --- |
| `document.sent`, `waiting_approval`, `approved`, `external_review` | `sent` |
| `document.viewed` | `viewed` |
| `document.completed`, `paid`, `waiting_pay` | `completed` |
| `document.declined`, `rejected` | `declined` |
| `document.voided` | `voided` |
| `document.error` | `provider_error` |

A recipient is `signed` when `has_completed`, else `sent`.

## Authentication and limits

- **OAuth per person.** Each person signs in to PandaDoc and picks a
  workspace. PandaDoc publishes no client id for its server, which suggests
  dynamic client registration (*to capture*).
- **Sandbox.** A sandbox workspace's documents are watermarked and not
  legally binding, and in a trial it sends only within the account's own
  email domain. It allows 10 requests a minute per endpoint, so the descriptor
  sets `status_interval_seconds: 60`.
- **Size.** 50 MB per document; encrypted PDFs are refused.

## To capture

The provider is not offered until a capture shows:

- the tool names and input schemas;
- that `documents_create` with `source: "file"` takes the
  [signed link](README.md#the-document-link) to the file, as PandaDoc's REST
  API takes a public HTTPS `url`;
- that field tags in a `.docx` are read through that path;
- a delete tool, for a document whose send failed.
