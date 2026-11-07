import type {
  CalendarAttendeeResponse,
  CalendarBusyInterval,
  CalendarEvent,
  CalendarEventSummary,
  CalendarSession,
  DriveFileSummary,
  DriveSession,
  MailDraft,
  MailMessage,
  MailMessageSummary,
  MailSession,
  ProductivityAddress,
  ProductivitySession,
  ProductivitySessionOptions,
} from "@introspection-ai/recipes/productivity";

import { GraphClient, invalidRequest, type GraphRequest } from "./client.js";
import type {
  GraphAttachment,
  GraphCalendar,
  GraphDriveItem,
  GraphEvent,
  GraphMailFolder,
  GraphMessage,
  GraphRecipient,
  GraphResponseStatus,
  GraphScheduleInformation,
  GraphUploadSession,
} from "./graph-types.js";
import { MICROSOFT_SCOPES } from "./scopes.js";

/** Files up to this size upload in one PUT; larger ones use an upload session. */
export const SIMPLE_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;
/** Upload session ranges: a multiple of 320 KiB, as Graph requires. */
export const UPLOAD_CHUNK_BYTES = 320 * 1024 * 32;

/** The most addresses one `getSchedule` call takes. */
const SCHEDULES_PER_CALL = 20;

const MESSAGE_SELECT =
  "id,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,isDraft,hasAttachments,categories";
const ATTACHMENT_EXPAND =
  "attachments($select=id,name,contentType,size,isInline)";
const EVENT_SELECT =
  "id,subject,start,end,isAllDay,isCancelled,isOrganizer,location,organizer,responseStatus,onlineMeeting,webLink";
const DRIVE_SELECT =
  "id,name,size,webUrl,lastModifiedDateTime,lastModifiedBy,file,folder,package,parentReference,remoteItem";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The most messages `mail read` returns for one thread. */
const THREAD_MESSAGE_LIMIT = 500;

const kqlDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Whether a message arrived in `[after, before)`, the bounds `$filter` applies. */
function receivedWithin(
  message: GraphMessage,
  after: number | undefined,
  before: number | undefined,
): boolean {
  if (after === undefined && before === undefined) return true;
  const received = Date.parse(message.receivedDateTime ?? "");
  if (!Number.isFinite(received)) return false;
  return (
    (after === undefined || received >= after) &&
    (before === undefined || received < before)
  );
}

/** Outlook's well-known folder names, and the everyday names that mean them. */
const WELL_KNOWN_FOLDERS: Record<string, string> = {
  inbox: "inbox",
  archive: "archive",
  drafts: "drafts",
  sent: "sentitems",
  sentitems: "sentitems",
  "sent items": "sentitems",
  trash: "deleteditems",
  deleted: "deleteditems",
  deleteditems: "deleteditems",
  "deleted items": "deleteditems",
  junk: "junkemail",
  junkemail: "junkemail",
  spam: "junkemail",
};

const TEXT_TYPES =
  /^(text\/|application\/(json|xml|csv|x-yaml|yaml|markdown)\b)/i;
const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|html?|log|ini)$/i;

const segment = (value: string) => encodeURIComponent(value);
/** An OData string literal. */
const odata = (value: string) => `'${value.replaceAll("'", "''")}'`;

function address(
  recipient: GraphRecipient | undefined,
): ProductivityAddress | undefined {
  const email = recipient?.emailAddress?.address;
  if (!email) return undefined;
  const name = recipient?.emailAddress?.name;
  return { email, ...(name && name !== email ? { name } : {}) };
}

function addresses(
  list: GraphRecipient[] | undefined,
): ProductivityAddress[] | undefined {
  if (!list) return undefined;
  return list
    .map(address)
    .filter((value): value is ProductivityAddress => !!value);
}

const recipients = (emails: readonly string[]) =>
  emails.map((email) => ({ emailAddress: { address: email } }));

