import type { Tracer } from "@opentelemetry/api";
import type {
  CalendarEvent,
  CalendarListResult,
  DriveReadResult,
  DriveSearchResult,
  MailDraft,
  MailMessageSummary,
  MailReadResult,
  MailSearchResult,
  ProductivityToolCaller,
  ProductivityToolCallOutcome,
} from "@introspection-ai/recipes/productivity";

import type { CalendarEvent as GoogleEvent } from "./calendar.js";
import { driveSearchQuery, type DriveFile } from "./drive.js";
import { GoogleProductivityError } from "./errors.js";
import { decodeEventId, PRIMARY_CALENDAR } from "./event-id.js";
import type { GmailDraft, GmailMessage } from "./gmail.js";
import { mapGoogleError } from "./http.js";
import {
  driveFileSummary,
  eventDetail,
  eventSummary,
  type GoogleRestBackend,
} from "./rest.js";
import { tracedToolCall } from "./telemetry.js";

/**
 * Google's Workspace MCP servers, one per product, as a Recipe declares them:
 * the server id under `pi.mcp.servers` and the agent's `mcp.servers`, and the
 * URL its binding names. Gmail's host answers; the Calendar and Drive host
 * names follow Google's `<product>mcp.googleapis.com` pattern and are *to
 * confirm* (docs/productivity/google.md, Backends).
 */
export const GOOGLE_MCP_SERVERS = {
  gmail: { id: "gmail", url: "https://gmailmcp.googleapis.com/mcp/v1" },
  calendar: {
    id: "calendar",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
  },
  drive: { id: "drive", url: "https://drivemcp.googleapis.com/mcp/v1" },
} as const;

export type GoogleMcpServer = keyof typeof GOOGLE_MCP_SERVERS;

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
 * Calendar names are the design's intent. A command whose tool the session
 * cannot call is served by REST, so a wrong name costs a REST call, never a
 * failure. `mail fetch_attachment`, `mail send`, `calendar free_busy`,
 * `drive download` and `drive upload` have no entry: they are REST only.
 */
export const EXPECTED_MCP_TOOLS: Readonly<
  Record<McpCommand, { server: GoogleMcpServer; tool: string }>
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

/**
 * Pi's name for an MCP tool, `mcp__<server>__<tool>` with every character
 * outside `[A-Za-z0-9_]` replaced. Pi shortens a name past 64 characters with
 * a hash; no expected tool comes near that.
 */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
}

/** The Pi tool name that serves `command`. */
export function mcpToolFor(command: McpCommand): string {
  const { server, tool } = EXPECTED_MCP_TOOLS[command];
  return mcpToolName(GOOGLE_MCP_SERVERS[server].id, tool);
}

/**
 * A call Pi's MCP client failed rather than the tool answering: Pi reports
 * the error's message as the result's text, so the HTTP status is read back
 * from Pi's own wording (`MCP server requires authentication` for a 401,
 * `MCP HTTP request failed with status <n>` for the rest).
 */
function mapFailedCall(
  outcome: ProductivityToolCallOutcome,
  label: string,
  scope: string,
): GoogleProductivityError {
  const text = outcome.content
    .flatMap((block) =>
      block.type === "text" && block.text ? [block.text] : [],
    )
    .join("\n");
  const status = /MCP server requires authentication/.test(text)
    ? 401
    : Number(/MCP HTTP request failed with status (\d{3})/.exec(text)?.[1]);
  if (status) {
    // MCP's authorization spec answers an insufficient scope with 403.
    const body =
      status === 403
        ? { error: { errors: [{ reason: "insufficientPermissions" }] } }
        : {};
    return mapGoogleError(status, body, { scope, label });
  }
  return new GoogleProductivityError(
    "provider_error",
    `${label} failed: ${(text || "the call failed").slice(0, 500)}`,
  );
}

/**
 * A tool's result as data: its `structuredContent`, else its first text
 * block parsed as JSON, else that text. An `isError` result maps to
 * `provider_error` with the tool's own message, cut short.
 */
function toolResultData(result: unknown, label: string): unknown {
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
 * The Workspace MCP backend for one tool call: commands go to the Recipe's
 * Google MCP servers through the session's tools (Pi's in-process MCP
 * client), mapped onto the same results the REST backend returns. Results are
 * read as the REST resources they wrap (a Gmail `Message`, a Calendar
 * `Event`, a Drive `File`); that assumption is pinned by the contract tests
 * and is *to confirm* against the live servers.
 */
export class GoogleMcpBackend {
  constructor(
    private readonly tools: ProductivityToolCaller,
    private readonly rest: GoogleRestBackend,
    private readonly tracer: Tracer,
  ) {}

  /** Whether this call can serve `command`: the session can call its tool now. */
  serves(command: McpCommand): boolean {
    return this.tools.canCall(mcpToolFor(command));
  }

