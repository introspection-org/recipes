/**
 * Provider-neutral issues vocabulary: the `issues` tool, its commands, the one
 * shape every issue is returned in, and what a provider module implements
 * (`docs/providers.md`, The `issues` family).
 *
 * A provider receives and returns its own references (`ENG-123`, `PROJ-45`,
 * a display index); the host prefixes each with the provider's id to make the
 * handle the model sees (`linear:ENG-123`) and strips it before calling the
 * provider again.
 */

/**
 * The issues contract this host implements. A provider module, and the bundle
 * that exports it, declare the version they were written against, and the
 * host refuses one that differs; bump it on any breaking change to
 * `RecipeIssuesProviderModule` or the types it uses. Separate from the search
 * and productivity versions.
 */
export const ISSUES_MODULE_API_VERSION = 1 as const;

/** The one tool the family serves. */
export const ISSUES_TOOL_NAME = "issues";

export const ISSUES_COMMANDS = [
  "search",
  "get",
  "create",
  "update",
  "comment",
  "transition",
] as const;
export type IssuesCommand = (typeof ISSUES_COMMANDS)[number];

/** The first-party providers, served by `@introspection-ai/recipe-issues`. */
export const ISSUES_PROVIDER_IDS = ["linear", "jira", "introspection"] as const;

/**
 * The family's fallback: included whenever a Recipe declares `pi.issues`
 * unless it is disabled, and offered only when no other declared provider
 * has a working credential path.
 */
export const ISSUES_FALLBACK_PROVIDER = "introspection";

/**
 * The options a first-party provider takes beside its id: where `create`
 * puts a new issue. A Recipe's own provider (`package` or `module`) may take
 * any of them.
 */
export const ISSUES_PROVIDER_OPTIONS: Readonly<
  Record<string, readonly string[]>
> = {
  linear: ["team", "server"],
  jira: ["project", "issueType", "server"],
  introspection: ["enabled"],
};

/** Every option a declaration may carry beside `provider`, `package` and `module`. */
export const ISSUES_DECLARATION_OPTIONS = [
  "team",
  "project",
  "issueType",
  "server",
  "enabled",
] as const;

export const ISSUE_STATUS_CATEGORIES = [
  "open",
  "in_progress",
  "done",
  "cancelled",
] as const;
export type IssueStatusCategory = (typeof ISSUE_STATUS_CATEGORIES)[number];

export const ISSUE_PRIORITIES = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

/** The fields of the issue shape a provider may or may not serve. */
export const ISSUE_FIELDS = [
  "description",
  "priority",
  "assignee",
  "labels",
  "container",
  "comments",
  "url",
] as const;
export type IssueField = (typeof ISSUE_FIELDS)[number];

// ---------------------------------------------------------------------------
// The shape

export interface IssueStatus {
  /** The provider's own name: a Linear workflow state, a Jira status. */
  readonly name: string;
  readonly category: IssueStatusCategory;
}

export interface IssuePerson {
  readonly name?: string;
  readonly email?: string;
  /** The provider's id for the person. */
  readonly id?: string;
}

/** Where an issue lives: a Linear team, a Jira project and issue type, an Introspection project. */
export interface IssueContainer {
  readonly name: string;
  readonly id?: string;
  /** Jira's issue type. */
  readonly type?: string;
}

export interface IssueComment {
  readonly id?: string;
  readonly author?: IssuePerson;
  /** Markdown. */
  readonly body: string;
  readonly created_at?: string;
}

/** One issue, as a provider returns it: its own `ref`, which the host turns into a handle. */
export interface ProviderIssue {
  /** The provider's reference: `ENG-123`, `PROJ-45`, a display index. */
  readonly ref: string;
  readonly title: string;
  /** Markdown. */
  readonly description?: string;
  readonly status: IssueStatus;
  readonly priority?: IssuePriority;
  readonly assignee?: IssuePerson | null;
  readonly labels?: readonly string[];
  readonly container?: IssueContainer;
  readonly url?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  /** Present on `get`. */
  readonly comments?: readonly IssueComment[];
}

/** One issue as the tool returns it. */
export interface Issue extends ProviderIssue {
  /** `<provider>:<ref>`, which every later command takes. */
  readonly handle: string;
  readonly provider: string;
}

// ---------------------------------------------------------------------------
// Commands

export interface IssuesSearchArgs {
  /** Free text. */
  readonly query?: string;
  /** A status name or category. */
  readonly status?: string;
  /** A person's name or email, or `me`. */
  readonly assignee?: string;
  /** A team, project or container name. */
  readonly container?: string;
  readonly label?: string;
  readonly limit?: number;
}

export interface IssuesSearchResult {
  readonly issues: readonly ProviderIssue[];
}

export interface IssuesGetArgs {
  readonly ref: string;
}

export interface IssuesCreateArgs {
  readonly title: string;
  readonly description?: string;
  readonly priority?: IssuePriority;
  readonly labels?: readonly string[];
  readonly assignee?: string;
  /** A team (Linear) or project (Jira); defaults to the declaration's. */
  readonly container?: string;
  /** Jira's issue type; defaults to the declaration's. */
  readonly issue_type?: string;
}

export interface IssuesUpdateArgs {
  readonly ref: string;
  readonly title?: string;
  readonly description?: string;
  readonly priority?: IssuePriority;
  /** Replaces the labels. */
  readonly labels?: readonly string[];
  /** A person's name or email, `me`, or `none` to unassign. */
  readonly assignee?: string;
}

export interface IssuesCommentArgs {
  readonly ref: string;
  /** Markdown. */
  readonly body: string;
}

