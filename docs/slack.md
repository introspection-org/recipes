# Slack channel connector

`@introspection-ai/recipe-channel-slack` is the Slack adapter for the
[channel tools](channels.md). It supplies Slack Web API transport and a
capability descriptor. The `channels` tool and its command schemas are
provider-neutral, so a Recipe written against it is not written against Slack.

Slack sends inbound events to the existing Events API webhook. The tools make
ordinary HTTP requests to the Slack Web API with the bot that received the
task. The package does not use Socket Mode, WebSockets, or a streamed tool
protocol.

## Declare it

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

Commit the package manager lockfile. The host loads the package only for a
Recipe that declares the connector.

The connector registers one `channels` tool. Agents select `tools: [channels]`;
all supported commands are immediately visible. An optional connector `commands`
allowlist restricts operations for every agent using that connector.

## What Slack registers

| Tool | Slack operation |
| --- | --- |
| `channels reply` | `chat.postMessage` into the origin channel and thread |
| `channels send` | `chat.postMessage` into an explicit channel and optional thread |
| `channels list` | paged `conversations.list` returning accessible channels |
| `channels read` | `conversations.replies` in a thread, else `conversations.history` |
| `channels react` | `reactions.add` or `reactions.remove` |
| `channels edit` | `chat.update` for a message the agent posted |
| `channels retract` | `chat.delete` for a message the agent posted |
| `channels fetch_file` | `files.info` plus a private file download |

Slack history requests at most 15 messages and makes one history request per
tool call. Threads start at the beginning and page forward; channel timelines
start with recent messages and page backward. Each page is chronological, and
`next_direction` describes pagination. Repeat the target with the cursor.
This replaces the old unbounded full-thread fetch/backward session cache.
Provider rate limits still apply; failures are not automatically retried.

`channels attach` and `channels post_document` are not registered: `files.uploadV2`
and canvases are not implemented in this package yet, and the capability
descriptor says so rather than registering tools that fail.

`channels list` returns all non-archived public and private channels where the
bot is a member. `channels send` requires an explicit `channel_id` (listing first is not required); `thread_id` is
optional. `channels read` accepts optional targets, defaulting to the origin. Explicit channel without
thread means timeline/top-level, not the origin's thread. Reply stays bound.
Author display names (`users.info`) and
permalinks (`chat.getPermalink`) are resolved inside the adapter and attached to
message rows and reply results, so there is no user lookup or permalink tool.
Edit and retract also require an opaque reference for a message posted by this
agent. They cannot act on another author's message.

Search, individual channel-info lookup, joining, and directory lookup remain deferred.
Tools use one existing credential session; they do not select installations or
enforce project/customer bindings. The optional host target-policy callback
constrains these tools, not direct shell/API access.

## Cloud access

The Recipe never receives the Slack bot token. The adapter sends the task
locator to `INTROSPECTION_EGRESS_URL`, the provider proxy inside the
Introspection environment, with the Slack host as the proxy route. The proxy
verifies and removes the locator, checks the connector's granted scope and
allowed path, and adds the bot token before the request leaves for Slack.

The adapter refuses to send a task locator when the provider proxy URL is
missing. It never falls back to sending the locator to Slack.

After `channels reply` or `channels send` succeeds in cloud, the adapter posts
the `connector_posted` task event to the Data Plane. Cloud checks the agent
session, current run, and destination before recording follow-up routing.
An explicit send may attach a new thread to its issue worker when the destination
is configured for that project. Sending into an unrelated existing thread does
not claim ownership. A reply in a registered thread resumes its owning task.

The result includes the actual target. `bridge_recorded` is true only when Cloud
confirms registration, not merely when the event request succeeds. Cloud may
decline registration and return `bridge_recorded: false`.

Slack writes are attempted once. The adapter does not retry `chat.postMessage`,
because Slack accepts no idempotency key for it. If Slack accepts the post but
event recording fails, only registration is retried, up to three attempts.
Retries honor the server's `Retry-After` header and support cancellation. If
registration still fails, the tool returns the message reference,
`bridge_recorded: false`, and a `bridge_error`. It does not post again.

## Test with introspection dev

Run `introspection dev` from the Recipe repository. A Slack event sent to the
development runtime starts a cloud sandbox with the local Recipe overlay, so the
adapter uses the cloud task origin and provider proxy and needs no local Slack
credential. Use `introspection dev --logs` for sandbox logs.

Standalone channel access through `introspection local` is not supported. It
has no webhook receiver, cloud task origin, or provider proxy. Use the same
`introspection dev` workflow for inbound events and outbound channel tools.

## File downloads

`channels fetch_file` writes a file under the task files directory and returns its
path, media type, size, and SHA-256 digest. The bytes land in the workspace and
not in model context. It accepts only a `file_…` handle from a `channels read`
attachment, and resolves that reference's channel before the host policy check.
On the wire it accepts only `files.slack.com` download URLs, rejects
redirects, caps the body at 100 MiB, checks the declared size, and removes
partial files after a failure. The `video_low` variant uses Slack's smaller MP4
rendition when one exists.

## Direct host use

The package exports `SlackChannelAdapter`, `createSlackChannelSession` and
`slackChannelTarget` for custom hosts and tests, alongside the default
`slackRecipeConnectorModule`. A normal Recipe uses `pi.channels` instead.
