import type { Tracer } from "@opentelemetry/api";
import type {
  CalendarSession,
  DriveSession,
  MailSession,
  ProductivityCallContext,
  ProductivityCapabilities,
  ProductivitySession,
  ProductivitySessionOptions,
} from "@introspection-ai/recipes/productivity";

import { GoogleMcpBackend, type McpCommand } from "./mcp.js";
import { type GoogleEndpoints, GoogleTransport, type Sleep } from "./http.js";
import { GoogleRestBackend } from "./rest.js";
import { defaultTracer } from "./telemetry.js";

/**
 * What the package serves, and from where by default
 * (docs/productivity/google.md, Backends). A command marked `mcp` is served
 * by the Recipe's Workspace MCP server when the session can call its tool,
 * and by REST otherwise. The effects restate the host's fixed table,
 * which the host checks; a companion imports the host's types only.
 */
export const GOOGLE_PRODUCTIVITY_CAPABILITIES = {
  mail: {
    labels: "labels",
    folders: "labels",
    commands: {
      search: { effect: "read", backend: "mcp" },
      read: { effect: "read", backend: "mcp" },
      fetch_attachment: { effect: "read", backend: "rest" },
      draft: { effect: "reversible", backend: "mcp" },
      update_draft: { effect: "reversible", backend: "mcp" },
      send: { effect: "irreversible", backend: "rest" },
      move: {
        effect: "reversible",
        backend: "mcp",
        note: "Gmail has no folders: a folder is a label, moving takes the message out of the inbox, and `archive` only does that.",
      },
      label: {
        effect: "reversible",
        backend: "mcp",
        note: "Labels are Gmail labels, named as Gmail shows them.",
      },
    },
  },
  calendar: {
    commands: {
      list: { effect: "read", backend: "mcp" },
      read: { effect: "read", backend: "mcp" },
      free_busy: { effect: "read", backend: "rest" },
      create: { effect: "sends", backend: "mcp" },
      update: { effect: "sends", backend: "mcp" },
      respond: { effect: "sends", backend: "mcp" },
      cancel: {
        effect: "irreversible",
        backend: "mcp",
        note: "Google sends attendees its own cancellation notice; a comment is not delivered.",
      },
    },
  },
  drive: {
    commands: {
      search: { effect: "read", backend: "mcp" },
      read: {
        effect: "read",
        backend: "mcp",
        note: "Google Docs, Sheets and Slides are read as text (a Sheet as CSV of its first sheet over REST); Google refuses exports above 10 MB.",
      },
      download: {
        effect: "read",
        backend: "rest",
        note: "Google Docs, Sheets and Slides download as .docx, .xlsx and .pptx.",
      },
      upload: { effect: "reversible", backend: "rest" },
    },
  },
} as const satisfies ProductivityCapabilities;

/** What tests and other hosts may override; production needs none of it. */
export interface GoogleSessionOverrides {
  endpoints?: Partial<GoogleEndpoints>;
  sleep?: Sleep;
  /** Default: the globally registered tracer; tests record the spans. */
  tracer?: Tracer;
}

/** A tool session with every method present and the call context optional. */
type CompleteSession<S> = {
  [K in keyof S]-?: S[K] extends
    ((args: infer A, ctx: infer C) => infer R) | undefined
    ? (args: A, ctx?: C) => R
    : never;
};

export interface GoogleProductivitySession extends ProductivitySession {
  readonly mail: CompleteSession<MailSession>;
  readonly calendar: CompleteSession<CalendarSession>;
  readonly drive: CompleteSession<DriveSession>;
  /** Which backend serves `command` for a call with `ctx`. */
  backendFor(
    command: McpCommand,
    ctx?: ProductivityCallContext,
  ): "mcp" | "rest";
}

/**
 * One person's Google connection. Each call goes to MCP when the session can
 * call the command's tool on the Recipe's Google MCP server (Pi's in-process
 * client, through `ctx.tools`), and to REST otherwise.
 */
