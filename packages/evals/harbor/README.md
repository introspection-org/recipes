# `introspection-harbor`

Harbor installed-agent adapter for Introspection Recipes. Install it through
`introspection setup --target harbor`, then run a task through:

```sh
introspection eval run --runner harbor --path evals/refund-task
```

Select an inherited Recipe agent variant by its declared YAML `name`:

```sh
introspection eval run --runner harbor --path evals/refund-task --agent agent2
```

The selected agent YAML is the only source of the evaluated model; the CLI and
adapter do not apply a separate model override.

## What the adapter does

The trial image is the Runtime image the Data Plane published for the Recipe,
so the Recipe (`/opt/introspection/recipe`), Pi, the Recipes extension, and the
Introspection CLI are already inside it. The adapter installs nothing. Per
trial it:

1. writes a `pi` launcher for the image's own Pi when the image has none on
   `PATH` (the Operator image already provides one);
2. uploads the Harbor instruction, or the CLI-selected replay prompt, as a
   prompt file and runs the baked Recipe:

   ```sh
   pi --recipe /opt/introspection/recipe \
     --print --mode json --approve \
     @/tmp/introspection-eval-prompt.md
   ```

   A production-conversation replay runs the same command through
   `introspection local --replay-context`, which creates the temporary native
   Pi session immediately before Pi starts;
3. captures Pi's JSON event stream as `pi.jsonl` under the agent log directory
   and converts it into `trajectory.json` (ATIF) with token usage, cost, and
   the observed model, which `introspection eval run` verifies against the
   agent YAML.

Recipe source is never uploaded, patched, or dependency-installed inside the
trial. Test a changed Recipe by publishing it as a new Runtime version.

## E2B through scoped Data Plane egress

Operator can use E2B without receiving a real E2B, OpenAI, or Anthropic key.
Configure E2B in the Data Plane's `sandbox_providers`; `weight: 0` keeps it out
of normal traffic while allowing an explicitly pinned Operator task to use it.
Then select the Introspection environment class in the arguments forwarded to
Harbor, naming the Runtime's published template:

```sh
introspection eval run --runner harbor --path evals/refund-task -- \
  --env introspection_harbor.environment:IntrospectionE2BEnvironment \
  --environment-kwarg "template_name=$(introspection runtimes get "$RUNTIME_ID" \
    --query image_build_metadata.external_image_name -o json | jq -r .)"
```

Harbor's native E2B implementation still owns preflight, sandbox creation,
resources, and networking. The adapter only:

- skips Harbor's template build when `template_name` names a published
  Runtime template, and defaults the task workdir to the baked Recipe;
- copies the scoped public-egress contract (`INTROSPECTION_TOKEN`,
  `INTROSPECTION_PUBLIC_EGRESS_URL` as the trial's `INTROSPECTION_EGRESS_URL`,
  `INTROSPECTION_ENDPOINT_HOSTS`, and `INTROSPECTION_RELAY_TARGET` when set)
  into the trial through Harbor's supported `persistent_env` input. A template
  snapshot carries no session state, so this is the only way the baked Pi
  learns where its egress is. The Data Plane exchanges the locator for
  credentials at egress; model provider keys never enter the trial;
- forwards the host variables named in `INTROSPECTION_HARBOR_PASSTHROUGH_ENV`
  (comma-separated) for direct, non-egress runs such as a laptop trial with a
  developer's own provider key.

The platform Operator image sets
`INTROSPECTION_HARBOR_ENVIRONMENT=introspection_harbor.environment:IntrospectionE2BEnvironment`.
When the variable is set, `introspection eval run` supplies that environment to
Harbor unless the caller explicitly passes `--env` or `-e`. Ordinary developer
installs leave it unset, so the same command keeps Harbor's local Docker default.

When none of the three Introspection egress variables are set, the same class
adds no egress configuration and Harbor uses E2B's normal environment and
credentials. A partial egress contract is rejected rather than silently mixing
direct and routed traffic.

## Where this is heading

The adapter has two seams: how the Recipe is launched (`run`) and how the
result is collected (`populate_context_post_run`). Today the launch executes Pi
inside a Harbor-owned sandbox and the result is read back from that sandbox as
`pi.jsonl`. A bare `pi` process exports no telemetry, so nothing from a trial
reaches the platform's conversation store.

The intended end state keeps Harbor as the trial orchestrator but moves both
seams onto the platform: the launch becomes a task on the Runtime, and the
result is read from that task's conversation and judgement events, which the
Runtime already exports. That removes the direct E2B dependency and the
file-based verifier from the path, and a Recipe judge becomes the reward.

## End-to-end MCP example

[recipe-harbor-mcp-agent](https://github.com/introspection-org/recipe-harbor-mcp-agent)
runs a Harbor trial in E2B against a published Runtime whose Recipe calls an
authenticated MCP server. See that repository's README for the setup and the
`scripts/run-e2b.sh` helper.
