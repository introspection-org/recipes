/**
 * Provider-neutral signatures vocabulary: the `signatures` tool, its commands,
 * the envelope shape, and what a provider module implements
 * (`docs/signatures/README.md`).
 *
 * A provider receives and returns its own envelope id; the host prefixes it
 * with the provider's id to make the handle the model sees
 * (`docusign:<envelopeId>`) and strips it before calling the provider again.
 */

/**
 * The signatures contract this host implements. A provider module, and the
 * bundle that exports it, declare the version they were written against, and
 * the host refuses one that differs. Separate from the other families'.
 */
export const SIGNATURES_MODULE_API_VERSION = 1 as const;

/** The one tool the family serves. */
export const SIGNATURES_TOOL_NAME = "signatures";

export const SIGNATURES_COMMANDS = ["create", "send", "get"] as const;
export type SignaturesCommand = (typeof SIGNATURES_COMMANDS)[number];

/** The first-party providers, served by `@introspection-ai/recipe-signatures`. */
export const SIGNATURES_PROVIDER_IDS = ["docusign"] as const;

/** The type of one value in a declaration's `options`. */
export type SignaturesOptionType = "string" | "boolean";

/** The options a provider takes, by name. */
export type SignaturesOptionsSchema = Readonly<
  Record<string, SignaturesOptionType>
>;

/** A declaration's `options`, checked against the provider's schema. */
export type SignaturesProviderOptions = Readonly<
  Record<string, string | boolean>
>;

/**
 * The options each first-party provider takes, for `introspection check`,
 * which does not load providers. Each equals its module's
 * `capabilities.options`.
 */
export const SIGNATURES_FIRST_PARTY_OPTIONS: Readonly<
  Record<string, SignaturesOptionsSchema>
> = {
  docusign: { environment: "string", account: "string" },
};

/** The `kind` of the approval interrupt `send` raises, which a later `send` looks for. */
export const SIGNATURES_SEND_APPROVAL_KIND = "signatures_send";

// ---------------------------------------------------------------------------
// The document and its signers

export interface SignaturesRecipient {
  readonly name: string;
  readonly email: string;
  /** 1 signs (or receives) first; equal orders run in parallel. */
  readonly routing_order: number;
}

/** Where one signer's tabs go: anchor strings that occur once in the document sent. */
export interface SignaturesPlacement {
  /** The signHere anchor, on the signer's own `By:` line. */
  readonly sign: string;
  /** The dateSigned anchor, on the signer's own `Date:` line, when the block has one. */
  readonly date?: string;
}

export interface SignaturesSigner extends SignaturesRecipient {
  readonly placement: SignaturesPlacement;
}

/** The final document, as the host checked and prepared it. */
export interface SignaturesDocument {
  /** The file name signers see, such as `acme-msa.docx`. */
  readonly name: string;
  /** `docx`. */
  readonly extension: string;
  /** The bytes sent: the reviewed file with each signer's anchors added. */
  readonly bytes: Uint8Array;
  /** SHA-256 (hex) of the reviewed file under `outputs/`, not of the bytes sent. */
  readonly sha256: string;
}

// ---------------------------------------------------------------------------
// The envelope

export const ENVELOPE_STATUSES = [
  "created",
  "sent",
  "delivered",
  "completed",
  "declined",
  "voided",
] as const;

export interface EnvelopeRecipient {
  readonly name: string;
  readonly email: string;
  readonly role: "signer" | "cc";
  readonly routing_order: number;
  /** The provider's own status: `created`, `sent`, `delivered`, `completed`, `declined`, … */
  readonly status: string;
  readonly signed_at?: string;
}

/** One envelope, as a provider returns it: its own `ref`, which the host turns into a handle. */
export interface ProviderEnvelope {
  readonly ref: string;
  /** The provider's own status; one of {@link ENVELOPE_STATUSES} for DocuSign. */
  readonly status: string;
  readonly subject?: string;
  readonly document?: { readonly name: string; readonly sha256?: string };
  readonly recipients?: readonly EnvelopeRecipient[];
  readonly sent_at?: string;
  readonly completed_at?: string;
}

/** One envelope as the tool returns it. */
export interface Envelope extends ProviderEnvelope {
  /** `<provider>:<ref>`, which `send` and `get` take. */
  readonly handle: string;
  readonly provider: string;
}