export async function createGoogleProductivitySession(
  options: ProductivitySessionOptions,
  overrides: GoogleSessionOverrides = {},
): Promise<GoogleProductivitySession> {
  const transport = new GoogleTransport({
    env: options.env,
    fetchImpl: options.fetch,
    hostAttachesCredential: options.fetch !== undefined,
    endpoints: overrides.endpoints,
    sleep: overrides.sleep,
    tracer: overrides.tracer,
  });
  const rest = new GoogleRestBackend(transport);
  const tracer = overrides.tracer ?? defaultTracer();
  const via = (
    command: McpCommand,
    ctx: ProductivityCallContext,
  ): GoogleMcpBackend | undefined => {
    if (!ctx.tools) return undefined;
    const backend = new GoogleMcpBackend(ctx.tools, rest, tracer);
    return backend.serves(command) ? backend : undefined;
  };

  const mail: CompleteSession<MailSession> = {
    search: async (args, ctx = {}) => {
      const backend = via("mail.search", ctx);
      if (!backend) return rest.mail.search(args, ctx);
      const query = await rest.mail.searchQuery(args, ctx.signal);
      return backend.mailSearch(
        { ...query, limit: args.limit, cursor: args.cursor },
        ctx.signal,
      );
    },
    read: (args, ctx = {}) => {
      const backend = via("mail.read", ctx);
      return backend && "message_id" in args
        ? backend.mailRead(args.message_id, ctx.signal)
        : rest.mail.read(args, ctx);
    },
    fetchAttachment: (args, ctx) => rest.mail.fetchAttachment(args, ctx),
    // A reply needs In-Reply-To and References, which only the REST draft sets.
    draft: (args, ctx = {}) => {
      const backend = via("mail.draft", ctx);
      return backend && !args.reply_to_id
        ? backend.mailDraft({
            to: [...args.to],
            cc: [...(args.cc ?? [])],
            subject: args.subject,
            body: args.body,
          })
        : rest.mail.draft(args, ctx);
    },
    updateDraft: (args, ctx = {}) => {
      const backend = via("mail.update_draft", ctx);
      return backend
        ? backend.mailUpdateDraft({
            draftId: args.draft_id,
            to: args.to ? [...args.to] : undefined,
            cc: args.cc ? [...args.cc] : undefined,
            subject: args.subject,
            body: args.body,
          })
        : rest.mail.updateDraft(args, ctx);
    },
    send: (args, ctx) => rest.mail.send(args, ctx),
    move: async (args, ctx = {}) => {
      const backend = via("mail.move", ctx);
      if (!backend) return rest.mail.move(args, ctx);
      const change = await rest.mail.moveChange(args.folder, ctx.signal);
      return backend.mailModifyLabels(
        "mail.move",
        { messageId: args.message_id, ...change },
        ctx.signal,
      );
    },
    label: async (args, ctx = {}) => {
      const backend = via("mail.label", ctx);
      if (!backend) return rest.mail.label(args, ctx);
      const change = await rest.mail.labelChange(args, ctx.signal);
      return backend.mailModifyLabels(
        "mail.label",
        { messageId: args.message_id, ...change },
        ctx.signal,
      );
    },
  };

  const calendar: CompleteSession<CalendarSession> = {
    list: async (args, ctx = {}) => {
      const backend = via("calendar.list", ctx);
      if (!backend) return rest.calendar.list(args, ctx);
      const calendarId = await rest.calendar.calendarId(
        args.calendar,
        ctx.signal,
      );
      return backend.calendarList({
        calendarId,
        from: args.from,
        to: args.to,
        limit: args.limit,
        cursor: args.cursor,
      });
    },
    read: (args, ctx = {}) => {
      const backend = via("calendar.read", ctx);
      return backend
        ? backend.calendarRead(args.event_id)
        : rest.calendar.read(args, ctx);
    },
    freeBusy: (args, ctx) => rest.calendar.freeBusy(args, ctx),
    create: (args, ctx = {}) => {
      const backend = via("calendar.create", ctx);
      return backend
        ? backend.calendarCreate(rest.calendar.eventBody(args), args.time_zone)
        : rest.calendar.create(args, ctx);
    },
    update: (args, ctx = {}) => {
      const backend = via("calendar.update", ctx);
      if (!backend) return rest.calendar.update(args, ctx);
      const { event_id: eventId, ...change } = args;
      return backend.calendarUpdate(
        eventId,
        rest.calendar.eventBody(change),
        args.time_zone,
      );
    },
    respond: (args, ctx = {}) => {
      const backend = via("calendar.respond", ctx);
      return backend
        ? backend.calendarRespond({
            eventId: args.event_id,
            response: args.response,
            comment: args.comment,
          })
        : rest.calendar.respond(args, ctx);
    },
    cancel: (args, ctx = {}) => {
      const backend = via("calendar.cancel", ctx);
      return backend
        ? backend.calendarCancel(args.event_id)
        : rest.calendar.cancel(args, ctx);
    },
  };

  const drive: CompleteSession<DriveSession> = {
    search: (args, ctx = {}) => {
      const backend = via("drive.search", ctx);
      return backend
        ? backend.driveSearch({
            query: args.query,
            folderId: args.folder_id,
            modifiedAfter: args.modified_after,
            limit: args.limit,
            cursor: args.cursor,
          })
        : rest.drive.search(args, ctx);
    },
    read: (args, ctx = {}) => {
      const backend = via("drive.read", ctx);
      return backend
        ? backend.driveRead(args.file_id, args.max_bytes, ctx.signal)
        : rest.drive.read(args, ctx);
    },
    download: (args, ctx) => rest.drive.download(args, ctx),
    upload: (args, ctx) => rest.drive.upload(args, ctx),
  };

  return {
    provider: "google",
    mail,
    calendar,
    drive,
    backendFor: (command, ctx = {}) => (via(command, ctx) ? "mcp" : "rest"),
  };
}
