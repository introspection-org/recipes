# @introspection-ai/recipe-signature

The signature provider behind the `signature` tool of
[`@introspection-ai/recipes`](https://www.npmjs.com/package/@introspection-ai/recipes):
DocuSign's eSignature REST API.

Recipes installs this package alongside itself, so a Recipe does not need to
list it; listing it in `dependencies` pins the version the Recipe uses. The
provider is a plain `RecipeSignatureProviderModule`: a capability descriptor
and a session per run. The package imports only types from Recipes; the host
loads it when a Recipe declares `pi.signature`, checks the document, asks a
person to approve each send, and holds the credential and the spans.

```json
{ "pi": { "signature": [{ "provider": "docusign" }] } }
```

`environment` defaults to `demo` (the developer sandbox); a Recipe that sends
real envelopes declares `{ "environment": "production" }`.

See [docs/signature/README.md](https://github.com/introspection-org/recipes/blob/main/docs/signature/README.md)
for the commands, the checks before sending and the approval.
