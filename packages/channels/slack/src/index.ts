import { createChannelConnectorModule } from "@introspection-ai/recipes/channels";

import {
  SLACK_CHANNEL_CAPABILITIES,
  SlackChannelAdapter,
  createSlackChannelSession,
  slackChannelTarget,
} from "./adapter.js";

export {
  SlackBotSession,
  type SlackApiResult,
  type SlackBotSessionOptions,
  type SlackFetch,
  type SlackHttpResponse,
  type SlackPostResult,
} from "./client.js";
export { MAX_SLACK_FILE_BYTES, SlackFileSession } from "./files.js";
export type {
  SlackDownloadResult,
  SlackFileSessionOptions,
  SlackFileVariant,
} from "./files.js";
export { slackMessageBody, toPlainText } from "./format.js";
export type { SlackMessageBody } from "./format.js";
export { slackDownloadRoot } from "./runtime.js";
export {
  SLACK_CHANNEL_CAPABILITIES,
  SlackChannelAdapter,
  createSlackChannelSession,
  slackChannelTarget,
};

/**
 * Slack as a channel connector.
 *
 * The package supplies transport and a capability descriptor; the tool names,
 * schemas, and opaque message handles come from
 * `@introspection-ai/recipes/channels`, so Slack cannot drift from any other
 * channel and cannot grow a provider-specific tool schema of its own.
 *
 * Recipes declare the provider. Each agent then selects complete tool names in
 * its YAML file.
 *
 * ```json
 * { "pi": { "channels": [{ "provider": "slack" }] } }
 * ```
 *
 * ```yaml
 * tools: [channels]
 * ```
 *
 * Channel listing and explicit read/send targets use this session's
 * credentials. Search, directory lookup, binding authorization and
 * cross-channel reply routing are deferred.
 */
export const slackRecipeConnectorModule = createChannelConnectorModule({
  provider: "slack",
  capabilities: SLACK_CHANNEL_CAPABILITIES,
  createSession: ({ config, env, cwd }) =>
    createSlackChannelSession({ config, env, cwd }),
});

export default slackRecipeConnectorModule;
