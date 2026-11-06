import type {
  CalendarCommand,
  CalendarSession,
  DriveCommand,
  DriveSession,
  MailCommand,
  MailSession,
  ProductivityCapabilities,
  ProductivitySession,
  ProductivitySessionOptions,
} from "@introspection-ai/recipes/productivity";

import {
  connectGoogleMcp,
  EXPECTED_MCP_TOOLS,
  type GoogleMcpBackend,
  type GoogleMcpServers,
  type McpCommand,
  type McpFetch,
} from "./mcp.js";
import {
  type GoogleEndpoints,
  type GoogleFetch,
  GoogleTransport,
  type Sleep,
} from "./http.js";
import { GoogleRestBackend } from "./rest.js";

/**
 * What the package serves, and from where by default
 * (docs/productivity/google.md, Backends). A command marked `mcp` is served
 * by the Workspace MCP server when the server lists its tool at session
 * start, and by REST otherwise. The effects restate the host's fixed table,
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
  mcpServers?: Partial<GoogleMcpServers>;
  mcpFetch?: McpFetch;
  sleep?: Sleep;
  /** Skip the MCP servers entirely: every command over REST. */
  restOnly?: boolean;
}

export interface GoogleProductivitySession extends ProductivitySession {
  readonly mail: Required<MailSession>;
  readonly calendar: Required<CalendarSession>;
  readonly drive: Required<DriveSession>;
  /** Which backend serves each MCP-capable command in this session. */
  readonly backends: Readonly<Partial<Record<McpCommand, "mcp" | "rest">>>;
}

function enabledMcpCommands(options: ProductivitySessionOptions): McpCommand[] {
  const tools = options.config.tools;
  const enabled = [
    ...(tools.mail ?? []).map((command: MailCommand) => `mail.${command}`),
    ...(tools.calendar ?? []).map(
      (command: CalendarCommand) => `calendar.${command}`,
    ),
    ...(tools.drive ?? []).map((command: DriveCommand) => `drive.${command}`),
  ];
  return enabled.filter(
    (command): command is McpCommand => command in EXPECTED_MCP_TOOLS,
  );
}

/**
 * One person's Google connection. The MCP servers the enabled commands need
 * are listed once, here; each command then goes to MCP when its tool was
 * listed, and to REST otherwise.
 */
