# DocuSign signature provider

**Status: proposed; first to build.** The tool names come from DocuSign's own
sample code for its MCP server
([`docusign/mcp-agent-foundry-procurement-python`](https://github.com/docusign/mcp-agent-foundry-procurement-python),
`scripts/test_all_mcp_tools.py`), not from a captured tool list. The envelope
shape comes from DocuSign's eSignature REST v2.1 OpenAPI description
([`docusign/OpenAPI-Specifications`](https://github.com/docusign/OpenAPI-Specifications)),
which the server passes through. The capture settles what is marked *to
capture*.

The `docusign` provider serves the [`signature` tool](README.md) through the
Docusign MCP Server, a remote server DocuSign hosts.

| Environment | Server | OAuth |
| --- | --- | --- |
| Developer | `https://mcp-d.docusign.com/mcp` | `account-d.docusign.com` |
| Production | `https://mcp.docusign.com/mcp` | `account.docusign.com` |

```yaml
mcp:
  servers:
    docusign:
      include: ["*"]
      behind: [signature]
```

## Commands

Every tool takes `accountId`.

| Command | Tool | Arguments |
| --- | --- | --- |
| `send` | `createEnvelope` | `envelopeDefinition` with `status: "sent"` (below) |
| `status` | `getEnvelope`, `listRecipients` | `envelopeId` |
| `void` | `updateEnvelope` | `envelopeId`, `envelopeUpdate: { status: "voided", voidedReason }` |
| setup | *to capture* | the person's accounts, to choose `accountId` |

The envelope definition `send` passes:

```json
{
  "status": "sent",
  "emailSubject": "Acme MSA for signature",
  "emailBlurb": "Please sign the attached agreement.",
  "documents": [
    { "documentId": "1", "name": "acme-msa.docx", "fileExtension": "docx", "documentBase64": "<the marked copy>" }
  ],
  "recipients": {
    "signers": [
      {
        "recipientId": "1",
        "routingOrder": "1",
        "name": "Jane Doe",
        "email": "jane@example.com",
        "tabs": {
          "signHereTabs": [{ "anchorString": "\\s1\\", "anchorUnits": "pixels", "anchorXOffset": "0", "anchorYOffset": "0", "anchorIgnoreIfNotPresent": "false", "anchorMatchWholeWord": "true" }],
          "dateSignedTabs": [{ "anchorString": "\\d1\\", "anchorUnits": "pixels", "anchorXOffset": "0", "anchorYOffset": "0", "anchorIgnoreIfNotPresent": "false", "anchorMatchWholeWord": "true" }]
        }
      }
    ],
    "carbonCopies": [{ "recipientId": "2", "routingOrder": "2", "name": "Sam Roe", "email": "sam@example.com" }]
  }
}
```

- `emailSubject` is at most 100 characters and is refused, not cut, beyond
  that; `emailBlurb` at most 10,000. A name or email is at most 100.
- DocuSign converts a `.docx` to PDF itself; `fileExtension` is required for
  it.
- DocuSign searches every document for an anchor and places a tab at each
  occurrence, which is why each signer has their own marker
  ([Placing fields](README.md#placing-fields)). It leaves the anchor text in
  place, so the marker is white.
- `voidedReason` is cut at 200 characters. A completed envelope cannot be
  voided.

## Status mapping

| Envelope | Neutral |
| --- | --- |
| `sent` | `sent` |
| `delivered` | `viewed` |
| `signed`, `completed` | `completed` |
| `declined` | `declined` |
| `voided`, `timedout` | `voided` |
| `deleted` | `not_found` |

A recipient's `created` is `pending`, `sent` is `sent`, `delivered` is
`viewed`, `signed` and `completed` are `signed`, and `declined` is
`declined`. `autoresponded` (the email bounced) is `sent`, with a note.

## Authentication and limits

- **Authorization Code grant, per person.** DocuSign registers no MCP client
  itself, so the host's connector holds an integration key and secret from
  DocuSign's developer console, with the `signature` scope. Each person
  connects once. *To capture:* the scopes the server requires.
- **Plans.** DocuSign says the server's eSignature tools need a paid
  production account, and an account admin can switch MCP access off. A
  developer account reaches the developer server.
- **Rate limits.** 3,000 calls an hour per account and 500 per 30 seconds,
  and one status read per envelope every 15 minutes:
  `status_interval_seconds` is 900.
- **Size.** 25 MB per document, and less in `documentBase64`, which grows by
  a third.

## To capture

Against the developer server, with `introspection bindings mcp capture
docusign`:

- the current tool names and input schemas: the sample targets an older
  endpoint, and the current server may rename tools;
- which tool lists the person's accounts, for `accountId`;
- that `createEnvelope` passes anchor tabs through and accepts a `.docx` in
  `documentBase64`;
- the error shapes for `401`, a refused anchor (`ANCHOR_TAB_STRING_NOT_FOUND`)
  and throttling.
