/**
 * Provider-neutral productivity vocabulary: the `mail`, `calendar` and `drive`
 * tools, their commands, and what a provider package implements.
 *
 * A provider package (Microsoft Graph, Google Workspace, ...) supplies the
 * transport and a capability descriptor; the tool schemas, the handles and the
 * command allowlists live in the host, so two providers cannot drift into
 * differently shaped versions of the same command.
 *
 * Everything a provider receives and returns is addressed by the provider's
 * own ids. The host mints the opaque handles the model sees (`msg_`, `thr_`,
 * `att_`, `evt_`, `file_`) and resolves them before calling the provider, so a
 * provider never sees or mints a handle.
 */

/** The tools a productivity provider can serve. */
export const PRODUCTIVITY_TOOLS = ["mail", "calendar", "drive"] as const;

export type ProductivityTool = (typeof PRODUCTIVITY_TOOLS)[number];

export const MAIL_COMMANDS = [
  "search",
  "read",
  "fetch_attachment",
  "draft",
  "update_draft",
  "send",
  "move",
  "label",
] as const;

export const CALENDAR_COMMANDS = [
  "list",
  "read",
  "free_busy",
  "create",
  "update",
  "respond",
  "cancel",
] as const;

export const DRIVE_COMMANDS = ["search", "read", "download", "upload"] as const;

export type MailCommand = (typeof MAIL_COMMANDS)[number];
export type CalendarCommand = (typeof CALENDAR_COMMANDS)[number];
export type DriveCommand = (typeof DRIVE_COMMANDS)[number];

/** Each tool's commands, in the order the tool describes them. */
export const PRODUCTIVITY_COMMANDS = {
  mail: MAIL_COMMANDS,
  calendar: CALENDAR_COMMANDS,
  drive: DRIVE_COMMANDS,
} as const;

/** The commands of one tool. */
export type ProductivityCommand<T extends ProductivityTool = ProductivityTool> =
  (typeof PRODUCTIVITY_COMMANDS)[T][number];

/**
 * What running a command does beyond reading:
 *
 * - `read`: nothing changes.
 * - `reversible`: changes the person's own data in a way they can undo
 *   (a draft, a move, a label, a new file).
 * - `irreversible`: cannot be undone (a sent message, a cancelled meeting).
 * - `sends`: reaches other people (invitations, updates, responses).
 */
export type ProductivityEffect =
  "read" | "reversible" | "irreversible" | "sends";

/**
 * The fixed effect of every command. A policy gates on it, and a provider's
 * descriptor must state the same value, so the effect never depends on which
 * provider runs.
 */
export const PRODUCTIVITY_COMMAND_EFFECTS: {
  readonly mail: Readonly<Record<MailCommand, ProductivityEffect>>;
  readonly calendar: Readonly<Record<CalendarCommand, ProductivityEffect>>;
  readonly drive: Readonly<Record<DriveCommand, ProductivityEffect>>;
} = {
  mail: {
    search: "read",
    read: "read",
    fetch_attachment: "read",
    draft: "reversible",
    update_draft: "reversible",
    send: "irreversible",
    move: "reversible",
    label: "reversible",
  },
  calendar: {
    list: "read",
    read: "read",
    free_busy: "read",
    create: "sends",
    update: "sends",
    respond: "sends",
    cancel: "irreversible",
  },
  drive: {
    search: "read",
    read: "read",
    download: "read",
    upload: "reversible",
  },
};

/** Which API serves a command: the provider's MCP server or its REST API. */
export type ProductivityBackend = "mcp" | "rest";

/** How a provider serves one command. */
export interface ProductivityCommandCapability {
  /** Must equal `PRODUCTIVITY_COMMAND_EFFECTS` for the command. */
  readonly effect: ProductivityEffect;
  readonly backend: ProductivityBackend;
  /**
   * One sentence on how this provider differs, appended to the command's
   * description, such as "Outlook categories serve as labels."
   */
  readonly note?: string;
}

/** Per command a tool supports, how it is served. An absent command is unsupported. */
export type ProductivityCommandCapabilities<C extends string> = Partial<
  Readonly<Record<C, ProductivityCommandCapability>>
