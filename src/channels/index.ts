export { ChannelRefStore } from "./refs.js";
export { resolveChannelConfig } from "./config.js";
export type { ChannelConfig, ChannelEnvironment } from "./config.js";
export {
  CHANNEL_TOOL_IDS,
  channelConnectorTools,
  channelToolIdsFor,
  registerChannelTools,
} from "./tools.js";
export type {
  ChannelToolHost,
  ChannelToolId,
  RegisterChannelToolsOptions,
} from "./tools.js";
export { createChannelConnectorModule } from "./module.js";
export type {
  ChannelConnectorModuleOptions,
  ChannelConnectorSession,
} from "./module.js";
export type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelAttachment,
  ChannelAuthor,
  ChannelCapabilities,
  ChannelCursor,
  ChannelFileIdentity,
  ChannelListEntry,
  ChannelReadPage,
  ChannelLocalFile,
  ChannelMessage,
  ChannelMessageIdentity,
  ChannelPostResult,
  ChannelReactionAction,
  ChannelRefResolver,
  ChannelTarget,
  FileRef,
  MessageRef,
} from "./types.js";
