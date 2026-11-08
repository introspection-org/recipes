import type {
  CalendarAttendee,
  CalendarAttendeeResponse,
  CalendarCancelArgs,
  CalendarCreateArgs,
  CalendarEvent,
  CalendarEventSummary,
  CalendarFreeBusyArgs,
  CalendarFreeBusyResult,
  CalendarListArgs,
  CalendarListResult,
  CalendarReadArgs,
  CalendarRespondArgs,
  CalendarSession,
  CalendarUpdateArgs,
  DriveDownloadArgs,
  DriveFileSummary,
  DriveReadArgs,
  DriveReadResult,
  DriveSearchArgs,
  DriveSearchResult,
  DriveSession,
  DriveUploadArgs,
  MailDraft,
  MailDraftArgs,
  MailFetchAttachmentArgs,
  MailLabelArgs,
  MailMessage,
  MailMessageSummary,
  MailMoveArgs,
  MailReadArgs,
  MailReadResult,
  MailSearchArgs,
  MailSearchResult,
  MailSendArgs,
  MailSendResult,
  MailSession,
  MailUpdateDraftArgs,
  Pages,
  ProductivityAddress,
  ProductivityCallContext,
  ProductivityContent,
  ProductivityFileContent,
} from "@introspection-ai/recipes/productivity";

import {
  type CalendarAttendee as GoogleAttendee,
  CalendarClient,
  type CalendarDateTime,
  type CalendarEvent as GoogleEvent,
} from "./calendar.js";
import { composeRawMessage, replySubject } from "./compose.js";
import {
  DriveClient,
  type DriveFile,
  driveSearchQuery,
  isGoogleNative,
  isTextType,
  MAX_DOWNLOAD_BYTES,
  nativeExport,
} from "./drive.js";
import { GoogleProductivityError, isSizeLimit } from "./errors.js";
import { decodeEventId, encodeEventId, PRIMARY_CALENDAR } from "./event-id.js";
import { GmailClient, type GmailLabel, type GmailMessage } from "./gmail.js";
import type { GoogleTransport } from "./http.js";
import {
  decodeBase64Url,
  encodeBase64Url,
  findPart,
  header,
  type ParsedMailBody,
  parseMailPayload,
  splitAddresses,
} from "./mime.js";

const SYSTEM_LABELS = new Set([
  "INBOX",
  "SPAM",
  "TRASH",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "SENT",
  "DRAFT",
]);
/** Labels Gmail sets itself, which `mail move` and `mail label` may not. */
const IMMUTABLE_LABELS = new Set(["SENT", "DRAFT"]);
const FOLDER_TYPE = "application/vnd.google-apps.folder";

function invalid(message: string): GoogleProductivityError {
  return new GoogleProductivityError("invalid_request", message);
}

/** The host has checked `value` is an RFC 3339 time with an offset. */
function epochSeconds(value: string): number {
  return Math.floor(Date.parse(value) / 1000);
}

