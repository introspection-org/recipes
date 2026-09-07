# Slack connector for Introspection Recipes

The Slack adapter for the provider-neutral
[channel tools](https://github.com/introspection-org/recipes/blob/main/docs/channels.md).
A Recipe installs it when its `package.json#pi.channels` list includes the
`slack` provider.

The package supplies Slack Web API transport and a capability descriptor. The
tool names and schemas come from `@introspection-ai/recipes/channels`, so a
Recipe written against `channels reply` is not written against Slack.

```json
{
  "dependencies": {
    "@introspection-ai/recipe-channel-slack": "^0.2.0"
  },
  "pi": {
    "channels": [
      {
        "provider": "slack"
      }
    ]
  }
}
```

`channels reply` answers the origin. `channels list` returns the public and
private channels available to the bot. `channels send` takes an explicit channel
and optional thread; `channels read` accepts optional channel/thread targets.
Recipe authors select tools in the agent YAML:

```yaml
tools: [channels]
```

Targets use the existing connection. This package does not add backend binding
authorization or cross-channel reply routing. Handles are session-local. Thread
reads page forward in bounded requests; channel timelines page backward.
Thread pages count the root toward `limit` and include it only once. Opaque
cursors retain overflow and an exclusive timestamp boundary, avoiding Slack's
repeated-root and cursor-ordering quirks. Reaction add/remove are idempotent
when the requested reaction state already exists.

Use `introspection dev` to test channel recipes. The cloud runtime installs the
locked production dependencies and receives Slack events for your local Recipe
files. Standalone channel access through `introspection local` is not supported.

The package calls the Slack Web API. It does not use Socket Mode, WebSockets,
or streaming. Operations outside the declared `channels` command set are
unsupported.

See the [Slack connector guide](https://github.com/introspection-org/recipes/blob/main/docs/slack.md)
for tool behavior and testing.

### Follow-up routing

Confirmed Slack posts are reported through the existing `connector_posted` task event. Cloud may attach a newly posted thread to its issue worker when the destination is configured for that project. Sending into an unrelated existing thread does not claim ownership. `bridge_recorded` reflects Cloud's routing decision, not merely a successful HTTP response.

Transient registration failures retry only the task event, never the Slack post. If registration remains unavailable, the result retains the posted message reference and a `bridge_error`; do not resend the message to repair routing. This bounded retry is not a durable outbox: a process failure between Slack accepting the post and Cloud recording it still needs reconciliation.
