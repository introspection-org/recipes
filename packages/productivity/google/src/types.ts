/**
 * The provider-side shapes of the productivity commands. Every identifier
 * here is Google's own; the host mints the `msg_…`, `evt_…` and `file_…`
 * handles the model sees from them and resolves them back before a call.
 */

export interface Page<T> {
  items: T[];
  /** Google's `nextPageToken`, opaque to the host. */
  next_cursor?: string;
}

export interface LimitedText {
  text: string;
  truncated: boolean;
  limit_chars: number;
}

export interface MailSummary {
  id: string;
  thread_id?: string;
  from?: string;
  to: string[];
  subject?: string;
  sent_at?: string;
  snippet?: string;
  /** Label names, never IDs. */
  labels: string[];
  unread: boolean;
}

export interface MailAttachment {
  /** `<message id>:<part id>`: Gmail's attachment IDs change between fetches. */
  id: string;
  filename: string;
  mime_type: string;
  size: number;
}

export interface MailMessage extends MailSummary {
  cc: string[];
  body: LimitedText & { from_html: boolean };
  attachments: MailAttachment[];
}

export interface MailThread {
  thread_id: string;
  messages: MailMessage[];
}

export interface FetchedFile {
  filename: string;
  mime_type: string;
  data: Uint8Array;
}

export interface MailSearchInput {
  query?: string;
  folder?: string;
  from?: string;
  after?: string;
  before?: string;
  unread?: boolean;
  limit?: number;
  cursor?: string;
}

export interface DraftInput {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** The message replied to (a resolved `msg_…` handle). */
  reply_to?: string;
}

export interface DraftResult {
  draft_id: string;
  message_id?: string;
  thread_id?: string;
}

export interface SentResult {
  message_id: string;
  thread_id?: string;
}

export interface EventTime {
  /** RFC 3339, for a timed event. */
  date_time?: string;
  /** `YYYY-MM-DD`, for an all-day event. */
  date?: string;
  time_zone?: string;
}

export type AttendeeResponse = "accept" | "tentative" | "decline" | "none";

export interface CalendarEventResult {
  id: string;
  title?: string;
  start: EventTime;
  end: EventTime;
  location?: string;
  body?: LimitedText;
  status?: string;
  organizer?: string;
  attendees: Array<{
    email: string;
    name?: string;
    response: AttendeeResponse;
    optional: boolean;
    self: boolean;
  }>;
  online_meeting_url?: string;
  web_url?: string;
}

export interface CalendarListInput {
  from: string;
  to: string;
  calendar?: string;
  limit?: number;
  cursor?: string;
}

export interface EventInput {
  title: string;
  start: string;
  end: string;
  time_zone: string;
  attendees?: string[];
  location?: string;
  body?: string;
  online_meeting?: boolean;
}

export interface FreeBusyResultItem {
  attendee: string;
  busy: Array<{ start: string; end: string }>;
  error?: string;
}

export interface DriveFileSummary {
  id: string;
  name: string;
  mime_type: string;
  size?: number;
  modified_at?: string;
  web_url?: string;
  /** Set for a Google Doc, Sheet or Slides file. */
  native?: "document" | "spreadsheet" | "presentation";
}

export interface DriveReadResult extends LimitedText {
  file: DriveFileSummary;
  /** The type the text was exported as, for a Google-native file. */
  exported_as?: string;
  /** Set when the file has no text form `drive read` can return. */
  binary?: boolean;
}

export interface DriveSearchInput {
  query?: string;
  folder?: string;
  modified_after?: string;
  limit?: number;
  cursor?: string;
}

export interface DriveUploadInput {
  name: string;
  mime_type: string;
  data: Uint8Array;
  folder?: string;
}
