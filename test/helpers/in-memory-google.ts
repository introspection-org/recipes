// Loaded by the fixture's provider package through the Recipe loader, so it
// imports nothing at run time.
import type {
  CalendarEvent,
  DriveFileSummary,
  MailMessage,
  ProductivitySession,
} from "../../src/productivity/types.js";

const ME = { email: "me@example.test", name: "Sam Example" };
const DANA = { email: "dana@example.test", name: "Dana Example" };
const LEE = { email: "lee@example.test", name: "Lee Example" };

// The machine's own zone: what `date` prints in the session's shell, so
// "tomorrow" means the same day to the data as it does to the clock.
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** RFC 3339 with the local offset, such as 2026-03-02T09:00:00-08:00. */
function local(date: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${offset < 0 ? "-" : "+"}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

/** `hour:minute` local time, `offset` days from today, never after now when it is today or earlier. */
function day(offset: number, hour: number, minute = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(hour, minute, 0, 0);
  const now = Date.now();
  if (offset <= 0 && date.getTime() > now)
    return local(new Date(now - 10 * 60_000));
  return local(date);
}

function notFound(what: string): Error {
  return Object.assign(new Error(`${what} not found`), {
    productivity: { code: "not_found", message: `${what} not found` },
  });
}

function overlaps(start: string, end: string, from: string, to: string) {
  return (
    Date.parse(start) < Date.parse(to) && Date.parse(end) > Date.parse(from)
  );
}

/** Every plain word of a Gmail-style query in the message, `from:` against the sender. */
function matches(message: MailMessage, query: string | undefined): boolean {
  const haystack = [
    message.from?.name,
    message.from?.email,
    message.subject,
    message.snippet,
    message.body?.content,
  ]
    .join(" ")
    .toLowerCase();
  return (query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => {
      const [operator, value] = token.includes(":")
        ? token.split(":", 2)
        : [undefined, token];
      if (operator === "from")
        return `${message.from?.name} ${message.from?.email}`
          .toLowerCase()
          .includes(value!.replace(/"/g, ""));
      if (operator) return true;
      return haystack.includes(value!.replace(/"/g, ""));
    });
}

/**
 * Placeholder mail, calendar and drive for one run, dated around today in
 * the machine's time zone so a prompt about tomorrow finds something. Writes
 * are kept in `actions`.
 */
export function createInMemoryGoogleSession(): ProductivitySession & {
  actions: Array<{ command: string; args: unknown }>;
} {
  const messages: MailMessage[] = [
    {
      id: "m-budget",
      thread_id: "t-budget",
      from: DANA,
      to: [ME],
      subject: "Q3 budget numbers",
      snippet: "Can you bring the latest budget sheet to tomorrow's review?",
      sent_at: day(0, 8, 12),
      unread: true,
      labels: ["INBOX", "UNREAD"],
      body: {
        content_type: "text",
        content:
          "Hi Sam,\n\nCan you bring the latest budget sheet to tomorrow's planning review? Finance wants the Q3 travel line.\n\nThanks,\nDana",
      },
    },
    {
      id: "m-offsite",
      thread_id: "t-offsite",
      from: LEE,
      to: [ME],
      subject: "Offsite venue options",
      snippet: "Three venues shortlisted for the team offsite.",
      sent_at: day(-1, 16, 40),
      labels: ["INBOX"],
      body: {
        content_type: "text",
        content:
          "Three venues shortlisted for the team offsite. Vote by Friday.",
      },
    },
    {
      id: "m-lunch",
      thread_id: "t-lunch",
      from: DANA,
      to: [ME],
      subject: "Lunch on Thursday?",
      snippet: "Free for lunch on Thursday?",
      sent_at: day(-3, 11, 5),
      labels: ["INBOX"],
      body: { content_type: "text", content: "Free for lunch on Thursday?" },
    },
  ];
  const events: CalendarEvent[] = [
    {
      id: "e-standup",
      title: "Team standup",
      start: day(1, 9),
      end: day(1, 9, 15),
      time_zone: TIME_ZONE,
      organizer: LEE,
      response: "accepted",
      attendees: [ME, LEE],
    },
    {
      id: "e-review",
      title: "Q3 planning review",
      start: day(1, 14),
      end: day(1, 15),
      time_zone: TIME_ZONE,
      location: "Room 4",
      organizer: DANA,
      response: "accepted",
      attendees: [ME, DANA, LEE],
      body: { content_type: "text", content: "Budget and hiring plan." },
    },
    {
      id: "e-dentist",
      title: "Dentist",
      start: day(3, 10),
      end: day(3, 11),
      time_zone: TIME_ZONE,
      is_organizer: true,
    },
  ];
  const files: DriveFileSummary[] = [
    {
      id: "f-budget",
      name: "Q3 Budget",
      mime_type: "application/vnd.google-apps.spreadsheet",
      native_type: "spreadsheet",
      modified_at: day(-1, 17),
      modified_by: DANA.name,
      web_url: "https://docs.example.test/spreadsheets/d/f-budget",
    },
    {
      id: "f-offsite",
      name: "Offsite agenda",
      mime_type: "application/vnd.google-apps.document",
      native_type: "document",
      modified_at: day(-2, 10),
      web_url: "https://docs.example.test/document/d/f-offsite",
    },
  ];
  const actions: Array<{ command: string; args: unknown }> = [];
  const record = (command: string, args: unknown) =>
    actions.push({ command, args });
  const message = (id: string) => {
    const found = messages.find((m) => m.id === id);
    if (!found) throw notFound("message");
    return found;
  };
  const event = (id: string) => {
    const found = events.find((e) => e.id === id);
    if (!found) throw notFound("event");
    return found;
  };
  const file = (id: string) => {
    const found = files.find((f) => f.id === id);
    if (!found) throw notFound("file");
    return found;
  };
  const summary = ({ body: _body, ...rest }: MailMessage) => rest;
  let drafts = 0;

  return {
    provider: "google",
    actions,
    mail: {
      search: async (args) => ({
        messages: messages
          .filter(
            (m) =>
              matches(m, args.query) &&
              (!args.from || matches(m, `from:${args.from}`)),
          )
          .slice(0, args.limit)
          .map(summary),
      }),
      read: async (args) => ({
        messages:
          "message_id" in args
            ? [message(args.message_id)]
            : messages.filter((m) => m.thread_id === args.thread_id),
      }),
      fetchAttachment: async () => {
        throw notFound("attachment");
      },
      draft: async (args) => {
        record("mail draft", args);
        const replied = args.reply_to_id
          ? message(args.reply_to_id)
          : undefined;
        drafts += 1;
        return {
          id: `d-${drafts}`,
          message_id: `m-draft-${drafts}`,
          ...(replied?.thread_id ? { thread_id: replied.thread_id } : {}),
          to: args.to.map((email) => ({ email })),
          subject: args.subject,
        };
      },
      updateDraft: async (args) => {
        record("mail update_draft", args);
        return {
          id: args.draft_id,
          ...(args.subject ? { subject: args.subject } : {}),
        };
      },
      send: async (args) => {
        record("mail send", args);
        return { message_id: `sent-${args.draft_id}` };
      },
      move: async (args) => {
        record("mail move", args);
        return summary(message(args.message_id));
      },
      label: async (args) => {
        record("mail label", args);
        return summary(message(args.message_id));
      },
    },
    calendar: {
      list: async (args) => ({
        events: events
          .filter((e) => overlaps(e.start, e.end, args.from, args.to))
          .slice(0, args.limit)
          .map(({ attendees: _a, body: _b, ...rest }) => rest),
      }),
      read: async (args) => event(args.event_id),
      freeBusy: async (args) => ({
        time_zone: args.time_zone,
        schedules: args.attendees.map((attendee) => ({ attendee, busy: [] })),
      }),
      create: async (args) => {
        record("calendar create", args);
        return {
          id: `e-new-${actions.length}`,
          title: args.title,
          start: args.start,
          end: args.end,
          time_zone: args.time_zone,
          is_organizer: true,
        };
      },
      update: async (args) => {
        record("calendar update", args);
        return event(args.event_id);
      },
      respond: async (args) => void record("calendar respond", args),
      cancel: async (args) => void record("calendar cancel", args),
    },
    drive: {
      search: async (args) => ({
        files: files
          .filter((f) =>
            args.query
              .toLowerCase()
              .split(/\s+/)
              .filter(Boolean)
              .some((word) => f.name.toLowerCase().includes(word)),
          )
          .slice(0, args.limit),
      }),
      read: async (args) => {
        const found = file(args.file_id);
        return found.id === "f-budget"
          ? {
              file: found,
              exported_as: "text/csv",
              content: {
                content_type: "text",
                content:
                  "line,q2,q3\ntravel,12000,15500\nsoftware,8000,8200\nevents,4000,6500\n",
              },
            }
          : {
              file: found,
              content: { content_type: "text", content: "Day 1: arrive." },
            };
      },
      download: async (args) => ({
        name: file(args.file_id).name,
        bytes: new TextEncoder().encode("placeholder"),
      }),
      upload: async (args) => {
        record("drive upload", { name: args.name, folder_id: args.folder_id });
        return { id: `f-up-${actions.length}`, name: args.name };
      },
    },
  };
}
