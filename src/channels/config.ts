export type ChannelEnvironment = Record<string, string | undefined>;

/** Provider-neutral destination supplied by the Recipe host. */
export interface ChannelConfig {
  provider: string;
  channel_ref: string;
  thread_ref: string | null;
}

/** Read the channel destination shared by every provider package. */
export function resolveChannelConfig(
  env: ChannelEnvironment = process.env,
): ChannelConfig | null {
  const provider = env.INTROSPECTION_TASK_CHANNEL_PROVIDER?.trim();
  const channelRef = env.INTROSPECTION_TASK_CHANNEL_ID?.trim();
  if (!provider || !channelRef) return null;

  return {
    provider,
    channel_ref: channelRef,
    thread_ref: env.INTROSPECTION_TASK_THREAD_ID?.trim() || null,
  };
}
