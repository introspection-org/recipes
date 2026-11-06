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

Each command names its backend in the descriptor. A command marked `mcp` is
served by Google's Workspace MCP server for that product when the Recipe
declares it as an MCP server (ids `gmail`, `calendar`, `drive`) and the
session can call the expected tool, through Pi's in-process MCP client
(`mcp.mode: codemode`, Pi 1.3.0 or newer); otherwise by Google's REST APIs. `mail send`, `mail fetch_attachment`, `calendar free_busy`,
`drive download` and `drive upload` are REST only. The expected MCP tool
names (`EXPECTED_MCP_TOOLS`) and the Calendar and Drive MCP hosts are still
to be confirmed against the live servers.

## Credentials

The package holds no credential. It sends a placeholder bearer, and the
host's egress attaches the person's own token for the hosts the connector
declares: `gmail.googleapis.com`, the Workspace MCP hosts (which the Recipe's
MCP bindings name), and
`www.googleapis.com` limited to `/calendar/v3/`, `/drive/v3/` and
`/upload/drive/v3/`. Use `introspection dev` to test a productivity Recipe
against a connected account.

See the [Google provider guide](https://github.com/introspection-org/recipes/blob/main/docs/productivity/google.md)
for the command mapping, scopes, setup and errors.
