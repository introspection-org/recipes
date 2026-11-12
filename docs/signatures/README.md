# Signatures tool

**Status: built** (`@introspection-ai/recipes/signatures` and
`@introspection-ai/recipe-signatures`); the sandbox recording is not yet
committed ([Tests](#tests)). One `signatures` tool sends a reviewed document for
e-signature. It is the `signatures` family of
[provider modules](../providers.md), and its first provider is DocuSign's
eSignature REST API
([Envelopes: create](https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/envelopes/create)).

It is the step after the [document tools](../documents/README.md): an agent
converts a PDF contract to Word, redlines it, fills in the customer's side of
the signature block, a person reviews it, the changes are accepted, and then
the final `.docx` under `outputs/` goes out for signature.

## Why a provider, not a `documents` command

Every `documents` command works on files in the sandbox and never leaves it.
Sending for signature hands a member's document to an external service, under
a credential the host holds, to people outside the organization. That is what
provider modules are for: the host owns the credential, the egress and the
spans, and a provider module declares the hosts it calls. A Recipe that never
sends for signature never loads it.

## Declare it

```json
{
  "pi": {
    "signatures": [{ "provider": "docusign" }]
  }
}
```

```yaml
tools: [documents, signatures]
```

Nothing about signatures loads, and no `signatures` tool is offered, unless a
Recipe declares `pi.signatures` and its agent names `signatures` in its
`tools`. An agent's `include: ["*"]` does not select it: a tool that emails
people outside the organization is chosen by name. When it is selected, the
host also offers the `signatures` skill (`skills/signatures/SKILL.md`).

A declaration takes `provider`, `package` (a Recipe's own provider, as for
[every family](../providers.md#2-declaring-providers)) and `options`. One
provider per Recipe: a document is sent through one service.

| Option        | Provider   | Meaning                                                                                                                                  |
| ------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `environment` | `docusign` | `demo` (default) or `production`. `demo` reaches the developer sandbox (`account-d.docusign.com`, `demo.docusign.net`) and nothing else. |
| `account`     | `docusign` | the DocuSign account id to send from, when the person's user belongs to several; default: the user's default account                     |

A Recipe moves to `production` by saying so in its declaration; nothing in the
tool's arguments can.

## Commands

| Command  | Takes                                               | Does                                                          |
| -------- | --------------------------------------------------- | ------------------------------------------------------------- |
| `create` | `path`, `subject`, `message?`, `signers[]`, `cc?[]` | a draft envelope (DocuSign status `created`); nothing is sent |
| `send`   | `envelope`                                          | sends a draft, only after a person approves it (below)        |
| `get`    | `envelope`                                          | the envelope's status and each recipient's                    |

A signer is `{ name, email, routing_order? }`, a cc `{ name, email,
routing_order? }`. `routing_order` defaults to 1 for every signer, so all sign
in parallel; give 1, 2, … to sign in turn. A cc receives a copy once everyone
before it in the order has signed.

Every envelope comes back with a handle, `docusign:<envelopeId>`, which `send`
and `get` take, as `issues` handles do.

## `create`: what is checked before anything leaves

`create` reads the document locally and refuses, before any request, when:

- `path` is not a `.docx` under `outputs/`, the directory the document tools
  write to. The document sent is the one the redline produced, never an
  original the tools did not save. A PDF is not accepted: it never went through
  review here, and the review is what makes sending safe.
- the document has **pending tracked changes** (`w:ins`, `w:del`, moves, or
  formatting changes) in its body, headers, footers, footnotes or endnotes.
  Accept or reject them first (`documents respond`).
- the document has **comments**, open or resolved. Word keeps a resolved
  comment in the file, so a signer would receive the negotiation's notes. The
  documents tool has no command that deletes a comment yet, so the agent asks
  the person to remove them in Word, or to send without them.
- a signer's signature line cannot be found (below).

The error names what it found (`3 tracked changes`, `2 comments`), so the
agent can say exactly what is left.

### Placing the signature without coordinates

Tabs are placed with anchor strings, so no page or position is ever computed.
The obvious anchor, the `By:` and `Date:` text of the block, does not work on
its own: DocuSign places an anchored tab at **every** occurrence of its string,
and a two-column block has a `By:` in each column, so each signer would get a
signature field in the other party's column too.

So `create` finds each signer's own lines and gives them an anchor of their
own:

1. It reads the document's tables and finds the cell where the signer's name
   follows `Name:` (the line the redline filled in). The column that cell is in
   is the signer's.
2. In that column it finds the cell whose text starts with `By:`, and the one
   that starts with `Date:`, in the same table. A block that keeps every line
   in one cell is handled the same way, within that cell.
3. In the copy it sends, it adds an invisible anchor to each of those lines,
   right after the run holding the label's colon (so before any `______`
   line): `\s1\` and `\d1\` for the first signer, `\s2\` and `\d2\` for the
   second, in white 1-point text. Each anchor occurs exactly once. A page
   rendered from that copy shows nothing new; its text layer, which DocuSign's
   anchor search reads, holds each anchor once, in its signer's column.
4. The signer's tabs are a `signHere` tab anchored on `\sN\` and a
   `dateSigned` tab anchored on `\dN\`, with `anchorIgnoreIfNotPresent:
false`, so DocuSign refuses the envelope rather than send one without a
   signature field.

The file under `outputs/` is never changed; only the bytes sent carry the
anchors. A signer whose name is not on a `Name:` line, or appears on more than
one, fails `create` with `anchor_not_found` or `ambiguous`, naming the signer.
A column with no `Date:` line gets no date tab.

Other placements (a signer without a `Name:` line, initials on every page,
text fields) are not in this version.

### The envelope

`create` sends one request:

```http
POST {base_uri}/restapi/v2.1/accounts/{accountId}/envelopes
```

```json
{
  "status": "created",
  "emailSubject": "Acme MSA for signature",
  "emailBlurb": "Please sign the attached agreement.",
  "documents": [
    {
      "documentId": "1",
      "name": "acme-msa.docx",
      "fileExtension": "docx",
      "documentBase64": "<the copy with anchors>"
    }
  ],
  "recipients": {
    "signers": [
      {
        "recipientId": "1",
        "routingOrder": "1",
        "name": "Jane Doe",
        "email": "jane@example.com",
        "tabs": {
          "signHereTabs": [
            {
              "anchorString": "\\s1\\",
              "anchorUnits": "pixels",
              "anchorXOffset": "0",
              "anchorYOffset": "0",
              "anchorIgnoreIfNotPresent": "false"
            }
          ],
          "dateSignedTabs": [
            {
              "anchorString": "\\d1\\",
              "anchorUnits": "pixels",
              "anchorXOffset": "0",
              "anchorYOffset": "0",
              "anchorIgnoreIfNotPresent": "false"
            }
          ]
        }
      }
    ],
    "carbonCopies": []
  },
  "customFields": {
    "textCustomFields": [
      {
        "name": "introspection_document_sha256",
        "value": "<sha256 of the file under outputs/>",
        "show": "false",
        "required": "false"
      },
      {
        "name": "introspection_document_name",
        "value": "acme-msa.docx",
        "show": "false",
        "required": "false"
      }
    ]
  }
}
```

`status: "created"` makes a draft: DocuSign stores it and emails no one. The
document's SHA-256 and name travel with the envelope as hidden custom fields, so
`send` can show the person exactly which file they approve without trusting
the model's word for it.

## `send`: only after a person approves

`send` changes a draft's status to `sent` (`PUT
…/envelopes/{envelopeId}` with `{ "status": "sent" }`), which emails the
signers. It never happens without a person's approval, given for that
envelope:

1. `send` reads the envelope from DocuSign (`GET
…/envelopes/{envelopeId}?include=recipients,custom_fields`) and refuses one
   whose status is not `created`.
2. It asks for approval with `askUserApproval`
   ([interactions](../interactions.md)), showing what DocuSign holds, not what
   the model says: the subject, the document's name and SHA-256, and every
   signer and cc with their email and routing order.
3. It sends only on `approved`. `revision_requested` and a decline leave the
   draft as it is and return the person's feedback.

How the approval arrives depends on the host:

| Host                      | Approval                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi terminal (TUI) and RPC | The approval dialog; on `Approve`, the same call sends.                                                                                                                                                                                                                                                                                                       |
| Pause/resume host         | The call returns the approval interrupt (`metadata.kind: "signatures_send"`, with the envelope, the SHA-256 and the recipients). After the person approves, the model calls `send` again; the tool finds that call's result in the session, rewritten by the host to `Approved.`, checks that it names the same envelope, document and recipients, and sends. |
| Headless and child agents | Refused with `approval_required`. `PI_ASK_USER_AUTO_APPROVE` and a child agent's automatic approvals approve every other confirmation; they never approve a `send`.                                                                                                                                                                                           |
| No channel                | Refused with `approval_required`, telling the model to ask in its reply.                                                                                                                                                                                                                                                                                      |

The approval is read from the session's own tool results, which the model
cannot write, so a model cannot claim an approval it was not given. An
approval binds the envelope, the document's SHA-256 and the recipients; a
draft changed since (in DocuSign's web app, say) asks again.

## `get`

```http
GET {base_uri}/restapi/v2.1/accounts/{accountId}/envelopes/{envelopeId}?include=recipients,custom_fields
```

returns the envelope's status (`created`, `sent`, `delivered`, `completed`,
`declined`, `voided`), its sent and completed times, and each recipient's
status and signed time. Downloading the signed document is not in this version.

## The DocuSign provider

|           |                                                                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package   | `@introspection-ai/recipe-signatures`, a companion of Recipes like `@introspection-ai/recipe-issues`                                                                         |
| Transport | REST, through the host's HTTP (spans, a placeholder credential, retried reads; a write is sent once)                                                                         |
| Hosts     | `account-d.docusign.com` and `demo.docusign.net` (demo); `account.docusign.com` and the production base URIs `www`, `na2`, `na3`, `na4`, `eu`, `au` and `ca` `.docusign.net` |

### Credential

The provider never holds a credential: it sends a placeholder bearer token
and the egress attaches the real one, as for productivity providers
([providers](../providers.md#4-credentials)).

DocuSign issues that token by the **JWT grant**: the platform's integration
key signs a JWT with its RSA key, impersonating the person's DocuSign user,
who consents to the integration once. The grant, the key and the consent live
with the platform's integrations; the sandbox never sees any of them. A host
without an egress passes a `fetch` that attaches a token it obtained itself
(`introspection dev`, a test).

### Account and base URI

On its first call a session asks DocuSign who the token belongs to:

```http
GET https://account-d.docusign.com/oauth/userinfo
```

and takes the account named by the `account` option, or the user's default
account (`is_default`), with that account's `base_uri`. Every later request
goes to `{base_uri}/restapi/v2.1/accounts/{account_id}/…`. A `base_uri` whose
host is not one the environment declares (`demo.docusign.net` for demo, the
production list above) is refused, so a userinfo answer cannot send a document
anywhere else, and a demo declaration never reaches a production account. The
userinfo answer names the person, so it is never recorded on a span.

### Errors

| Code                | When                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------- |
| `not_ready`         | the document has tracked changes or comments, or is not a `.docx` under `outputs/`    |
| `anchor_not_found`  | a signer's `Name:` line, or the `By:` line in its column, is not in the document      |
| `ambiguous`         | a signer's name is on more than one `Name:` line                                      |
| `approval_required` | `send` cannot ask a person here: a headless run, a child agent, or no channel         |
| `invalid_request`   | arguments the message names, or an envelope that is not a draft                       |
| `not_connected`     | no DocuSign credential in this runtime (`401`, or DocuSign's `consent_required`)      |
| `not_found`         | the envelope does not exist in the account                                            |
| `provider_error`    | DocuSign failed; the message carries its `errorCode` and `message`, never the request |

## Tests

- **Unit:** the docx checks (tracked changes in each part, comments, the
  anchor placement in a two-column block and a one-cell block, a missing and a
  repeated name) against `.docx` files built in the test; the approval gate on
  every host row above; the envelope body.
- **Recorded:** one run against the DocuSign developer sandbox
  (`demo.docusign.net`) with Polly
  ([wiring a provider](../providers.md#10-wiring-a-provider)): `userinfo`,
  `create`, `get`, `send`, `get`, using a dummy document from `acme` and
  recipients at `example.com`, never a real person. The helper redacts the
  token, the account and user ids, and every email address before the
  cassette is committed; CI replays it. The test
  (`packages/signatures/test/docusign.recording.test.ts`) is skipped until a
  cassette is committed: record it with `POLLY_MODE=record` and
  `MCP_RECORD_TOKEN_FILE` holding a sandbox `access_token`.

## Not in this version

Voiding or correcting a sent envelope, downloading the signed document,
templates, embedded (in-app) signing, signers without an email, and other
signature vendors. Each is a command or a provider added later without
changing the ones above.