/** A Gmail search operand, quoted only when it holds whitespace. */
function gmailOperand(value: string): string {
  const bare = value.replace(/"/g, "");
  return /\s/.test(bare) ? `"${bare}"` : bare;
}

/**
 * `Name <a@b>` or `a@b` as an address. Parsed without a regular expression: a
 * header comes from whoever sent the mail, and a backtracking pattern stalls on
 * a long run of spaces.
 */
function parseAddress(value: string): ProductivityAddress {
  const trimmed = value.trim();
  const open = trimmed.indexOf("<");
  const email =
    open < 0 || !trimmed.endsWith(">") ? "" : trimmed.slice(open + 1, -1);
  let name = open < 0 ? "" : trimmed.slice(0, open).trimEnd();
  if (name.startsWith('"')) name = name.slice(1);
  if (name.endsWith('"')) name = name.slice(0, -1);
  if (email === "" || email.includes(">") || name.includes('"'))
    return { email: trimmed };
  name = name.trim();
  return { email: email.trim(), ...(name ? { name } : {}) };
}

function addresses(value: string | undefined): ProductivityAddress[] {
  return splitAddresses(value).map(parseAddress);
}

function sentAt(message: GmailMessage): string | undefined {
  if (message.internalDate && /^\d+$/.test(message.internalDate)) {
    return new Date(Number(message.internalDate)).toISOString();
  }
  const date = header(message.payload, "Date");
  const ms = date ? Date.parse(date) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * Who a reply goes to when the draft names no one, as Gmail's Reply does: the
 * parent's `Reply-To`, else its `From`, or its `To` when the person sent it.
 */
function replyRecipients(parent: GmailMessage): string[] {
  const payload = parent.payload;
  const replyTo = parent.labelIds?.includes("SENT")
    ? addresses(header(payload, "To"))
    : addresses(header(payload, "Reply-To"));
  const to = replyTo.length ? replyTo : addresses(header(payload, "From"));
  // Bare addresses: a decoded display name may not be ASCII, which a header cannot carry raw.
  return to.map((address) => address.email);
}

function textContent(text: string): ProductivityContent {
  return { content_type: "text", content: text };
}

/** Recipient headers a draft update cannot carry, so it refuses rather than drop them. */
const UNKEPT_RECIPIENT_HEADERS = [
  "Reply-To",
  "Resent-To",
  "Resent-Cc",
  "Resent-Bcc",
];

/** The largest body part Gmail stores apart from the message that a read fetches. */
const MAX_STORED_BODY_BYTES = 5 * 1024 * 1024;

function readResult(
  read: readonly { message: MailMessage; unavailable?: string }[],
): MailReadResult {
  const notes = read.flatMap((item) => item.unavailable ?? []);
  return {
    messages: read.map((item) => item.message),
    ...(notes.length ? { unavailable: notes.join(" ") } : {}),
  };
}

/** Gmail over REST (`gmail/v1`): every `mail` command. */
export class GoogleRestMail implements Required<MailSession> {
  private labels?: Promise<GmailLabel[]>;

  constructor(
    readonly gmail: GmailClient,
    private readonly pages: Pages,
  ) {}

  private labelList(signal?: AbortSignal): Promise<GmailLabel[]> {
    this.labels ??= this.gmail.listLabels(signal).catch((error: unknown) => {
      this.labels = undefined;
      throw error;
    });
    return this.labels;
  }

  /** A label ID from its name (case-insensitive) or a system label's ID. */
  async labelId(name: string, signal?: AbortSignal): Promise<string> {
    const wanted = name.trim();
    if (SYSTEM_LABELS.has(wanted.toUpperCase())) return wanted.toUpperCase();
    const labels = await this.labelList(signal);
    const found =
      labels.find((label) => label.name === wanted) ??
      labels.find((label) => label.name.toLowerCase() === wanted.toLowerCase());
    if (!found) throw invalid(`No Gmail label is named '${wanted}'.`);
    return found.id;
  }

  async labelNames(
    ids: string[] | undefined,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (!ids?.length) return [];
    const labels = await this.labelList(signal);
    const byId = new Map(labels.map((label) => [label.id, label.name]));
    return ids.map((id) => byId.get(id) ?? id);
  }

  /** The `q` and `labelIds` for `users.messages.list` from neutral filters. */
  private async searchQuery(
    args: Omit<MailSearchArgs, "limit">,
    signal?: AbortSignal,
  ): Promise<{ q?: string; labelIds?: string[]; includeSpamTrash?: true }> {
    const terms: string[] = [];
    if (args.query?.trim()) terms.push(args.query.trim());
    if (args.from?.trim()) terms.push(`from:${gmailOperand(args.from.trim())}`);
    if (args.after) terms.push(`after:${epochSeconds(args.after)}`);
    if (args.before) terms.push(`before:${epochSeconds(args.before)}`);
    if (args.unread === true) terms.push("is:unread");
    if (args.unread === false) terms.push("-is:unread");
    const label = args.folder
      ? await this.labelId(args.folder, signal)
      : undefined;
    return {
      q: terms.length ? terms.join(" ") : undefined,
      labelIds: label ? [label] : undefined,
      // `messages.list` leaves out spam and trash unless asked.
      ...(label === "SPAM" || label === "TRASH"
        ? { includeSpamTrash: true as const }
        : {}),
    };
  }

  async summary(
    message: GmailMessage,
    signal?: AbortSignal,
  ): Promise<MailMessageSummary> {
    const from = header(message.payload, "From");
    const cc = addresses(header(message.payload, "Cc"));
    const parsed = parseMailPayload(message.payload);
    return {
      id: message.id,
      thread_id: message.threadId,
      ...(from ? { from: parseAddress(from) } : {}),
      to: addresses(header(message.payload, "To")),
      ...(cc.length ? { cc } : {}),
      subject: header(message.payload, "Subject"),
      snippet: message.snippet,
      sent_at: sentAt(message),
      unread: message.labelIds?.includes("UNREAD") ?? false,
      has_attachments: parsed.attachments.length > 0,
      labels: await this.labelNames(message.labelIds, signal),
      is_draft: message.labelIds?.includes("DRAFT") ?? false,
    };
  }

  /** A message read in full; a body Gmail stores apart is fetched, or said to be missing. */
  async message(
    message: GmailMessage,
    signal?: AbortSignal,
  ): Promise<{ message: MailMessage; unavailable?: string }> {
    const { parsed, unavailable } = await this.parse(message, signal);
    return {
      message: await this.mailMessage(message, parsed, signal),
      ...(unavailable ? { unavailable } : {}),
    };
  }

  /** A message's body and attachments, fetching a body part Gmail stores apart. */
  private async parse(
    message: GmailMessage,
    signal?: AbortSignal,
  ): Promise<{ parsed: ParsedMailBody; unavailable?: string }> {
    const parsed = parseMailPayload(message.payload);
    const stored = parsed.part?.body;
    if (!stored?.attachmentId || stored.data) return { parsed };
    if ((stored.size ?? 0) > MAX_STORED_BODY_BYTES)
      return {
        parsed,
        unavailable: `A message body is larger than ${MAX_STORED_BODY_BYTES / (1024 * 1024)} MB, so it was not read.`,
      };
    try {
      stored.data = encodeBase64Url(
        await this.gmail.getAttachment(message.id, stored.attachmentId, signal),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        parsed,
        unavailable: `A message body could not be read: ${(error as Error).message}`,
      };
    }
    return { parsed: parseMailPayload(message.payload) };
  }

  private async mailMessage(
    message: GmailMessage,
    parsed: ParsedMailBody,
    signal?: AbortSignal,
  ): Promise<MailMessage> {
    return {
      ...(await this.summary(message, signal)),
      body: parsed.body,
      attachments: parsed.attachments.map((attachment) => ({
        id: attachment.partId,
        name: attachment.filename,
        mime_type: attachment.mimeType,
        size: attachment.size,
      })),
    };
  }

  async search(
    args: MailSearchArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<MailSearchResult> {
    const query = await this.searchQuery(args, ctx.signal);
    const page = await this.pages({
      fetch: (pageToken, maxResults) =>
        this.gmail.listMessages(
          { ...query, maxResults, pageToken },
          ctx.signal,
        ),
      items: (found) => found.items,
      next: "nextPageToken",
      limit: args.limit,
      ...(args.cursor ? { cursor: args.cursor } : {}),
    });
    const messages = await Promise.all(
      page.items.map(async (ref) =>
        this.summary(
          await this.gmail.getMessage(ref.id, "structure", ctx.signal),
          ctx.signal,
        ),
      ),
    );
    return { messages, cursor: page.cursor };
  }

  async read(
    args: MailReadArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<MailReadResult> {
    if ("message_id" in args) {
      const message = await this.gmail.getMessage(
        args.message_id,
        "full",
        ctx.signal,
      );
      return readResult([await this.message(message, ctx.signal)]);
    }
    const thread = await this.gmail.getThread(args.thread_id, ctx.signal);
    return readResult(
      await Promise.all(
        (thread.messages ?? []).map((message) =>
          this.message(message, ctx.signal),
        ),
      ),
    );
  }

  /**
   * `attachment_id` is the part's `partId`: Gmail's `attachmentId` changes
   * between fetches of the same message, so it is looked up afresh here.
   */
  async fetchAttachment(
    args: MailFetchAttachmentArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<ProductivityFileContent> {
    const message = await this.gmail.getMessage(
      args.message_id,
      "full",
      ctx.signal,
    );
    const part = findPart(message.payload, args.attachment_id);
    if (!part) {
      throw new GoogleProductivityError(
        "not_found",
        "The attachment is no longer on the message.",
      );
    }
    if ((part.body?.size ?? 0) > MAX_DOWNLOAD_BYTES) {
      throw new GoogleProductivityError(
        "invalid_request",
        `The attachment is larger than the ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB limit, so it was not fetched.`,
        { limitBytes: MAX_DOWNLOAD_BYTES },
      );
    }
    const bytes = part.body?.attachmentId
      ? await this.gmail.getAttachment(
          args.message_id,
          part.body.attachmentId,
          ctx.signal,
        )
      : decodeBase64Url(part.body?.data ?? "");
    return {
      name: part.filename || "attachment",
      mime_type: part.mimeType ?? "application/octet-stream",
      bytes,
    };
  }

  private draftResult(
    draft: { id: string; message?: GmailMessage },
    fields: { to: readonly string[]; cc?: readonly string[]; subject: string },
    threadId?: string,
  ): MailDraft {
    return {
      id: draft.id,
      message_id: draft.message?.id,
      thread_id: draft.message?.threadId ?? threadId,
      to: fields.to.map(parseAddress),
      cc: (fields.cc ?? []).map(parseAddress),
      subject: fields.subject,
    };
  }

  async draft(
    args: MailDraftArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<MailDraft> {
    let threadId: string | undefined;
    let inReplyTo: { messageId?: string; references?: string } | undefined;
    let subject = args.subject;
    let to = [...args.to];
    if (args.reply_to_id) {
      const parent = await this.gmail.getMessage(
        args.reply_to_id,
        "full",
        ctx.signal,
      );
      threadId = parent.threadId;
      inReplyTo = {
        messageId: header(parent.payload, "Message-ID"),
        references: header(parent.payload, "References"),
      };
      if (!subject.trim())
        subject = replySubject(header(parent.payload, "Subject"));
      if (to.length === 0) to = replyRecipients(parent);
      if (to.length === 0)
        throw invalid("The message has no sender to reply to; pass `to`.");
    }
    const fields = { to, cc: [...(args.cc ?? [])], subject };
    const raw = composeRawMessage({ ...fields, body: args.body, inReplyTo });
    const draft = await this.gmail.createDraft(raw, threadId, ctx.signal);
    return this.draftResult(draft, fields, threadId);
  }

  async updateDraft(
    args: MailUpdateDraftArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<MailDraft> {
    const current = await this.gmail.getDraft(args.draft_id, ctx.signal);
    const payload = current.message?.payload;
    const parent = header(payload, "In-Reply-To");
    // The rebuilt message carries only the body, To, Cc and Bcc, and Gmail
    // replaces the whole draft.
    if (parseMailPayload(payload).attachments.length > 0)
      throw invalid(
        "This draft has attachments, which an update would remove. The draft was not changed.",
      );
    const lost = UNKEPT_RECIPIENT_HEADERS.filter((name) =>
      header(payload, name)?.trim(),
    );
    if (lost.length > 0)
      throw invalid(
        `This draft has ${lost.join(", ")}, which an update would remove. The draft was not changed.`,
      );
    let kept: ProductivityContent | undefined;
    if (args.body === undefined && current.message) {
      const { parsed, unavailable } = await this.parse(
        current.message,
        ctx.signal,
      );
      // Writing the draft without its body would erase it.
      if (unavailable)
        throw invalid(`${unavailable} The draft was not changed; give body.`);
      kept = parsed.body;
    }
    const fields = {
      to: args.to ? [...args.to] : splitAddresses(header(payload, "To")),
      cc: args.cc ? [...args.cc] : splitAddresses(header(payload, "Cc")),
      subject: args.subject ?? header(payload, "Subject") ?? "",
    };
    const bcc = splitAddresses(header(payload, "Bcc"));
    const raw = composeRawMessage({
      ...fields,
      ...(bcc.length ? { bcc } : {}),
      body: args.body ?? kept?.content ?? "",
      html: kept?.content_type === "html",
      inReplyTo: {
        messageId: parent,
        // References already ends with the parent, which composing appends again.
        references: header(payload, "References")
          ?.split(/\s+/)
          .filter((id) => id && id !== parent)
          .join(" "),
      },
    });
    const threadId = current.message?.threadId;
    const draft = await this.gmail.updateDraft(
      args.draft_id,
      raw,
      threadId,
      ctx.signal,
    );
    return this.draftResult(draft, fields, threadId);
  }

  /** Always REST, so a policy sees one path for the only command that sends mail. */
  async send(
    args: MailSendArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<MailSendResult> {
    const sent = await this.gmail.sendDraft(args.draft_id, ctx.signal);
    return { message_id: sent.id, thread_id: sent.threadId };
  }

  private assertMutable(ids: string[]): void {
    const fixed = ids.find((id) => IMMUTABLE_LABELS.has(id));
    if (fixed)
      throw invalid(
        `Gmail sets ${fixed} itself; it cannot be added or removed.`,
      );
  }

  /** The label IDs `mail label` adds and removes, from label names. */
  private async labelChange(
    args: Omit<MailLabelArgs, "message_id">,
    signal?: AbortSignal,
  ): Promise<{ addLabelIds: string[]; removeLabelIds: string[] }> {
    const addLabelIds = await Promise.all(
      (args.add ?? []).map((name) => this.labelId(name, signal)),
    );
    const removeLabelIds = await Promise.all(
      (args.remove ?? []).map((name) => this.labelId(name, signal)),
    );
    this.assertMutable([...addLabelIds, ...removeLabelIds]);
    return { addLabelIds, removeLabelIds };
  }

  /**
   * Gmail has no folders: moving adds the folder's label and takes the message
   * out of the inbox, and `archive` only takes it out of the inbox.
   */
  private async moveChange(
    folder: string,
    signal?: AbortSignal,
  ): Promise<{ addLabelIds: string[]; removeLabelIds: string[] }> {
    const archive = folder.trim().toLowerCase() === "archive";
    const target = archive ? undefined : await this.labelId(folder, signal);
    if (target) this.assertMutable([target]);
    return target === "INBOX"
      ? { addLabelIds: ["INBOX"], removeLabelIds: [] }
      : { addLabelIds: target ? [target] : [], removeLabelIds: ["INBOX"] };
  }

  async label(
    args: MailLabelArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<MailMessageSummary> {
    const change = await this.labelChange(args, ctx.signal);
    const message = await this.gmail.modifyMessage(
      args.message_id,
      change,
      ctx.signal,
    );
    return this.summaryAfterChange(message, ctx.signal);
  }

  async move(
    args: MailMoveArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<MailMessageSummary> {
    const change = await this.moveChange(args.folder, ctx.signal);
    const message = await this.gmail.modifyMessage(
      args.message_id,
      change,
      ctx.signal,
    );
    return this.summaryAfterChange(message, ctx.signal);
  }

  /** `messages.modify` answers with IDs and labels only; headers need a read. */
  private async summaryAfterChange(
    modified: GmailMessage,
    signal?: AbortSignal,
  ): Promise<MailMessageSummary> {
    const message = modified.payload
      ? modified
      : await this.gmail.getMessage(modified.id, "structure", signal);
    return this.summary(message, signal);
  }
}

const ATTENDEE_RESPONSES: Record<string, CalendarAttendeeResponse> = {
  accepted: "accepted",
  tentative: "tentative",
  declined: "declined",
  needsAction: "none",
};
const GOOGLE_RESPONSES = {
  accept: "accepted",
  tentative: "tentative",
  decline: "declined",
} as const;

/** The host has checked the time against `all_day` and the zone's name. */
function eventDateTime(
  value: string,
  timeZone: string,
  allDay: boolean | undefined,
): CalendarDateTime {
  return allDay ? { date: value } : { dateTime: value, timeZone };
}

/** `Etc/GMT-1` for `+01:00`: the IANA zone of a whole-hour offset; UTC otherwise. */
function offsetZone(dateTime: string | undefined): string | undefined {
  const match = /([+-])(\d{2}):00$/.exec(dateTime ?? "");
  if (!match || match[2] === "00") return undefined;
  return `Etc/GMT${match[1] === "+" ? "-" : "+"}${Number(match[2])}`;
}

function looksLikeHtml(text: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(text);
}

function attendeeResponse(
  attendee: GoogleAttendee | undefined,
): CalendarAttendeeResponse | undefined {
  if (!attendee) return undefined;
  if (attendee.organizer) return "organizer";
  return ATTENDEE_RESPONSES[attendee.responseStatus ?? "needsAction"] ?? "none";
}

/** A Google event as the neutral summary, its times in the event's own zone. */
function eventSummary(
  event: GoogleEvent,
  calendarZone = "UTC",
  calendarId = PRIMARY_CALENDAR,
): CalendarEventSummary {
  const allDay = Boolean(event.start?.date);
  const self = event.attendees?.find((attendee) => attendee.self);
  const video = event.conferenceData?.entryPoints?.find(
    (entry) => entry.entryPointType === "video",
  )?.uri;
  return {
    id: encodeEventId(calendarId, event.id ?? ""),
    title: event.summary,
    start: (allDay ? event.start?.date : event.start?.dateTime) ?? "",
    end: (allDay ? event.end?.date : event.end?.dateTime) ?? "",
    time_zone: event.start?.timeZone ?? calendarZone,
    ...(allDay ? { all_day: true } : {}),
    location: event.location,
    ...(event.organizer?.email
      ? {
          organizer: {
            email: event.organizer.email,
            ...(event.organizer.displayName
              ? { name: event.organizer.displayName }
              : {}),
          },
        }
      : {}),
    is_organizer: event.organizer?.self ?? false,
    response: event.organizer?.self ? "organizer" : attendeeResponse(self),
    cancelled: event.status === "cancelled",
    online_meeting_url: video ?? event.hangoutLink,
    web_link: event.htmlLink,
  };
}

function eventDetail(
  event: GoogleEvent,
  calendarZone?: string,
  calendarId = PRIMARY_CALENDAR,
): CalendarEvent {
  return {
    ...eventSummary(event, calendarZone, calendarId),
    attendees: (event.attendees ?? [])
      .filter((attendee) => attendee.email)
      .map((attendee): CalendarAttendee => ({
        email: attendee.email!,
        ...(attendee.displayName ? { name: attendee.displayName } : {}),
        type: attendee.resource
          ? "resource"
          : attendee.optional
            ? "optional"
            : "required",
        response: attendeeResponse(attendee),
      })),
    ...(event.description
      ? {
          body: {
            content_type: looksLikeHtml(event.description) ? "html" : "text",
            content: event.description,
          },
        }
      : {}),
  };
}

/** Google Calendar over REST (`calendar/v3`): every `calendar` command. */
export class GoogleRestCalendar implements Required<CalendarSession> {
  private readonly zones = new Map<string, Promise<string | undefined>>();

  constructor(
    readonly calendar: CalendarClient,
    private readonly pages: Pages,
  ) {}

  /**
   * The zone an event without its own is shown in: its calendar's, as
   * `events.list` gives it. When `calendars.get` is refused (a connection with
   * only `calendar.events`), the fixed zone of the event's own offset, so a
   * read degrades and a write that already happened never reports failure.
   */
  private async zoneFor(
    calendarId: string,
    event: GoogleEvent,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (event.start?.timeZone) return undefined;
    let zone = this.zones.get(calendarId);
    if (!zone) {
      zone = this.calendar.calendarZone(calendarId, signal).catch((error) => {
        if (signal?.aborted) {
          this.zones.delete(calendarId);
          throw error;
        }
        return undefined;
      });
      this.zones.set(calendarId, zone);
    }
    return (await zone) ?? offsetZone(event.start?.dateTime);
  }

  /** A calendar named by its title (or ID) on the person's list; absent means primary. */
  private async calendarId(
    name: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!name?.trim() || name.trim().toLowerCase() === PRIMARY_CALENDAR)
      return PRIMARY_CALENDAR;
    const wanted = name.trim().toLowerCase();
    const calendars = await this.calendar.listCalendars(signal);
    const found =
      calendars.find((entry) => entry.summary?.toLowerCase() === wanted) ??
      calendars.find((entry) => entry.id.toLowerCase() === wanted);
    if (!found)
      throw invalid(`No calendar named '${name}' is on the person's list.`);
    return found.id;
  }

  async list(
    args: CalendarListArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<CalendarListResult> {
    const calendarId = await this.calendarId(args.calendar, ctx.signal);
    let zone: string | undefined;
    const page = await this.pages({
      fetch: async (pageToken, maxResults) => {
        const result = await this.calendar.listEvents(
          calendarId,
          { timeMin: args.from, timeMax: args.to, maxResults, pageToken },
          ctx.signal,
        );
        zone ??= result.timeZone;
        return result;
      },
      items: (found) => found.items,
      next: "nextPageToken",
      limit: args.limit,
      ...(args.cursor ? { cursor: args.cursor } : {}),
    });
    return {
      events: page.items.map((event) => eventSummary(event, zone, calendarId)),
      cursor: page.cursor,
    };
  }

  async read(
    args: CalendarReadArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<CalendarEvent> {
    const { calendarId, eventId } = decodeEventId(args.event_id);
    const event = await this.calendar.getEvent(calendarId, eventId, ctx.signal);
    return eventDetail(
      event,
      await this.zoneFor(calendarId, event, ctx.signal),
      calendarId,
    );
  }

  async freeBusy(
    args: CalendarFreeBusyArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<CalendarFreeBusyResult> {
    const result = await this.calendar.freeBusy(
      {
        timeMin: args.from,
        timeMax: args.to,
        timeZone: args.time_zone,
        items: args.attendees.map((id) => ({ id })),
      },
      ctx.signal,
    );
    return {
      time_zone: args.time_zone,
      schedules: args.attendees.map((attendee) => {
        const entry = result.calendars?.[attendee];
        const error = entry ? entry.errors?.[0]?.reason : "notFound";
        return {
          attendee,
          busy: (entry?.busy ?? []).map(({ start, end }) => ({
            start,
            end,
            status: "busy" as const,
          })),
          ...(error ? { error } : {}),
        };
      }),
    };
  }

  /** The `Event` body for a create, or for a patch of only the fields given. */
  private eventBody(args: Partial<CalendarCreateArgs>): GoogleEvent {
    const event: GoogleEvent = {};
    if (args.title !== undefined) event.summary = args.title;
    if (args.start !== undefined) {
      event.start = eventDateTime(args.start, args.time_zone!, args.all_day);
    }
    if (args.end !== undefined) {
      event.end = eventDateTime(args.end, args.time_zone!, args.all_day);
    }
    if (args.location !== undefined) event.location = args.location;
    if (args.body !== undefined) event.description = args.body;
    if (args.attendees !== undefined || args.optional_attendees !== undefined) {
      event.attendees = [
        ...(args.attendees ?? []).map((email) => ({ email })),
        ...(args.optional_attendees ?? []).map((email) => ({
          email,
          optional: true,
        })),
      ];
    }
    if (args.online_meeting) {
      event.conferenceData = {
        createRequest: {
          requestId: crypto.randomUUID(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }
    return event;
  }

  async create(
    args: CalendarCreateArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<CalendarEvent> {
    const created = await this.calendar.insertEvent(
      PRIMARY_CALENDAR,
      this.eventBody(args),
      ctx.signal,
    );
    return eventDetail(created, args.time_zone);
  }

  async update(
    args: CalendarUpdateArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<CalendarEvent> {
    const { event_id: id, ...change } = args;
    const { calendarId, eventId } = decodeEventId(id);
    const updated = await this.calendar.patchEvent(
      calendarId,
      eventId,
      this.eventBody(change),
      ctx.signal,
    );
    return eventDetail(
      updated,
      args.time_zone ?? (await this.zoneFor(calendarId, updated, ctx.signal)),
      calendarId,
    );
  }

  /** Sets the person's own `responseStatus` (and comment) and nothing else. */
  async respond(
    args: CalendarRespondArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<void> {
    const { calendarId, eventId } = decodeEventId(args.event_id);
    const event = await this.calendar.getEvent(calendarId, eventId, ctx.signal);
    const attendees = event.attendees ?? [];
    if (!attendees.some((attendee) => attendee.self)) {
      throw invalid(
        "The person is not an attendee of this event, so there is nothing to respond to.",
      );
    }
    const updated = attendees.map((attendee) =>
      attendee.self
        ? {
            ...attendee,
            responseStatus: GOOGLE_RESPONSES[args.response],
            ...(args.comment !== undefined ? { comment: args.comment } : {}),
          }
        : attendee,
    );
    await this.calendar.patchEvent(
      calendarId,
      eventId,
      { attendees: updated },
      ctx.signal,
    );
  }

  /** Deletes the event and notifies attendees; Google's delete carries no comment. */
  async cancel(
    args: CalendarCancelArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<void> {
    const { calendarId, eventId } = decodeEventId(args.event_id);
    await this.calendar.deleteEvent(calendarId, eventId, ctx.signal);
  }
}

function driveFileSummary(file: DriveFile): DriveFileSummary {
  const size = file.size === undefined ? Number.NaN : Number(file.size);
  return {
    id: file.id,
    name: file.name ?? "",
    mime_type: file.mimeType,
    ...(Number.isFinite(size) ? { size } : {}),
    modified_at: file.modifiedTime,
    is_folder: file.mimeType === FOLDER_TYPE,
    ...(isGoogleNative(file.mimeType) && file.mimeType !== FOLDER_TYPE
      ? { native_type: file.mimeType }
      : {}),
    web_url: file.webViewLink,
    ...(file.parents?.[0] ? { parent_id: file.parents[0] } : {}),
  };
}

/** Text from bytes, dropping a multi-byte character cut at the end. */
function decodePrefix(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/�$/, "");
}

/** Google Drive over REST (`drive/v3`, `upload/drive/v3`): every `drive` command. */
export class GoogleRestDrive implements Required<DriveSession> {
  constructor(
    readonly drive: DriveClient,
    private readonly pages: Pages,
  ) {}

  async search(
    args: DriveSearchArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<DriveSearchResult> {
    const q = driveSearchQuery({
      query: args.query,
      folderId: args.folder_id,
      modifiedAfter: args.modified_after,
    });
    const page = await this.pages({
      fetch: (pageToken, pageSize) =>
        this.drive.listFiles({ q, pageSize, pageToken }, ctx.signal),
      items: (found) => found.items,
      next: "nextPageToken",
      limit: args.limit,
      ...(args.cursor ? { cursor: args.cursor } : {}),
    });
    return {
      files: page.items.map(driveFileSummary),
      cursor: page.cursor,
    };
  }

  async read(
    args: DriveReadArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<DriveReadResult> {
    const file = await this.drive.getFile(args.file_id, ctx.signal);
    const summary = driveFileSummary(file);
    const exported = nativeExport(file.mimeType);
    if (exported) {
      try {
        const bytes = await this.drive.exportFile(
          args.file_id,
          exported.read.mimeType,
          ctx.signal,
        );
        return {
          file: summary,
          content: textContent(decodePrefix(bytes.subarray(0, args.max_bytes))),
          exported_as: exported.read.mimeType,
        };
      } catch (error) {
        if (isSizeLimit(error))
          return { file: summary, unavailable: error.message };
        throw error;
      }
    }
    if (!isTextType(file.mimeType)) {
      return {
        file: summary,
        unavailable: `${file.mimeType ?? "This file"} has no text form; use drive download.`,
      };
    }
    const { data } = await this.drive.downloadPrefix(
      args.file_id,
      args.max_bytes,
      ctx.signal,
    );
    return { file: summary, content: textContent(decodePrefix(data)) };
  }

  async download(
    args: DriveDownloadArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<ProductivityFileContent> {
    const file = await this.drive.getFile(args.file_id, ctx.signal);
    const exported = nativeExport(file.mimeType);
    const name = file.name ?? "file";
    if (exported) {
      return {
        name: name.endsWith(exported.download.extension)
          ? name
          : `${name}${exported.download.extension}`,
        mime_type: exported.download.mimeType,
        bytes: await this.drive.exportFile(
          args.file_id,
          exported.download.mimeType,
          ctx.signal,
        ),
      };
    }
    if (isGoogleNative(file.mimeType)) {
      throw invalid(
        `${file.mimeType} has no file form drive download can export.`,
      );
    }
    return {
      name,
      mime_type: file.mimeType ?? "application/octet-stream",
      bytes: await this.drive.downloadFile(
        args.file_id,
        MAX_DOWNLOAD_BYTES,
        ctx.signal,
      ),
    };
  }

  async upload(
    args: DriveUploadArgs,
    ctx: ProductivityCallContext = {},
  ): Promise<DriveFileSummary> {
    const uploaded = await this.drive.uploadFile(
      {
        name: args.name,
        mimeType: args.mime_type ?? "application/octet-stream",
        parents: args.folder_id ? [args.folder_id] : undefined,
        data: args.bytes,
      },
      ctx.signal,
    );
    return driveFileSummary(uploaded);
  }
}

/** Every productivity command over Google's REST APIs, sharing one transport. */
export class GoogleRestBackend {
  readonly mail: GoogleRestMail;
  readonly calendar: GoogleRestCalendar;
  readonly drive: GoogleRestDrive;

  constructor(transport: GoogleTransport) {
    this.mail = new GoogleRestMail(new GmailClient(transport), transport.pages);
    this.calendar = new GoogleRestCalendar(
      new CalendarClient(transport),
      transport.pages,
    );
    this.drive = new GoogleRestDrive(
      new DriveClient(transport),
      transport.pages,
    );
  }
}
