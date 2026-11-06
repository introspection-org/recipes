import {
  type CalendarAttendee,
  CalendarClient,
  type CalendarDateTime,
  type CalendarEvent,
} from "./calendar.js";
import { composeRawMessage, replySubject } from "./compose.js";
import {
  DriveClient,
  type DriveFile,
  driveSearchQuery,
  isTextType,
  MAX_DOWNLOAD_BYTES,
  nativeExport,
} from "./drive.js";
import { GoogleProductivityError } from "./errors.js";
import { GmailClient, type GmailLabel, type GmailMessage } from "./gmail.js";
import { htmlToText } from "./html.js";
import { collectPages, type GoogleTransport } from "./http.js";
import {
  decodeBase64Url,
  findPart,
  header,
  limitText,
  parseMailPayload,
  splitAddresses,
} from "./mime.js";
import type {
  AttendeeResponse,
  CalendarEventResult,
  CalendarListInput,
  DraftInput,
  DraftResult,
  DriveFileSummary,
  DriveReadResult,
  DriveSearchInput,
  DriveUploadInput,
  EventInput,
  EventTime,
  FetchedFile,
  FreeBusyResultItem,
  MailMessage,
  MailSearchInput,
  MailSummary,
  MailThread,
  Page,
  SentResult,
} from "./types.js";

/** A mail body or event description longer than this is cut, and says so. */
export const MAIL_BODY_LIMIT_CHARS = 100_000;
/** `drive read` returns at most this much text, and says when it cut. */
export const DRIVE_READ_LIMIT_CHARS = 200_000;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

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

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function invalid(message: string): GoogleProductivityError {
  return new GoogleProductivityError("invalid_request", message);
}

function epochSeconds(value: string, name: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw invalid(`${name} must be an RFC 3339 time.`);
  return Math.floor(ms / 1000);
}

