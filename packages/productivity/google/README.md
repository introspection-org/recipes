# Google productivity provider for Introspection Recipes

The Google provider for the provider-neutral
[productivity tools](https://github.com/introspection-org/recipes/blob/main/docs/productivity/README.md):
`mail`, `calendar` and `drive` over a person's Gmail, Google Calendar and
Google Drive. A Recipe uses it when its `package.json#pi.productivity` names
the `google` provider.

The package supplies the transport and a capability descriptor. The tool
names, schemas and handles come from `@introspection-ai/recipes/productivity`,
so a Recipe written against `mail search` is not written against Gmail.

Recipes installs this package alongside itself (an `optionalDependencies`
entry). The package has no run-time dependency on Recipes: it exports a plain
descriptor, and the host builds the tools from it. Declare it as a peer,
meaning the platform provides it, or omit it; list it in `dependencies` with
an exact version only to pin one. `X.Y.Z` stands for a released version
(`npm view @introspection-ai/recipe-productivity-google version`).

```json
{
  "peerDependencies": {
    "@introspection-ai/recipe-productivity-google": ">=X.Y.Z"
  },
  "pi": {
    "productivity": [{ "provider": "google" }]
  }
}
```

```yaml
tools: [mail, calendar, drive]
```

## Backends

Every command is served by Google's REST APIs. Google's Workspace MCP servers
are in developer preview; an MCP path can return once they are generally
available and their tool names are confirmed.

## Credentials

The package holds no credential. It sends a placeholder bearer, and the
host's egress attaches the person's own token for the hosts the connector
declares: `gmail.googleapis.com`, and `www.googleapis.com` limited to
`/calendar/v3/`, `/drive/v3/` and `/upload/drive/v3/`. Use `introspection dev` to test a productivity Recipe
against a connected account.

See the [Google provider guide](https://github.com/introspection-org/recipes/blob/main/docs/productivity/google.md)
for the command mapping, scopes, setup and errors.
