/**
 * The arguments each `mail`, `calendar` and `drive` command takes, as the
 * model sees them. `scripts/generate-tool-schemas.mjs` turns each
 * `<Tool><Command>Arguments` type into the JSON Schema in
 * `arguments.generated.ts`: a field's doc comment is its description and its
 * tags are its limits. `{folder}` and `{labels}` are filled in at
 * registration with the provider's own words.
 */

/**
 * @minLength 3
 * @maxLength 320
 */
type Email = string;

/**
 * @minLength 1
 * @maxLength 200
 */
type LabelName = string;

/**
 * At most this many results
 * @asType integer
 * @minimum 1
 * @maximum 100
 * @default 25
 */
type Limit = number;

/**
 * A cursor from the previous page, with the same arguments
 * @minLength 1
 */
type Cursor = string;

/**
 * Words to search for
 * @minLength 1
 * @maxLength 1000
 */
type Query = string;

/** RFC 3339 time with offset */
type Instant = string;

/**
 * A message handle (msg_…)
 * @minLength 1
 */
type MessageHandle = string;

/**
 * A {folder} name, such as inbox
 * @minLength 1
 * @maxLength 200
 */
type FolderName = string;

/**
 * A draft handle from mail draft
 * @minLength 1
 */
type DraftHandle = string;

/**
 * Recipient addresses
 * @maxItems 100
 */
type Recipients = Email[];

/**
 * Copied addresses
 * @maxItems 100
 */
type Copied = Email[];

/**
 * The subject line
 * @maxLength 1000
 */
type Subject = string;

/**
 * The message, in Markdown
 * @maxLength 200000
 */
type MailBody = string;

export interface MailSearchArguments {
  query?: Query;
  folder?: FolderName;
  /**
   * Sender address or name
   * @minLength 1
   * @maxLength 320
   */
  from?: string;
  after?: Instant;
  before?: Instant;
  /** true for unread messages only, false for read ones only */
  unread?: boolean;
  limit?: Limit;
  cursor?: Cursor;
}

export interface MailReadArguments {
  message?: MessageHandle;
  /**
   * A thread handle (thr_…)
   * @minLength 1
   */
  thread?: string;
}

export interface MailFetchAttachmentArguments {
  /**
   * An attachment handle (att_…) from mail read
   * @minLength 1
   */
  attachment: string;
}

/**
 * Recipient addresses; with reply_to, default the replied-to message's sender
 * @maxItems 100
 */
type DraftRecipients = Email[];

/**
 * The subject line; with reply_to, default "Re: " and the replied-to subject
 * @maxLength 1000
 */
type DraftSubject = string;

export interface MailDraftArguments {
  to?: DraftRecipients;
  cc?: Copied;
  subject?: DraftSubject;
  body: MailBody;
  /**
   * A message handle to reply to
   * @minLength 1
   */
  reply_to?: string;
}

export interface MailUpdateDraftArguments {
  draft: DraftHandle;
  to?: Recipients;
  cc?: Copied;
  subject?: Subject;
  body?: MailBody;
}

export interface MailSendArguments {
  draft: DraftHandle;
}

export interface MailMoveArguments {
  message: MessageHandle;
  folder: FolderName;
}

export interface MailLabelArguments {
  message: MessageHandle;
  /**
   * The {labels} to add
   * @maxItems 50
   */
  add?: LabelName[];
  /**
   * The {labels} to remove
   * @maxItems 50
   */
  remove?: LabelName[];
}

/**
 * An event handle (evt_…)
 * @minLength 1
 */
type EventHandle = string;

/**
 * IANA time zone, such as America/New_York
 * @minLength 1
 */
type TimeZone = string;

/** RFC 3339 date-time, read in time_zone; a date when all_day */
type EventTime = string;

/**
 * The event's title
 * @minLength 1
 * @maxLength 1000
 */
type Title = string;

/** An all-day event: start and end are dates (YYYY-MM-DD) */
type AllDay = boolean;

/**
 * Attendee addresses; on update, the full list
 * @maxItems 100
 */
type Attendees = Email[];

/**
 * Where the event is
 * @maxLength 1000
 */
type Location = string;

/**
 * The event's description, in Markdown
 * @maxLength 100000
 */
type EventBody = string;

/** Add an online meeting link */
type OnlineMeeting = boolean;

/**
 * A note sent to the organizer or attendees
 * @maxLength 10000
 */
type Comment = string;

/** RFC 3339 time with offset; default the start of today in the person's time zone */
type ListFrom = string;

/** RFC 3339 time with offset; default the end of tomorrow in the person's time zone */
type ListTo = string;

export interface CalendarListArguments {
  from?: ListFrom;
  to?: ListTo;
  /**
   * A calendar name; default the primary calendar
   * @minLength 1
   * @maxLength 200
   */
  calendar?: string;
  limit?: Limit;
  cursor?: Cursor;
}

export interface CalendarReadArguments {
  event: EventHandle;
}

export interface CalendarFreeBusyArguments {
  /**
   * The addresses whose busy times to read
   * @minItems 1
   * @maxItems 50
   */
  attendees: Email[];
  from: Instant;
  to: Instant;
  time_zone: TimeZone;
}

export interface CalendarCreateArguments {
  title: Title;
  start: EventTime;
  end: EventTime;
  time_zone: TimeZone;
  all_day?: AllDay;
  attendees?: Attendees;
  location?: Location;
  body?: EventBody;
  online_meeting?: OnlineMeeting;
}

export interface CalendarUpdateArguments {
  event: EventHandle;
  title?: Title;
  start?: EventTime;
  end?: EventTime;
  time_zone?: TimeZone;
  all_day?: AllDay;
  attendees?: Attendees;
  location?: Location;
  body?: EventBody;
  online_meeting?: OnlineMeeting;
}

export interface CalendarRespondArguments {
  event: EventHandle;
  /** The person's answer */
  response: "accept" | "tentative" | "decline";
  comment?: Comment;
}

export interface CalendarCancelArguments {
  event: EventHandle;
  comment?: Comment;
}

/**
 * A file handle (file_…)
 * @minLength 1
 */
type FileHandle = string;

/**
 * A folder's file handle; without it, the whole drive, or its root for upload
 * @minLength 1
 */
type FolderHandle = string;

export interface DriveSearchArguments {
  query: Query;
  folder?: FolderHandle;
  modified_after?: Instant;
  limit?: Limit;
  cursor?: Cursor;
}

export interface DriveReadArguments {
  file: FileHandle;
}

export interface DriveDownloadArguments {
  file: FileHandle;
}

export interface DriveUploadArguments {
  /**
   * A file under outputs/
   * @minLength 1
   */
  path: string;
  folder?: FolderHandle;
  /**
   * The new file's name; default the local file's name
   * @minLength 1
   * @maxLength 255
   */
  name?: string;
}