>;

export interface MailCapabilities {
  readonly commands: ProductivityCommandCapabilities<MailCommand>;
  /** What `mail label` adds and removes: Gmail labels or Outlook categories. */
  readonly labels: "labels" | "categories";
  /** What `mail move` moves between: Outlook folders, or Gmail labels. */
  readonly folders: "folders" | "labels";
}

export interface CalendarCapabilities {
  readonly commands: ProductivityCommandCapabilities<CalendarCommand>;
}

export interface DriveCapabilities {
  readonly commands: ProductivityCommandCapabilities<DriveCommand>;
}

/**
 * What a provider supports, as static data the loader reads before any session
 * exists. A tool the provider does not serve is absent.
 */
export interface ProductivityCapabilities {
  readonly mail?: MailCapabilities;
  readonly calendar?: CalendarCapabilities;
  readonly drive?: DriveCapabilities;
}

// ---------------------------------------------------------------------------
// Errors

/**
 * Error codes a provider reports. A provider throws an `Error` carrying
 * `productivity: ProductivityErrorInfo` (see `ProductivityProviderError`); the
 * host turns it into the shared error result. Any other thrown error is a
 * `provider_error`.
 */
export const PRODUCTIVITY_ERROR_CODES = [
  "not_connected",
  "missing_scope",
  "rate_limited",
  "not_found",
  "invalid_request",
  "provider_error",
] as const;

export type ProductivityErrorCode = (typeof PRODUCTIVITY_ERROR_CODES)[number];

export interface ProductivityErrorInfo {
  readonly code: ProductivityErrorCode;
  /** Safe for the model: never a token, never a raw provider payload. */
  readonly message: string;
  /** For `missing_scope`: the scope the connection lacks, when known. */
  readonly scope?: string;
  /** For `rate_limited`: how long to wait. */
  readonly retry_after_seconds?: number;
  /** The provider's HTTP status, when there was one. */
  readonly status?: number;
}

/** The shape a provider throws. Plain data, so a provider needs no host import. */
export interface ProductivityProviderError extends Error {
  readonly productivity: ProductivityErrorInfo;
}

// ---------------------------------------------------------------------------
// Values

/** A person's address. */
export interface ProductivityAddress {
  readonly email: string;
  readonly name?: string;
}

/**
 * Text content as the provider holds it. The host converts `html` to plain
 * text and caps its size before the model sees it.
 */
export interface ProductivityContent {
  readonly content_type: "text" | "html";
  readonly content: string;
}

/** A file's bytes, for the host to write under the session's downloads. */
export interface ProductivityFileContent {
  readonly name: string;
  readonly mime_type?: string;
  readonly bytes: Uint8Array;
}

/**
 * A page of results. `cursor` is the provider's own and resumes after the last
 * item returned; the host wraps it in a handle. A provider may return more
 * items than `limit` rather than cut a page: the host shows `limit` and serves
 * the rest from its cursor handle before calling the provider again.
 */
export interface ProductivityPage {
  readonly cursor?: string;
}

// ---------------------------------------------------------------------------
// mail

export interface MailSearchArgs {
  /** Free text, in the provider's search syntax where it has one. */
  readonly query?: string;
  /** A folder (Outlook) or label (Gmail) name, such as `inbox`. */
  readonly folder?: string;
  readonly from?: string;
  /** RFC 3339. */
  readonly after?: string;
  /** RFC 3339. */
  readonly before?: string;
  readonly unread?: boolean;
  readonly limit: number;
  readonly cursor?: string;
}

export interface MailMessageSummary {
  readonly id: string;
  readonly thread_id?: string;
  readonly from?: ProductivityAddress;
  readonly to?: readonly ProductivityAddress[];
  readonly cc?: readonly ProductivityAddress[];
  readonly subject?: string;
  /** A short preview, plain text. */
  readonly snippet?: string;
  /** RFC 3339. */
  readonly sent_at?: string;
  readonly unread?: boolean;
  readonly has_attachments?: boolean;
  /** Label or category names, never provider label ids. */
  readonly labels?: readonly string[];
  /** The folder name, where the provider has folders. */
  readonly folder?: string;
  readonly is_draft?: boolean;
}

