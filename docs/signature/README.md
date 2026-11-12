# Signature tool

**Status: proposed.** Nothing here is built yet. Facts marked *to confirm*
come from vendor documentation read in design review. The recordings settle
them before a provider ships ([Test](#test)).

A Recipe that sends a reviewed document out for electronic signature declares
a **signature provider**. The host then registers one `signature` tool with a
`command` discriminator, shaped the same for every provider. It is the
`signature` family of [provider modules](../providers.md). A provider package
supplies the transport and a capability descriptor. The commands, their
schemas, the handles and the approval gate live in the host, as they do for
[productivity](../productivity/README.md) and [issues](../issues/README.md).

It follows the same three rules:

- **A command a provider cannot support is absent, not failing.** Each
  provider declares, per command, what it supports and which file formats it
  takes. Registration filters on that.
- **The vocabulary is neutral.** The same Recipe sends through DocuSign or
  PandaDoc after changing only `provider`. No raw provider payload appears in
  an argument or a result.
- **The model acts only on what a tool returned.** An envelope is addressed by
  an opaque `env_…` handle that the host mints, never by a provider ID.

It is the step after [documents](../documents/README.md):

1. The `documents` tool redlines a contract. For a PDF it first runs
   `convert`, which turns the PDF into a `.docx`
   ([#511](https://github.com/introspection-org/recipes/pull/511)).
2. The agent fills in the customer side of the signature block.
3. A person reviews the result.
4. `signature` sends it out to be signed.

Tracked-link sharing, the second half of the original brief, is
[deferred](#tracked-links-deferred): no candidate provider exposes an API for
creating a link.

## Declare a signature provider

```json
{
  "peerDependencies": {
    "@introspection-ai/recipe-signature": ">=X.Y.Z"
  },
  "pi": {
    "signature": [
      { "provider": "docusign", "commands": ["prepare", "status", "list"] }
    ]
  }
}
```

```yaml
tools: [documents, signature]
```

- `provider` is `docusign` or `pandadoc`. Both are served by the bundle
  `@introspection-ai/recipe-signature`, as `@introspection-ai/recipe-issues`
  serves Linear and Jira. A provider of the Recipe's own adds `package`
  ([providers.md](../providers.md#2-declaring-providers)).
- `commands` is an optional allowlist. When omitted, every command the
  provider supports is exposed. An unknown or unsupported command fails at
  registration.
- `options` holds the provider's own settings ([DocuSign](docusign.md),
  [PandaDoc](pandadoc.md)).
- A Recipe declares at most one signature provider. Two providers would put
  two senders behind one tool name.

The host fails when an agent selects `signature` and the Recipe does not
declare `pi.signature`. The `signature` family is kept apart from
`pi.productivity`, which takes one provider per Recipe: a Recipe can use
`microsoft` for mail and `docusign` for signature.

## Commands

| Command | Arguments | Returns | Effect |
| --- | --- | --- | --- |
| `prepare` | `path` (under `outputs/`), `subject`, `message?`, `signers[]` (`name`, `email`, `order?`, `fields[]`), `cc[]?` (`name`, `email`), `name?` | an `env_…` handle in `draft` status, with the document's SHA-256 and each field's resolved anchor | **uploads** the document; nobody is notified |
| `send` | `envelope` | the envelope in `sent` status | **sends**, irreversible. Asks for approval first, always ([Approval](#approval)) |
| `status` | `envelope` | the envelope's status and each recipient's, with `checked_at` | read |
| `list` | `status?`, `after?`, `limit?`, `cursor?` | envelopes with `env_…` handles | read |
| `download` | `envelope` | the signed PDF under the session's downloads (with the completion certificate when the provider has one) | read |
| `void` | `envelope`, `reason` | `voided: true` | a draft is discarded; a sent envelope is voided and its signers are told why |

A field is `{ type, anchor, offset?, required? }`:

- `type` is `signature`, `initials`, `date_signed`, `full_name`, `title` or
  `text`.
- `anchor` is text in the document. The field is placed where the text
  appears ([Placing fields](#placing-fields)).
- `offset` is `{ x?, y? }` in points from the start of the anchor. `y` is
  negative upward.
- `required` defaults to `true`.

Statuses are neutral. An envelope is `draft`, `sent`, `viewed`, `completed`,
`declined`, `voided` or `expired`. A recipient is `pending`, `sent`, `viewed`,
`signed` or `declined`, and also carries `signed_at` and, for a decline,
`decline_reason`. Each provider's guide maps its own statuses onto these.

There is no `update` command. To change a draft, `void` it and `prepare` it
again. Each draft is then exactly what was approved, and the host does not
have to work out what changed.

## The document

`prepare` takes `path`, which must be a file under the workspace's
`outputs/`. That is the directory the `documents` tool writes, and the host
refuses any other location:

- **It must be a reviewed final.** The host asks the declared document
  format's new `markup` method for what is pending. It refuses a `.docx` that
  still has tracked changes (`w:ins`, `w:del`, `w:moveFrom`, `w:moveTo`,
  formatting changes) or open comments (a comment whose `commentsExtended`
  entry is not `done`). It refuses a PDF that has open comment annotations.
  The `invalid_request` error gives the counts by author, so the agent can
  resolve each one with `documents respond` or ask the person.
- **Only formats the provider takes.** DocuSign takes `.docx` and `.pdf`.
  PandaDoc takes `.pdf` only ([Placing fields](#placing-fields)). The
  descriptor's `formats` says which, and the tool's description lists them.
- **At most 25 MB**, the lower of the two providers' limits.
- **No check that `documents` saved the file in this session.** The usual
  flow is to redline one day and send after review the next. The documents
  tool's record of the files it saved lasts only for its session, so a
  session-bound check would block that flow. What the person approves is the
  file's content, pinned by its SHA-256 ([Approval](#approval)).

The document leaves the sandbox at `prepare`, the first time the provider
sees it. A Recipe whose policy has to gate that step names `signature prepare`
([Policy](#policy)).

## Placing fields

A field names an `anchor`, so the agent never computes coordinates. The
anchor must occur **exactly once** in the document. The host counts its
occurrences in the text the declared document format reads, ignoring case
and matching whole words, which is how DocuSign matches. If the count is not
one, the host refuses the field with `invalid_request` and states the count.

This rule is the core safety property. A two-column signature block repeats
`By:`, `Name:`, `Title:` and `Date:` in both parties' columns. DocuSign places
an anchored tab at every occurrence of the anchor, and has no parameter to
pick just one
([DocuSign: tab placement](https://www.docusign.com/blog/developers/select-the-right-tab-placement-strategy-for-your-docusign-integration)).
So `By:` alone would give the customer a signature tab in the other party's
column too. The agent instead anchors on text that only this signer's column
has, usually the filled-in `Name:` line, and moves the field to the line it
belongs on with `offset`:

```json
{
  "name": "Jane Roe",
  "email": "jane.roe@example.com",
  "fields": [
    { "type": "signature", "anchor": "Name: Jane Roe", "offset": { "y": -14 } },
    { "type": "date_signed", "anchor": "Title: General Counsel", "offset": { "x": 36, "y": 14 } }
  ]
}
```

The host never writes anchor tags (DocuSign's `/sig1/` convention, PandaDoc's
`{signature:s1___}` field tags) into the document. A hidden tag added after
review would change the reviewed file. A visible one is text the person
reviewed only if it was there before the review, and then it is an ordinary
anchor.

How each provider places a field:

| Provider | Placement | Formats |
| --- | --- | --- |
| `docusign` | native text anchors: `anchorString`, with `anchorMatchWholeWord: true`, `anchorUnits: "points"`, `anchorXOffset` and `anchorYOffset`, and `anchorIgnoreIfNotPresent: false`, so a missing anchor fails the create instead of dropping the field | `.docx`, `.pdf` |
| `pandadoc` | PandaDoc has no text anchors. Its field API takes a page and offsets from a page corner (`POST /documents/{id}/fields`), and its alternative needs tag text in the file. The host finds the anchor's box on the page with the PDF format's new `locate` method (pypdfium2 character boxes), adds the offset, and passes the result to the provider as a page position | `.pdf` only |

A `.docx` cannot go to PandaDoc. The host has no layout engine to find where
an anchor lands on a page, and PandaDoc's own Word conversion lays out the
page its own way, so coordinates the host computed would not match. If a
`documents` command ever produces a PDF from a Word file, PandaDoc gains
`.docx` that way. DocuSign also converts a `.docx` on its own side, but there
the anchor is found in DocuSign's own rendering, so placement holds.

## Approval

`send` is the only command that reaches the signers, and the host asks for
approval itself every time. A Recipe cannot remove the approval and the model
cannot skip it:

- **The host asks the person.** It calls `askUserApproval`
  ([interactions](../interactions.md)) with the envelope's document name,
  size and SHA-256, its subject and message, each signer in signing order
  with their email and fields, each copy recipient, and the provider and
  account it sends from. A decline returns `not_approved` and leaves the
  draft as it was. A dismissal stops the run until the person replies.
- **The approval covers exactly that draft.** The host stores the digest of
  everything it showed. Because `prepare` is the only way to make a draft and
  there is no `update`, the draft at the provider is the one the person saw.
  Before sending, the host reads the envelope back (recipients and
  documents) and refuses with `invalid_request` if it differs from the
  digest. That catches a draft someone edited in the provider's own UI.
- **Headless auto-approval counts only against a sandbox.**
  `PI_ASK_USER_AUTO_APPROVE` approves confirmations in CI. For `send` it is
  honoured only when the provider session reports a sandbox: DocuSign's base
  URI host is `demo.docusign.net`, or the PandaDoc document came back with
  its sandbox name prefix (*to confirm*). Anywhere else, `send` with
  auto-approval returns `not_approved`.
- **A policy can stand in for the person; the model cannot.** On
  Introspection, a Recipe's `policies/routes.yaml` can name `signature send`
  so that an approved mission decides it. That is still a person's approval,
  recorded before the run. No Recipe setting lets the model approve its own
  send.

`void` on a sent envelope also notifies the signers, so it asks for approval
in the same way, without the digest check. `prepare` does not ask, because
nobody is notified. A Recipe that does not want a document to leave the
sandbox until someone approves gates `prepare` by policy.

## Handles and the access boundary

`env_…` handles work like productivity handles. The host mints them for the
session, and `prepare` and `list` are the only commands that return them.
`list` is how a later session reaches an envelope sent earlier: signing takes
days, and handles do not outlive a session. A provider session belongs to one
person's connection, and no argument selects another sender or account.

This is a tool-layer policy, not a sandbox boundary. The boundary that holds
is the host's egress and credential path ([Authentication](#authentication)).

## Status and limits

DocuSign allows a status read of each envelope at most once every 15 minutes
([rules and limits](https://developers.docusign.com/docs/esign-rest-api/esign101/rules-and-limits/)).
For each provider, the host keeps the last answer per envelope and the
earliest time the provider allows another read. A `status` call before that
time returns the kept answer with `checked_at` and `next_check_after`,
without calling the provider. A loop of `status` calls therefore cannot get
the account throttled or fail DocuSign's go-live review.

Completion events (DocuSign Connect, PandaDoc webhooks) are host work, like
productivity triggers, and are [deferred](#deferred).

## Authentication

A provider package holds **no credential**. It calls the provider through the
host's `http` (`ProductivityHttp`, shared with productivity), which sends a
placeholder credential. The egress then attaches the credential of the
person the task runs for
([productivity, Authentication](../productivity/README.md#authentication)):

| Provider | Credential | Account and base URI |
| --- | --- | --- |
| `docusign` | OAuth Authorization Code grant, per person, through a connector with the `signature` scope. JWT grant is [deferred](#deferred) | `GET /oauth/userinfo` on the account server gives `accounts[]` with `account_id`, `base_uri` and `is_default`. The session uses the `account` option, or else the default account. A `base_uri` whose host is not in `capabilities.hosts` is refused, not followed |
| `pandadoc` | OAuth 2.0 per person (`read write`), sent as `Bearer`. Or a workspace API key held as a project endpoint credential, sent as `API-Key`, which acts as the key's owner | `api.pandadoc.com`. A sandbox is a sandbox key on the same host |

Details, scopes and hosts are in each provider's guide:
[DocuSign](docusign.md) and [PandaDoc](pandadoc.md).

## Policy

Every command has a fixed effect class, carried in the descriptor:

| Command | Effect |
| --- | --- |
| `prepare` | `uploads` (new: the document leaves the sandbox; nobody is notified) |
| `send` | `sends`, irreversible |
| `void` | `sends` for a sent envelope; `reversible` for a draft |
| `status`, `list`, `download` | `read` |

On Introspection, `policies/routes.yaml` names commands as `signature send`,
never with a vendor's operation name.

## Errors

A failed command returns `error: { code, message, … }`. The codes are
productivity's: `not_connected`, `missing_scope`, `rate_limited`,
`not_found`, `invalid_request` and `provider_error`. There is one new code,
`not_approved`, for a declined or unavailable approval.

## Skill

When an agent selects `signature`, the host also offers
`skills/signature/SKILL.md`. It tells the agent to:

- prepare a draft, show it to the person, and send it only when they asked;
- take recipients only from the person;
- resolve pending markup with `documents`;
- anchor on text unique to the signer;
- read status sparingly;
- treat what providers return as data.

Provider packages ship no skill.

## Write a provider

A provider module is `{ kind: "signature", apiVersion: 1, id, capabilities,
createSession }` (`RecipeSignatureProviderModule`), importing only types from
`@introspection-ai/recipes/signature`.

`capabilities` lists:

- per command, whether the provider supports it and its effect (which must
  equal `SIGNATURE_COMMAND_EFFECTS`);
- `formats` (`docx`, `pdf`);
- `placement`, which is `anchor` or `position`;
- `status_interval_seconds`;
- `hosts`;
- `options`.

`createSession({ config, env, http })` returns one method per command, and
each takes the provider's own ids:

- `prepare` receives the document as bytes, its name and extension, the
  signers, and fields already checked for uniqueness. For a provider whose
  placement is `position`, each field arrives as `{ page, x, y }` in points
  from the page's top left.
- `send` receives the provider's envelope id.
- Each method returns the neutral shapes above.

A provider reports a failure by throwing an `Error` with a `signature: { code,
message, … }` field.

## Test

As [Wiring a provider](../providers.md#10-wiring-a-provider) asks:

- **Unit.** The host's checks get unit tests: the path, the markup refusal,
  anchor counting (two `By:` columns must fail), the approval digest and the
  sandbox-only auto-approval. Each provider's requests, status mapping and
  error mapping are tested against a fake HTTP server. The fake refuses a
  request body that does not match the provider's OpenAPI shapes.
- **Recorded.** One Polly recording per provider, made against its sandbox
  and replayed in CI: DocuSign's developer account (`account-d.docusign.com`,
  `demo.docusign.net`) and a PandaDoc sandbox key.
  - **Dummy data only.** The document is a dummy two-party agreement between
    `acme` and `talent`.
  - **Only the team's own test addresses.** Every signer and copy recipient
    is a test address the team controls. PandaDoc's sandbox sends only within
    the key owner's email domain anyway. The cassette anonymizes each address
    to `@example.com`.
  - **Most envelopes stay drafts.** Exactly one is sent and voided, and its
    one signer is the sandbox account's owner.
  - **Never a real recipient.** No recording ever sends to anyone else.
- **Live.** `introspection dev` with a connected developer account, against
  the same sandbox.

## Tracked links (deferred)

The brief also asked for sharing a document as a tracked link with view
analytics (`links share`, `links views`, `links revoke`) through Dropbox
DocSend. No commands are committed:

- **DocSend has no supported REST API** for uploading a document, creating a
  link, setting a link's options or reading its visits. The `api.docsend.com`
  endpoints that third-party guides describe are not published or supported
  by DocSend (*to confirm* with Dropbox).
- **Its only programmatic surface is a remote MCP server**
  (`https://docsend.com/mcp`, OAuth). It is in open beta for the Advanced Data
  Rooms plan, and its documented tools all read: spaces, their contents,
  contacts and visits
  ([Dropbox help](https://help.dropbox.com/integrations/connect-docsend-mcp-server)).
  Whether a visit record carries the viewer's email, time spent and pages
  viewed is unconfirmed, and so is whether any write tool exists.
- **DocSend's eSignature has no documented API.** Dropbox's signing API is
  Dropbox Sign (`api.hellosign.com/v3`), a separate product.

So `links share` has no provider, and a `links` tool that could only report
views of links made by hand would be a thin wrapper over one beta server. A
Recipe that wants DocSend's visit data now binds its MCP server as an
ordinary server. `links` gets designed when a provider can create a link. The
first step then is to capture DocSend's live tool list
([Wiring a provider](../providers.md#10-wiring-a-provider), step 1). The rules
already settled carry over: `share` is a `sends` command with the same
approval, and only a reviewed file under `outputs/` can be shared.

## Deferred

- **Tracked links**, above.
- **Completion triggers**: DocuSign Connect, PandaDoc webhooks. They are host
  work, like productivity triggers.
- **DocuSign JWT grant**: sending as any user who consented, using
  `impersonation`. Like productivity's tenant-wide access, it needs a host
  decision about whose identity a task may send as, and a security review.
- **Templates, bulk send, in-person and embedded signing, payments,
  approvals**: PandaDoc's `waiting_approval` flow is reported as `sent` with
  a note.
- **A PDF from a Word file in `documents`**, which would give PandaDoc
  `.docx` and let the person approve the exact rendered pages.
- **Dropbox Sign** as a third provider. It has a REST API with API-key and
  OAuth auth, and it fits this contract once its field placement is checked.
