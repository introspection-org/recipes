# Microsoft 365 productivity provider for Introspection Recipes

The Microsoft provider for the provider-neutral
[productivity tools](https://github.com/introspection-org/recipes/blob/main/docs/productivity/README.md):
`mail`, `calendar` and `drive` over a person's Outlook mail, Outlook calendar
and OneDrive, through Microsoft Graph v1.0. A Recipe uses it when its
`package.json#pi.productivity` names the `microsoft` provider.

The package supplies a small Graph client and a capability descriptor. The
tool names, schemas and handles come from
`@introspection-ai/recipes/productivity`, so a Recipe written against
`mail search` is not written against Graph.

Recipes installs this package alongside itself (an `optionalDependencies`
entry). The package has no run-time dependency on Recipes: it exports a plain
descriptor, and the host builds the tools from it. Declare it as a peer,
meaning the platform provides it, or omit it; list it in `dependencies` with
an exact version only to pin one. `X.Y.Z` stands for a released version.

```json
{
  "peerDependencies": {
    "@introspection-ai/recipe-productivity-microsoft": ">=X.Y.Z"
  },
  "pi": {
    "productivity": [{ "provider": "microsoft" }]
  }
}
```

```yaml
tools: [mail, calendar, drive]
```

The package holds no credential. It sends every request through the host,
which adds a placeholder bearer that the Introspection egress (or a host's
request hook) replaces with the person's own token, and retries a throttled
read. Reads follow `@odata.nextLink`; writes are sent once.

See the [Microsoft provider guide](https://github.com/introspection-org/recipes/blob/main/docs/productivity/microsoft.md)
for the command-to-Graph mapping, scopes and setup.
