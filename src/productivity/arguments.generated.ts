// Generated from src/productivity/arguments.ts by scripts/generate-tool-schemas.mjs; do not edit.
import type { ArgumentsSchema } from "../command-parameters.js";
import type {
  MailSearchArguments,
  MailReadArguments,
  MailFetchAttachmentArguments,
  MailDraftArguments,
  MailUpdateDraftArguments,
  MailSendArguments,
  MailMoveArguments,
  MailLabelArguments,
  CalendarListArguments,
  CalendarReadArguments,
  CalendarFreeBusyArguments,
  CalendarCreateArguments,
  CalendarUpdateArguments,
  CalendarRespondArguments,
  CalendarCancelArguments,
  DriveSearchArguments,
  DriveReadArguments,
  DriveDownloadArguments,
  DriveUploadArguments,
} from "./arguments.js";

export const MAIL_ARGUMENTS = {
  search: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Words to search for",
        minLength: 1,
        maxLength: 1000,
      },
      folder: {
        type: "string",
        description: "A {folder} name, such as inbox",
        minLength: 1,
        maxLength: 200,
      },
      from: {
        type: "string",
        description: "Sender address or name",
        minLength: 1,
        maxLength: 320,
      },
      after: { type: "string", description: "RFC 3339 time with offset" },
      before: { type: "string", description: "RFC 3339 time with offset" },
      unread: {
        type: "boolean",
        description: "true for unread messages only, false for read ones only",
      },
      limit: {
        type: "integer",
        description: "At most this many results",
        minimum: 1,
        maximum: 100,
        default: 25,
      },
      cursor: {
        type: "string",
        description: "A cursor from the previous page, with the same arguments",
        minLength: 1,
      },
    },
    additionalProperties: false,
  } as ArgumentsSchema<MailSearchArguments>,
  read: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "A message handle (msg_…)",
        minLength: 1,
      },
      thread: {
        type: "string",
        description: "A thread handle (thr_…)",
        minLength: 1,
      },
    },
    additionalProperties: false,
  } as ArgumentsSchema<MailReadArguments>,
  fetch_attachment: {
    type: "object",
    properties: {
      attachment: {
        type: "string",
        description: "An attachment handle (att_…) from mail read",
        minLength: 1,
      },
    },
    required: ["attachment"],
    additionalProperties: false,
  } as ArgumentsSchema<MailFetchAttachmentArguments>,
  draft: {
    type: "object",
    properties: {
      to: {
        type: "array",
        items: { type: "string", minLength: 3, maxLength: 320 },
        description:
          "Recipient addresses; with reply_to, default the replied-to message's sender",
        maxItems: 100,
      },
      cc: {
        type: "array",
        items: { type: "string", minLength: 3, maxLength: 320 },
        description: "Copied addresses",
        maxItems: 100,
      },
      subject: {
        type: "string",
        description:
          'The subject line; with reply_to, default "Re: " and the replied-to subject',
        maxLength: 1000,
      },
      body: {
        type: "string",
        description: "The message, in Markdown",
        maxLength: 200000,
      },
      reply_to: {
        type: "string",
        description: "A message handle to reply to",
        minLength: 1,
      },
    },
    required: ["body"],
    additionalProperties: false,
  } as ArgumentsSchema<MailDraftArguments>,
  update_draft: {
    type: "object",
    properties: {
      draft: {
        type: "string",
        description: "A draft handle from mail draft",
        minLength: 1,
      },
      to: {
        type: "array",
        items: { type: "string", minLength: 3, maxLength: 320 },
        description: "Recipient addresses",
        maxItems: 100,
      },
      cc: {
        type: "array",
        items: { type: "string", minLength: 3, maxLength: 320 },
        description: "Copied addresses",
        maxItems: 100,
      },
      subject: {
        type: "string",
        description: "The subject line",
        maxLength: 1000,
      },
      body: {
        type: "string",
        description: "The message, in Markdown",
        maxLength: 200000,
      },
    },
    required: ["draft"],
    additionalProperties: false,
  } as ArgumentsSchema<MailUpdateDraftArguments>,
  send: {
    type: "object",
    properties: {
      draft: {
        type: "string",
        description: "A draft handle from mail draft",
        minLength: 1,
      },
    },
    required: ["draft"],
    additionalProperties: false,
  } as ArgumentsSchema<MailSendArguments>,
  move: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "A message handle (msg_…)",
        minLength: 1,
      },
      folder: {
        type: "string",
        description: "A {folder} name, such as inbox",
        minLength: 1,
        maxLength: 200,
      },
    },
    required: ["message", "folder"],
    additionalProperties: false,
  } as ArgumentsSchema<MailMoveArguments>,
  label: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "A message handle (msg_…)",
        minLength: 1,
      },
      add: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 200 },
        description: "The {labels} to add",
        maxItems: 50,
      },
      remove: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 200 },
        description: "The {labels} to remove",
        maxItems: 50,
      },
    },
    required: ["message"],
    additionalProperties: false,
  } as ArgumentsSchema<MailLabelArguments>,
};
export const CALENDAR_ARGUMENTS = {
  list: {
    type: "object",
    properties: {
      from: {
        type: "string",
        description:
          "RFC 3339 time with offset; default the start of today in the person's time zone",
      },
      to: {
        type: "string",
        description:
          "RFC 3339 time with offset; default the end of tomorrow in the person's time zone",
      },
      calendar: {
        type: "string",
        description: "A calendar name; default the primary calendar",
        minLength: 1,
        maxLength: 200,
      },
      limit: {
        type: "integer",
        description: "At most this many results",
        minimum: 1,
        maximum: 100,
        default: 25,
      },
      cursor: {
        type: "string",
        description: "A cursor from the previous page, with the same arguments",
        minLength: 1,
      },
    },
    additionalProperties: false,
  } as ArgumentsSchema<CalendarListArguments>,
  read: {
    type: "object",
    properties: {
      event: {
        type: "string",
        description: "An event handle (evt_…)",
        minLength: 1,
      },
    },
    required: ["event"],
    additionalProperties: false,
  } as ArgumentsSchema<CalendarReadArguments>,
  free_busy: {
    type: "object",
    properties: {
      attendees: {
        type: "array",
        items: { type: "string", minLength: 3, maxLength: 320 },
        description: "The addresses whose busy times to read",
        minItems: 1,
        maxItems: 50,
      },
      from: { type: "string", description: "RFC 3339 time with offset" },
      to: { type: "string", description: "RFC 3339 time with offset" },
      time_zone: {
        type: "string",
        description: "IANA time zone, such as America/New_York",
        minLength: 1,
      },
    },
    required: ["attendees", "from", "to", "time_zone"],
    additionalProperties: false,
  } as ArgumentsSchema<CalendarFreeBusyArguments>,
  create: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "The event's title",
        minLength: 1,
        maxLength: 1000,
      },
      start: {
        type: "string",
        description:
          "RFC 3339 date-time, read in time_zone; a date when all_day",
      },
      end: {
        type: "string",
        description:
          "RFC 3339 date-time, read in time_zone; a date when all_day",
      },
      time_zone: {
        type: "string",
        description: "IANA time zone, such as America/New_York",
        minLength: 1,
      },
      all_day: {
        type: "boolean",
        description: "An all-day event: start and end are dates (YYYY-MM-DD)",
      },
      attendees: {
        type: "array",
        items: { type: "string", minLength: 3, maxLength: 320 },
        description: "Attendee addresses; on update, the full list",
        maxItems: 100,
      },
      location: {
        type: "string",
        description: "Where the event is",
        maxLength: 1000,
      },
      body: {
        type: "string",
        description: "The event's description, in Markdown",
        maxLength: 100000,
      },
      online_meeting: {
        type: "boolean",
        description: "Add an online meeting link",
      },
    },
    required: ["title", "start", "end", "time_zone"],
    additionalProperties: false,
  } as ArgumentsSchema<CalendarCreateArguments>,
  update: {
    type: "object",
    properties: {
      event: {
        type: "string",
        description: "An event handle (evt_…)",
        minLength: 1,
      },
      title: {
        type: "string",
        description: "The event's title",
        minLength: 1,
        maxLength: 1000,
      },
      start: {
        type: "string",
        description:
          "RFC 3339 date-time, read in time_zone; a date when all_day",
      },
      end: {
        type: "string",
        description:
          "RFC 3339 date-time, read in time_zone; a date when all_day",
      },
      time_zone: {
        type: "string",
        description: "IANA time zone, such as America/New_York",
        minLength: 1,
      },
      all_day: {
        type: "boolean",
        description: "An all-day event: start and end are dates (YYYY-MM-DD)",
      },
      attendees: {
        type: "array",
        items: { type: "string", minLength: 3, maxLength: 320 },
        description: "Attendee addresses; on update, the full list",
        maxItems: 100,
      },
      location: {
        type: "string",
        description: "Where the event is",
        maxLength: 1000,
      },
      body: {
        type: "string",
        description: "The event's description, in Markdown",
        maxLength: 100000,
      },
      online_meeting: {
        type: "boolean",
        description: "Add an online meeting link",
      },
    },
    required: ["event"],
    additionalProperties: false,
  } as ArgumentsSchema<CalendarUpdateArguments>,
  respond: {
    type: "object",
    properties: {
      event: {
        type: "string",
        description: "An event handle (evt_…)",
        minLength: 1,
      },
      response: {
        type: "string",
        enum: ["accept", "tentative", "decline"],
        description: "The person's answer",
      },
      comment: {
        type: "string",
        description: "A note sent to the organizer or attendees",
        maxLength: 10000,
      },
    },
    required: ["event", "response"],
    additionalProperties: false,
  } as ArgumentsSchema<CalendarRespondArguments>,
  cancel: {
    type: "object",
    properties: {
      event: {
        type: "string",
        description: "An event handle (evt_…)",
        minLength: 1,
      },
      comment: {
        type: "string",
        description: "A note sent to the organizer or attendees",
        maxLength: 10000,
      },
    },
    required: ["event"],
    additionalProperties: false,
  } as ArgumentsSchema<CalendarCancelArguments>,
};
export const DRIVE_ARGUMENTS = {
  search: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Words to search for",
        minLength: 1,
        maxLength: 1000,
      },
      folder: {
        type: "string",
        description:
          "A folder's file handle; without it, the whole drive, or its root for upload",
        minLength: 1,
      },
      modified_after: {
        type: "string",
        description: "RFC 3339 time with offset",
      },
      limit: {
        type: "integer",
        description: "At most this many results",
        minimum: 1,
        maximum: 100,
        default: 25,
      },
      cursor: {
        type: "string",
        description: "A cursor from the previous page, with the same arguments",
        minLength: 1,
      },
    },
    required: ["query"],
    additionalProperties: false,
  } as ArgumentsSchema<DriveSearchArguments>,
  read: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "A file handle (file_…)",
        minLength: 1,
      },
    },
    required: ["file"],
    additionalProperties: false,
  } as ArgumentsSchema<DriveReadArguments>,
  download: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "A file handle (file_…)",
        minLength: 1,
      },
    },
    required: ["file"],
    additionalProperties: false,
  } as ArgumentsSchema<DriveDownloadArguments>,
  upload: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "A file under outputs/",
        minLength: 1,
      },
      folder: {
        type: "string",
        description:
          "A folder's file handle; without it, the whole drive, or its root for upload",
        minLength: 1,
      },
      name: {
        type: "string",
        description: "The new file's name; default the local file's name",
        minLength: 1,
        maxLength: 255,
      },
    },
    required: ["path"],
    additionalProperties: false,
  } as ArgumentsSchema<DriveUploadArguments>,
};
