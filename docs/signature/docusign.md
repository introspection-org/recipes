# DocuSign signature provider

**Status: proposed; tools captured.** The tools below were captured from the
developer server (`docusign-mcp-server` v2.2.2, 42 tools) on 2026-11-12; the
ones the provider calls are in
[`test/fixtures/signature/docusign-tools.json`](../../test/fixtures/signature/docusign-tools.json).
The envelope shape follows DocuSign's eSignature REST v2.1 OpenAPI description
([`docusign/OpenAPI-Specifications`](https://github.com/docusign/OpenAPI-Specifications)).

**The document goes by link.** `createEnvelope` accepts a document only as a
`remoteUrl` ("a publicly accessible HTTPS URL, max 25 MB per file") and
refuses base64, so the provider passes the host's short-lived signed link
([The document link](README.md#the-document-link)). A test on the developer
account created a draft from a public URL this way.

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
| `send` | `createEnvelope` | `envelopeDefinition` below, with `status: "sent"` |
| `status` | `getEnvelope`, `listRecipients` | `envelopeId` |
| `void` | `updateEnvelope` | `envelopeId`, `envelopeUpdate: { status: "voided", voidedReason }` |
| setup | `getUserInfo` | none; returns the person's accounts and each one's base URI |

The envelope definition `send` passes:

```json
{
  "status": "sent",
  "emailSubject": "Acme MSA for signature",
  "emailBlurb": "Please sign the attached agreement.",
  "documents": [
    { "documentId": "1", "name": "acme-msa.docx", "fileExtension": "docx", "remoteUrl": "<the signed link to the marked copy>" }
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
  it, since a signed link's path need not end in `.docx`.
- Each tab also takes `documentId` and `recipientId`, which the server's
  schema requires.
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
- **Size.** 25 MB per document.

## Tested

On the developer account, 2026-11-12, with the demo user as the only
recipient:

- `getUserInfo` returned one account and its base URI.
- `createEnvelope` made a draft from a public URL.
- A two-column block (Acme and Talent) with the markers written after the
  Acme `By:` and `Date:` lines: DocuSign placed one signature and one date
  tab, both in the Acme column (`listRecipients` with
  `include_anchor_tab_locations`), and none in Talent's.
- `updateEnvelope` sent it; `getEnvelope` read `sent`.

That run created the envelope over REST, before this design chose links.

## Still to confirm

- `createEnvelope` with a `.docx` behind a signed link whose path has no
  extension, and the markers in it.
- `updateEnvelope` to `voided`, and its error for a completed envelope.
- A Polly recording of `prepare`, `send`, `status` and `void` for CI.
