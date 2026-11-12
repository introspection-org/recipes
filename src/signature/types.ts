/**
 * Provider-neutral signature vocabulary: the `signature` tool, its commands,
 * the request shape, and what a provider module implements
 * (`docs/signature/README.md`).
 *
 * The host keeps a draft until `send`, and names every request by a `sig_…`
 * handle it mints; a provider sees only its own refs.
 */

/**
 * The signature contract this host implements. A provider module, and the
 * bundle that exports it, declare the version they were written against, and
 * the host refuses one that differs. Separate from the other families'.
 */
export const SIGNATURE_MODULE_API_VERSION = 2 as const;

/** The one tool the family serves. */
export const SIGNATURE_TOOL_NAME = "signature";

export const SIGNATURE_COMMANDS = [
  "prepare",
  "send",
  "status",
  "void",
] as const;
export type SignatureCommand = (typeof SIGNATURE_COMMANDS)[number];

/** The commands a provider serves; `prepare` is the host's alone. */
export const SIGNATURE_PROVIDER_COMMANDS = ["send", "status", "void"] as const;
export type SignatureProviderCommand =
  (typeof SIGNATURE_PROVIDER_COMMANDS)[number];

/** The first-party providers, served by `@introspection-ai/recipe-signature`. */
export const SIGNATURE_PROVIDER_IDS = ["docusign"] as const;

/** The type of one value in a declaration's `options`. */
export type SignatureOptionType = "string" | "boolean";

/** The options a provider takes, by name. */
export type SignatureOptionsSchema = Readonly<
  Record<string, SignatureOptionType>
>;

/** A declaration's `options`, checked against the provider's schema. */
export type SignatureProviderOptions = Readonly<
  Record<string, string | boolean>
>;

/**
 * The options each first-party provider takes, for `introspection check`,
 * which does not load providers. Each equals its module's
 * `capabilities.options`.
 */
export const SIGNATURE_FIRST_PARTY_OPTIONS: Readonly<
  Record<string, SignatureOptionsSchema>
> = {
  docusign: { account: "string", server: "string" },
};

/** The `kind` of the approval interrupts `send` and `void` raise, which a later call looks for. */
export const SIGNATURE_SEND_APPROVAL_KIND = "signature_send";
export const SIGNATURE_VOID_APPROVAL_KIND = "signature_void";

// ---------------------------------------------------------------------------
// Statuses

export const SIGNATURE_REQUEST_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "completed",
  "declined",
  "voided",
] as const;
export type SignatureRequestStatus =
  (typeof SIGNATURE_REQUEST_STATUSES)[number];

export const SIGNATURE_RECIPIENT_STATUSES = [
  "pending",
  "sent",
  "viewed",
  "signed",
  "declined",
] as const;
export type SignatureRecipientStatus =
  (typeof SIGNATURE_RECIPIENT_STATUSES)[number];

// ---------------------------------------------------------------------------
// The document and its recipients

export interface SignatureRecipient {
  readonly name: string;
  readonly email: string;
  /** 1 signs (or receives) first; equal orders run in parallel. */
  readonly order: number;
}

/** Where one signer's fields go: the provider's markers, each once in the copy sent. */
export interface SignaturePlacement {
  /** The signature marker, on the signer's own `By:` line. */
  readonly sign: string;
  /** The date marker, on the signer's own `Date:` line, when the block has one. */
  readonly date?: string;
}

export interface SignatureSigner extends SignatureRecipient {
  readonly placement: SignaturePlacement;
}

/** The approved document as the provider receives it. */
export interface SignatureDocument {
  /** The file name signers see, such as `acme-msa.docx`. */
  readonly name: string;
  /** `docx`. */
  readonly extension: string;
  /** SHA-256 (hex) of the reviewed file under `outputs/`, not of the copy sent. */
  readonly sha256: string;
  /** The marked copy, for a provider that uploads it. */
  readonly bytes: Uint8Array;
  /** A short-lived signed link to the marked copy, when the host issues one. */
  readonly url?: string;
}

/** A host's way to publish the marked copy at a short-lived signed link. */
export type SignaturePublishDocument = (
  bytes: Uint8Array,
  file: { readonly name: string; readonly contentType: string },
  signal?: AbortSignal,
) => Promise<{ readonly url: string; readonly expires_at: string }>;

// ---------------------------------------------------------------------------
// Requests

export interface SignatureRecipientState {
  readonly name: string;
  readonly email: string;
  readonly role: "signer" | "cc";
  readonly order: number;
  readonly status: SignatureRecipientStatus;
  readonly signed_at?: string;
}

/** A request as a provider reports it, by its own ref. */
export interface ProviderSignatureRequest {
  readonly ref: string;
  readonly status: SignatureRequestStatus;
  readonly recipients?: readonly SignatureRecipientState[];
  readonly sent_at?: string;
  readonly completed_at?: string;
}

/** A request as the tool returns it. */
export interface SignatureRequest {
  /** `sig_…`, valid in this session. */
  readonly handle: string;
  readonly provider: string;
  readonly status: SignatureRequestStatus;
  readonly subject: string;
  readonly document: { readonly name: string; readonly sha256: string };
  readonly recipients: readonly SignatureRecipientState[];
  readonly sent_at?: string;
  readonly completed_at?: string;
}

// ---------------------------------------------------------------------------
// Session calls

export interface SignatureSendArgs {
  readonly document: SignatureDocument;
  readonly subject: string;
  readonly message?: string;
  readonly signers: readonly SignatureSigner[];
  readonly cc: readonly SignatureRecipient[];
}

export interface SignatureRefArgs {
  readonly ref: string;
}