export interface MailSearchResult extends ProductivityPage {
  readonly messages: readonly MailMessageSummary[];
}

export type MailReadArgs =
  { readonly message_id: string } | { readonly thread_id: string };

export interface MailAttachmentInfo {
  readonly id: string;
  readonly name: string;
  readonly mime_type?: string;
  readonly size?: number;
  /** Inline images and the like. */
  readonly inline?: boolean;
}

export interface MailMessage extends MailMessageSummary {
  readonly body?: ProductivityContent;
  readonly attachments?: readonly MailAttachmentInfo[];
}

/** One message, or a thread's messages oldest first. */
export interface MailReadResult {
  readonly messages: readonly MailMessage[];
  /** Why the thread is incomplete, such as one longer than the provider reads. */
  readonly unavailable?: string;
}

export interface MailFetchAttachmentArgs {
  readonly message_id: string;
  readonly attachment_id: string;
}

export interface MailDraftArgs {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  /** Markdown. */
  readonly body: string;
  /** A message to reply to; the draft joins its thread. */
  readonly reply_to_id?: string;
}

export interface MailUpdateDraftArgs {
  readonly draft_id: string;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly subject?: string;
  /** Markdown. */
  readonly body?: string;
}

export interface MailDraft {
  /** The id `update_draft` and `send` take. */
  readonly id: string;
  /** The draft's message id, where it differs from the draft id (Gmail). */
  readonly message_id?: string;
  readonly thread_id?: string;
  readonly to?: readonly ProductivityAddress[];
  readonly cc?: readonly ProductivityAddress[];
  readonly subject?: string;
}

export interface MailSendArgs {
  readonly draft_id: string;
}

export interface MailSendResult {
  /** The sent message, when the provider reports it. */
  readonly message_id?: string;
  readonly thread_id?: string;
}

export interface MailMoveArgs {
  readonly message_id: string;
  readonly folder: string;
}

export interface MailLabelArgs {
  readonly message_id: string;
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
}

export interface MailSession {
  search?: ProductivityMethod<MailSearchArgs, MailSearchResult>;
  read?: ProductivityMethod<MailReadArgs, MailReadResult>;
  fetchAttachment?: ProductivityMethod<
    MailFetchAttachmentArgs,
    ProductivityFileContent
  >;
  draft?: ProductivityMethod<MailDraftArgs, MailDraft>;
  updateDraft?: ProductivityMethod<MailUpdateDraftArgs, MailDraft>;
  send?: ProductivityMethod<MailSendArgs, MailSendResult>;
  /** Returns the message as it is after the move; its id may change. */
  move?: ProductivityMethod<MailMoveArgs, MailMessageSummary>;
  label?: ProductivityMethod<MailLabelArgs, MailMessageSummary>;
}

// ---------------------------------------------------------------------------
// calendar