function messageSummary(message: GraphMessage): MailMessageSummary {
  const from = address(message.from);
  const to = addresses(message.toRecipients);
  const cc = addresses(message.ccRecipients);
  const sentAt = message.receivedDateTime ?? message.sentDateTime;
  return {
    id: message.id,
    ...(message.conversationId ? { thread_id: message.conversationId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(cc?.length ? { cc } : {}),
    ...(message.subject !== undefined ? { subject: message.subject } : {}),
    ...(message.bodyPreview ? { snippet: message.bodyPreview } : {}),
    ...(sentAt ? { sent_at: sentAt } : {}),
    ...(message.isRead !== undefined ? { unread: !message.isRead } : {}),
    ...(message.hasAttachments !== undefined
      ? { has_attachments: message.hasAttachments }
      : {}),
    ...(message.categories?.length ? { labels: message.categories } : {}),
    ...(message.isDraft ? { is_draft: true } : {}),
  };
}

function fullMessage(message: GraphMessage): MailMessage {
  return {
    ...messageSummary(message),
    ...(message.body?.content !== undefined
      ? {
          body: {
            content_type: message.body.contentType === "html" ? "html" : "text",
            content: message.body.content,
          },
        }
      : {}),
    attachments: (message.attachments ?? []).map(
      (attachment: GraphAttachment) => ({
        id: attachment.id,
        name: attachment.name ?? "attachment",
        ...(attachment.contentType
          ? { mime_type: attachment.contentType }
          : {}),
        ...(attachment.size !== undefined ? { size: attachment.size } : {}),
        ...(attachment.isInline ? { inline: true } : {}),
      }),
    ),
  };
}

function draftResult(message: GraphMessage): MailDraft {
  const to = addresses(message.toRecipients);
  const cc = addresses(message.ccRecipients);
  return {
    id: message.id,
    ...(message.conversationId ? { thread_id: message.conversationId } : {}),
    ...(to ? { to } : {}),
    ...(cc?.length ? { cc } : {}),
    ...(message.subject !== undefined ? { subject: message.subject } : {}),
  };
}

/** Graph's `2026-03-02T09:00:00.0000000` as RFC 3339 without the fraction, or a date when all-day. */
function graphTime(value: string | undefined, allDay: boolean): string {
  const trimmed = (value ?? "").replace(/\.\d+$/, "");
  return allDay ? trimmed.slice(0, 10) : trimmed;
}

const RESPONSES: Record<
  NonNullable<GraphResponseStatus["response"]>,
  CalendarAttendeeResponse
> = {
  none: "none",
  notResponded: "none",
  organizer: "organizer",
  accepted: "accepted",
  tentativelyAccepted: "tentative",
  declined: "declined",
};

/**
 * The opaque event id behind an `evt_` handle. An event listed from a named
 * calendar carries that calendar, since one shared from another mailbox is
 * not reachable as `/me/events/{id}`.
 */
function eventId(event: GraphEvent, calendarId?: string): string {
  return calendarId === undefined
    ? event.id
    : `${segment(calendarId)}/${segment(event.id)}`;
}

function eventSummary(
  event: GraphEvent,
  calendarId?: string,
): CalendarEventSummary {
  const allDay = event.isAllDay === true;
  const organizer = address(event.organizer);
  const response = event.responseStatus?.response;
  return {
    id: eventId(event, calendarId),
    ...(event.subject !== undefined ? { title: event.subject } : {}),
    start: graphTime(event.start?.dateTime, allDay),
    end: graphTime(event.end?.dateTime, allDay),
    time_zone: event.start?.timeZone ?? "UTC",
    ...(allDay ? { all_day: true } : {}),
    ...(event.location?.displayName
      ? { location: event.location.displayName }
      : {}),
    ...(organizer ? { organizer } : {}),
    ...(event.isOrganizer !== undefined
      ? { is_organizer: event.isOrganizer }
      : {}),
    ...(response ? { response: RESPONSES[response] } : {}),
    ...(event.isCancelled ? { cancelled: true } : {}),
    ...(event.onlineMeeting?.joinUrl
      ? { online_meeting_url: event.onlineMeeting.joinUrl }
      : {}),
    ...(event.webLink ? { web_link: event.webLink } : {}),
  };
}

function fullEvent(event: GraphEvent, calendarId?: string): CalendarEvent {
  return {
    ...eventSummary(event, calendarId),
    ...(event.attendees
      ? {
          attendees: event.attendees.flatMap((attendee) => {
            const who = address(attendee);
            if (!who) return [];
            const response = attendee.status?.response;
            return [
              {
                ...who,
                ...(attendee.type ? { type: attendee.type } : {}),
                ...(response ? { response: RESPONSES[response] } : {}),
              },
            ];
          }),
        }
      : {}),
    ...(event.body?.content
      ? {
          body: {
            content_type: event.body.contentType === "html" ? "html" : "text",
            content: event.body.content,
          },
        }
      : {}),
  };
}

/**
 * A time for Graph's `dateTimeTimeZone`: the wall-clock time in `timeZone`.
 * A time with an offset is converted to that zone; a local time is kept.
 */
export function wallTime(
  value: string,
  timeZone: string,
  allDay = false,
): string {
  if (allDay) return `${value.slice(0, 10)}T00:00:00`;
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const local = value.replace(/\.\d+$/, "");
    return local.length === 16 ? `${local}:00` : local;
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(value))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Graph `dateTime` in UTC, no offset, as `getSchedule` takes it. */
const utc = (value: string) =>
  new Date(value).toISOString().replace(/\.\d+Z$/, "");

const BUSY: Record<string, CalendarBusyInterval["status"] | undefined> = {
  busy: "busy",
  tentative: "tentative",
  oof: "out_of_office",
  workingElsewhere: "busy",
  unknown: "unknown",
};

/**
 * A drive item's id as the host holds it: `<driveId>/<itemId>`, so an item in
 * another drive (SharePoint, a shared folder) resolves to the right drive.
 */
function driveItemId(item: GraphDriveItem): string {
  const remoteId = item.remoteItem?.id;
  const itemId = remoteId ?? item.id;
  const driveId = remoteId
    ? item.remoteItem?.parentReference?.driveId
    : item.parentReference?.driveId;
  return driveId ? `${driveId}/${itemId}` : itemId;
}

/** A request path and its template in Graph's OpenAPI description. */
type GraphPath = Pick<GraphRequest, "path" | "template">;

const route = (path: string, template = path): GraphPath => ({
  path,
  template,
});

/** Below `base`, adding `path` and its `template`. */
const under = (base: GraphPath, path: string, template = path): GraphPath => ({
  path: `${base.path}${path}`,
  template: `${base.template}${template}`,
});

const messagePath = (id: string): GraphPath =>
  route(`/me/messages/${segment(id)}`, "/me/messages/{message-id}");

/** A calendar's or event's Graph path, with the calendar it names, if any. */
interface CalendarRoute {
  at: GraphPath;
  calendarId?: string;
}

/** The Graph path of an event id from `eventId`. */
function eventRoute(id: string): CalendarRoute {
  const slash = id.indexOf("/");
  if (slash === -1)
    return {
      at: route(`/me/events/${segment(id)}`, "/me/events/{event-id}"),
    };
  const calendarId = decodeURIComponent(id.slice(0, slash));
  return {
    at: route(
      `/me/calendars/${segment(calendarId)}/events/${id.slice(slash + 1)}`,
      "/me/calendars/{calendar-id}/events/{event-id}",
    ),
    calendarId,
  };
}

/** The Graph path of an item id from `driveItemId`. */
function itemPath(id: string): GraphPath {
  const slash = id.indexOf("/");
  return slash === -1
    ? route(`/me/drive/items/${segment(id)}`, "/me/drive/items/{driveItem-id}")
    : route(
        `/drives/${segment(id.slice(0, slash))}/items/${segment(id.slice(slash + 1))}`,
        "/drives/{drive-id}/items/{driveItem-id}",
      );
}

function fileSummary(item: GraphDriveItem): DriveFileSummary {
  const modifiedBy =
    item.lastModifiedBy?.user?.displayName ?? item.lastModifiedBy?.user?.email;
  return {
    id: driveItemId(item),
    name: item.name ?? "",
    ...(item.file?.mimeType ? { mime_type: item.file.mimeType } : {}),
    ...(item.size !== undefined && !item.folder ? { size: item.size } : {}),
    ...(item.lastModifiedDateTime
      ? { modified_at: item.lastModifiedDateTime }
      : {}),
    ...(modifiedBy ? { modified_by: modifiedBy } : {}),
    ...(item.folder || item.package ? { is_folder: true } : {}),
    ...(item.webUrl ? { web_url: item.webUrl } : {}),
    ...(item.parentReference?.id
      ? {
          parent_id: item.parentReference.driveId
            ? `${item.parentReference.driveId}/${item.parentReference.id}`
            : item.parentReference.id,
        }
      : {}),
  };
}

const preferZone = (timeZone: string) => ({
  Prefer: `outlook.timezone="${timeZone.replaceAll('"', "")}"`,
});

/**
 * One person's Microsoft 365 mail, calendar and OneDrive over Graph v1.0,
 * served for the host's `mail`, `calendar` and `drive` tools.
 */
export function createMicrosoftSession(
  options: Pick<ProductivitySessionOptions, "http"> & { baseUrl?: string },
): ProductivitySession {
  const graph = new GraphClient(
    options.http,
    options.baseUrl ? { baseUrl: options.baseUrl } : {},
  );
  const get = (
    target: GraphPath,
    query: GraphRequest["query"],
    scope: string,
  ): GraphRequest => ({
    method: "GET",
    ...target,
    query,
    scope,
    read: true,
  });

  const folderTemplate = "/me/mailFolders/{mailFolder-id}";
  const mailFolderPath = async (
    folder: string,
    signal?: AbortSignal,
  ): Promise<GraphPath> => {
    const known = WELL_KNOWN_FOLDERS[folder.trim().toLowerCase()];
    if (known) return route(`/me/mailFolders/${known}`, folderTemplate);
    const found = await graph.json<{ value?: GraphMailFolder[] }>(
      get(
        route("/me/mailFolders"),
        {
          $filter: `displayName eq ${odata(folder.trim())}`,
          $select: "id,displayName",
          $top: "2",
        },
        MICROSOFT_SCOPES.mail.search,
      ),
      signal,
    );
    const id = found?.value?.[0]?.id;
    if (!id)
      throw invalidRequest(
        `No mail folder named '${folder}'. Use inbox, archive, sent, drafts, trash, junk or a top-level folder's name.`,
      );
    return route(`/me/mailFolders/${segment(id)}`, folderTemplate);
  };

  const mail: MailSession = {
    async search(args, { signal }) {
      const folderPath = args.folder
        ? await mailFolderPath(args.folder, signal)
        : route("/me");
      const query: Record<string, string | undefined> = {
        $select: MESSAGE_SELECT,
        $top: String(args.limit),
      };
      let unreadAfter = false;
      const after = args.after ? Date.parse(args.after) : undefined;
      const before = args.before ? Date.parse(args.before) : undefined;
      if (args.query?.trim()) {
        // Graph does not combine $search with $filter or $orderby on messages,
        // so every other criterion becomes a KQL term (user-list-messages.md).
        // KQL's received takes a date in the mailbox's zone, so the terms are
        // widened a day each way and the exact instants filter the results.
        const terms = [args.query.trim()];
        if (args.from) terms.push(`from:${args.from}`);
        if (after !== undefined)
          terms.push(`received>=${kqlDate(after - DAY_MS)}`);
        if (before !== undefined)
          terms.push(`received<=${kqlDate(before + DAY_MS)}`);
        query.$search = `"${terms.join(" ").replaceAll('"', '\\"')}"`;
        unreadAfter = args.unread !== undefined;
      } else {
        // $orderby's property must lead $filter (user-list-messages.md).
        const filters = [
          `receivedDateTime ge ${args.after ? new Date(args.after).toISOString() : "1900-01-01T00:00:00Z"}`,
        ];
        if (args.before)
          filters.push(
            `receivedDateTime lt ${new Date(args.before).toISOString()}`,
          );
        if (args.from)
          filters.push(`from/emailAddress/address eq ${odata(args.from)}`);
        if (args.unread !== undefined)
          filters.push(`isRead eq ${args.unread ? "false" : "true"}`);
        query.$filter = filters.join(" and ");
        query.$orderby = "receivedDateTime desc";
      }
      const page = await graph.page<GraphMessage>(
        get(
          under(folderPath, "/messages"),
          query,
          MICROSOFT_SCOPES.mail.search,
        ),
        args.limit,
        signal,
        args.cursor,
      );
      return {
        messages: page.items
          .filter(
            (message) =>
              (!unreadAfter || !message.isRead === args.unread) &&
              receivedWithin(message, after, before),
          )
          .map(messageSummary),
        ...(page.next ? { cursor: page.next } : {}),
      };
    },

    async read(args, { signal }) {
      if ("message_id" in args) {
        const message = await graph.json<GraphMessage>(
          get(
            messagePath(args.message_id),
            { $select: `${MESSAGE_SELECT},body`, $expand: ATTACHMENT_EXPAND },
            MICROSOFT_SCOPES.mail.read,
          ),
          signal,
        );
        return { messages: [fullMessage(message)] };
      }
      // Newest first, so a thread past the cap keeps its latest messages;
      // $orderby's property must lead $filter (user-list-messages.md).
      const page = await graph.page<GraphMessage>(
        get(
          route("/me/messages"),
          {
            $filter: `receivedDateTime ge 1900-01-01T00:00:00Z and conversationId eq ${odata(args.thread_id)}`,
            $orderby: "receivedDateTime desc",
            $select: `${MESSAGE_SELECT},body`,
            $expand: ATTACHMENT_EXPAND,
            $top: "50",
          },
          MICROSOFT_SCOPES.mail.read,
        ),
        THREAD_MESSAGE_LIMIT,
        signal,
      );
      const cut =
        page.next !== undefined || page.items.length > THREAD_MESSAGE_LIMIT;
      const messages = page.items
        .slice(0, THREAD_MESSAGE_LIMIT)
        .sort((a, b) =>
          (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""),
        );
      return {
        messages: messages.map(fullMessage),
        ...(cut
          ? {
              unavailable: `The thread has more than ${THREAD_MESSAGE_LIMIT} messages; only the latest ${THREAD_MESSAGE_LIMIT} are shown.`,
            }
          : {}),
      };
    },

    async fetchAttachment(args, { signal }) {
      const path = under(
        messagePath(args.message_id),
        `/attachments/${segment(args.attachment_id)}`,
        "/attachments/{attachment-id}",
      );
      const meta = await graph.json<GraphAttachment>(
        get(
          path,
          { $select: "id,name,contentType,size" },
          MICROSOFT_SCOPES.mail.fetch_attachment,
        ),
        signal,
      );
      if (meta?.["@odata.type"] === "#microsoft.graph.referenceAttachment")
        throw invalidRequest(
          "This attachment is a link to a file in the cloud, not a file in the message.",
        );
      const content = await graph.bytes(
        get(
          under(path, "/$value"),
          undefined,
          MICROSOFT_SCOPES.mail.fetch_attachment,
        ),
        signal,
      );
      const mimeType = meta?.contentType ?? content.contentType;
      return {
        name: meta?.name ?? "attachment",
        ...(mimeType ? { mime_type: mimeType } : {}),
        bytes: content.bytes,
      };
    },

    async draft(args, { signal }) {
      const scope = MICROSOFT_SCOPES.mail.draft;
      if (args.reply_to_id) {
        // A reply keeps the quoted thread: the new text goes in `comment`,
        // which Graph refuses beside `message.body` (message-createreply.md).
        const created = await graph.json<GraphMessage>(
          {
            method: "POST",
            ...under(messagePath(args.reply_to_id), "/createReply"),
            body: {
              comment: args.body,
              message: {
                ...(args.to.length
                  ? { toRecipients: recipients(args.to) }
                  : {}),
                ...(args.cc ? { ccRecipients: recipients(args.cc) } : {}),
                ...(args.subject ? { subject: args.subject } : {}),
              },
            },
            scope,
            read: false,
          },
          signal,
        );
        return draftResult(created);
      }
      const created = await graph.json<GraphMessage>(
        {
          method: "POST",
          ...route("/me/messages"),
          body: {
            subject: args.subject,
            body: { contentType: "text", content: args.body },
            toRecipients: recipients(args.to),
            ...(args.cc ? { ccRecipients: recipients(args.cc) } : {}),
          },
          scope,
          read: false,
        },
        signal,
      );
      return draftResult(created);
    },

    async updateDraft(args, { signal }) {
      const updated = await graph.json<GraphMessage>(
        {
          method: "PATCH",
          ...messagePath(args.draft_id),
          body: {
            ...(args.subject !== undefined ? { subject: args.subject } : {}),
            ...(args.body !== undefined
              ? { body: { contentType: "text", content: args.body } }
              : {}),
            ...(args.to ? { toRecipients: recipients(args.to) } : {}),
            ...(args.cc ? { ccRecipients: recipients(args.cc) } : {}),
          },
          scope: MICROSOFT_SCOPES.mail.update_draft,
          read: false,
        },
        signal,
      );
      return draftResult(updated);
    },

    async send(args, { signal }) {
      await graph.send(
        {
          method: "POST",
          ...under(messagePath(args.draft_id), "/send"),
          scope: MICROSOFT_SCOPES.mail.send,
          read: false,
        },
        signal,
      );
      // 202 with no body: Graph does not say which sent item the draft became.
      return {};
    },

    async move(args, { signal }) {
      const folder = await mailFolderPath(args.folder, signal);
      const moved = await graph.json<GraphMessage>(
        {
          method: "POST",
          ...under(messagePath(args.message_id), "/move"),
          body: {
            destinationId: decodeURIComponent(
              folder.path.slice("/me/mailFolders/".length),
            ),
          },
          scope: MICROSOFT_SCOPES.mail.move,
          read: false,
        },
        signal,
      );
      return messageSummary(moved);
    },

    async label(args, { signal }) {
      const path = messagePath(args.message_id);
      const current = await graph.json<GraphMessage>(
        get(path, { $select: "id,categories" }, MICROSOFT_SCOPES.mail.label),
        signal,
      );
      const remove = new Set(
        (args.remove ?? []).map((name) => name.toLowerCase()),
      );
      const categories = (current?.categories ?? []).filter(
        (name) => !remove.has(name.toLowerCase()),
      );
      for (const name of args.add ?? []) {
        if (
          !categories.some(
            (existing) => existing.toLowerCase() === name.toLowerCase(),
          )
        )
          categories.push(name);
      }
      const updated = await graph.json<GraphMessage>(
        {
          method: "PATCH",
          ...path,
          body: { categories },
          scope: MICROSOFT_SCOPES.mail.label,
          read: false,
        },
        signal,
      );
      return messageSummary(updated);
    },
  };

  const calendarPath = async (
    name: string | undefined,
    signal?: AbortSignal,
  ): Promise<CalendarRoute> => {
    if (!name) return { at: route("/me") };
    const found = await graph.json<{ value?: GraphCalendar[] }>(
      get(
        route("/me/calendars"),
        { $filter: `name eq ${odata(name)}`, $select: "id,name", $top: "2" },
        MICROSOFT_SCOPES.calendar.list,
      ),
      signal,
    );
    const id = found?.value?.[0]?.id;
    if (!id) throw invalidRequest(`No calendar named '${name}'.`);
    return {
      at: route(`/me/calendars/${segment(id)}`, "/me/calendars/{calendar-id}"),
      calendarId: id,
    };
  };

  const eventBody = (args: {
    title?: string;
    start?: string;
    end?: string;
    time_zone?: string;
    all_day?: boolean;
    attendees?: readonly string[];
    optional_attendees?: readonly string[];
    location?: string;
    body?: string;
    online_meeting?: boolean;
  }) => {
    const allDay = args.all_day === true;
    const zone = args.time_zone ?? "UTC";
    return {
      ...(args.title !== undefined ? { subject: args.title } : {}),
      ...(args.start !== undefined
        ? {
            start: {
              dateTime: wallTime(args.start, zone, allDay),
              timeZone: zone,
            },
          }
        : {}),
      ...(args.end !== undefined
        ? {
            end: { dateTime: wallTime(args.end, zone, allDay), timeZone: zone },
          }
        : {}),
      ...(args.all_day !== undefined ? { isAllDay: allDay } : {}),
      ...(args.attendees !== undefined || args.optional_attendees !== undefined
        ? {
            attendees: [
              ...(args.attendees ?? []).map((email) => ({
                emailAddress: { address: email },
                type: "required",
              })),
              ...(args.optional_attendees ?? []).map((email) => ({
                emailAddress: { address: email },
                type: "optional",
              })),
            ],
          }
        : {}),
      ...(args.location !== undefined
        ? { location: { displayName: args.location } }
        : {}),
      ...(args.body !== undefined
        ? { body: { contentType: "text", content: args.body } }
        : {}),
      ...(args.online_meeting !== undefined
        ? {
            isOnlineMeeting: args.online_meeting,
            ...(args.online_meeting
              ? { onlineMeetingProvider: "teamsForBusiness" }
              : {}),
          }
        : {}),
    };
  };

  const calendar: CalendarSession = {
    async list(args, { signal }) {
      const { at, calendarId } = await calendarPath(args.calendar, signal);
      const page = await graph.page<GraphEvent>(
        get(
          under(at, "/calendarView"),
          {
            startDateTime: args.from,
            endDateTime: args.to,
            $select: EVENT_SELECT,
            $orderby: "start/dateTime",
            $top: String(args.limit),
          },
          MICROSOFT_SCOPES.calendar.list,
        ),
        args.limit,
        signal,
        args.cursor,
      );
      return {
        events: page.items.map((event) => eventSummary(event, calendarId)),
        ...(page.next ? { cursor: page.next } : {}),
      };
    },

    async read(args, { signal }) {
      const { at, calendarId } = eventRoute(args.event_id);
      return fullEvent(
        await graph.json<GraphEvent>(
          get(
            at,
            { $select: `${EVENT_SELECT},attendees,body` },
            MICROSOFT_SCOPES.calendar.read,
          ),
          signal,
        ),
        calendarId,
      );
    },

    async freeBusy(args, { signal }) {
      const answered: { schedule: GraphScheduleInformation; asked: string }[] =
        [];
      for (
        let start = 0;
        start < args.attendees.length;
        start += SCHEDULES_PER_CALL
      ) {
        const batch = args.attendees.slice(start, start + SCHEDULES_PER_CALL);
        const result = await graph.json<{
          value?: GraphScheduleInformation[];
        }>(
          {
            method: "POST",
            ...route("/me/calendar/getSchedule"),
            headers: preferZone(args.time_zone),
            body: {
              schedules: batch,
              startTime: { dateTime: utc(args.from), timeZone: "UTC" },
              endTime: { dateTime: utc(args.to), timeZone: "UTC" },
              availabilityViewInterval: 30,
            },
            scope: MICROSOFT_SCOPES.calendar.free_busy,
            // getSchedule only reads, so a throttled call may be retried.
            read: true,
          },
          signal,
        );
        (result?.value ?? []).forEach((schedule, index) =>
          answered.push({ schedule, asked: batch[index] ?? "" }),
        );
      }
      return {
        time_zone: args.time_zone,
        schedules: answered.map(({ schedule, asked }) => ({
          attendee: schedule.scheduleId ?? asked,
          busy: (schedule.scheduleItems ?? []).flatMap((item) => {
            const status = BUSY[item.status ?? "unknown"];
            if (!status) return [];
            return [
              {
                start: graphTime(item.start?.dateTime, false),
                end: graphTime(item.end?.dateTime, false),
                status,
              },
            ];
          }),
          ...(schedule.error?.message ? { error: schedule.error.message } : {}),
        })),
      };
    },

    async create(args, { signal }) {
      return fullEvent(
        await graph.json<GraphEvent>(
          {
            method: "POST",
            ...route("/me/events"),
            headers: preferZone(args.time_zone),
            body: eventBody(args),
            scope: MICROSOFT_SCOPES.calendar.create,
            read: false,
          },
          signal,
        ),
      );
    },

    async update(args, { signal }) {
      const { event_id: id, ...changes } = args;
      const { at, calendarId } = eventRoute(id);
      if (changes.body !== undefined) {
        // Graph replaces the whole body, and a Teams meeting's join details
        // live in it: dropping them disables the meeting (event-update.md).
        // The blob has no documented delimiter to keep it by, so refuse.
        const current = await graph.json<GraphEvent>(
          get(
            at,
            { $select: "id,isOnlineMeeting" },
            MICROSOFT_SCOPES.calendar.read,
          ),
          signal,
        );
        if (current?.isOnlineMeeting)
          throw invalidRequest(
            "This event is an online meeting, whose join details live in its body; changing the body would disable the meeting. Change the other fields, or put the note in the attendees' invitation another way.",
          );
      }
      return fullEvent(
        await graph.json<GraphEvent>(
          {
            method: "PATCH",
            ...at,
            ...(args.time_zone ? { headers: preferZone(args.time_zone) } : {}),
            body: eventBody(changes),
            scope: MICROSOFT_SCOPES.calendar.update,
            read: false,
          },
          signal,
        ),
        calendarId,
      );
    },

    async respond(args, { signal }) {
      const action = {
        accept: "accept",
        tentative: "tentativelyAccept",
        decline: "decline",
      }[args.response];
      await graph.send(
        {
          method: "POST",
          ...under(eventRoute(args.event_id).at, `/${action}`),
          body: {
            ...(args.comment !== undefined ? { comment: args.comment } : {}),
            sendResponse: true,
          },
          scope: MICROSOFT_SCOPES.calendar.respond,
          read: false,
        },
        signal,
      );
    },

    async cancel(args, { signal }) {
      await graph.send(
        {
          method: "POST",
          ...under(eventRoute(args.event_id).at, "/cancel"),
          body: {
            ...(args.comment !== undefined ? { comment: args.comment } : {}),
          },
          scope: MICROSOFT_SCOPES.calendar.cancel,
          read: false,
        },
        signal,
      );
    },
  };

  const itemMeta = (id: string, scope: string, signal?: AbortSignal) =>
    graph.json<GraphDriveItem>(
      get(itemPath(id), { $select: DRIVE_SELECT }, scope),
      signal,
    );

  const drive: DriveSession = {
    async search(args, { signal }) {
      const base = args.folder_id
        ? itemPath(args.folder_id)
        : route("/me/drive/root");
      const page = await graph.page<GraphDriveItem>(
        get(
          under(
            base,
            `/search(q=${segment(odata(args.query))})`,
            "/search(q='{q}')",
          ),
          { $select: DRIVE_SELECT, $top: String(args.limit) },
          MICROSOFT_SCOPES.drive.search,
        ),
        args.limit,
        signal,
        args.cursor,
      );
      const after = args.modified_after
        ? Date.parse(args.modified_after)
        : undefined;
      return {
        files: page.items
          .filter(
            (item) =>
              after === undefined ||
              (item.lastModifiedDateTime !== undefined &&
                Date.parse(item.lastModifiedDateTime) > after),
          )
          .map(fileSummary),
        ...(page.next ? { cursor: page.next } : {}),
      };
    },

    async read(args, { signal }) {
      const item = await itemMeta(
        args.file_id,
        MICROSOFT_SCOPES.drive.read,
        signal,
      );
      const file = fileSummary(item);
      const mimeType = item.file?.mimeType ?? "";
      const name = item.name ?? "";
      if (!TEXT_TYPES.test(mimeType) && !TEXT_EXTENSIONS.test(name)) {
        return {
          file,
          unavailable: `${name || "This file"} is not a text file. Use drive download, then the documents tool for Word and PDF files.`,
        };
      }
      if ((item.size ?? 0) > args.max_bytes) {
        return {
          file,
          unavailable: `${name} is larger than ${args.max_bytes} bytes. Use drive download.`,
        };
      }
      const content = await graph.bytes(
        get(
          under(itemPath(args.file_id), "/content"),
          undefined,
          MICROSOFT_SCOPES.drive.read,
        ),
        signal,
      );
      const text = new TextDecoder().decode(content.bytes);
      return {
        file,
        content: {
          content_type:
            /html/i.test(mimeType) || /\.html?$/i.test(name) ? "html" : "text",
          content: text,
        },
      };
    },

    async download(args, { signal }) {
      const item = await itemMeta(
        args.file_id,
        MICROSOFT_SCOPES.drive.download,
        signal,
      );
      if (item.folder)
        throw invalidRequest(`${item.name ?? "This item"} is a folder.`);
      const content = await graph.bytes(
        get(
          under(itemPath(args.file_id), "/content"),
          undefined,
          MICROSOFT_SCOPES.drive.download,
        ),
        signal,
      );
      const mimeType = item.file?.mimeType ?? content.contentType;
      return {
        name: item.name ?? "file",
        ...(mimeType ? { mime_type: mimeType } : {}),
        bytes: content.bytes,
      };
    },

    async upload(args, { signal }) {
      const parent = args.folder_id
        ? itemPath(args.folder_id)
        : route("/me/drive/root");
      const target = under(parent, `:/${segment(args.name)}:`, ":/{filename}:");
      const scope = MICROSOFT_SCOPES.drive.upload;
      if (args.bytes.byteLength <= SIMPLE_UPLOAD_LIMIT_BYTES) {
        const item = await graph.json<GraphDriveItem>(
          {
            method: "PUT",
            ...under(target, "/content"),
            query: { "@microsoft.graph.conflictBehavior": "rename" },
            headers: {
              "Content-Type": args.mime_type ?? "application/octet-stream",
            },
            body: args.bytes,
            scope,
            read: false,
          },
          signal,
        );
        return fileSummary(item);
      }
      // Above 4 MB: an upload session, sent in 320 KiB-multiple ranges to its
      // pre-authenticated URL (driveitem-createuploadsession.md).
      const session = await graph.json<GraphUploadSession>(
        {
          method: "POST",
          ...under(target, "/createUploadSession"),
          body: { item: { "@microsoft.graph.conflictBehavior": "rename" } },
          scope,
          read: false,
        },
        signal,
      );
      if (!session?.uploadUrl)
        throw invalidRequest("Graph returned no upload URL");
      const total = args.bytes.byteLength;
      let last: Awaited<ReturnType<GraphClient["uploadRange"]>> | undefined;
      for (let start = 0; start < total; start += UPLOAD_CHUNK_BYTES) {
        const end = Math.min(start + UPLOAD_CHUNK_BYTES, total) - 1;
        last = await graph.uploadRange(
          session.uploadUrl,
          args.bytes.subarray(start, end + 1),
          { start, end, total },
          signal,
        );
      }
      return fileSummary(await graph.decode<GraphDriveItem>(last!));
    },
  };

  return { provider: "microsoft", mail, calendar, drive };
}
