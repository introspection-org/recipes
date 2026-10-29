# MCP authentication in recipe sessions

This page covers authentication after capability has been declared and selected.
Start with [MCP configuration](mcp-configuration.md) for the complete policy and
endpoint model.

Recipe MCP authentication follows the endpoint source that made an
already-approved server reachable: a configured package manifest or a local/host
binding. Authentication never selects a server or grants tools; the package and
selected-agent policies still determine the final server/tool inventory.

## Local OAuth

Local users may declare OAuth on a server in the workspace- or recipe-local
`.pi/mcp.local.json`:

```json
{
  "servers": [
    {
      "id": "linear",
      "transport": "streamable_http",
      "url": "https://mcp.linear.app/mcp",
      "auth": "oauth",
      "oauthClientId": "optional-pre-registered-client-id",
      "oauthClientSecretEnv": "LINEAR_OAUTH_CLIENT_SECRET",
      "oauthRedirectUrl": "http://127.0.0.1:8787/callback",
      "oauthScope": "optional provider-specific scopes"
    }
  ]
}
```

Only `auth: "oauth"` enables mcporter OAuth for that local definition. Recipe
startup and the agent-facing `mcp` command use cached credentials only and never
start a browser flow. A local user completes or refreshes OAuth outside the
agent session with mcporter directly, using the same server name and OAuth
settings, then retries the recipe operation. They can use their normal mcporter
config, or the generated session projection when it exists, for example:

```bash
npx mcporter auth linear --config .pi/mcporter.json
```

The session CLI does not accept OAuth URLs, ad-hoc servers, config imports, or
configuration mutation. A local user configures connectivity outside the agent
through `.pi/mcp.local.json` or their normal mcporter configuration. The agent
cannot initiate authentication.

## Hosted bindings

Hosts adapt their endpoint and credential systems into the same
`.pi/mcp.local.json` shape before starting Recipes. Header values remain
environment references, so credentials are resolved at runtime rather than
written into the recipe workspace. Deployment-specific bootstrap, token, and
egress behavior belongs to the host, not this package.

Regardless of where a Recipe runs, the agent sees one rule: MCP operations are
headless. When authentication is missing, it receives a deployment-neutral
recovery telling it to ask the user to authenticate the connection outside the
agent session and then retry; `mcp run --json-errors` reports this as
`authentication_required` with action `ask_user_to_authenticate`.
Deployment-specific credential handling is not part of the agent's
instructions.

## Agent-facing command boundary

Recipe sessions expose only `mcp search`, `mcp list`, `mcp call`, and `mcp run`.
Interactive authentication and administrative and
developer commands (`config`, `vault`, `generate-cli`, `emit-ts`, `record`,
`replay`, `daemon`, and `serve`) are intentionally unavailable. URL selectors,
ad-hoc HTTP/stdio transports, config overrides, and persistence flags are also
rejected. The upstream `--tail-log` call flag is also unavailable because it
reads an absolute local path supplied by an MCP result; server output must not
choose files for an agent session to read.

This command policy prevents accidental escape from the materialized MCP
surface. It is not an OS or network sandbox: the enclosing local shell or host
remains responsible for filesystem, process, and egress
isolation.
