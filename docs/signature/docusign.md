# DocuSign signature provider

**Status: proposed; tools captured.** The tools below were captured from the
developer server (`docusign-mcp-server` v2.2.2, 42 tools) on 2026-11-12; the
ones the provider calls are in
[`test/fixtures/signature/docusign-tools.json`](../../test/fixtures/signature/docusign-tools.json).
The envelope shape follows DocuSign's eSignature REST v2.1 OpenAPI description
([`docusign/OpenAPI-Specifications`](https://github.com/docusign/OpenAPI-Specifications)).

**⚠️ The MCP server cannot take the document.** `createEnvelope` accepts a
document only as a `remoteUrl`, "a publicly accessible HTTPS URL", and says
it "does not accept base64 file uploads". The reviewed contract is a file in
the session, and the host does not publish one, so the envelope is created
over REST (`POST /restapi/v2.1/accounts/{accountId}/envelopes` with
`documentBase64`) with the same token. Everything else the provider needs, the
server serves.

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

Every tool but `getUserInfo` takes `accountId`.

| Command | Tool | Arguments |
| --- | --- | --- |
| `send` | REST `POST …/envelopes` (the server's `createEnvelope` takes no file) | the envelope definition below, with `status: "sent"` |
| `status` | `getEnvelope`, `listRecipients` | `envelopeId` |
| `void` | `updateEnvelope` | `envelopeId`, `envelopeUpdate: { status: "voided", voidedReason }` |
| setup | `getUserInfo` | none; returns the person's accounts and each one's base URI |

The envelope definition `send` posts. The server's own `createEnvelope`
schema takes the same recipients and anchor tabs (`signHereTabs`,
`dateSignedTabs` with `anchorString`), only not the document:

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

## Still to confirm

- A recording against the developer account: `getUserInfo`, the REST create
  with the anchors, `getEnvelope`, `listRecipients`, `updateEnvelope` to void.
- Whether `updateEnvelope` to `voided` is refused for a completed envelope
  with a readable error.
- The REST host for the account (`base_uri` from `getUserInfo`), which the
  egress has to allow alongside the MCP server.