export interface SignatureVoidArgs extends SignatureRefArgs {
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Transports

/** One HTTP request a provider sends through the host. */
export interface SignatureHttpRequest {
  readonly method: "GET" | "POST" | "PUT";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  /** The API's path template, which names the span. */
  readonly template?: string;
  /** A read, retried while the provider is throttled; a write is sent once. */
  readonly read?: boolean;
  /** Whether the JSON answer is recorded on the span. Default: a read's is. */
  readonly record?: boolean;
}

export interface SignatureHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/**
 * The host's HTTP: it attaches the placeholder credential the egress
 * replaces, records each attempt as a client span, and retries a throttled
 * read.
 */
export type SignatureHttp = (
  request: SignatureHttpRequest,
) => Promise<SignatureHttpResponse>;

/** An MCP `CallToolResult`, without `_meta`. */
export interface SignatureMcpCallToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** Calls to the provider's bound MCP server, which the host routes and traces. */
export interface SignatureMcpCaller {
  hasTool(tool: string): boolean;
  callTool(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<SignatureMcpCallToolResult>;
}

/** One entry of an adapter's tool map: which server tool serves what. */
export interface SignatureMcpToolMapping {
  /** The tool's name as the server's tool list names it. */
  readonly tool: string;
  /** The commands it serves, or `setup` for a lookup the provider needs. */
  readonly serves: readonly (SignatureProviderCommand | "setup")[];
  /** Whether the name and arguments were checked against a captured tool list. */
  readonly verified: boolean;
}

/** A provider's hosted MCP server, which the Recipe binds behind the tool. */
export interface SignatureMcpAdapter {
  /** The vendor's hosted server, for docs and bindings; the bound URL may differ. */
  readonly url: string;
  /** The Recipe MCP server id it expects by default; the `server` option overrides it. */
  readonly server: string;
  /** Every tool it may call. */
  readonly tools: readonly SignatureMcpToolMapping[];
}

// ---------------------------------------------------------------------------
// Capabilities

/** How the document reaches the vendor: a signed link the host issues, or an upload. */
export type SignatureDocumentPath = "link" | "upload";

/** What a provider supports, as static data the host reads before any session exists. */
export interface SignatureCapabilities {
  /** The commands it serves, besides the host's `prepare`. */
  readonly commands: readonly SignatureProviderCommand[];
  /** The document extensions it accepts, without the dot. */
  readonly extensions: readonly string[];
  /** The paths it takes the document by; the host uses `link` when it can issue one. */
  readonly document: readonly SignatureDocumentPath[];
  /** How long a `status` answer stands before the provider is asked again. */
  readonly status_interval_seconds: number;
  /** Every host the provider sends to. */
  readonly hosts: readonly string[];
  /** The options a declaration may set for it. Absent: none. */
  readonly options?: SignatureOptionsSchema;
}

// ---------------------------------------------------------------------------
// Errors

export const SIGNATURE_ERROR_CODES = [
  "not_ready",
  "anchor_not_found",
  "ambiguous",
  "changed",
  "approval_required",
  "invalid_request",
  "not_connected",
  "not_found",
  "rate_limited",
  "provider_error",
] as const;
export type SignatureErrorCode = (typeof SIGNATURE_ERROR_CODES)[number];

export interface SignatureErrorInfo {
  readonly code: SignatureErrorCode;
  /** Safe for the model: never a token, a link, a document or a raw request. */
  readonly message: string;
}

/**
 * The shape a provider throws: any `Error` carrying `signature`. Plain data,
 * so a provider needs no host import. Any other thrown error is a
 * `provider_error`.
 */
export interface SignatureProviderError extends Error {
  readonly signature: SignatureErrorInfo;
}

// ---------------------------------------------------------------------------
// Sessions and modules

export interface SignatureCallContext {
  readonly signal?: AbortSignal;
  /** The provider's bound MCP server, for a provider with an `mcp` adapter. */
  readonly mcp?: SignatureMcpCaller;
}

/** One run's connection to a provider. Each method is present exactly when `capabilities.commands` declares it. */
export interface SignatureSession {
  /** Creates the request from the approved document and sends it, in one step. */
  send(
    args: SignatureSendArgs,
    ctx: SignatureCallContext,
  ): Promise<ProviderSignatureRequest>;
  status(
    args: SignatureRefArgs,
    ctx: SignatureCallContext,
  ): Promise<ProviderSignatureRequest>;
  void?(
    args: SignatureVoidArgs,
    ctx: SignatureCallContext,
  ): Promise<ProviderSignatureRequest>;
}

/** The declaration a session is created for: its id and options. */
export interface SignatureProviderConfig {
  readonly provider: string;
  readonly options: SignatureProviderOptions;
}

export interface SignatureSessionOptions {
  readonly config: SignatureProviderConfig;
  readonly env: NodeJS.ProcessEnv;
  /** Every HTTP request the provider sends goes through it. */
  readonly http: SignatureHttp;
}

/**
 * A signature provider: a plain descriptor and the session it creates. It
 * imports only types from `@introspection-ai/recipes`; the host holds
 * credentials, transports and spans.
 */
export interface RecipeSignatureProviderModule {
  readonly kind: "signature";
  readonly apiVersion: typeof SIGNATURE_MODULE_API_VERSION;
  readonly id: string;
  readonly capabilities: SignatureCapabilities;
  /** Present for a provider served through its vendor's MCP server. */
  readonly mcp?: SignatureMcpAdapter;
  createSession(
    options: SignatureSessionOptions,
  ): SignatureSession | Promise<SignatureSession>;
}

/**
 * What `@introspection-ai/recipe-signature` exports as its default: its
 * providers by id.
 */
export interface RecipeSignatureModule {
  readonly kind: "signature";
  readonly apiVersion: typeof SIGNATURE_MODULE_API_VERSION;
  readonly providers: Readonly<Record<string, RecipeSignatureProviderModule>>;
}
