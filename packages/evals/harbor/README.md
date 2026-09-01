# `introspection-harbor`

Harbor installed-agent adapter for local Introspection Recipes. Install it
through `introspection setup --target harbor`, then run a task through:

```sh
introspection eval run --runner harbor --path evals/refund-task
```

Select an inherited Recipe agent variant by its declared YAML `name`:

```sh
introspection eval run --runner harbor --path evals/refund-task --agent agent2
```

For example, `agents/agent2.yaml` can declare `name: agent2` and `from: agent`,
then override only its model, tools, extensions, or other variant settings.
The selected agent YAML is the only source of the evaluated model; the CLI and
adapter do not apply a separate model override.

The CLI selects the Recipe and optional canonical replay context. The adapter
copies that opaque context into Harbor's environment and forwards its path to
`introspection local`, which creates the temporary native Pi session immediately
before Pi starts. The adapter writes both native Pi events and
`trajectory.json` (ATIF) under the agent log directory. Recipe execution
preserves the Harbor task image's `WORKDIR`; the staged Recipe source is
selected separately and does not replace the task's working directory.

## E2B through scoped Data Plane egress

Operator can use E2B without Docker Compose and without receiving a real E2B,
OpenAI, or Anthropic key. Configure E2B in the Data Plane's
`sandbox_providers`; `weight: 0` keeps it out of normal traffic while allowing
an explicitly pinned Operator task to use it. Then select the Introspection
environment class in the arguments forwarded to Harbor:

```sh
introspection eval run --runner harbor --path evals/refund-task -- \
  --env introspection_harbor.environment:IntrospectionE2BEnvironment
```

Harbor's native E2B implementation still owns preflight, template operations,
sandbox creation, resources, and networking. The adapter only adds the public
egress contract through Harbor's supported `persistent_env` constructor input.
The Data Plane exchanges the scoped session locator for credentials after
authorization. Model inference returns through that public egress path; model
provider keys are never copied into the E2B environment. Adding a Kubernetes
Agent Sandbox provider therefore does not require changing the CLI runner or
task API.

The platform Operator image sets
`INTROSPECTION_HARBOR_ENVIRONMENT=introspection_harbor.environment:IntrospectionE2BEnvironment`.
When the variable is set, `introspection eval run` supplies that environment to
Harbor unless the caller explicitly passes `--env` or `-e`. Ordinary developer
installs leave it unset, so the same command keeps Harbor's local Docker default.

When none of the three Introspection egress variables are set, the same class
adds no egress configuration and Harbor uses E2B's normal environment and
credentials. A partial egress contract is rejected rather than silently mixing
direct and routed traffic.

## End-to-end MCP example

[recipe-harbor-mcp-agent](https://github.com/introspection-org/recipe-harbor-mcp-agent)
runs a Harbor trial in E2B while its Recipe calls a tiny MCP server on the
developer's machine through `introspection dev`. It has no Docker Compose
dependency. The Recipe declares a logical MCP id, so the local development
bridge can later be replaced with an Introspection MCP endpoint binding without
changing the Recipe or Harbor task.

From the example directory, run each command in a separate terminal. First
start the included hello-world MCP server:

```sh
git clone git@github.com:introspection-org/recipe-harbor-mcp-agent.git
cd recipe-harbor-mcp-agent
introspection runtimes create
uv run --with 'fastmcp>=2.0' mcp/server.py
```

Before involving Harbor or E2B, verify the Recipe locally with Pi. In another
terminal, configure the ignored local binding, provide the model credential
selected by `agents/agent.yaml`, and run one prompt:

```sh
cd recipe-harbor-mcp-agent
introspection setup --yes
cp .pi/mcp.local.example.json .pi/mcp.local.json
export ANTHROPIC_API_KEY='...'
introspection local \
  --runtime hello-mcp \
  --agent agent \
  --print 'Call the hello MCP get_greeting tool and return exactly its result.'
```

This local mode runs the Recipe's Pi coding agent directly on the developer's
machine. Pi resolves logical server `hello` from the ignored
`.pi/mcp.local.json`, calls `hello.get_greeting`, and returns
`hello from the local MCP`. The committed example binding contains only the
loopback endpoint and no credential. This is a quick check of the Recipe,
agent-level MCP authorization, and server before testing either Harbor or the
development tunnel.

The Harbor task adds one more piece of work: the same Pi agent must call that
tool and write its exact result to `/app/greeting.txt`; Harbor's deterministic
verifier checks that file. Harbor and `introspection_harbor` run in the local
evaluation process (or later in Operator), not inside the evaluated Recipe
image.

Next attach that local server to the Recipe's development Runtime, leaving the
command running while the evaluation executes:

```sh
cd recipe-harbor-mcp-agent
introspection dev --runtime hello-mcp \
  --mcp=hello=http://localhost:8010/mcp
```

Finally start the Harbor trial in E2B:

```sh
cd recipe-harbor-mcp-agent
introspection eval run \
  --runner harbor \
  --runtime hello-mcp \
  --path harbor-task \
  -- \
  --env introspection_harbor.environment:IntrospectionE2BEnvironment
```

The Recipe inside E2B calls `hello.get_greeting` through the development tunnel
and writes the response for Harbor's verifier. See the standalone repository's
README for prerequisites and the equivalent proxy configuration.