/** A Gmail search operand, quoted only when it holds whitespace. */
function gmailOperand(value: string): string {
  const bare = value.replace(/"/g, "");
  return /\s/.test(bare) ? `"${bare}"` : bare;
}

function sentAt(message: GmailMessage): string | undefined {
  if (message.internalDate && /^\d+$/.test(message.internalDate)) {
    return new Date(Number(message.internalDate)).toISOString();
  }
  const date = header(message.payload, "Date");
  const ms = date ? Date.parse(date) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

const RESPONSES: Record<string, AttendeeResponse> = {
  accepted: "accept",
  tentative: "tentative",
  declined: "decline",
  needsAction: "none",
};
const GOOGLE_RESPONSES: Record<
  Exclude<AttendeeResponse, "none">,
  CalendarAttendee["responseStatus"]
> = {
  accept: "accepted",
  tentative: "tentative",
  decline: "declined",
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw invalid(
      `time_zone must be an IANA time zone name, not '${timeZone}'.`,
    );
  }
}

function eventDateTime(
  value: string,
  timeZone: string,
  name: string,
): CalendarDateTime {
  if (DATE_ONLY.test(value)) return { date: value };
  if (!Number.isFinite(Date.parse(value)))
    throw invalid(`${name} must be RFC 3339 or a date.`);
  return { dateTime: value, timeZone };
}

function eventTime(
  value: CalendarDateTime | undefined,
  fallbackZone?: string,
): EventTime {
  if (value?.date) return { date: value.date };
  return {
    date_time: value?.dateTime,
    time_zone: value?.timeZone ?? fallbackZone,
  };
}

export function eventResult(
  event: CalendarEvent,
  fallbackZone?: string,
): CalendarEventResult {
  const video = event.conferenceData?.entryPoints?.find(
    (entry) => entry.entryPointType === "video",
  )?.uri;
  return {
    id: event.id ?? "",
    title: event.summary,
    start: eventTime(event.start, fallbackZone),
    end: eventTime(event.end, fallbackZone),
    location: event.location,
    body: event.description
      ? limitText(
          /<[a-z][\s\S]*>/i.test(event.description)
            ? htmlToText(event.description)
            : event.description,
          MAIL_BODY_LIMIT_CHARS,
        )
      : undefined,
    status: event.status,
    organizer: event.organizer?.email,
    attendees: (event.attendees ?? [])
      .filter((attendee) => attendee.email)
      .map((attendee) => ({
        email: attendee.email!,
        name: attendee.displayName,
        response: RESPONSES[attendee.responseStatus ?? "needsAction"] ?? "none",
        optional: attendee.optional ?? false,
        self: attendee.self ?? false,
      })),
    online_meeting_url: video ?? event.hangoutLink,
    web_url: event.htmlLink,
  };
}

export function driveFileSummary(file: DriveFile): DriveFileSummary {
  const size = file.size === undefined ? undefined : Number(file.size);
  return {
    id: file.id,
    name: file.name ?? "",
    mime_type: file.mimeType ?? "application/octet-stream",
    size: Number.isFinite(size) ? size : undefined,
    modified_at: file.modifiedTime,
    web_url: file.webViewLink,
    native: nativeExport(file.mimeType)?.kind,
  };
}

function attachmentRef(id: string): { messageId: string; partId: string } {
  const at = id.lastIndexOf(":");
  if (at <= 0) throw invalid("Unknown attachment.");
  return { messageId: id.slice(0, at), partId: id.slice(at + 1) };
}

/**
 * Every productivity command over Google's REST APIs. This is the complete
 * backend: the MCP backend serves a subset and falls back here.
 */
export class GoogleRestBackend {
  readonly gmail: GmailClient;
  readonly calendar: CalendarClient;
  readonly drive: DriveClient;
  private labels?: Promise<GmailLabel[]>;

  constructor(transport: GoogleTransport) {
    this.gmail = new GmailClient(transport);
    this.calendar = new CalendarClient(transport);
    this.drive = new DriveClient(transport);
  }

  // ---- labels -------------------------------------------------------------

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

  // ---- mail ---------------------------------------------------------------

  async mailSearchQuery(
    input: MailSearchInput,
  ): Promise<{ q: string; labelIds?: string[] }> {
    const terms: string[] = [];
    if (input.query?.trim()) terms.push(input.query.trim());
    if (input.from?.trim())
      terms.push(`from:${gmailOperand(input.from.trim())}`);
    if (input.after) terms.push(`after:${epochSeconds(input.after, "after")}`);
    if (input.before)
      terms.push(`before:${epochSeconds(input.before, "before")}`);
    if (input.unread === true) terms.push("is:unread");
    if (input.unread === false) terms.push("-is:unread");
    const labelIds = input.folder
      ? [await this.labelId(input.folder)]
      : undefined;
    return { q: terms.join(" "), labelIds };
  }

  async summary(
    message: GmailMessage,
    signal?: AbortSignal,
  ): Promise<MailSummary> {
    return {
      id: message.id,
      thread_id: message.threadId,
      from: header(message.payload, "From"),
      to: splitAddresses(header(message.payload, "To")),
      subject: header(message.payload, "Subject"),
      sent_at: sentAt(message),
      snippet: message.snippet,
      labels: await this.labelNames(message.labelIds, signal),
      unread: message.labelIds?.includes("UNREAD") ?? false,
    };
  }

  async mailSearch(
    input: MailSearchInput,
    signal?: AbortSignal,
  ): Promise<Page<MailSummary>> {
    const { q, labelIds } = await this.mailSearchQuery(input);
    const page = await collectPages(
      (pageToken, maxResults) =>
        this.gmail.listMessages(
          { q: q || undefined, labelIds, maxResults, pageToken },
          signal,
        ),
      pageSize(input.limit),
      input.cursor,
    );
    const items = await Promise.all(
      page.items.map(async (ref) =>
        this.summary(
          await this.gmail.getMessage(ref.id, "metadata", signal),
          signal,
        ),
      ),
    );
    return { items, next_cursor: page.nextPageToken };
  }

  async message(
    message: GmailMessage,
    signal?: AbortSignal,
  ): Promise<MailMessage> {
    const parsed = parseMailPayload(message.payload);
    return {
      ...(await this.summary(message, signal)),
      cc: splitAddresses(header(message.payload, "Cc")),
      body: {
        ...limitText(parsed.text, MAIL_BODY_LIMIT_CHARS),
        from_html: parsed.fromHtml,
      },
      attachments: parsed.attachments.map((attachment) => ({
        id: `${message.id}:${attachment.partId}`,
        filename: attachment.filename,
        mime_type: attachment.mimeType,
        size: attachment.size,
      })),
    };
  }

  async mailRead(
    messageId: string,
    signal?: AbortSignal,
  ): Promise<MailMessage> {
    return this.message(
      await this.gmail.getMessage(messageId, "full", signal),
      signal,
    );
  }

  async mailReadThread(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<MailThread> {
    const thread = await this.gmail.getThread(threadId, signal);
    return {
      thread_id: thread.id,
      messages: await Promise.all(
        (thread.messages ?? []).map((message) => this.message(message, signal)),
      ),
    };
  }

  async mailFetchAttachment(
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<FetchedFile> {
    const { messageId, partId } = attachmentRef(attachmentId);
    const message = await this.gmail.getMessage(messageId, "full", signal);
    const part = findPart(message.payload, partId);
    if (!part) {
      throw new GoogleProductivityError(
        "not_found",
        "The attachment is no longer on the message.",
      );
    }
    if ((part.body?.size ?? 0) > MAX_DOWNLOAD_BYTES) {
      throw new GoogleProductivityError(
        "too_large",
        `The attachment is larger than the ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB limit, so it was not fetched.`,
        { limitBytes: MAX_DOWNLOAD_BYTES },
      );
    }
    const data = part.body?.attachmentId
      ? await this.gmail.getAttachment(
          messageId,
          part.body.attachmentId,
          signal,
        )
      : decodeBase64Url(part.body?.data ?? "");
    return {
      filename: part.filename || "attachment",
      mime_type: part.mimeType ?? "application/octet-stream",
      data,
    };
  }

  async mailDraft(
    input: DraftInput,
    signal?: AbortSignal,
  ): Promise<DraftResult> {
    let threadId: string | undefined;
    let inReplyTo: { messageId?: string; references?: string } | undefined;
    let subject = input.subject;
    if (input.reply_to) {
      const parent = await this.gmail.getMessage(
        input.reply_to,
        "full",
        signal,
      );
      threadId = parent.threadId;
      inReplyTo = {
        messageId:
          header(parent.payload, "Message-ID") ??
          header(parent.payload, "Message-Id"),
        references: header(parent.payload, "References"),
      };
      if (!subject.trim())
        subject = replySubject(header(parent.payload, "Subject"));
    }
    const raw = composeRawMessage({ ...input, subject, inReplyTo });
    const draft = await this.gmail.createDraft(raw, threadId, signal);
    return {
      draft_id: draft.id,
      message_id: draft.message?.id,
      thread_id: draft.message?.threadId ?? threadId,
    };
  }

  async mailUpdateDraft(
    draftId: string,
    change: Partial<Omit<DraftInput, "reply_to">>,
    signal?: AbortSignal,
  ): Promise<DraftResult> {
    const current = await this.gmail.getDraft(draftId, signal);
    const payload = current.message?.payload;
    const raw = composeRawMessage({
      to: change.to ?? splitAddresses(header(payload, "To")),
      cc: change.cc ?? splitAddresses(header(payload, "Cc")),
      subject: change.subject ?? header(payload, "Subject") ?? "",
      body: change.body ?? parseMailPayload(payload).text,
      inReplyTo: {
        messageId: header(payload, "In-Reply-To"),
        // References already ends with the parent, which composing appends again.
        references: header(payload, "References")
          ?.split(/\s+/)
          .filter((id) => id && id !== header(payload, "In-Reply-To"))
          .join(" "),
      },
    });
    const threadId = current.message?.threadId;
    const draft = await this.gmail.updateDraft(draftId, raw, threadId, signal);
    return {
      draft_id: draft.id,
      message_id: draft.message?.id,
      thread_id: draft.message?.threadId ?? threadId,
    };
  }

  async mailSend(draftId: string, signal?: AbortSignal): Promise<SentResult> {
    const sent = await this.gmail.sendDraft(draftId, signal);
    return { message_id: sent.id, thread_id: sent.threadId };
  }

  private async assertMutable(ids: string[]): Promise<void> {
    const fixed = ids.find((id) => IMMUTABLE_LABELS.has(id));
    if (fixed)
      throw invalid(
        `Gmail sets ${fixed} itself; it cannot be added or removed.`,
      );
  }

  async mailLabel(
    messageId: string,
    change: { add?: string[]; remove?: string[] },
    signal?: AbortSignal,
  ): Promise<MailSummary> {
    const addLabelIds = await Promise.all(
      (change.add ?? []).map((name) => this.labelId(name, signal)),
    );
    const removeLabelIds = await Promise.all(
      (change.remove ?? []).map((name) => this.labelId(name, signal)),
    );
    await this.assertMutable([...addLabelIds, ...removeLabelIds]);
    await this.gmail.modifyMessage(
      messageId,
      { addLabelIds, removeLabelIds },
      signal,
    );
    return this.summary(
      await this.gmail.getMessage(messageId, "metadata", signal),
      signal,
    );
  }

  /**
   * Gmail has no folders: moving adds the folder's label and takes the
   * message out of the inbox. `archive` only takes it out of the inbox.
   */
  async mailMove(
    messageId: string,
    folder: string,
    signal?: AbortSignal,
  ): Promise<MailSummary> {
    const archive = folder.trim().toLowerCase() === "archive";
    const target = archive ? undefined : await this.labelId(folder, signal);
    if (target) await this.assertMutable([target]);
    const change =
      target === "INBOX"
        ? { addLabelIds: ["INBOX"], removeLabelIds: [] }
        : { addLabelIds: target ? [target] : [], removeLabelIds: ["INBOX"] };
    await this.gmail.modifyMessage(messageId, change, signal);
    return this.summary(
      await this.gmail.getMessage(messageId, "metadata", signal),
      signal,
    );
  }

  // ---- calendar -----------------------------------------------------------

  async calendarList(
    input: CalendarListInput,
    signal?: AbortSignal,
  ): Promise<Page<CalendarEventResult>> {
    const calendarId = input.calendar ?? "primary";
    let zone: string | undefined;
    const page = await collectPages(
      async (pageToken, maxResults) => {
        const result = await this.calendar.listEvents(
          calendarId,
          { timeMin: input.from, timeMax: input.to, maxResults, pageToken },
          signal,
        );
        zone ??= result.timeZone;
        return result;
      },
      pageSize(input.limit),
      input.cursor,
    );
    return {
      items: page.items.map((event) => eventResult(event, zone)),
      next_cursor: page.nextPageToken,
    };
  }

  async calendarRead(
    eventId: string,
    signal?: AbortSignal,
  ): Promise<CalendarEventResult> {
    return eventResult(
      await this.calendar.getEvent("primary", eventId, signal),
    );
  }

  async calendarFreeBusy(
    input: { attendees: string[]; from: string; to: string },
    signal?: AbortSignal,
  ): Promise<FreeBusyResultItem[]> {
    const result = await this.calendar.freeBusy(
      {
        timeMin: input.from,
        timeMax: input.to,
        items: input.attendees.map((id) => ({ id })),
      },
      signal,
    );
    return input.attendees.map((attendee) => {
      const entry = result.calendars?.[attendee];
      const error = entry?.errors?.[0]?.reason;
      return {
        attendee,
        busy: (entry?.busy ?? []).map(({ start, end }) => ({ start, end })),
        ...(error || !entry ? { error: error ?? "notFound" } : {}),
      };
    });
  }

  eventBody(input: Partial<EventInput>, existingZone?: string): CalendarEvent {
    const zone = input.time_zone ?? existingZone;
    if ((input.start || input.end) && !zone) {
      throw invalid("time_zone is required with start and end.");
    }
    if (zone) assertTimeZone(zone);
    const event: CalendarEvent = {};
    if (input.title !== undefined) event.summary = input.title;
    if (input.start !== undefined)
      event.start = eventDateTime(input.start, zone!, "start");
    if (input.end !== undefined)
      event.end = eventDateTime(input.end, zone!, "end");
    if (input.location !== undefined) event.location = input.location;
    if (input.body !== undefined) event.description = input.body;
    if (input.attendees !== undefined) {
      event.attendees = input.attendees.map((email) => ({ email }));
    }
    if (input.online_meeting) {
      event.conferenceData = {
        createRequest: {
          requestId: crypto.randomUUID(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }
    return event;
  }

  async calendarCreate(
    input: EventInput,
    signal?: AbortSignal,
  ): Promise<CalendarEventResult> {
    return eventResult(
      await this.calendar.insertEvent("primary", this.eventBody(input), signal),
    );
  }

  async calendarUpdate(
    eventId: string,
    change: Partial<EventInput>,
    signal?: AbortSignal,
  ): Promise<CalendarEventResult> {
    return eventResult(
      await this.calendar.patchEvent(
        "primary",
        eventId,
        this.eventBody(change),
        signal,
      ),
    );
  }

  /** Sets the person's own `responseStatus` (and comment) and nothing else. */
  async calendarRespond(
    eventId: string,
    response: Exclude<AttendeeResponse, "none">,
    comment: string | undefined,
    signal?: AbortSignal,
  ): Promise<CalendarEventResult> {
    const event = await this.calendar.getEvent("primary", eventId, signal);
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
            responseStatus: GOOGLE_RESPONSES[response],
            ...(comment !== undefined ? { comment } : {}),
          }
        : attendee,
    );
    return eventResult(
      await this.calendar.patchEvent(
        "primary",
        eventId,
        { attendees: updated },
        signal,
      ),
    );
  }

  /** Deletes the event and notifies attendees; Google takes no cancellation note. */
  async calendarCancel(eventId: string, signal?: AbortSignal): Promise<void> {
    await this.calendar.deleteEvent("primary", eventId, signal);
  }

  // ---- drive --------------------------------------------------------------

  async driveSearch(
    input: DriveSearchInput,
    signal?: AbortSignal,
  ): Promise<Page<DriveFileSummary>> {
    const q = driveSearchQuery({
      query: input.query,
      folderId: input.folder,
      modifiedAfter: input.modified_after,
    });
    const page = await collectPages(
      (pageToken, size) =>
        this.drive.listFiles({ q, pageSize: size, pageToken }, signal),
      pageSize(input.limit),
      input.cursor,
    );
    return {
      items: page.items.map(driveFileSummary),
      next_cursor: page.nextPageToken,
    };
  }

  async driveRead(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<DriveReadResult> {
    const file = await this.drive.getFile(fileId, signal);
    const summary = driveFileSummary(file);
    const exported = nativeExport(file.mimeType);
    if (exported) {
      const bytes = await this.drive.exportFile(
        fileId,
        exported.read.mimeType,
        signal,
      );
      return {
        file: summary,
        exported_as: exported.read.mimeType,
        ...limitText(new TextDecoder().decode(bytes), DRIVE_READ_LIMIT_CHARS),
      };
    }
    if (!isTextType(file.mimeType)) {
      return {
        file: summary,
        binary: true,
        text: "",
        truncated: false,
        limit_chars: DRIVE_READ_LIMIT_CHARS,
      };
    }
    const bytes = await this.drive.downloadFile(
      fileId,
      MAX_DOWNLOAD_BYTES,
      signal,
    );
    return {
      file: summary,
      ...limitText(new TextDecoder().decode(bytes), DRIVE_READ_LIMIT_CHARS),
    };
  }

  async driveDownload(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<FetchedFile & { file: DriveFileSummary }> {
    const file = await this.drive.getFile(fileId, signal);
    const exported = nativeExport(file.mimeType);
    if (exported) {
      const data = await this.drive.exportFile(
        fileId,
        exported.download.mimeType,
        signal,
      );
      const base = file.name ?? "file";
      return {
        file: driveFileSummary(file),
        filename: base.endsWith(exported.download.extension)
          ? base
          : `${base}${exported.download.extension}`,
        mime_type: exported.download.mimeType,
        data,
      };
    }
    if (file.mimeType?.startsWith("application/vnd.google-apps.")) {
      throw new GoogleProductivityError(
        "unsupported",
        `${file.mimeType} has no file form drive download can export.`,
      );
    }
    return {
      file: driveFileSummary(file),
      filename: file.name ?? "file",
      mime_type: file.mimeType ?? "application/octet-stream",
      data: await this.drive.downloadFile(fileId, MAX_DOWNLOAD_BYTES, signal),
    };
  }

  async driveUpload(
    input: DriveUploadInput,
    signal?: AbortSignal,
  ): Promise<DriveFileSummary> {
    return driveFileSummary(
      await this.drive.uploadFile(
        {
          name: input.name,
          mimeType: input.mime_type,
          parents: input.folder ? [input.folder] : undefined,
          data: input.data,
        },
        signal,
      ),
    );
  }
}
