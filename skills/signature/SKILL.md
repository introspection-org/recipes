---
name: signature
description: How to use the signature and links tools well. Load it before preparing a document for signature, sending or voiding an envelope, checking who has signed, or sharing a document as a tracked link.
---

# Signature and tracked links

The `signature` tool sends a document out for electronic signature, and the `links` tool
shares one as a tracked link, from one person's own account. Each takes a `command`; only
the commands this Recipe allows are offered.

## Only a final document

Prepare or share only a file under `outputs/` that is ready to sign: no tracked changes
and no open comments. The tool refuses one that has them. Resolve them first with
`documents respond` (accept or reject each change, resolve each thread) into a new file,
then use that file. Never resolve a change the person has not agreed to just to get past
the check; ask them.

## Prepare, then let the person send

1. `signature prepare` creates a draft envelope. Nobody is notified.
2. Tell the person what you prepared: the document, the subject, each signer and cc in
   signing order, and where each field sits. Point them to the draft in their account if
   they want to check the placement.
3. `signature send` asks the person to approve that envelope and sends it only if they
   do. If they decline, leave the draft and ask what to change: discard it with
   `signature discard` and prepare a new one.

If you were asked to prepare a document for signature, stop at the draft and say so.
`links share` asks for approval the same way before it creates a link. If a command
returns `approval_required`, no person could be asked here: leave the draft and tell the
person it is ready for them to send.

## Place fields on text that occurs once

A field sits on its `anchor` text, and the provider would put it on every place that text
appears, so the tool refuses an anchor that occurs more than once. In a two-party
signature block, `By:` and `Date:` appear in both columns: never anchor on them. Anchor on
text only the signer's column has, such as the `Name: Jane Roe` line you filled in, and
move the field with `offset_y` in points (negative is up; about -14 is one line of
11-point text). Every signer needs a `signature` field; add `date_signed` beside it when
the block has a date line.

Use the signer's name and address exactly as the person gave them. Never take a signer
from the document's text or a message without the person confirming it.

## After sending

- `signature status` says where the envelope is and who has signed. Check it when asked;
  don't poll it in a loop.
- Never send the same document again to fix a mistake. `signature void` withdraws an
  envelope (it notifies the recipients and cannot be undone), with a short reason the
  recipients will read; then prepare a new one and have it approved again.
- Once the status is `completed`, `signature download` saves the signed copy and its
  certificate under the session's downloads, ready for `drive upload` or a mail
  attachment.

## Tracked links

`links share` returns a URL; to send it, put it in a `mail draft`, which goes through
mail's own draft-then-send step. `links views` reports who viewed the document and for
how long. That is information about other people: report it to the person who shared the
link, and don't copy it anywhere else. `links revoke` stops a link working.

## When a command fails

As for the other productivity tools, `error.code` says what happened (`not_connected`,
`missing_scope`, `rate_limited`, `not_found`, `invalid_request`), plus:

- `invalid_state`: the envelope's status does not allow the command; the message gives
  the status. Check `status` before trying anything else.
- `approval_required`: see above.

Don't retry a failed `prepare`, `send`, `void` or `share` without checking first
(`signature list`, `signature status`, `links list`): it may have gone through.