export async function createGoogleProductivitySession(
  options: ProductivitySessionOptions,
  overrides: GoogleSessionOverrides = {},
): Promise<GoogleProductivitySession> {
  const transport = new GoogleTransport({
    env: options.env,
    fetchImpl: options.fetch as GoogleFetch | undefined,
    hostAttachesCredential: options.fetch !== undefined,
    endpoints: overrides.endpoints,
    sleep: overrides.sleep,
  });
  const rest = new GoogleRestBackend(transport);
  const commands = overrides.restOnly ? [] : enabledMcpCommands(options);
  const mcp = commands.length
    ? await connectGoogleMcp(transport, rest, {
        servers: overrides.mcpServers,
        fetchImpl:
          overrides.mcpFetch ?? (options.fetch as McpFetch | undefined),
        commands,
      })
    : undefined;
  const via = (command: McpCommand): GoogleMcpBackend | undefined =>
    mcp?.backend.served.has(command) ? mcp.backend : undefined;
  const backends = Object.fromEntries(
    (Object.keys(EXPECTED_MCP_TOOLS) as McpCommand[]).map((command) => [
      command,
      via(command) ? "mcp" : "rest",
    ]),
  ) as Record<McpCommand, "mcp" | "rest">;

  const mail: Required<MailSession> = {
    search: async (args, ctx = {}) => {
      const backend = via("mail.search");
      if (!backend) return rest.mail.search(args, ctx);
      const query = await rest.mail.searchQuery(args, ctx.signal);
      return backend.mailSearch(
        { ...query, limit: args.limit, cursor: args.cursor },
        ctx.signal,
      );
    },
    read: (args, ctx = {}) => {
      const backend = via("mail.read");
      return backend && "message_id" in args
        ? backend.mailRead(args.message_id, ctx.signal)
        : rest.mail.read(args, ctx);
    },
    fetchAttachment: (args, ctx) => rest.mail.fetchAttachment(args, ctx),
    // A reply needs In-Reply-To and References, which only the REST draft sets.
    draft: (args, ctx = {}) => {
      const backend = via("mail.draft");
      return backend && !args.reply_to_id
        ? backend.mailDraft(
            {
              to: [...args.to],
              cc: [...(args.cc ?? [])],
              subject: args.subject,
              body: args.body,
            },
            ctx.signal,
          )
        : rest.mail.draft(args, ctx);
    },
    updateDraft: (args, ctx = {}) => {
      const backend = via("mail.update_draft");
      return backend
        ? backend.mailUpdateDraft(
            {
              draftId: args.draft_id,
              to: args.to ? [...args.to] : undefined,
              cc: args.cc ? [...args.cc] : undefined,
              subject: args.subject,
              body: args.body,
            },
            ctx.signal,
          )
        : rest.mail.updateDraft(args, ctx);
    },
    send: (args, ctx) => rest.mail.send(args, ctx),
    move: async (args, ctx = {}) => {
      const backend = via("mail.move");
      if (!backend) return rest.mail.move(args, ctx);
      const change = await rest.mail.moveChange(args.folder, ctx.signal);
      return backend.mailModifyLabels(
        "mail.move",
        { messageId: args.message_id, ...change },
        ctx.signal,
      );
    },
    label: async (args, ctx = {}) => {
      const backend = via("mail.label");
      if (!backend) return rest.mail.label(args, ctx);
      const change = await rest.mail.labelChange(args, ctx.signal);
      return backend.mailModifyLabels(
        "mail.label",
        { messageId: args.message_id, ...change },
        ctx.signal,
      );
    },
  };

  const calendar: Required<CalendarSession> = {
    list: async (args, ctx = {}) => {
      const backend = via("calendar.list");
      if (!backend) return rest.calendar.list(args, ctx);
      const calendarId = await rest.calendar.calendarId(
        args.calendar,
        ctx.signal,
      );
      return backend.calendarList(
        {
          calendarId,
          from: args.from,
          to: args.to,
          limit: args.limit,
          cursor: args.cursor,
        },
        ctx.signal,
      );
    },
    read: (args, ctx = {}) => {
      const backend = via("calendar.read");
      return backend
        ? backend.calendarRead(args.event_id, ctx.signal)
        : rest.calendar.read(args, ctx);
    },
    freeBusy: (args, ctx) => rest.calendar.freeBusy(args, ctx),
    create: (args, ctx = {}) => {
      const backend = via("calendar.create");
      return backend
        ? backend.calendarCreate(
            rest.calendar.eventBody(args),
            args.time_zone,
            ctx.signal,
          )
        : rest.calendar.create(args, ctx);
    },
    update: (args, ctx = {}) => {
      const backend = via("calendar.update");
      if (!backend) return rest.calendar.update(args, ctx);
      const { event_id: eventId, ...change } = args;
      return backend.calendarUpdate(
        eventId,
        rest.calendar.eventBody(change),
        args.time_zone,
        ctx.signal,
      );
    },
    respond: (args, ctx = {}) => {
      const backend = via("calendar.respond");
      return backend
        ? backend.calendarRespond(
            {
              eventId: args.event_id,
              response: args.response,
              comment: args.comment,
            },
            ctx.signal,
          )
        : rest.calendar.respond(args, ctx);
    },
    cancel: (args, ctx = {}) => {
      const backend = via("calendar.cancel");
      return backend
        ? backend.calendarCancel(args.event_id, ctx.signal)
        : rest.calendar.cancel(args, ctx);
    },
  };

  const drive: Required<DriveSession> = {
    search: (args, ctx = {}) => {
      const backend = via("drive.search");
      return backend
        ? backend.driveSearch(
            {
              query: args.query,
              folderId: args.folder_id,
              modifiedAfter: args.modified_after,
              limit: args.limit,
              cursor: args.cursor,
            },
            ctx.signal,
          )
        : rest.drive.search(args, ctx);
    },
    read: (args, ctx = {}) => {
      const backend = via("drive.read");
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
    backends,
    close: async () => {
      await mcp?.close();
    },
  };
}