export interface CalendarListArgs {
  /** RFC 3339. */
  readonly from: string;
  /** RFC 3339. */
  readonly to: string;
  /** A calendar name; absent means the person's primary calendar. */
  readonly calendar?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export type CalendarResponse = "accept" | "tentative" | "decline";

export type CalendarAttendeeResponse =
  "accepted" | "tentative" | "declined" | "none" | "organizer";

export interface CalendarAttendee extends ProductivityAddress {
  readonly type?: "required" | "optional" | "resource";
  readonly response?: CalendarAttendeeResponse;
}

export interface CalendarEventSummary {
  readonly id: string;
  readonly title?: string;
  /** RFC 3339 date-time, or a date (`YYYY-MM-DD`) when `all_day`. */
  readonly start: string;
  readonly end: string;
  /** IANA time zone of `start` and `end`. */
  readonly time_zone: string;
  readonly all_day?: boolean;
  readonly location?: string;
  readonly organizer?: ProductivityAddress;
  readonly is_organizer?: boolean;
  /** The person's own response. */
  readonly response?: CalendarAttendeeResponse;
  readonly cancelled?: boolean;
  readonly online_meeting_url?: string;
  readonly web_link?: string;
}

export interface CalendarEvent extends CalendarEventSummary {
  readonly attendees?: readonly CalendarAttendee[];
  readonly body?: ProductivityContent;
}

export interface CalendarListResult extends ProductivityPage {
  readonly events: readonly CalendarEventSummary[];
}

export interface CalendarReadArgs {
  readonly event_id: string;
}

export interface CalendarFreeBusyArgs {
  /** Email addresses. */
  readonly attendees: readonly string[];
  readonly from: string;
  readonly to: string;
  /** IANA time zone the busy intervals are returned in. */
  readonly time_zone: string;
}

export interface CalendarBusyInterval {
  readonly start: string;
  readonly end: string;
  readonly status?: "busy" | "tentative" | "out_of_office" | "unknown";
}

export interface CalendarFreeBusyResult {
  readonly time_zone: string;
  readonly schedules: readonly {
    readonly attendee: string;
    readonly busy: readonly CalendarBusyInterval[];
    /** Why this attendee's schedule is unavailable, when it is. */
    readonly error?: string;
  }[];
}

export interface CalendarCreateArgs {
  readonly title: string;
  /** RFC 3339 local date-time in `time_zone`, or a date for an all-day event. */
  readonly start: string;
  readonly end: string;
  /** IANA name. */
  readonly time_zone: string;
  readonly all_day?: boolean;
  readonly attendees?: readonly string[];
  readonly optional_attendees?: readonly string[];
  readonly location?: string;
  /** Markdown. */
  readonly body?: string;
  readonly online_meeting?: boolean;
}

export interface CalendarUpdateArgs extends Partial<
  Omit<CalendarCreateArgs, "time_zone">
> {
  readonly event_id: string;
  /** Required with `start` or `end`. */
  readonly time_zone?: string;
}

export interface CalendarRespondArgs {
  readonly event_id: string;
  readonly response: CalendarResponse;
  readonly comment?: string;
}

export interface CalendarCancelArgs {
  readonly event_id: string;
  readonly comment?: string;
}

export interface CalendarSession {
  list?: ProductivityMethod<CalendarListArgs, CalendarListResult>;
  read?: ProductivityMethod<CalendarReadArgs, CalendarEvent>;
  freeBusy?: ProductivityMethod<CalendarFreeBusyArgs, CalendarFreeBusyResult>;
  create?: ProductivityMethod<CalendarCreateArgs, CalendarEvent>;
  update?: ProductivityMethod<CalendarUpdateArgs, CalendarEvent>;
  respond?: ProductivityMethod<CalendarRespondArgs, void>;
  cancel?: ProductivityMethod<CalendarCancelArgs, void>;
}

// ---------------------------------------------------------------------------
// drive

export interface DriveFileSummary {
  /** Opaque to the host; a provider may encode a drive and an item in it. */
  readonly id: string;
  readonly name: string;
  readonly mime_type?: string;
  readonly size?: number;
  /** RFC 3339. */
  readonly modified_at?: string;
  readonly modified_by?: string;
  readonly is_folder?: boolean;
  /** A native document with no bytes of its own (Google Docs, Sheets, Slides). */
  readonly native_type?: string;
  readonly web_url?: string;
  /** The parent folder's id, when known. */
  readonly parent_id?: string;
}

export interface DriveSearchArgs {
  readonly query: string;
  /** A folder id from an earlier result. */
  readonly folder_id?: string;
  /** RFC 3339. */
  readonly modified_after?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface DriveSearchResult extends ProductivityPage {
  readonly files: readonly DriveFileSummary[];
}

export interface DriveReadArgs {
  readonly file_id: string;
  /** The most bytes of text the host will keep; a provider may stop early. */
  readonly max_bytes: number;
}

export interface DriveReadResult {
  readonly file: DriveFileSummary;
  /** Text content, exported from native formats; absent when the file has none. */
  readonly content?: ProductivityContent;
  /** The format the text was exported as, such as `text/csv`. */
  readonly exported_as?: string;
  /** Why there is no text, such as a binary file or an export limit. */
  readonly unavailable?: string;
}

export interface DriveDownloadArgs {
  readonly file_id: string;
}

export interface DriveUploadArgs {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mime_type?: string;
  /** A folder id from an earlier result; absent means the drive's root. */
  readonly folder_id?: string;
}

export interface DriveSession {
  search?: ProductivityMethod<DriveSearchArgs, DriveSearchResult>;
  read?: ProductivityMethod<DriveReadArgs, DriveReadResult>;
  download?: ProductivityMethod<DriveDownloadArgs, ProductivityFileContent>;
  upload?: ProductivityMethod<DriveUploadArgs, DriveFileSummary>;
}

// ---------------------------------------------------------------------------
// Sessions

export interface ProductivityCallContext {
  readonly signal?: AbortSignal;
}

/** A session method: one call for one person, aborted with `ctx.signal`. */
export type ProductivityMethod<A, R> = (
  args: A,
  ctx: ProductivityCallContext,
) => Promise<R>;

/**
 * One person's connection to a provider. Each method is present exactly when
 * the descriptor declares its command; the host checks this at registration.
 */
export interface ProductivitySession {
  readonly provider: string;
  readonly mail?: MailSession;
  readonly calendar?: CalendarSession;
  readonly drive?: DriveSession;
  /** Release connections (an MCP client, say) when the run ends. */
  close?(): Promise<void>;
}

/** The method name on a tool's session that serves each command. */
export const PRODUCTIVITY_SESSION_METHODS = {
  mail: {
    search: "search",
    read: "read",
    fetch_attachment: "fetchAttachment",
    draft: "draft",
    update_draft: "updateDraft",
    send: "send",
    move: "move",
    label: "label",
  },
  calendar: {
    list: "list",
    read: "read",
    free_busy: "freeBusy",
    create: "create",
    update: "update",
    respond: "respond",
    cancel: "cancel",
  },
  drive: {
    search: "search",
    read: "read",
    download: "download",
    upload: "upload",
  },
} as const satisfies {
  readonly mail: Record<MailCommand, keyof MailSession>;
  readonly calendar: Record<CalendarCommand, keyof CalendarSession>;
  readonly drive: Record<DriveCommand, keyof DriveSession>;
};

/** The declaration a provider session is created for: the enabled commands per tool. */
export interface ProductivityConfig {
  readonly provider: string;
  readonly tools: {
    readonly mail?: readonly MailCommand[];
    readonly calendar?: readonly CalendarCommand[];
    readonly drive?: readonly DriveCommand[];
  };
}

/**
 * The `fetch` under the host's `http`: a host that attaches the person's
 * credential with a request hook passes its own; absent, the global `fetch`
 * with the placeholder bearer, which the egress replaces.
 */
export type ProductivityFetch = (
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    redirect?: "error" | "follow" | "manual";
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null | undefined };
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** One request a provider sends through the host's `http`. */
export interface ProductivityHttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly signal?: AbortSignal;
  /** The API's path template, such as `/me/messages/{message-id}`, which names the span. */
  readonly template?: string;
  /** The API's id for the method, such as `gmail.users.messages.get`. */
  readonly operation?: string;
  /** A read, retried while the provider is throttled; anything else is sent once. */
  readonly read?: boolean;
  /** Whether a failed answer also means throttled, beyond 429 and 5xx (such as Google's 403 `rateLimitExceeded`). */
  readonly throttled?: (status: number, body: string) => boolean;
  /** A pre-authenticated URL, which carries its own credential: no `Authorization` is added. */
  readonly anonymous?: boolean;
  /** `manual` returns a redirect; by default one is refused. */
  readonly redirect?: "error" | "manual";
}

/** An answer, ok or not; a failed one's body is readable for the provider to map. */
export type ProductivityHttpResponse = Awaited<
  ReturnType<ProductivityFetch>
> & {
  /** The answer's `Retry-After`, in seconds. */
  readonly retryAfterSeconds?: number;
};

/**
 * The host's HTTP for a provider: it attaches the placeholder credential,
 * records each attempt as a client span, and retries a throttled read.
 */
export type ProductivityHttp = (
  request: ProductivityHttpRequest,
) => Promise<ProductivityHttpResponse>;

export interface ProductivitySessionOptions {
  readonly config: ProductivityConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Every request the provider sends goes through it. */
  readonly http: ProductivityHttp;
}
