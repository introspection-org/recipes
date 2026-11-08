# @introspection-ai/recipe-issues

The issues providers behind the `issues` tool of
[`@introspection-ai/recipes`](https://www.npmjs.com/package/@introspection-ai/recipes):
Linear and Jira through their vendors' MCP servers, and Introspection's own
issues through the JavaScript SDK.

Recipes installs this package alongside itself, so a Recipe does not need to
list it; listing it in `dependencies` pins the version the Recipe uses. Each
provider is a plain `RecipeIssuesProviderModule`: a capability descriptor and
a session per run. The package imports only types from Recipes; the host
loads it when a Recipe declares `pi.issues` and holds the credentials, the MCP
transport and the spans.

```json
{ "pi": { "issues": [{ "provider": "linear", "team": "ENG" }] } }
```

See [docs/issues/README.md](https://github.com/introspection-org/recipes/blob/main/docs/issues/README.md)
for the shape, what each provider supports, and the tool maps still to be
checked against captured tool lists.
