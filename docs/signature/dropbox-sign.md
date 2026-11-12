# Dropbox Sign signature provider

**Status: proposed; blocked on a capture.** Dropbox serves Dropbox Sign's
tools from its own remote MCP server, `https://mcp.dropbox.com/mcp`, which is
in beta. Dropbox's help centre says those tools send a document for
signature, check status, send reminders and cancel a pending request. Neither
the tool names nor how a tool takes a file have been seen, so this guide
records what the API supports (from the
[`hellosign/hellosign-openapi`](https://github.com/hellosign/hellosign-openapi)
description) and what the capture has to confirm.

The `dropbox-sign` provider serves the [`signature` tool](README.md) through
that server, under the Recipe's server id `dropbox`.

```yaml
mcp:
  servers:
    dropbox:
      include: ["*"]
      behind: [signature]
```

## Commands

| Command | Tool (*to capture*) | API it should reach |
| --- | --- | --- |
| `send` | send for signature | `POST /v3/signature_request/send`: the [signed link](README.md#getting-the-document-to-the-vendor) to the marked copy as `file_urls[]`, `signers[]` (`name`, `email_address`, `order`), `cc_email_addresses[]`, `title`, `subject`, `message`, `use_text_tags: true`, `hide_text_tags: false` |
| `status` | check status | `GET /v3/signature_request/{id}` |
| `void` | cancel | `POST /v3/signature_request/cancel/{id}` |

- **No draft at the provider.** Dropbox Sign's API can only send at once, or
  make a draft someone finishes in its web app (`unclaimed_draft`), which is
  why the host keeps the draft ([Drafts and approval](README.md#drafts-and-approval)).
- **Text tags.** Each signer's tags are `[sig|req|signern]` and
  `[date|req|signern]`, *n* counting signers from 1. A tag must sit on one
  line, and its width is the field's, so the host pads it. Dropbox Sign's
  own `hide_text_tags` can clip text, so the tags are left in and coloured
  white instead.
- **Cancel** is asynchronous and cannot be undone: a `200` queues it. It
  applies to a request that is sent and not fully signed, by its sender.
- **Test mode.** `test_mode: true` makes a request that is free, watermarked
  and not legally binding. Recordings use it.

## Status mapping

| Signature request | Neutral |
| --- | --- |
| `is_complete` | `completed` |
| `is_declined` | `declined` |
| cancelled (`410` on read) | `voided` |
| any signature `last_viewed_at` | `viewed` |
| otherwise | `sent` |

A signature's `awaiting_signature` is `sent`, or `viewed` once
`last_viewed_at` is set; `signed` is `signed`; `declined` is `declined`.

## Authentication and limits

- **OAuth with the person's Dropbox account.** Dropbox registers MCP clients
  dynamically only for a trusted set; otherwise the connector holds the
  client id and secret of a Dropbox app. Requests run under the person's own
  Dropbox Sign plan and quota.
- **Rate limits.** Read from `X-RateLimit-*` headers; a `429`
  (`exceeded_rate`) carries no `Retry-After`, so `X-Ratelimit-Reset` gives
  `retry_after_seconds`. Test mode allows 10 requests a minute.
- **Size.** 40 MB per file and 500 pages per request.

## To capture

The provider is not offered until a capture shows:

- the Sign tools' names and input schemas;
- that the send tool takes a file URL (`file_urls`), not only a path in the
  person's Dropbox;
- that it takes `use_text_tags` and `test_mode`;
- the error shapes.
