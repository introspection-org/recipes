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

The CLI selects the Recipe and optional hydrated Pi session. The adapter copies
that snapshot into Harbor's environment, invokes `introspection local`, and
writes both native Pi events and `trajectory.json` (ATIF) under the agent log
directory. Recipe execution preserves the Harbor task image's `WORKDIR`; the
staged Recipe source is selected separately and does not replace the task's
working directory.
