# Signature and tracked links

**Status: design.** Nothing here is built yet. Facts marked *to confirm* come
from vendor blogs and help pages summarised in design review, not from the
API reference or a recorded response, and are checked against a sandbox
account before a provider ships (see [providers](#providers)).

Once a person has reviewed a document the agent prepared (a redlined
contract, say, with the customer's side of the signature block filled in),
the next step is getting it signed or putting it in front of someone. Two
productivity tools serve that, shaped identically for every provider:

- **`signature`** sends a document out for electronic signature: prepare a
  draft envelope, send it once a person approves, follow its status, void
  it, and fetch the signed copy.
- **`links`** shares a document as a tracked link: create the link once a
  person approves, read who viewed it, and revoke it.

They follow the [productivity contract](README.md): a provider package
supplies the transport and a capability descriptor, while the host owns the
commands, their schemas, the handles and the checks below. A command a
provider cannot support is absent, not failing. The vocabulary is neutral, so
a Recipe moves from one signature provider to another by changing `provider`.
The model acts only on handles the host minted.

## Declare a provider

Signature and link providers are productivity providers that serve the
`signature` or `links` tool. A Recipe that also reads mail declares two
entries, each serving tools the other does not:

```json
{
  "pi": {
    "productivity": [
      { "provider": "microsoft", "tools": { "mail": ["search", "read", "draft"] } },
      {
        "provider": "docusign",
        "tools": { "signature": ["prepare", "send", "status", "download"] }
      }
    ]
  }
}
```

```yaml
tools: [mail, signature]
```

This relaxes the one-declaration rule in the README: **one provider per
tool**, not per Recipe. The rule existed so the model never sees two
mailboxes behind one tool name, and that still holds; a second declaration
whose provider serves a tool another declaration already enables fails at
registration, naming both. Each declaration gets its own session, its own
connection and its own handle namespace.

`provider` is served by `@introspection-ai/recipe-productivity-<provider>`,
as for `microsoft` and `google`; the first is `docusign`
([guide](docusign.md)). DocSend is designed in [its guide](docsend.md) and
blocked until its server's tools are captured.

## `signature`

| Command | Arguments | Returns | Effect |
| --- | --- | --- | --- |
| `signature prepare` | `path` (under `outputs/`), `subject`, `message?`, `signers[]`, `cc?` | an `env_…` handle, its status (`draft`) and the checks it passed | reversible |
| `signature send` | `envelope` | the envelope, `sent`, after a person approves | **sends**, irreversible |
| `signature status` | `envelope` | the envelope status and each recipient's status and times | read |
| `signature list` | `status?`, `after?`, `limit?`, `cursor?` | envelopes this connection sent or drafted, with `env_…` handles | read |
| `signature void` | `envelope`, `reason` | the envelope, `voided` | **irreversible**, notifies recipients |
| `signature discard` | `envelope` | `discarded: true` | reversible (a draft only) |
| `signature download` | `envelope` | the signed document and its completion certificate under the session's downloads | read |

A signer is `{ name, email, order?, fields[] }`; `order` is the routing
order (signers with the same order sign in parallel, default 1, ascending). A
cc is `{ name, email, order? }` and receives a copy once the signers before
it have signed. A field is:

```ts
{
  type: "signature" | "initials" | "date_signed" | "full_name" | "title" | "text";
  /** Text in the document the field is placed on. Must occur exactly once. */
  anchor: string;
  /** Points right of the anchor's start, and down from it. Default 0. */
  offset_x?: number;
  offset_y?: number;
  /** For `text`: whether the signer must fill it. */
  required?: boolean;
}
```

Placing by text means the agent never deals in coordinates. Every signer
needs at least one `signature` field; a signer with none fails before any
provider call.

### Statuses

One neutral set, each provider mapping its own onto it:

| Envelope | Meaning |
| --- | --- |
| `draft` | Prepared, not sent. Only `send`, `discard` and `status` apply. |
| `sent` | Sent; no signer has finished. |
| `delivered` | Every current signer has opened it. |
| `completed` | Every signer signed. `download` returns the signed copy. |
| `declined` | A signer declined; the reason is on that recipient. |
| `voided` | Voided by the sender; the reason is on the envelope. |
| `expired` | Not completed in time. |

Recipients carry `pending`, `sent`, `delivered`, `signed`, `declined` or
`completed` (a cc), with `delivered_at`, `signed_at` and `declined_reason`
where the provider reports them.

### Anchors place a field at every occurrence

A signature provider places an anchored field at **every** place the anchor
text appears (*to confirm* against DocuSign's reference; DocuSign's own
developer blog says so, and Dropbox Sign's text tags behave the same way).
That breaks the obvious anchors in a two-party signature block:

```text
ACME, INC.                    TALENT LLC
By: ______________________    By: ______________________
Name: Jane Roe                Name:
Title: Chief Financial Officer Title:
Date: ____________________    Date: ____________________
```

`By:` and `Date:` each occur twice, so the customer's signature would land in
both columns. The host therefore **counts each anchor in the document's text
before calling the provider** and refuses an anchor that occurs zero times or
more than once, with `invalid_request` naming the count. For a `.docx` it
reads the text of the body, tables, headers and footers; a PDF's text comes
from the document's own text layer through the documents tool's PDF reader.

Until the follow-up below lands, the agent anchors on text that is unique to
the signer's column. Having filled in the customer's side, `Name: Jane Roe`
is unique, so the signature sits one line above it with a negative
`offset_y`, and `date_signed` two lines below it. The skill says so, and says
to check the placement in the provider's draft view, which a person sees
before approving the send.

**Follow-up: signature markers in `documents`.** The robust fix is for the
document to carry one invisible marker per field, as DocuSign's anchor tags
and Dropbox Sign's text tags both expect. A `documents` command for `.docx`,
`mark_fields`, would take a paragraph id from `documents read` (`p-012.r2c2`)
and a field type per signer, and write a marker run (white, 1 pt, such as
`\s1\`) at the end of that paragraph in a new file under `outputs/`. A field
would then name `marker` instead of `anchor`, and the host would check each
marker occurs once, as for an anchor. That is a `documents` change and lands
separately; `signature` keeps `anchor` either way.

### The document

`signature prepare` and `links share` take `path`, a file **under the
workspace's `outputs/`**: something the documents tool (or the agent) wrote
in this session, as for `drive upload`. They accept `.pdf` and `.docx`, up to
25 MB, and the host refuses before any provider call:

- a `.docx` with pending **tracked changes** (`w:ins`, `w:del`, `w:moveFrom`,
  `w:moveTo`, or a formatting change) anywhere in the body, headers, footers,
  footnotes or endnotes;
- a `.docx` with **open comments**: any comment in `word/comments.xml` not
  marked done in `word/commentsExtended.xml`;
- a PDF with markup annotations (text notes, highlights, strike-outs) that
  the documents tool's PDF reader reports as page comments.

The refusal names the counts and says to resolve them with `documents
respond` (accept or reject each change, resolve each thread) into a new file
first. Sending a document whose redline is still open would ask a person to
sign text nobody has agreed on.

The host records the file's SHA-256 at `prepare` and shows it, with the file
name, on the approval card; the provider holds its own copy from then on, so
a later change to the file under `outputs/` does not change what is sent.

### Sending needs a person

`signature send` and `links share` reach people outside the Recipe and
cannot be taken back, so the host asks for approval **inside the command**,
every time, through [`askUserApproval`](../interactions.md): the model cannot
skip the step by calling something else, and the approval is for that one
envelope or link.

- The card shows the document name and SHA-256, the subject and message, and
  each recipient by routing order with their fields, read back from the
  provider's draft rather than from the model's arguments.
- `Approved.` sends. Any other outcome returns `declined` with the person's
  feedback and leaves the draft as it was.
- **An approval nobody gave does not count.** In a child agent run, or with
  `PI_ASK_USER_AUTO_APPROVE`, interactions resolve as approved without a
  person; there the command fails with `approval_required` instead of
  sending. A host that renders no interaction falls back the same way.
- On Introspection, a Recipe's `policies/routes.yaml` can also name
  `signature send` and `links share`, so a Cedar rule or an approved mission
  decides them before the tool runs. The policy narrows, it never replaces
  the in-command approval.

Everything before the send stays a draft: `prepare` always creates one, even
when a provider could create and send in one call, and there is no `send`
with a document. The skill tells the agent to prepare, show the person what
it prepared, and leave the send to the person's approval.

`signature void` is the other command that reaches recipients. It is
irreversible but not gated by the host: withdrawing a document is the safe
direction. A Recipe that wants it gated names it in its policy or allowlist.

## `links`

| Command | Arguments | Returns | Effect |
| --- | --- | --- | --- |
| `links share` | `path` (under `outputs/`), `name?`, `require_email?`, `allow_download?`, `expires_at?`, `passcode?` | an `lnk_…` handle and the link URL, after a person approves | **sends** |
| `links views` | `link`, `after?`, `limit?`, `cursor?` | visits: viewer email when captured, time, duration, pages viewed | read |
| `links list` | `limit?`, `cursor?` | links this connection created, with handles | read |
| `links revoke` | `link` | `revoked: true` | irreversible |

`links share` follows the document rules and the approval rule above. The URL
is returned so the agent can put it in a `mail draft`; sending that mail is
the mail tool's own draft-then-send step.

Viewer emails and visit times are personal data about someone outside the
Recipe: results carry them, the host never records them in spans, and the
skill says to report them only to the person who shared the link.

## Handles and results

`env_…` (envelope) and `lnk_…` (link) handles are minted for the session like
`msg_…`: they resolve only in it and come back only from a command that
returned the item. `signature list` and `links list` return items the
connection itself created, so the model can pick up an envelope a previous
run prepared without being given a provider id. The completed document lands
at `<downloads>/<provider>/<env handle>/<name>.pdf`, with the certificate
beside it, ready for `drive upload` or a mail attachment.

Errors use the productivity codes, plus two:

- `approval_required`: `send` or `share` ran where no person could approve.
- `invalid_state`: the envelope's status does not allow the command
  (`void` on a draft, `send` on a sent envelope, `download` before
  `completed`), with the current status.

## Effects

| Command | Effect |
| --- | --- |
| `signature prepare` | reversible |
| `signature send` | sends |
| `signature status`, `list`, `download` | read |
| `signature void` | irreversible |
| `signature discard` | reversible |
| `links share` | sends |
| `links views`, `list` | read |
| `links revoke` | irreversible |

## Providers

| Command | `docusign` | `docsend` |
| --- | --- | --- |
| `signature prepare`, `send`, `status`, `list`, `void`, `discard`, `download` | REST, eSignature v2.1 | absent |
| `links share`, `views`, `list`, `revoke` | absent | MCP, *blocked on capture* |

DocuSign is the [first provider](docusign.md). DocSend publishes no REST API;
its MCP server is the only route, and what it can do is unknown until its
tools are captured ([DocSend](docsend.md)). Dropbox Sign is the natural
second signature provider: its `signature_request` API and text tags fit the
same commands.

## Authentication

As for the other productivity tools, a provider package holds **no
credential**: it sends a placeholder bearer through the host's `http` and the
host attaches the task member's own token on the way out. Each person
connects once, with the provider's authorization-code grant; there is no
shared service account. A JWT or service-user grant would let a task send as
someone other than the person it runs for, and is deferred with tenant-wide
access in the [README](README.md#deferred).

A provider whose API lives on a per-account host (DocuSign's `base_uri`)
resolves it from the connection at session start and declares every host it
may reach in `capabilities.hosts`, so the egress admits only those.

## Skill

When an agent selects `signature` or `links`, the host offers
`skills/signature/SKILL.md`, which says:

- the document must be final: no tracked changes, no open comments;
- prepare, show the person the draft, and let the send wait for approval;
- anchor each field on text that occurs once, and how to do that in a
  two-party signature block;
- check `status` rather than resending, and void rather than sending again;
- viewer data is about other people: report it, don't spread it.

## Test

- **Unit:** the host tests the document checks (tracked changes, comments,
  anchor counts) against small fixture files, the approval rule in each
  interaction mode, and handle minting; the DocuSign package tests its
  requests, status mapping and error mapping against a fake built from the
  recorded responses.
- **Recorded:** one Polly cassette against a DocuSign developer account
  (`demo.docusign.net`), envelopes created as drafts, sent only to a test
  mailbox the account owns, and voided; never a real recipient. The helper
  anonymizes it, and the cassette is read before it is committed
  ([Wiring a provider](../providers.md#10-wiring-a-provider)).
