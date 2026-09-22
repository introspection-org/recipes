# MCP configuration

MCP authorization is the intersection of two fail-closed policy gates: the
package boundary and the subset selected by an agent. The authorized server must
also have a reachable endpoint, supplied either by a package-declared MCP
manifest or by a local/host binding. A binding supplies connectivity; it never
expands authorization.

```text
package policy  ∩  selected-agent policy  =  authorized tools
       package.json#pi.mcp             agents/*.yaml#mcp
                              +
 endpoint from package manifest or local/host binding
                              ↓
                 CLI or Pi-registered tools
```

## 1. Declare the package boundary

`package.json#pi.mcp` declares the servers a Recipe may use and the maximum
tool set available from each one. It can also reference portable MCP manifests.

```json
{
  "pi": {
    "mcp": {
      "manifests": ["mcp.json"],
      "servers": [
        {
          "id": "contacts",
          "required": true,
          "tools": {
            "include": ["search_contacts", "get_contact"],
            "exclude": []
          }
        }
      ]
    }
  }
}
```

Prefer exact tool names. `"*"` explicitly permits the package-visible tool set,
including tools a server may add later; patterns such as `search_*` are invalid.

`manifests` is always an array of Recipe-relative paths or globs. Singular
`manifest` and string shorthand are invalid. A server marked
`"required": true` must resolve to a bound endpoint at session materialization
or the session fails closed rather than starting without the capability.

## 2. Choose an agent mode and narrow access

An agent selects a subset of the package-permitted servers and tools. It cannot
add capability that the package did not declare.

```yaml
tools:
  - bash
mcp:
  mode: cli
  servers:
    contacts:
      include:
        - search_contacts
```

Omitting a server—or the entire agent `mcp` block—means no access. `exclude`
removes exact names after inclusion and always wins. MCP tools are selected here,
not in the agent's ordinary `tools` list.

`mode: cli` creates the session-local `mcp` command.

`mode: tools` registers every authorized MCP tool with Pi. Server-local
`defer` selectors control which authorized tools start hidden from the model;
`eager` subtracts exceptions from that deferred set:

```yaml
mcp:
  mode: tools
  servers:
    contacts:
      include: ["*"]
      defer: ["*"]
      eager:
        - search_contacts
```

Omit `defer` to expose every authorized tool immediately. Use `defer: ["*"]`
to hide all authorized tools for a server, then optionally list exact tools in
`eager` to expose those tools at startup. Both fields accept exact tool names
or a sole `"*"` selector. `eager` wins when a tool matches both fields, but
neither field can authorize a tool excluded by `include`/`exclude`.

Deferred tools remain authorized and discoverable. When at least one connector
or MCP tool is deferred, Recipes registers `tool_search`. Calling it searches
the inactive tools already allowed for the agent and adds the best matches to
Pi's active tool set for the next model request. It never grants access beyond
the Recipe manifest and agent policy. Recipes also registers `mcp_search` as a
compatibility alias when MCP tools are deferred.

`defer` and `eager` are invalid in CLI mode. An omitted agent `mcp` block
inherits its base policy. Once a child declares `mcp`, the complete block
replaces the inherited policy; restate its mode, servers, authorization, and
activation selectors. This makes external capability changes reviewable at the
derived agent. Every resolved agent owns its mode independently.

## 3. Supply endpoint configuration

A referenced MCP manifest can carry a portable configured endpoint and catalog.
When connectivity varies by environment, provide an endpoint and credential
references in `.pi/mcp.local.json` for local runs, or through a host binding:

```json
{
  "servers": [
    {
      "id": "contacts",
      "transport": "streamable_http",
      "url": "https://contacts.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${CONTACTS_MCP_TOKEN}"
      }
    }
  ]
}
```

The `${CONTACTS_MCP_TOKEN}` reference is resolved from the environment at launch,
so export it before running the recipe locally:

```bash
export CONTACTS_MCP_TOKEN='...'
pi --recipe . --agent agent
```

Do not commit or distribute `.pi/mcp.local.json`; Recipe validation rejects
local configuration. Commit `.pi/mcp.local.example.json` when a binding template
is helpful. A host binds its own endpoint and credential system to the same
shape. A binding overrides a package-manifest endpoint with the same id,
but a server that the package or selected agent does not permit remains
unavailable.

When the local file is absent, manifest-supplied endpoints remain usable.
Required servers that need environment-specific bindings fail closed until the
local Pi environment or embedding host supplies them.

## Use capabilities from an agent

In CLI mode, Recipes creates a session-local `mcp` command containing only the
selected agent's authorized tools. Delegating to another agent does not grant
the parent direct access to that child's MCP capabilities. Discover narrowly,
inspect one schema, then call or compose:

```bash
mcp search "contact lookup"
mcp list contacts.search_contacts --schema
mcp call contacts.search_contacts query="Ada Lovelace"
```

The command is headless and cannot add servers, mutate configuration, or start
browser authentication. See [MCP authentication](mcp-auth.md) for OAuth and
hosted binding details, and [Recipes extension](pi-extension.md) for the
full session contract.

In tools mode, each Pi session—including each delegated child session—gets its
own registered tool catalog and active set. The MCP daemon and mcporter config
remain private to those wrappers; shell tools do not receive an `mcp` command,
`MCPORTER_CONFIG`, or MCP session path.

Pi receives each tool's MCP input schema. If the server declares
`outputSchema`, Recipes retains and validates it locally against successful
`structuredContent`; providers do not currently receive it as a tool
declaration field. Text, image, resource, resource-link, audio, and structured
results are normalized to Pi tool results. Duplicate structured JSON text is
removed, errors become ordinary failed tool calls, and model-visible text is
bounded to 50 KiB or 2,000 lines by default.
