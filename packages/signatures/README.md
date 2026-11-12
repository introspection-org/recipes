# @introspection-ai/recipe-signatures

The signatures provider behind the `signatures` tool of
[`@introspection-ai/recipes`](https://www.npmjs.com/package/@introspection-ai/recipes):
DocuSign's eSignature REST API.

Recipes installs this package alongside itself, so a Recipe does not need to
list it; listing it in `dependencies` pins the version the Recipe uses. The
provider is a plain `RecipeSignaturesProviderModule`: a capability descriptor
and a session per run. The package imports only types from Recipes; the host
loads it when a Recipe declares `pi.signatures`, checks the document, asks a
person to approve each send, and holds the credential and the spans.

```json
{ "pi": { "signatures": [{ "provider": "docusign" }] } }
```

`environment` defaults to `demo` (the developer sandbox); a Recipe that sends
real envelopes declares `{ "environment": "production" }`.

See [docs/signatures/README.md](https://github.com/introspection-org/recipes/blob/main/docs/signatures/README.md)
for the commands, the checks before sending and the approval.