export interface IssuesTransitionArgs {
  readonly ref: string;
  /** A status name, or one of the categories. */
  readonly status: string;
}

// ---------------------------------------------------------------------------
// Capabilities

export interface IssuesCommandCapability {
  /** One sentence on how this provider differs, shown with the command. */
  readonly note?: string;
}

/** What a provider supports, as static data the host reads before any session exists. */
export interface IssuesCapabilities {
  /** Per command it serves; an absent command is not offered. */
  readonly commands: Partial<
    Readonly<Record<IssuesCommand, IssuesCommandCapability>>
  >;
  /** The fields of the shape it fills; `update` and `create` take only these. */
  readonly fields: readonly IssueField[];
  /**
   * Every host the provider sends to, REST and MCP, so the egress can attach
   * a credential for each and a provider the platform does not know is
   * explicit about where a call goes.
   */
  readonly hosts: readonly string[];
}

// ---------------------------------------------------------------------------
// Transports

/** An MCP `CallToolResult`, without `_meta`. */
export interface IssuesMcpCallToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** One call to the provider's bound MCP server, which the host routes and traces. */
export interface IssuesMcpCaller {
  hasTool(tool: string): boolean;
  callTool(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<IssuesMcpCallToolResult>;
}

/** One entry of an adapter's tool map: which server tool serves what. */
export interface IssuesMcpToolMapping {
  /** The tool's name as the server's tool list names it. */
  readonly tool: string;
  /** The commands it serves, or `setup` for a lookup the adapter needs. */
  readonly serves: readonly (IssuesCommand | "setup")[];
  /**
   * Whether the name and arguments were checked against a tool list captured
   * from the live server (`introspection bindings mcp capture`). False when
   * they come from the vendor's documentation alone.
   */
  readonly verified: boolean;
}

/**
 * A provider's hosted MCP server. When the Recipe binds it, the provider's
 * session reaches it through the `issues` tool's nested calls.
 */
export interface IssuesMcpAdapter {
  /** The vendor's hosted server, for docs and bindings; the bound URL may differ. */
  readonly url: string;
  /** The Recipe MCP server id it expects by default; a declaration's `server` overrides it. */
  readonly server: string;
  /** Every tool it may call. */
  readonly tools: readonly IssuesMcpToolMapping[];
}

// ---------------------------------------------------------------------------
// Errors

export const ISSUES_ERROR_CODES = [
  "not_connected",
  "not_supported",
  "not_found",
  "invalid_request",
  "provider_error",
] as const;
export type IssuesErrorCode = (typeof ISSUES_ERROR_CODES)[number];

export interface IssuesErrorInfo {
  readonly code: IssuesErrorCode;
  /** Safe for the model: never a token, never a raw provider payload. */
  readonly message: string;
}

/**
 * The shape a provider throws: any `Error` carrying `issues`. Plain data, so a
 * provider needs no host import. Any other thrown error is a `provider_error`.
 */
export interface IssuesProviderError extends Error {
  readonly issues: IssuesErrorInfo;
}

// ---------------------------------------------------------------------------
// Sessions and modules

export interface IssuesCallContext {
  readonly signal?: AbortSignal;
  /** The provider's bound MCP server, for a provider with an `mcp` adapter. */
  readonly mcp?: IssuesMcpCaller;
}

export type IssuesMethod<A, R> = (
  args: A,
  ctx: IssuesCallContext,
) => Promise<R>;

/**
 * One run's connection to a provider. Each method is present exactly when
 * `capabilities.commands` declares it.
 */
export interface IssuesSession {
  search?: IssuesMethod<IssuesSearchArgs, IssuesSearchResult>;
  get?: IssuesMethod<IssuesGetArgs, ProviderIssue>;
  create?: IssuesMethod<IssuesCreateArgs, ProviderIssue>;
  update?: IssuesMethod<IssuesUpdateArgs, ProviderIssue>;
  comment?: IssuesMethod<IssuesCommentArgs, IssueComment>;
  transition?: IssuesMethod<IssuesTransitionArgs, ProviderIssue>;
}

/** The declaration a session is created for: its id and options. */
export interface IssuesProviderConfig {
  readonly provider: string;
  readonly team?: string;
  readonly project?: string;
  readonly issueType?: string;
}

export interface IssuesSessionOptions {
  readonly config: IssuesProviderConfig;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * An issues provider: a plain descriptor and the session it creates. It
 * imports only types from `@introspection-ai/recipes`; the host holds
 * credentials, transports and spans.
 */
export interface RecipeIssuesProviderModule {
  readonly kind: "issues";
  readonly apiVersion: typeof ISSUES_MODULE_API_VERSION;
  readonly id: string;
  readonly capabilities: IssuesCapabilities;
  /** Present for a provider served through its vendor's MCP server. */
  readonly mcp?: IssuesMcpAdapter;
  /**
   * Whether a REST provider has a working credential path in this
   * environment. Absent: it has one. An MCP provider has one when its server
   * is bound, which the host checks.
   */
  available?(env: NodeJS.ProcessEnv): boolean;
  createSession(
    options: IssuesSessionOptions,
  ): IssuesSession | Promise<IssuesSession>;
}

/**
 * What `@introspection-ai/recipe-issues` exports as its default: its providers
 * by id.
 */
export interface RecipeIssuesModule {
  readonly kind: "issues";
  readonly apiVersion: typeof ISSUES_MODULE_API_VERSION;
  readonly providers: Readonly<Record<string, RecipeIssuesProviderModule>>;
}
