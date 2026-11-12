# @introspection-ai/recipe-signature

The signature providers behind the `signature` tool of
[`@introspection-ai/recipes`](https://www.npmjs.com/package/@introspection-ai/recipes).
The first is DocuSign, through the Docusign MCP Server, with one REST upload
when the host issues no signed link to the document.

Recipes installs this package alongside itself, so a Recipe does not need to
list it; listing it in `dependencies` pins the version the Recipe uses. A
provider is a plain `RecipeSignatureProviderModule`: a capability descriptor,
the MCP tools it calls, and a session per run. The package imports only types
from Recipes; the host loads it when a Recipe declares `pi.signature`, checks
the document, asks a person to approve each send and void, and holds the
credential and the spans.

```json
{ "pi": { "signature": [{ "provider": "docusign" }] } }
```

with the vendor's MCP server bound behind the tool:

```yaml
tools: [documents, signature]
mcp:
  servers:
    docusign:
      include: ["*"]
      behind: [signature]
```

See [docs/signature/README.md](https://github.com/introspection-org/recipes/blob/main/docs/signature/README.md)
for the commands, the checks before sending and the approval.
