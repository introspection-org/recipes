// Generated from src/channels/arguments.ts by scripts/generate-tool-schemas.mjs; do not edit.
import type { ArgumentsSchema } from "../command-parameters.js";
import type {
  ChannelsReplyArguments,
  ChannelsSendArguments,
  ChannelsListArguments,
  ChannelsReadArguments,
  ChannelsReactArguments,
  ChannelsEditArguments,
  ChannelsRetractArguments,
  ChannelsAttachArguments,
  ChannelsFetchFileArguments,
  ChannelsPostDocumentArguments,
} from "./arguments.js";

export const CHANNELS_ARGUMENTS = {
  reply: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Markdown, rendered in the channel's native format",
        minLength: 1,
      },
      final: {
        type: "boolean",
        description:
          "false for progress; true, the default, for the completed answer",
      },
    },
    required: ["text"],
    additionalProperties: false,
  } as ArgumentsSchema<ChannelsReplyArguments>,
  send: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "A provider channel id, from list",
        minLength: 1,
      },
      thread_id: {
        type: "string",
        description: "A thread to post in; without it, a top-level post",
        minLength: 1,
      },
      text: {
        type: "string",
        description: "Markdown, rendered in the channel's native format",
        minLength: 1,
      },
    },
    required: ["channel_id", "text"],
    additionalProperties: false,
  } as ArgumentsSchema<ChannelsSendArguments>,
  list: {
    type: "object",
    properties: {},
    additionalProperties: false,
  } as ArgumentsSchema<ChannelsListArguments>,
  read: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The channel to read; default the origin",
        minLength: 1,
      },
      thread_id: {
        type: ["string", "null"],
        description: "A thread to read, or null for the channel's timeline",
        minLength: 1,
      },
      limit: {
        type: "integer",
        description: "At most this many messages",
        minimum: 1,
        maximum: 100,
      },
      cursor: {
        type: "string",
        description: "A cursor from the previous page, with the same target",
        minLength: 1,
      },
    },
    additionalProperties: false,
  } as ArgumentsSchema<ChannelsReadArguments>,
  react: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "A message reference a channel tool returned",
        minLength: 1,
      },
      emoji: {
        type: "string",
        description:
          "Emoji name or value accepted by the current channel provider.",
        minLength: 1,
      },
      action: {
        type: "string",
        enum: ["add", "remove"],
        description: "Add or remove the reaction",
        default: "add",
      },
    },
    required: ["message", "emoji"],
    additionalProperties: false,
  } as ArgumentsSchema<ChannelsReactArguments>,
  edit: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "A message reference a channel tool returned",
        minLength: 1,
      },
      text: {
        type: "string",
        description: "Markdown, rendered in the channel's native format",
        minLength: 1,
      },
    },
    required: ["message", "text"],
    additionalProperties: false,
  } as ArgumentsSchema<ChannelsEditArguments>,
  retract: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "A message reference a channel tool returned",
        minLength: 1,
      },
    },
    required: ["message"],
    additionalProperties: false,
  } as ArgumentsSchema<ChannelsRetractArguments>,
  attach: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "A file in the task workspace",
        minLength: 1,
      },
      title: {
        type: "string",
        description: "The file's title in the conversation",
      },
      comment: {
        type: "string",
        description: "A message posted with the file",
      },
    },
    required: ["path"],
    additionalProperties: false,
  } as ArgumentsSchema<ChannelsAttachArguments>,
  fetch_file: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "A file reference from read",
        minLength: 1,
        maxLength: 200,
      },
      variant: {
        type: "string",
        description:
          "A provider-specific rendition of the file; default the original",
        minLength: 1,
        maxLength: 40,
      },
    },
    required: ["file"],
    additionalProperties: false,
  } as ArgumentsSchema<ChannelsFetchFileArguments>,
  post_document: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "The document's title",
        minLength: 1,
      },
      markdown: {
        type: "string",
        description: "The document, in Markdown",
        minLength: 1,
      },
    },
    required: ["title", "markdown"],
    additionalProperties: false,
  } as ArgumentsSchema<ChannelsPostDocumentArguments>,
};
