/**
 * The arguments each `channels` command takes, as the model sees them.
 * `scripts/generate-tool-schemas.mjs` turns each `Channels<Command>Arguments`
 * type into the JSON Schema in `arguments.generated.ts`: a field's doc
 * comment is its description and its tags are its limits.
 */

/**
 * Markdown, rendered in the channel's native format
 * @minLength 1
 */
type Text = string;

/**
 * A message reference a channel tool returned
 * @minLength 1
 */
type MessageRef = string;

/**
 * A provider channel id, from list
 * @minLength 1
 */
type ChannelId = string;

export interface ChannelsReplyArguments {
  text: Text;
  /** false for progress; true, the default, for the completed answer */
  final?: boolean;
}

export interface ChannelsSendArguments {
  channel_id: ChannelId;
  /**
   * A thread to post in; without it, a top-level post
   * @minLength 1
   */
  thread_id?: string;
  text: Text;
}

export type ChannelsListArguments = Record<never, never>;

export interface ChannelsReadArguments {
  /** The channel to read; default the origin */
  channel_id?: ChannelId;
  /**
   * A thread to read, or null for the channel's timeline
   * @minLength 1
   */
  thread_id?: string | null;
  /**
   * At most this many messages
   * @asType integer
   * @minimum 1
   * @maximum 100
   */
  limit?: number;
  /**
   * A cursor from the previous page, with the same target
   * @minLength 1
   */
  cursor?: string;
}

export interface ChannelsReactArguments {
  message: MessageRef;
  /**
   * Emoji name or value accepted by the current channel provider.
   * @minLength 1
   */
  emoji: string;
  /**
   * Add or remove the reaction
   * @default "add"
   */
  action?: "add" | "remove";
}

export interface ChannelsEditArguments {
  message: MessageRef;
  text: Text;
}

export interface ChannelsRetractArguments {
  message: MessageRef;
}

export interface ChannelsAttachArguments {
  /**
   * A file in the task workspace
   * @minLength 1
   */
  path: string;
  /** The file's title in the conversation */
  title?: string;
  /** A message posted with the file */
  comment?: string;
}

export interface ChannelsFetchFileArguments {
  /**
   * A file reference from read
   * @minLength 1
   * @maxLength 200
   */
  file: string;
  /**
   * A provider-specific rendition of the file; default the original
   * @minLength 1
   * @maxLength 40
   */
  variant?: string;
}

export interface ChannelsPostDocumentArguments {
  /**
   * The document's title
   * @minLength 1
   */
  title: string;
  /**
   * The document, in Markdown
   * @minLength 1
   */
  markdown: string;
}
