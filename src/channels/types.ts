/**
 * Provider-neutral channel primitives.
 *
 * Reply defaults to the host-resolved origin. Adapters may opt into explicit
 * read/send destinations within their existing credential session. This is a
 * tool contract, not a sandbox-wide authorization boundary. Unsupported
 * operations are absent. Search and directory lookup are not part of it.
 */

/** A conversation within one provider credential session. */
export interface ChannelTarget {
  readonly provider: string;
  /** Provider conversation id (Slack channel, Teams conversation). */
  readonly conversation: string;
  /** Thread root within the conversation, when the origin is threaded. */
  readonly thread?: string | null;
  /** Human-readable conversation name, when the provider supplies one. */
  readonly name?: string | null;
  /** Stable link to the conversation, when the provider can produce one. */
  readonly permalink?: string | null;
}

/**
 * What a channel can actually do.
 *
 * Declared as static data by the adapter, never probed at runtime: a capability
 * that has to be discovered by failing a call is a capability the agent has
 * already wasted a turn on.
 */
export interface ChannelCapabilities {
  /** Accept explicit read targets and expose send. Absent preserves bound tools. */
  readonly targeting?: boolean;
  /** List conversations available to this provider credential session. */
  readonly list?: boolean;
  readonly react: boolean;
  readonly edit: boolean;
  readonly retract: boolean;
  /** `false`, or the widest scope the provider will return. */
  readonly read: false | "thread" | "channel";
  readonly attach: boolean;
  readonly fetchFile: boolean;
  readonly documents: false | "native" | "attachment";
  /** Enrichment performed in trusted code, not exposed as lookup tools. */
  readonly resolveAuthors: boolean;
  readonly permalinks: boolean;
}

/**
 * An opaque handle for one message.
 *
 * Never a provider id. The model cannot mint one, so it cannot name a message
 * it has not seen, and a provider changing its id format never reaches a tool
 * schema. The store behind it also records whether the agent authored the
 * message, which is what bounds `edit` and `retract`.
 */
export type MessageRef = string;

/** Whether `channel_react` adds or removes the agent's reaction. */
export type ChannelReactionAction = "add" | "remove";

/** An opaque pagination token. Same reasoning as `MessageRef`. */
export type ChannelCursor = string;

/**
 * An opaque handle for one file seen in this conversation.
 *
 * Like message refs, files must have been observed in this credential session.
 */
export type FileRef = string;

export interface ChannelAuthor {
  readonly id: string;
  readonly display_name?: string;
  readonly is_agent?: boolean;
}

export interface ChannelAttachment {
  /**
   * Opaque session handle, not the provider's file id.
   *
   * Minted when the file is seen in this credential session, and the only
   * thing `channel_fetch_file` accepts. Raw provider file IDs are not accepted.
   */
  readonly id: FileRef;
  readonly name?: string;
  readonly mime_type?: string;
  readonly size?: number;
}

/** A message handle, resolved author, and optional provider thread coordinates. */
export interface ChannelMessage {
  readonly ref: MessageRef;
  readonly author: ChannelAuthor;
  readonly text: string;
  /** Provider thread root/topic usable with the read command's thread_id. */
  readonly thread_id?: string;
  readonly reply_count?: number;
  readonly timestamp?: string;
  readonly permalink?: string;
  readonly attachments?: readonly ChannelAttachment[];
}

export interface ChannelPostResult {
  readonly ref: MessageRef;
  readonly permalink?: string;
  readonly target?: ChannelTarget;
  /**
   * Whether the platform recorded the posted thread for reply bridging. False
   * with a reason is not a failure of the post — the message is out.
   */
  readonly bridge_recorded?: boolean;
  readonly bridge_error?: string;
}

export interface ChannelReadPage {
  readonly messages: readonly ChannelMessage[];
  readonly cursor?: ChannelCursor;
  readonly target?: ChannelTarget;
  /** Direction of subsequent pages; messages within a page are chronological. */
  readonly next_direction?: "older" | "newer";
}

