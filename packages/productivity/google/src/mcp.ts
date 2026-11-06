import {
  Client,
  ProtocolError,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type {
  CalendarEvent,
  CalendarListResult,
  DriveReadResult,
  DriveSearchResult,
  MailDraft,
  MailMessageSummary,
  MailReadResult,
  MailSearchResult,
  ProductivityBackend,
} from "@introspection-ai/recipes/productivity";

import type { CalendarEvent as GoogleEvent } from "./calendar.js";
import { driveSearchQuery, type DriveFile } from "./drive.js";
import { GoogleProductivityError } from "./errors.js";
import type { GmailDraft, GmailMessage } from "./gmail.js";
import { mapGoogleError, type GoogleTransport } from "./http.js";
import {
  driveFileSummary,
  eventDetail,
  eventSummary,
  type GoogleRestBackend,
} from "./rest.js";

/** Google's Workspace MCP servers, one per product. */
export interface GoogleMcpServers {
  gmail: string;
  calendar: string;
  drive: string;
}

/**
 * Gmail's host answers; the Calendar and Drive host names follow Google's
 * `<product>mcp.googleapis.com` pattern and are *to confirm*
 * (docs/productivity/google.md, Backends).
 */
export const GOOGLE_MCP_SERVERS: GoogleMcpServers = {
  gmail: "https://gmailmcp.googleapis.com/mcp/v1",
  calendar: "https://calendarmcp.googleapis.com/mcp/v1",
  drive: "https://drivemcp.googleapis.com/mcp/v1",
};

/** The commands an MCP tool can serve; the rest are REST only by design. */
export type McpCommand =
  | "mail.search"
  | "mail.read"
  | "mail.draft"
  | "mail.update_draft"
  | "mail.label"
  | "mail.move"
  | "calendar.list"
  | "calendar.read"
  | "calendar.create"
  | "calendar.update"
  | "calendar.respond"
  | "calendar.cancel"
  | "drive.search"
  | "drive.read";

/**
 * The MCP tool expected to serve each command. **Every name here is to
 * confirm** against the server's authenticated `tools/list`: none could be
 * listed while this was written. The Drive names match a Drive MCP server's
 * published tools (`search_files`, `read_file_content`); the Gmail and
 * Calendar names are the design's intent. A command whose tool the server
 * does not list is served by REST, so a wrong name costs a REST call, never a
 * failure. `mail fetch_attachment`, `mail send`, `calendar free_busy`,
 * `drive download` and `drive upload` have no entry: they are REST only.
 */
export const EXPECTED_MCP_TOOLS: Readonly<
  Record<McpCommand, { server: keyof GoogleMcpServers; tool: string }>
> = {
  "mail.search": { server: "gmail", tool: "search_messages" },
  "mail.read": { server: "gmail", tool: "get_message" },
  "mail.draft": { server: "gmail", tool: "create_draft" },
  "mail.update_draft": { server: "gmail", tool: "update_draft" },
  "mail.label": { server: "gmail", tool: "modify_message_labels" },
  "mail.move": { server: "gmail", tool: "modify_message_labels" },
  "calendar.list": { server: "calendar", tool: "list_events" },
  "calendar.read": { server: "calendar", tool: "get_event" },
  "calendar.create": { server: "calendar", tool: "create_event" },
  "calendar.update": { server: "calendar", tool: "update_event" },
  "calendar.respond": { server: "calendar", tool: "respond_to_event" },
  "calendar.cancel": { server: "calendar", tool: "delete_event" },
  "drive.search": { server: "drive", tool: "search_files" },
  "drive.read": { server: "drive", tool: "read_file_content" },
};

export type McpFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** What one call to a tool needs: a connected client and the tool's name. */
interface McpToolCaller {
  call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

function mapMcpFailure(
  error: unknown,
  label: string,
  scope: string,
): GoogleProductivityError {
  if (error instanceof GoogleProductivityError) return error;
  if (UnauthorizedError.isInstance(error)) {
    return mapGoogleError(401, {}, { scope, label });
  }
  if (SdkHttpError.isInstance(error)) {
    return mapGoogleError(error.status, {}, { scope, label });
  }
  if (ProtocolError.isInstance(error)) {
    return new GoogleProductivityError(
      "provider_error",
      `${label} failed: ${error.message}`,
    );
  }
  return new GoogleProductivityError(
    "provider_error",
    `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * A tool's result as data: its `structuredContent`, else its first text
 * block parsed as JSON, else that text. An `isError` result maps to
 * `provider_error` with the tool's own message, cut short.
 */
export function toolResultData(result: unknown, label: string): unknown {
  const value = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = value.content?.find((block) => block.type === "text")?.text;
  if (value.isError) {
    throw new GoogleProductivityError(
      "provider_error",
      `${label} failed: ${(text ?? "the tool reported an error").slice(0, 500)}`,
    );
  }
  if (value.structuredContent !== undefined) return value.structuredContent;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new GoogleProductivityError(
    "provider_error",
    `${label} returned a result this package does not recognise.`,
  );
}

function list<T>(data: Record<string, unknown>, keys: string[]): T[] {
  for (const key of keys) if (Array.isArray(data[key])) return data[key] as T[];
  return [];
}

function nextToken(data: Record<string, unknown>): string | undefined {
  const token = data.nextPageToken ?? data.next_page_token;
  return typeof token === "string" && token ? token : undefined;
}

/**
 * The Workspace MCP backend: the commands whose expected tool the server
 * lists at session start, mapped onto the same results the REST backend
 * returns. Results are read as the REST resources they wrap (a Gmail
 * `Message`, a Calendar `Event`, a Drive `File`); that assumption is pinned by
 * the contract tests and is *to confirm* against the live servers.
 */
export class GoogleMcpBackend {
  constructor(
    private readonly callers: Partial<
      Record<keyof GoogleMcpServers, McpToolCaller>
    >,
    readonly served: ReadonlySet<McpCommand>,
    private readonly rest: GoogleRestBackend,
  ) {}

  /** Which backend serves `command` in this session. */
  backendFor(command: McpCommand): ProductivityBackend {
    return this.served.has(command) ? "mcp" : "rest";
  }

  private async call(
    command: McpCommand,
    args: Record<string, unknown>,
    scope: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const { server, tool } = EXPECTED_MCP_TOOLS[command];
    const label = `${server} MCP ${tool}`;
    const caller = this.callers[server];
    if (!caller)
      throw new GoogleProductivityError(
        "provider_error",
        `${label} is not connected.`,
      );
    let result: unknown;
    try {
      result = await caller.call(tool, args, signal);
    } catch (error) {
      throw mapMcpFailure(error, label, scope);
    }
    return toolResultData(result, label);
  }

  async mailSearch(
    args: { q?: string; labelIds?: string[]; limit: number; cursor?: string },
    signal?: AbortSignal,
  ): Promise<MailSearchResult> {
    const data = record(
      await this.call(
        "mail.search",
        {
          query: args.q,
          labelIds: args.labelIds,
          pageSize: args.limit,
          pageToken: args.cursor,
        },
        "https://www.googleapis.com/auth/gmail.readonly",
        signal,
      ),
      "mail search",
    );
    const messages = list<GmailMessage>(data, ["messages", "items"]);
    return {
      messages: await Promise.all(
        messages
          .slice(0, args.limit)
          .map((message) => this.mailSummary(message, signal)),
      ),
      cursor: nextToken(data),
    };
  }

  /** A listed message without headers is filled in with a REST metadata read. */
  private async mailSummary(
    message: GmailMessage,
    signal?: AbortSignal,
  ): Promise<MailMessageSummary> {
    const full = message.payload
      ? message
      : await this.rest.mail.gmail.getMessage(message.id, "metadata", signal);
    return this.rest.mail.summary(full, signal);
  }

  async mailRead(
    messageId: string,
    signal?: AbortSignal,
  ): Promise<MailReadResult> {
    const data = record(
      await this.call(
        "mail.read",
        { messageId },
        "https://www.googleapis.com/auth/gmail.readonly",
        signal,
      ),
      "mail read",
    );
    const message = (data.message ?? data) as GmailMessage;
    return { messages: [await this.rest.mail.message(message, signal)] };
  }

  async mailDraft(
    args: {
      to: string[];
      cc: string[];
      subject: string;
      body: string;
      threadId?: string;
    },
    signal?: AbortSignal,
  ): Promise<MailDraft> {
    const draft = record(
      await this.call(
        "mail.draft",
        { ...args },
        "https://www.googleapis.com/auth/gmail.compose",
        signal,
      ),
      "mail draft",
    ) as unknown as GmailDraft;
    return {
      id: draft.id,
      message_id: draft.message?.id,
      thread_id: draft.message?.threadId ?? args.threadId,
    };
  }

  async mailUpdateDraft(
    args: {
      draftId: string;
      to?: string[];
      cc?: string[];
      subject?: string;
      body?: string;
    },
    signal?: AbortSignal,
  ): Promise<MailDraft> {
    const draft = record(
      await this.call(
        "mail.update_draft",
        { ...args },
        "https://www.googleapis.com/auth/gmail.compose",
        signal,
      ),
      "mail update_draft",
    ) as unknown as GmailDraft;
    return {
      id: draft.id,
      message_id: draft.message?.id,
      thread_id: draft.message?.threadId,
    };
  }

  async mailModifyLabels(
    command: "mail.label" | "mail.move",
    args: {
      messageId: string;
      addLabelIds: string[];
      removeLabelIds: string[];
    },
    signal?: AbortSignal,
  ): Promise<MailMessageSummary> {
    const data = record(
      await this.call(
        command,
        { ...args },
        "https://www.googleapis.com/auth/gmail.modify",
        signal,
      ),
      command,
    );
    const message = (data.message ?? data) as GmailMessage;
    return this.mailSummary(
      { ...message, id: message.id ?? args.messageId },
      signal,
    );
  }

  async calendarList(
    args: {
      calendarId: string;
      from: string;
      to: string;
      limit: number;
      cursor?: string;
    },
    signal?: AbortSignal,
  ): Promise<CalendarListResult> {
    const data = record(
      await this.call(
        "calendar.list",
        {
          calendarId: args.calendarId,
          timeMin: args.from,
          timeMax: args.to,
          pageSize: args.limit,
          pageToken: args.cursor,
        },
        "https://www.googleapis.com/auth/calendar.readonly",
        signal,
      ),
      "calendar list",
    );
    const zone = typeof data.timeZone === "string" ? data.timeZone : undefined;
    return {
      events: list<GoogleEvent>(data, ["items", "events"])
        .slice(0, args.limit)
        .map((event) => eventSummary(event, zone)),
      cursor: nextToken(data),
    };
  }

  private async calendarEvent(
    command: "calendar.read" | "calendar.create" | "calendar.update",
    args: Record<string, unknown>,
    scope: string,
    zone: string | undefined,
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    const data = record(await this.call(command, args, scope, signal), command);
    return eventDetail((data.event ?? data) as GoogleEvent, zone);
  }

  calendarRead(eventId: string, signal?: AbortSignal): Promise<CalendarEvent> {
    return this.calendarEvent(
      "calendar.read",
      { calendarId: "primary", eventId },
      "https://www.googleapis.com/auth/calendar.readonly",
      undefined,
      signal,
    );
  }

  /** `event` is the REST `Event` body, which the tool is expected to take. */
  calendarCreate(
    event: GoogleEvent,
    zone: string,
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    return this.calendarEvent(
      "calendar.create",
      { calendarId: "primary", event, sendUpdates: "all" },
      "https://www.googleapis.com/auth/calendar.events",
      zone,
      signal,
    );
  }

  calendarUpdate(
    eventId: string,
    event: GoogleEvent,
    zone: string | undefined,
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    return this.calendarEvent(
      "calendar.update",
      { calendarId: "primary", eventId, event, sendUpdates: "all" },
      "https://www.googleapis.com/auth/calendar.events",
      zone,
      signal,
    );
  }

  async calendarRespond(
    args: { eventId: string; response: string; comment?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call(
      "calendar.respond",
      { calendarId: "primary", ...args, sendUpdates: "all" },
      "https://www.googleapis.com/auth/calendar.events",
      signal,
    );
  }

  async calendarCancel(eventId: string, signal?: AbortSignal): Promise<void> {
    await this.call(
      "calendar.cancel",
      { calendarId: "primary", eventId, sendUpdates: "all" },
      "https://www.googleapis.com/auth/calendar.events",
      signal,
    );
  }

  /**
   * The Drive MCP server takes the same query language as `files.list` for
   * the terms used here (`fullText contains`, `modifiedTime >`), but names a
   * parent `parentId = '…'` rather than `'…' in parents`.
   */
  async driveSearch(
    args: {
      query: string;
      folderId?: string;
      modifiedAfter?: string;
      limit: number;
      cursor?: string;
    },
    signal?: AbortSignal,
  ): Promise<DriveSearchResult> {
    const query = driveSearchQuery({
      query: args.query,
      modifiedAfter: args.modifiedAfter,
    });
    const scoped = args.folderId
      ? `${query} and parentId = '${args.folderId.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
      : query;
    const data = record(
      await this.call(
        "drive.search",
        {
          query: scoped,
          pageSize: args.limit,
          pageToken: args.cursor,
          excludeContentSnippets: true,
        },
        "https://www.googleapis.com/auth/drive.readonly",
        signal,
      ),
      "drive search",
    );
    return {
      files: list<DriveFile & { title?: string }>(data, ["files", "items"])
        .slice(0, args.limit)
        .map((file) =>
          driveFileSummary({ ...file, name: file.name ?? file.title }),
        ),
      cursor: nextToken(data),
    };
  }

  /**
   * The server's text rendering of the file. Its format is the server's
   * own and may change (Google says so), so `exported_as` is not set.
   */
  async driveRead(
    fileId: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<DriveReadResult> {
    const file = await this.rest.drive.drive.getFile(fileId, signal);
    const data = await this.call(
      "drive.read",
      { fileId },
      "https://www.googleapis.com/auth/drive.readonly",
      signal,
    );
    const text =
      typeof data === "string"
        ? data
        : typeof (data as { content?: unknown })?.content === "string"
          ? (data as { content: string }).content
          : JSON.stringify(data);
    const bytes = new TextEncoder().encode(text).subarray(0, maxBytes);
    return {
      file: driveFileSummary(file),
      content: {
        content_type: "text",
        content: new TextDecoder().decode(bytes).replace(/�$/, ""),
      },
    };
  }
}

/** A tool caller over one MCP server. */
class McpServerConnection implements McpToolCaller {
  constructor(private readonly client: Client) {}

  async call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const defined = Object.fromEntries(
      Object.entries(args).filter(([, v]) => v !== undefined),
    );
    return this.client.callTool({ name: tool, arguments: defined }, { signal });
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

export interface ConnectMcpOptions {
  servers?: Partial<GoogleMcpServers>;
  /** The fetch the MCP client uses; the placeholder bearer is added to every request. */
  fetchImpl?: McpFetch;
  /** Commands to look for; the host's allowlist, so a disabled command opens no server. */
  commands: readonly McpCommand[];
}

/**
 * Open the MCP servers the enabled commands need, list each one's tools, and
 * keep the commands whose expected tool is listed. A server that fails to
 * connect or list serves nothing, and its commands fall back to REST.
 */
export async function connectGoogleMcp(
  transport: GoogleTransport,
  rest: GoogleRestBackend,
  options: ConnectMcpOptions,
): Promise<{ backend: GoogleMcpBackend; close(): Promise<void> }> {
  const servers = { ...GOOGLE_MCP_SERVERS, ...options.servers };
  const baseFetch: McpFetch =
    options.fetchImpl ?? ((url, init) => fetch(url, init));
  const authorized: McpFetch = (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", transport.authorization());
    return baseFetch(url, { ...init, headers });
  };
  const wanted = new Set(
    options.commands.map((command) => EXPECTED_MCP_TOOLS[command].server),
  );
  const callers: Partial<Record<keyof GoogleMcpServers, McpServerConnection>> =
    {};
  const served = new Set<McpCommand>();
  await Promise.all(
    [...wanted].map(async (server) => {
      const client = new Client({
        name: "introspection-recipe-productivity-google",
        version: "1",
      });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(servers[server]), {
            fetch: authorized,
          }),
        );
        const tools = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined);
          for (const tool of page.tools) tools.add(tool.name);
          cursor = page.nextCursor;
        } while (cursor);
        callers[server] = new McpServerConnection(client);
        for (const command of options.commands) {
          const expected = EXPECTED_MCP_TOOLS[command];
          if (expected.server === server && tools.has(expected.tool))
            served.add(command);
        }
      } catch {
        await client.close().catch(() => undefined);
      }
    }),
  );
  return {
    backend: new GoogleMcpBackend(callers, served, rest),
    close: async () => {
      await Promise.all(
        Object.values(callers).map((caller) =>
          caller.close().catch(() => undefined),
        ),
      );
    },
  };
}
