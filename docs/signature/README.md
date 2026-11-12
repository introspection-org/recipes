# Signature tool

**Status: proposed.** One `signature` tool sends a final, reviewed document
out for e-signature through DocuSign, Dropbox Sign or PandaDoc, with the same
commands for each. Each provider is served through its vendor's own remote MCP
server, as the [issues tool](../issues/README.md) serves Linear and Jira. No
tool name below has been checked against a live tool list yet; each guide
lists what the capture must confirm
([Wiring a provider](../providers.md#10-wiring-a-provider)).

It is the step after the [document tools](../documents/README.md):

1. `documents convert` turns a PDF contract into Word.
2. The agent redlines it and fills in the customer's side of the signature
   block: a two-column table with the party, then `By:`, `Name:`, `Title:`
   and `Date:` lines.
3. A person reviews it, and every change is resolved.
4. `signature prepare` checks the result and makes a draft. `signature send`
   asks the person to approve it, and only then emails the signers.

The [productivity tools'](../productivity/README.md) properties hold:

- **A command a provider cannot serve is absent, not failing.**
- **The vocabulary is neutral.** A Recipe written against `signature send`
  runs on any provider by changing `provider`. No vendor payload is in a
  command's arguments or results.
- **The model acts only on handles the host minted.** A draft and a sent
  request are `sig_…` handles, valid in their session, never a vendor id.

## Declare it

```json
{ "pi": { "signature": [{ "provider": "docusign" }] } }
```

and select the tool in the agent file, with the vendor's server behind it:

```yaml
tools: [documents, signature]
mcp:
  servers:
    docusign:
      include: ["*"]
      behind: [signature]
```

- `provider` is `docusign`, `dropbox-sign` or `pandadoc`, all served by
  `@introspection-ai/recipe-signature`, a companion of Recipes like
  `@introspection-ai/recipe-issues`. A Recipe's own provider adds `package`,
  as for [every family](../providers.md#2-declaring-providers).
- **One provider per Recipe.** A document goes out through one service.
- The provider calls the Recipe's MCP server with its own id (`docusign`,
  `dropbox`, `pandadoc`); the `server` option names another. The server is
  kept [behind the tool](../mcp-configuration.md#keep-a-server-behind-a-tool),
  so the model never calls the vendor's tools directly.
- **The server's URL decides the environment.** A Recipe in development binds
  the vendor's sandbox ([Providers](#providers)). Moving to production changes
  the binding, never a tool argument.
- Nothing loads, and no tool is offered, unless the Recipe declares
  `pi.signature` and the agent names `signature` in its `tools`. An agent's
  `include: ["*"]` does not select it: a tool that emails people outside the
  organization is chosen by name. When it is selected, the host offers the
  core skill, `skills/signature/SKILL.md`.

## Commands

| Command | Arguments | Returns | Effect |
| --- | --- | --- | --- |
| `prepare` | `path`, `subject`, `message?`, `signers[]`, `cc?[]` | a draft's `sig_…` handle, the document's name and SHA-256, and where each signer's fields went | none outside the session |
| `send` | `request` (a draft's handle) | the request's status | **sends to others**, after a person approves |
| `status` | `request` | the request's status and each recipient's | read |
| `void` | `request`, `reason` | the request's status | **irreversible**, notifies the signers, after a person approves |

A signer and a cc are `{ name, email, order? }`. `order` defaults to 1 for
everyone, so all sign at once; 1, 2, … sign in turn. A cc receives the copy
once everyone before it has signed.

Every provider serves all four, with one difference: PandaDoc voids only a
sent request. Downloading the signed copy, listing earlier requests,
reminders, templates and embedded signing are [deferred](#deferred).

## What `prepare` checks

`prepare` reads the file locally and refuses it, before any provider call,
with `not_ready` naming what it found (`3 tracked changes`, `2 comments`):

- **It is a `.docx` under `outputs/`**, the directory the document tools write
  to, so the document sent is the one the review produced. A PDF is not
  accepted: `documents convert` turns it into Word for review, and the review
  is what makes sending safe.
- **It has no pending tracked changes** (`w:ins`, `w:del`, moves, formatting
  changes) in its body, headers, footers, footnotes or endnotes. They are
  resolved with `documents respond`.
- **It has no comments, open or resolved.** Word keeps a resolved comment in
  the file, so a signer would receive the negotiation's notes. The documents
  tool cannot delete one, so the agent asks the person to.
- **Each signer's lines are found** (below).

## Placing fields

No provider is given coordinates. Each signer's fields go on their own `By:`
and `Date:` lines, found from the text the redline filled in:

1. In the document's tables, the cell where the signer's name follows
   `Name:` is in the signer's column. A block that keeps every line in one
   cell is handled within that cell.
2. In that column, the cells starting `By:` and `Date:` are the signer's.
3. In the **copy sent**, the host writes the provider's marker for that
   signer right after the label's colon, in white text. The file under
   `outputs/` is never changed, and the SHA-256 the person approves is the
   reviewed file's.

The obvious anchor does not work: DocuSign places a tab at **every**
occurrence of its anchor text, and a two-column block has a `By:` in each
column, so each signer would also get a field in the other party's column.
Dropbox Sign and PandaDoc cannot anchor to existing text at all, only take
coordinates or tags typed into the document. A per-signer marker serves all
three:

| Provider | Marker for signer *n* | How the provider reads it |
| --- | --- | --- |
| `docusign` | `\sn\`, `\dn\` | `anchorString` tabs (`signHereTabs`, `dateSignedTabs`), `anchorIgnoreIfNotPresent: false`, so DocuSign refuses rather than send without a field |
| `dropbox-sign` | `[sig\|req\|signern]`, `[date\|req\|signern]` | text tags, with `use_text_tags` |
| `pandadoc` | `{signature:sn}`, `{date:sn}` | field tags, with `parse_form_fields: false` and the signer's `role` set to `sn` |

A DocuSign anchor is written at 1 point, since the tab has its own size. A
Dropbox Sign or PandaDoc tag *is* the field, sized by its text, so it keeps
the label's font size and is padded with underscores to the field's width.

A signer whose name is on no `Name:` line fails with `anchor_not_found`; one
whose name is on several, with `ambiguous`. A column with no `Date:` line gets
no date field. Initials on every page, text fields and signers without a
`Name:` line are not in this version.

## Drafts and approval

`prepare` keeps the draft **in the host**, not at the provider: the document's
path and SHA-256, the subject and message, the recipients and where their
fields went, recorded in the result's details so the host finds it again after
a pause. Nothing reaches the provider before `send`. This works the same for
all three, including Dropbox Sign, whose API has no draft that a later call
can send without someone finishing it in its web app.

`send` and `void` act only with a person's approval of that exact request:

1. `send` reads the file again and refuses it with `changed` if its SHA-256
   differs from the draft's.
2. It asks with `askUserApproval` ([Interactions](../interactions.md)),
   showing what will go out: the subject, the document's name and SHA-256,
   and every signer and cc with their email and order. The card is built from
   the draft, never from text the model wrote for it. `void` shows the
   request, its recipients and the reason.
3. Only on `approved` does it call the provider, which creates and sends the
   request in one step.

| Host | Approval |
| --- | --- |
| Pi terminal (TUI) and RPC | The approval dialog; on approve, the same call proceeds. |
| Pause/resume host | The call returns the approval interrupt (`metadata.kind: "signature_send"` or `"signature_void"`). After the person approves, the model calls the command again; the host finds the earlier result, rewritten by the host to `Approved.`, checks it names the same request and SHA-256, and proceeds. |
| Headless and child agents | Refused with `approval_required`. `PI_ASK_USER_AUTO_APPROVE` and a child agent's automatic approvals never approve `send` or `void`. |
| No channel | Refused with `approval_required`, telling the model to ask in its reply. |

The approval is read from the session's own tool results, which the model
cannot write, so it cannot claim an approval it was not given. A decline, or a
request for changes, leaves the draft and returns the person's words; to
change a draft, the agent prepares a new one.

On Introspection, a Recipe's `policies/routes.yaml` can name `signature send`
and `signature void`, so a Cedar rule or an approved mission decides them for
every provider alike
([Policy and approvals](../productivity/README.md#policy-and-approvals)). The
model never can.

## Status

`status` maps each provider's states to one set:

| Request | Means |
| --- | --- |
| `draft` | prepared in this session, not sent |
| `sent` | sent; nobody has opened it |
| `viewed` | a signer opened it |
| `completed` | everyone signed |
| `declined` | a signer declined |
| `voided` | voided by the sender, or expired |

A recipient is `pending`, `sent`, `viewed`, `signed` or `declined`, with
`signed_at` when known. Each guide gives its provider's mapping. DocuSign
allows one status read per envelope every 15 minutes, so the host keeps each
answer for the provider's `status_interval_seconds` and returns it with
`next_check_after` rather than calling again.

## Providers

| Provider | MCP server: sandbox | MCP server: production | Guide |
| --- | --- | --- | --- |
| `docusign` | `https://mcp-d.docusign.com/mcp`, a developer account | `https://mcp.docusign.com/mcp` | [DocuSign](docusign.md) |
| `dropbox-sign` | `https://mcp.dropbox.com/mcp`, with test mode | the same, without test mode | [Dropbox Sign](dropbox-sign.md) |
| `pandadoc` | `https://mcp.pandadoc.com/v1/mcp`, a sandbox workspace | the same; `mcp.pandadoc.eu` for EU accounts | [PandaDoc](pandadoc.md) |

A provider maps each command to its server's tools, each mapping marked
`verified` only once checked against a captured tool list, as
`LINEAR_MCP_TOOLS` is. A provider is offered only when every command it
declares is served by a verified mapping. A REST call is added only for a
command the server cannot serve, such as taking a file; each guide says what
the capture must settle.

## Authentication

A provider holds no credential. Each person connects the vendor's MCP server
once with the vendor's OAuth, and the host attaches their token to the
server's requests, as for any Recipe MCP server
([MCP authentication](../mcp-auth.md)). Every request runs as that person,
from their own account and plan, so the request is sent in their name. A
sandbox account connects the same way. A person who has not connected gets
`not_connected`, and the agent asks them with `introspection_open`.

## Errors

| Code | When |
| --- | --- |
| `not_ready` | the document is not a `.docx` under `outputs/`, or has tracked changes or comments |
| `anchor_not_found` | a signer's `Name:` line, or the `By:` line in its column, is not in the document |
| `ambiguous` | a signer's name is on more than one `Name:` line |
| `changed` | the file's SHA-256 differs from the draft's |
| `approval_required` | `send` or `void` cannot ask a person here |
| `not_connected` | the provider's MCP server is not bound, or the person has not connected it |
| `not_found` | the handle names nothing in this session, or the provider no longer has the request |
| `invalid_request` | arguments the message names, or a command the request's state does not allow (`send` twice, `void` once completed) |
| `rate_limited` | the provider throttled the call, with `retry_after_seconds` when it says |
| `provider_error` | the provider failed; the message quotes its error, never the request |

## Write a provider

As for [issues](../providers.md#7-the-issues-family): a module with `kind:
"signature"`, `apiVersion`, `id`, `capabilities` (`commands`, `marker`,
`status_interval_seconds`, `hosts`, `options`) and an `mcp` adapter (`url`,
`server`, `tools`). Its session implements:

- `send({ document, subject, message, signers, cc })`: create the request
  from the marked copy and send it, returning the provider's ref and status;
- `status({ ref })`;
- `void({ ref, reason })`.

`prepare` is the host's alone, so a provider never sees an unapproved draft.

## Test

- **Unit:** the docx checks and marker placement against `.docx` files built
  in the test (a two-column block, a one-cell block, a missing and a repeated
  name); the approval gate on each host row above; each provider's calls
  against a fake MCP server built from its captured tool list, which refuses
  an argument its schema lacks.
- **Recorded:** one run per provider against its sandbox, with Polly
  ([Wiring a provider](../providers.md#10-wiring-a-provider)): `prepare`,
  `send`, `status` and `void` on a dummy `acme` agreement whose signer and cc
  are the sandbox account's own test addresses, never a real recipient. The
  helper redacts tokens, account ids and addresses before the cassette is
  committed, and CI replays it.

## Deferred

- **Download** of the signed copy with its certificate.
- **List** of earlier requests, so `status` can reach one sent in another
  session.
- **Reminders, templates, embedded signing,** and signers without an email.
- **Tracked-link sharing** (DocSend), which has no API to create a link.
