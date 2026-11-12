# PandaDoc signature provider

**Status: proposed.** Request and response shapes are taken from PandaDoc's
OpenAPI description
([`PandaDoc/pandadoc-openapi-specification`](https://github.com/PandaDoc/pandadoc-openapi-specification),
8.29.0). Facts marked *to confirm* come from PandaDoc's reference pages as
summarised in design review. The [recording](README.md#test) against a
sandbox key settles them.

The `pandadoc` provider is the low-cost option. It serves the
[`signature` tool](README.md) from a PandaDoc workspace over
`https://api.pandadoc.com/public/v1`, and is part of
`@introspection-ai/recipe-signature`.

```json
{ "pi": { "signature": [{ "provider": "pandadoc" }] } }
```

## Placement and formats

PandaDoc places fields in two ways:

- **Field tags**, typed into the document's text (`{signature:s1____}`).
  The exact delimiters are *to confirm*.
- **Positions**, as `POST /documents/{id}/fields` with `layout: { page,
  position: { offset_x, offset_y, anchor_point: "topleft" }, style: { width,
  height } }`.

It has no anchor to existing text. The host never writes tags into a
reviewed file ([Placing fields](README.md#placing-fields)), so this provider
uses positions. The descriptor says `placement: "position"` and `formats:
["pdf"]`. The host turns each anchor into a page position with the PDF
format's `locate` and sends it in points from the top left. The units of the
offsets are *to confirm*: if PandaDoc expects pixels at 72 dpi, the two are
the same.

## Commands

| Command | REST | Notes |
| --- | --- | --- |
| `prepare` | `POST /documents` (multipart: `file`, `data`), poll `GET /documents/{id}` until `document.draft`, then `POST /documents/{id}/fields` | `data`: `name`, `recipients[]` with `email`, `first_name`, `last_name` (split from `name`), `role` (`s1`, `s2`, … per signer), `signing_order` (from `order`); `parse_form_fields: false`. A `cc` recipient has no `role`, which PandaDoc treats as a copy. Creation is asynchronous: the host polls for up to 30 seconds and stops on `document.error`. Each field is assigned to its recipient's uuid from the create answer |
| `send` | `POST /documents/{id}/send` | `subject`, `message`, `silent: false`. Runs after approval and after `GET /documents/{id}/details` matches the digest |
| `status` | `GET /documents/{id}/details` | Recipient status from `has_completed` and `signature_date`. Whether `details` answers outside `draft` is *to confirm*. If it does not, status falls back to `GET /documents/{id}` with no per-recipient detail, and says so |
| `list` | `GET /documents?status=&created_from=&count=&page=` | Numeric status filter. Paged by page number |
| `download` | `GET /documents/{id}/download` | Only for `document.completed`. A `202` with `Retry-After` is waited out through the host's `http`. `download-protected` answers only to a production key, so it is not used |
| `void` (draft) | `DELETE /documents/{id}` | |
| `void` (sent) | `PATCH /documents/{id}/status` `{ "status": 11, "note": reason, "notify_recipients": true }` | PandaDoc calls status 11 "voided" (expired) |

## Status mapping

| PandaDoc | Neutral |
| --- | --- |
| `document.uploaded` | `draft` (still processing) |
| `document.draft` | `draft` |
| `document.sent`, `document.waiting_approval`, `document.approved`, `document.external_review` | `sent` |
| `document.viewed` | `viewed` |
| `document.completed`, `document.paid`, `document.waiting_pay` | `completed` |
| `document.declined`, `document.rejected` | `declined` |
| `document.voided` | `voided` |
| `document.error` | `provider_error` |

## Authentication

- **OAuth 2.0 per person** is the default. A connector holds the client:
  authorize at `app.pandadoc.com/oauth2/authorize` with scope `read write`,
  and get tokens from `api.pandadoc.com/oauth2/access_token`. Each person
  connects once, and the egress sends their token as `Bearer`.
- **An API key** (`Authorization: API-Key …`) is the alternative, for a
  workspace without OAuth. The key acts as its owner, so every document is
  sent as that one person whoever the task runs for. On Introspection it is a
  project endpoint credential, and the Recipe's README has to say whose key
  it is.
- **Sandbox.** A sandbox is a sandbox key on the same host. Its documents are
  watermarked and named with a `[DEV]` prefix (*to confirm*). It sends only
  within the key owner's email domain, and allows 10 requests a minute. The
  host treats a document whose returned name carries the prefix as a sandbox
  for [auto-approval](README.md#approval).
- **`capabilities.hosts`** is `api.pandadoc.com` and `app.pandadoc.com`.
- **Statuses.** `401` is `not_connected` and `403` is `missing_scope`. `404`
  is `not_found`. `409` and `423` (locked) are `invalid_request`. `429`
  (`throttled`) is `rate_limited`.

## Limits

- **Document size.** 50 MB per document. The host's cap is 25 MB.
- **Encryption.** An encrypted PDF is refused by PandaDoc. The host refuses
  it first.
- **Rate limits.** They use a sliding 60-second window per user, shared by
  all of that user's keys, and the production limit varies by endpoint (*to
  confirm*). The descriptor sets `status_interval_seconds: 60`.