  private async call(
    command: McpCommand,
    args: Record<string, unknown>,
    scope: string,
  ): Promise<unknown> {
    const { server, tool } = EXPECTED_MCP_TOOLS[command];
    const label = `${server} MCP ${tool}`;
    const defined = Object.fromEntries(
      Object.entries(args).filter(([, v]) => v !== undefined),
    );
    const outcome = await tracedToolCall(
      this.tracer,
      { server: GOOGLE_MCP_SERVERS[server].id, tool },
      () => this.tools.executeTool(mcpToolFor(command), defined),
    );
    // A tool's own error result keeps its `CallToolResult`; a failed call has none.
    if (outcome.isError && outcome.structuredContent === undefined)
      throw mapFailedCall(outcome, label, scope);
    return toolResultData(
      outcome.structuredContent ?? { content: outcome.content },
      label,
    );
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
      ),
      "mail search",
    );
    const messages = list<GmailMessage>(data, ["messages", "items"]);
    return {
      messages: await Promise.all(
        messages.map((message) => this.mailSummary(message, signal)),
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
      ),
      "mail read",
    );
    const message = (data.message ?? data) as GmailMessage;
    return { messages: [await this.rest.mail.message(message, signal)] };
  }

  async mailDraft(args: {
    to: string[];
    cc: string[];
    subject: string;
    body: string;
    threadId?: string;
  }): Promise<MailDraft> {
    const draft = record(
      await this.call(
        "mail.draft",
        { ...args },
        "https://www.googleapis.com/auth/gmail.compose",
      ),
      "mail draft",
    ) as unknown as GmailDraft;
    return {
      id: draft.id,
      message_id: draft.message?.id,
      thread_id: draft.message?.threadId ?? args.threadId,
    };
  }

  async mailUpdateDraft(args: {
    draftId: string;
    to?: string[];
    cc?: string[];
    subject?: string;
    body?: string;
  }): Promise<MailDraft> {
    const draft = record(
      await this.call(
        "mail.update_draft",
        { ...args },
        "https://www.googleapis.com/auth/gmail.compose",
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
      ),
      command,
    );
    const message = (data.message ?? data) as GmailMessage;
    return this.mailSummary(
      { ...message, id: message.id ?? args.messageId },
      signal,
    );
  }

  async calendarList(args: {
    calendarId: string;
    from: string;
    to: string;
    limit: number;
    cursor?: string;
  }): Promise<CalendarListResult> {
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
      ),
      "calendar list",
    );
    const zone = typeof data.timeZone === "string" ? data.timeZone : undefined;
    return {
      events: list<GoogleEvent>(data, ["items", "events"]).map((event) =>
        eventSummary(event, zone, args.calendarId),
      ),
      cursor: nextToken(data),
    };
  }

  private async calendarEvent(
    command: "calendar.read" | "calendar.create" | "calendar.update",
    args: { calendarId: string } & Record<string, unknown>,
    scope: string,
    zone: string | undefined,
  ): Promise<CalendarEvent> {
    const data = record(await this.call(command, args, scope), command);
    return eventDetail(
      (data.event ?? data) as GoogleEvent,
      zone,
      args.calendarId,
    );
  }

  calendarRead(id: string): Promise<CalendarEvent> {
    return this.calendarEvent(
      "calendar.read",
      { ...decodeEventId(id) },
      "https://www.googleapis.com/auth/calendar.readonly",
      undefined,
    );
  }

  /** `event` is the REST `Event` body, which the tool is expected to take. */
  calendarCreate(event: GoogleEvent, zone: string): Promise<CalendarEvent> {
    return this.calendarEvent(
      "calendar.create",
      { calendarId: PRIMARY_CALENDAR, event, sendUpdates: "all" },
      "https://www.googleapis.com/auth/calendar.events",
      zone,
    );
  }

  calendarUpdate(
    id: string,
    event: GoogleEvent,
    zone: string | undefined,
  ): Promise<CalendarEvent> {
    return this.calendarEvent(
      "calendar.update",
      { ...decodeEventId(id), event, sendUpdates: "all" },
      "https://www.googleapis.com/auth/calendar.events",
      zone,
    );
  }

  async calendarRespond(args: {
    eventId: string;
    response: string;
    comment?: string;
  }): Promise<void> {
    await this.call(
      "calendar.respond",
      { ...args, ...decodeEventId(args.eventId), sendUpdates: "all" },
      "https://www.googleapis.com/auth/calendar.events",
    );
  }

  async calendarCancel(id: string): Promise<void> {
    await this.call(
      "calendar.cancel",
      { ...decodeEventId(id), sendUpdates: "all" },
      "https://www.googleapis.com/auth/calendar.events",
    );
  }

  /**
   * The Drive MCP server takes the same query language as `files.list` for
   * the terms used here (`fullText contains`, `modifiedTime >`), but names a
   * parent `parentId = '…'` rather than `'…' in parents`.
   */
  async driveSearch(args: {
    query: string;
    folderId?: string;
    modifiedAfter?: string;
    limit: number;
    cursor?: string;
  }): Promise<DriveSearchResult> {
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
      ),
      "drive search",
    );
    return {
      files: list<DriveFile & { title?: string }>(data, ["files", "items"]).map(
        (file) => driveFileSummary({ ...file, name: file.name ?? file.title }),
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