// ---------------------------------------------------------------------------
// Commands

export interface SignaturesCreateArgs {
  readonly document: SignaturesDocument;
  readonly subject: string;
  readonly message?: string;
  readonly signers: readonly SignaturesSigner[];
  readonly cc: readonly SignaturesRecipient[];
}

export interface SignaturesRefArgs {
  readonly ref: string;
}

// ---------------------------------------------------------------------------
// Capabilities

/** What a provider supports, as static data the host reads before any session exists. */
export interface SignaturesCapabilities {
  /** The commands it serves; all three for a first-party provider. */
  readonly commands: readonly SignaturesCommand[];
  /** The document extensions it accepts, without the dot. */
  readonly extensions: readonly string[];
  /** Every host the provider sends to. */
  readonly hosts: readonly string[];
  /** The options a declaration may set for it. Absent: none. */
  readonly options?: SignaturesOptionsSchema;
}

// ---------------------------------------------------------------------------
// Errors

export const SIGNATURES_ERROR_CODES = [
  "not_ready",
  "anchor_not_found",
  "ambiguous",
  "approval_required",
  "invalid_request",
  "not_connected",
  "not_found",
  "provider_error",
] as const;
export type SignaturesErrorCode = (typeof SIGNATURES_ERROR_CODES)[number];

export interface SignaturesErrorInfo {
  readonly code: SignaturesErrorCode;
  /** Safe for the model: never a token, never a document, never a raw request. */
  readonly message: string;
}

/**
 * The shape a provider throws: any `Error` carrying `signatures`. Plain data,
 * so a provider needs no host import. Any other thrown error is a
 * `provider_error`.
 */
export interface SignaturesProviderError extends Error {
  readonly signatures: SignaturesErrorInfo;
}

// ---------------------------------------------------------------------------
// Transport

/** One HTTP request a provider sends through the host. */
export interface SignaturesHttpRequest {
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

export interface SignaturesHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/**
 * The host's HTTP: it attaches the placeholder credential the egress
 * replaces, records each attempt as a client span, and retries a throttled
 * read.
 */
export type SignaturesHttp = (
  request: SignaturesHttpRequest,
) => Promise<SignaturesHttpResponse>;

// ---------------------------------------------------------------------------
// Sessions and modules

export interface SignaturesCallContext {
  readonly signal?: AbortSignal;
}

/** One run's connection to a provider. */
export interface SignaturesSession {
  /** A draft envelope: stored by the provider, sent to no one. */
  create(
    args: SignaturesCreateArgs,
    ctx: SignaturesCallContext,
  ): Promise<ProviderEnvelope>;
  /** The envelope with its recipients and the document's SHA-256 as recorded at create. */
  get(
    args: SignaturesRefArgs,
    ctx: SignaturesCallContext,
  ): Promise<ProviderEnvelope>;
  /** Sends a draft. The host calls it only after a person approved that envelope. */
  send(
    args: SignaturesRefArgs,
    ctx: SignaturesCallContext,
  ): Promise<ProviderEnvelope>;
}

/** The declaration a session is created for: its id and options. */
export interface SignaturesProviderConfig {
  readonly provider: string;
  readonly options: SignaturesProviderOptions;
}

export interface SignaturesSessionOptions {
  readonly config: SignaturesProviderConfig;
  readonly env: NodeJS.ProcessEnv;
  /** Every request the provider sends goes through it. */
  readonly http: SignaturesHttp;
}

/**
 * A signatures provider: a plain descriptor and the session it creates. It
 * imports only types from `@introspection-ai/recipes`; the host holds
 * credentials, transports and spans.
 */
export interface RecipeSignaturesProviderModule {
  readonly kind: "signatures";
  readonly apiVersion: typeof SIGNATURES_MODULE_API_VERSION;
  readonly id: string;
  readonly capabilities: SignaturesCapabilities;
  createSession(
    options: SignaturesSessionOptions,
  ): SignaturesSession | Promise<SignaturesSession>;
}

/**
 * What `@introspection-ai/recipe-signatures` exports as its default: its
 * providers by id.
 */
export interface RecipeSignaturesModule {
  readonly kind: "signatures";
  readonly apiVersion: typeof SIGNATURES_MODULE_API_VERSION;
  readonly providers: Readonly<Record<string, RecipeSignaturesProviderModule>>;
}
