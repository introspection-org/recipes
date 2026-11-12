# DocuSign signature provider

**Status: proposed.** Facts marked *to confirm* come from DocuSign's
developer blog and SDK models as read in design review, and the
[recording](README.md#test) against `demo.docusign.net` settles them.

The `docusign` provider serves the [`signature` tool](README.md) from a
person's DocuSign eSignature account, over the eSignature REST API v2.1. It
is part of `@introspection-ai/recipe-signature`.

```json
{
  "pi": {
    "signature": [{ "provider": "docusign", "options": { "account": "<account GUID>" } }]
  }
}
```

| Option | Meaning |
| --- | --- |
| `account` | the account GUID to send from, when the person belongs to several. Default: the `is_default` account from userinfo |

## Commands

Paths are relative to `{base_uri}/restapi/v2.1/accounts/{accountId}`.

| Command | REST | Notes |
| --- | --- | --- |
| `prepare` | `POST /envelopes` with `status: "created"` | `documents[]`: `documentBase64`, `name`, `fileExtension`, `documentId: "1"`. `recipients.signers[]`: `email`, `name`, `recipientId`, `routingOrder` (from `order`, default 1). `recipients.carbonCopies[]` for `cc`. `emailSubject`, `emailBlurb`. `status` is always explicit, since the default is disputed (*to confirm*) |
| `send` | `PUT /envelopes/{envelopeId}` `{ "status": "sent" }` | Runs after the approval and after `GET /envelopes/{id}/recipients` and `GET /envelopes/{id}/documents` match the digest |
| `status` | `GET /envelopes/{envelopeId}`, `GET /envelopes/{envelopeId}/recipients` | Two calls, each kept for 15 minutes ([Status and limits](README.md#status-and-limits)) |
| `list` | `GET /envelopes?from_date=&status=&count=&start_position=` | Without `after`, `from_date` is 30 days back. Paged by `start_position`, which advances by the rows returned |
| `download` | `GET /envelopes/{envelopeId}/documents/combined?certificate=true` | One PDF with the certificate of completion. Refused before `completed`, since DocuSign would return the in-progress copy |
| `void` (draft) | `PUT /folders/recyclebin` `{ "envelopeIds": [id] }` | Moves the draft to Deleted |
| `void` (sent) | `PUT /envelopes/{envelopeId}` `{ "status": "voided", "voidedReason": reason }` | Only before `completed`. `reason` is capped at 200 characters (*to confirm*) |

Each field becomes a tab on its signer. The tab arrays and anchor
properties:

| Field `type` | Tab |
| --- | --- |
| `signature` | `signHereTabs` |
| `initials` | `initialHereTabs` |
| `date_signed` | `dateSignedTabs` |
| `full_name` | `fullNameTabs` |
| `title` | `titleTabs` |
| `text` | `textTabs` |

Every tab carries `anchorString`, `anchorUnits: "points"`, `anchorXOffset`,
`anchorYOffset`, `anchorMatchWholeWord: true` and
`anchorIgnoreIfNotPresent: false`. A tab whose `required` is false also
carries `optional: true`. `anchorCaseSensitive` is reserved by DocuSign, so
DocuSign always matches without regard to case. The host's uniqueness count
does the same.

## Status mapping

| DocuSign envelope | Neutral |
| --- | --- |
| `created` | `draft` |
| `sent` | `sent` |
| `delivered` | `viewed` |
| `signed`, `completed` | `completed` |
| `declined` | `declined` |
| `voided` | `voided` |
| `timedout` | `expired` |

`deleted` is `not_found`. For a recipient, `created` is `pending`;
`delivered` is `viewed`; `signed` and `completed` are `signed`;
`autoresponded` (email bounced) is `sent`, with a note.

## Authentication

- **Authorization Code grant, per person.** A connector holds the
  integration key and redirect URI, with the `signature` scope (plus
  `extended` for a long-lived refresh token, *to confirm*). Each person
  connects once.
- **Account server.** The account server is `account.docusign.com`, or
  `account-d.docusign.com` for the developer environment. The provider calls
  `GET /oauth/userinfo` on it once per session and picks the account.
- **Hosts.** `capabilities.hosts` lists both account servers,
  `demo.docusign.net`, and the production API hosts DocuSign assigns
  (`na1`–`na4`, `eu`, `au`, `ca` `.docusign.net`, *to confirm* against the
  userinfo answers). A `base_uri` outside the list is refused rather than
  followed, so the egress never learns a host from a response.
- **Statuses.** `401` is `not_connected` and `consent_required` is
  `not_connected` with the connect hint. `403` is `missing_scope`.
  `404`, and `ENVELOPE_DOES_NOT_EXIST`, are `not_found`. `429` and the
  hourly-limit error are `rate_limited`. Other `4xx` are `invalid_request`,
  quoting DocuSign's `errorCode`.
- **JWT grant** is [deferred](README.md#deferred).

## Limits

- **API calls.** 3,000 per account per hour, and a burst limit of 500 calls
  per 30 seconds (200 in the developer environment).
- **Status polling.** One status read per envelope every 15 minutes. The
  descriptor sets `status_interval_seconds: 900`.
- **Retries.** Writes are sent once, and reads retry on `429` and `5xx`
  through the host's `http`.

Sources:
- [eSignature rules and limits](https://developers.docusign.com/docs/esign-rest-api/esign101/rules-and-limits/)
- [Envelopes: create](https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/envelopes/create)
- [Tab placement strategies](https://www.docusign.com/blog/developers/select-the-right-tab-placement-strategy-for-your-docusign-integration)
- [Void an envelope](https://docusign.com/blog/developers/dsdev-common-api-tasks-void-an-envelope)
- [Delete an envelope](https://www.docusign.com/blog/common-api-tasks-delete-and-undelete-envelope)
- [Download documents](https://www.docusign.com/blog/developers/dsdev-common-api-tasks-downloading-documents)
- [Userinfo](https://docusign.com/blog/developers/the-trenches-who-are-you)