export interface ChannelListEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: "public_channel" | "private_channel";
}

export interface ChannelLocalFile {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly mime_type: string;
  readonly size: number;
  readonly sha256: string;
}

/** Raw message identity an adapter hands to the ref store. Never model-facing. */
export interface ChannelMessageIdentity {
  readonly conversation: string;
  readonly id: string;
  readonly thread?: string | null;
  readonly authoredByAgent?: boolean;
  readonly permalink?: string;
}

/** The provider identity behind a `FileRef`, resolvable only in-session. */
export interface ChannelFileIdentity {
  readonly conversation: string;
  readonly id: string;
  /** Read target where this file was observed; absent/null means the timeline. */
  readonly thread?: string | null;
}

/**
 * Resolves opaque handles for one session.
 *
 * Passed to adapters so they mint refs for what they return and resolve refs
 * the model hands back — an adapter never invents its own handle format.
 */
export interface ChannelRefResolver {
  message(identity: ChannelMessageIdentity): MessageRef;
  resolveMessage(ref: MessageRef): ChannelMessageIdentity;
  /** Throws unless the agent authored the message. Guards edit and retract. */
  resolveAuthored(ref: MessageRef): ChannelMessageIdentity;
  cursor(providerCursor: string): ChannelCursor;
  resolveCursor(cursor: ChannelCursor): string;
  /** Mint a handle for a file seen in this conversation. */
  file(identity: ChannelFileIdentity): FileRef;
  /** Resolve a handle back to a provider file id. Guards fetch_file. */
  resolveFile(ref: FileRef): ChannelFileIdentity;
}

export interface ChannelAdapterContext {
  readonly target: ChannelTarget;
  readonly refs: ChannelRefResolver;
  readonly signal?: AbortSignal;
}

/**
 * What a provider package implements.
 *
 * Every method takes its resolved conversation from `ChannelAdapterContext`. An
 * optional method must be present exactly when the matching capability is
 * true — `channelConnectorTools` asserts that, so a capability cannot claim
 * something the adapter cannot do.
 */
export interface ChannelAdapter {
  readonly provider: string;
  readonly capabilities: ChannelCapabilities;

  /** Add provider metadata to the trusted target before it enters the prompt. */
  enrichTarget?(ctx: ChannelAdapterContext): Promise<ChannelTarget>;
  reply(
    ctx: ChannelAdapterContext,
    input: { text: string },
  ): Promise<ChannelPostResult>;
  /** Explicit send; does not imply cross-channel reply routing support. */
  send?(
    ctx: ChannelAdapterContext,
    input: { text: string },
  ): Promise<ChannelPostResult>;
  /** List conversations available to this credential session. */
  list?(signal?: AbortSignal): Promise<readonly ChannelListEntry[]>;

  react?(
    ctx: ChannelAdapterContext,
    input: {
      ref: MessageRef;
      emoji: string;
      action: ChannelReactionAction;
    },
  ): Promise<void>;
  edit?(
    ctx: ChannelAdapterContext,
    input: { ref: MessageRef; text: string },
  ): Promise<ChannelPostResult>;
  retract?(
    ctx: ChannelAdapterContext,
    input: { ref: MessageRef },
  ): Promise<void>;
  read?(
    ctx: ChannelAdapterContext,
    input: { limit?: number; cursor?: string },
  ): Promise<ChannelReadPage>;
  attach?(
    ctx: ChannelAdapterContext,
    input: { path: string; title?: string; comment?: string },
  ): Promise<ChannelPostResult>;
  fetchFile?(
    ctx: ChannelAdapterContext,
    input: { file: FileRef; variant?: string },
  ): Promise<ChannelLocalFile>;
  postDocument?(
    ctx: ChannelAdapterContext,
    input: { title: string; markdown: string },
  ): Promise<ChannelPostResult>;
}
