# DocuSign signature provider

**Status: design.** Request and response shapes below are *to confirm*
against the eSignature REST API reference and a recorded response from a
developer account before the package is built; this design was written
without access to the reference pages.

The `docusign` provider serves the [`signature`](signature.md) tool from a
person's DocuSign account, over the eSignature REST API v2.1. It is the
package `@introspection-ai/recipe-productivity-docusign`.

```json
{
  "peerDependencies": {
    "@introspection-ai/recipe-productivity-docusign": ">=X.Y.Z"
  },
  "pi": {
    "productivity": [{ "provider": "docusign" }]
  }
}
```

## Account and base URI

A DocuSign API call goes to the account's own host, not a fixed one. At
session start the package calls `GET /oauth/userinfo` on the account server
(`account-d.docusign.com` for a developer account, `account.docusign.com` in
production) and takes the person's default account (`is_default`) from
`accounts[]`, with its `account_id` and `base_uri`. Every later call goes to
`{base_uri}/restapi/v2.1/accounts/{account_id}/…`. A person with several
accounts and no default gets `invalid_request` naming them; picking one by
name is a provider option (`account`), set by the Recipe, never by the model.

`environment` (`demo` or `production`, default `production`) picks the
account server. `capabilities.hosts` lists both account servers and the
`base_uri` hosts the package accepts (`demo.docusign.net`, `na*`, `eu*`,
`au*`, `ca*` `.docusign.net`, spelled out host by host); a `base_uri` outside
that list fails rather than sending the bearer there.

## Commands

| Command | eSignature v2.1 |
| --- | --- |
| `signature prepare` | `POST /envelopes` with `status: "created"` |
| `signature send` | `GET /envelopes/{id}` and `/recipients` (for the approval card), then `PUT /envelopes/{id}` with `status: "sent"` |
| `signature status` | `GET /envelopes/{id}`, `GET /envelopes/{id}/recipients` |
| `signature list` | `GET /envelopes?from_date=&status=` (`from_date` required by the API) |
| `signature void` | `PUT /envelopes/{id}` with `status: "voided"` and `voidedReason` |
| `signature discard` | `PUT /folders/recyclebin` with the envelope id (a draft only) |
| `signature download` | `GET /envelopes/{id}/documents/combined` and `/documents/certificate` |

`prepare` sends the document as `documentBase64` with `fileExtension`
(`pdf` or `docx`; DocuSign converts Word to PDF), the subject as
`emailSubject`, the message as `emailBlurb`, each signer under
`recipients.signers[]` with a `recipientId` and `routingOrder`, and each cc
under `recipients.carbonCopies[]`.

Fields become anchored tabs on the signer:

| Field `type` | Tab |
| --- | --- |
| `signature` | `signHereTabs` |
| `initials` | `initialHereTabs` |
| `date_signed` | `dateSignedTabs` |
| `full_name` | `fullNameTabs` |
| `title` | `titleTabs` |
| `text` | `textTabs` with `required` |

Each with `anchorString`, `anchorXOffset`, `anchorYOffset`, `anchorUnits:
"points"`, `anchorMatchWholeWord: true`, `anchorCaseSensitive: true`, and
`anchorIgnoreIfNotPresent: false`, so a missing anchor fails the create
rather than silently dropping a signature. DocuSign places the tab at every
occurrence of the anchor, which is why the host checks each anchor occurs
once before the call ([Anchors](signature.md#anchors-place-a-field-at-every-occurrence)).

`discard` moves a draft to the recycle bin rather than voiding it: DocuSign
voids only an envelope that is sent or delivered, and moving one of those to
the recycle bin voids it, so `discard` checks the status is `created` first
and returns `invalid_state` otherwise.

## Status mapping

| DocuSign envelope | `signature` |
| --- | --- |
| `created` | `draft` |
| `sent` | `sent` |
| `delivered` | `delivered` |
| `signed`, `completed` | `completed` |
| `declined` | `declined` |
| `voided` | `voided` |
| `timedout`, `expired` *(to confirm)* | `expired` |

Recipients map `created` to `pending`, and `sent`, `delivered`, `signed`,
`declined` and `completed` to themselves, with `deliveredDateTime`,
`signedDateTime` and `declinedReason`.

## Errors and limits

- `401` is `not_connected`; `403` (`USER_LACKS_PERMISSIONS` and similar) is
  `missing_scope` naming `signature`; `404` is `not_found`.
- `429` (`HOURLY_APIINVOCATION_LIMIT_EXCEEDED`,
  `BURST_APIINVOCATION_LIMIT_EXCEEDED`) is `rate_limited`. DocuSign limits
  calls per account per hour and per 30 seconds, and separately limits
  polling one envelope; `status` is therefore never retried in a loop by the
  host, and the skill tells the agent not to poll.
- A `400` with an envelope-state error code (*to confirm*:
  `ENVELOPE_CANNOT_VOID_INVALID_STATE` and its siblings) is `invalid_state`;
  other `400`s are `invalid_request` with DocuSign's `message`.
- Reads are retried by the host's `http`; `POST /envelopes` and every `PUT`
  are sent once. A `prepare` whose answer is lost may have created a draft,
  which `signature list` finds.

## Authentication and setup

The package sends a placeholder bearer to the account server and the
`base_uri` host, and the host attaches the person's token
([Authentication](signature.md#authentication)).

An admin creates one DocuSign app (an integration key) with the connector
callback as its redirect URI and the `signature` scope (*to confirm*), for
the authorization-code grant. Each person connects once. The JWT grant
(`impersonation` scope) is not used: it would let a task act as any user who
consented, which is the tenant-wide access the
[README](README.md#deferred) defers.

A developer account (`account-d.docusign.com`, `demo.docusign.net`) serves
tests. Moving an app to production goes through DocuSign's go-live review.

## Not the MCP server

DocuSign runs a remote MCP server in beta (`mcp-d.docusign.com` for
developer accounts, *to confirm*). Its tool names are not published. The
REST API serves every command here; the MCP path can be revisited once its
tools are captured, behind the same commands.

## Recording

Following [Wiring a provider](../providers.md#10-wiring-a-provider):

1. Record each request and response shape against a developer account, with
   a two-page test agreement between `acme` and `talent` carrying a two-party
   signature block.
2. Create every envelope as a draft; send only to a mailbox the developer
   account owns; void what was sent and discard every draft at the end.
3. Let the Polly helper anonymize account ids, envelope ids, names and
   addresses; read the cassette before committing it.
4. Build the package's fake from the cassette, refusing a field the recorded
   request lacked.
