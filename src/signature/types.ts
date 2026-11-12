/**
 * Provider-neutral signature vocabulary: the `signature` tool, its commands,
 * the envelope shape, and what a provider module implements
 * (`docs/signature/README.md`).
 *
 * A provider receives and returns its own envelope id; the host prefixes it
 * with the provider's id to make the handle the model sees
 * (`docusign:<envelopeId>`) and strips it before calling the provider again.
 */

/**
 * The signature contract this host implements. A provider module, and the
 * bundle that exports it, declare the version they were written against, and
 * the host refuses one that differs. Separate from the other families'.
 */
export const SIGNATURE_MODULE_API_VERSION = 1 as const;

/** The one tool the family serves. */
export const SIGNATURE_TOOL_NAME = "signature";

export const SIGNATURE_COMMANDS = ["create", "send", "get"] as const;
export type SignatureCommand = (typeof SIGNATURE_COMMANDS)[number];

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
  docusign: { environment: "string", account: "string" },
};

/** The `kind` of the approval interrupt `send` raises, which a later `send` looks for. */
export const SIGNATURE_SEND_APPROVAL_KIND = "signature_send";

// ---------------------------------------------------------------------------
// The document and its signers

export interface SignatureRecipient {
  readonly name: string;
  readonly email: string;
  /** 1 signs (or receives) first; equal orders run in parallel. */
  readonly routing_order: number;
}

/** Where one signer's tabs go: anchor strings that occur once in the document sent. */
export interface SignaturePlacement {
  /** The signHere anchor, on the signer's own `By:` line. */
  readonly sign: string;
  /** The dateSigned anchor, on the signer's own `Date:` line, when the block has one. */
  readonly date?: string;
}

export interface SignatureSigner extends SignatureRecipient {
  readonly placement: SignaturePlacement;
}

/** The final document, as the host checked and prepared it. */
export interface SignatureDocument {
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

export interface SignatureCreateArgs {
  readonly document: SignatureDocument;
  readonly subject: string;
  readonly message?: string;
  readonly signers: readonly SignatureSigner[];
  readonly cc: readonly SignatureRecipient[];
}

export interface SignatureRefArgs {
  readonly ref: string;
}

// ---------------------------------------------------------------------------
// Capabilities

/** What a provider supports, as static data the host reads before any session exists. */
export interface SignatureCapabilities {
  /** The commands it serves; all three for a first-party provider. */
  readonly commands: readonly SignatureCommand[];
  /** The document extensions it accepts, without the dot. */
  readonly extensions: readonly string[];
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
  "approval_required",
  "invalid_request",
  "not_connected",
  "not_found",
  "provider_error",
] as const;
export type SignatureErrorCode = (typeof SIGNATURE_ERROR_CODES)[number];

export interface SignatureErrorInfo {
  readonly code: SignatureErrorCode;
  /** Safe for the model: never a token, never a document, never a raw request. */
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
// Transport

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

// ---------------------------------------------------------------------------
// Sessions and modules

export interface SignatureCallContext {
  readonly signal?: AbortSignal;
}

/** One run's connection to a provider. */
export interface SignatureSession {
  /** A draft envelope: stored by the provider, sent to no one. */
  create(
    args: SignatureCreateArgs,
    ctx: SignatureCallContext,
  ): Promise<ProviderEnvelope>;
  /** The envelope with its recipients and the document's SHA-256 as recorded at create. */
  get(
    args: SignatureRefArgs,
    ctx: SignatureCallContext,
  ): Promise<ProviderEnvelope>;
  /** Sends a draft. The host calls it only after a person approved that envelope. */
  send(
    args: SignatureRefArgs,
    ctx: SignatureCallContext,
  ): Promise<ProviderEnvelope>;
}

/** The declaration a session is created for: its id and options. */
export interface SignatureProviderConfig {
  readonly provider: string;
  readonly options: SignatureProviderOptions;
}

export interface SignatureSessionOptions {
  readonly config: SignatureProviderConfig;
  readonly env: NodeJS.ProcessEnv;
  /** Every request the provider sends goes through it. */
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
