/**
 * DocuSign's eSignature REST API (v2.1) as a `signatures` provider: a draft
 * envelope from the prepared document, its status, and sending it.
 * https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/envelopes/create
 *
 * The provider holds no credential: every request goes through the host's
 * HTTP, which sends a placeholder the egress replaces with a token from the
 * platform's JWT grant.
 */

import type {
  EnvelopeRecipient,
  ProviderEnvelope,
  RecipeSignaturesProviderModule,
  SignaturesCallContext,
  SignaturesCreateArgs,
  SignaturesErrorCode,
  SignaturesErrorInfo,
  SignaturesHttp,
  SignaturesHttpRequest,
  SignaturesSession,
} from "@introspection-ai/recipes/signatures";

/** The hosts each environment reaches: its OAuth server and its accounts' base URIs. */
export const DOCUSIGN_ENVIRONMENTS = {
  demo: {
    auth: "account-d.docusign.com",
    api: ["demo.docusign.net"],
  },
  production: {
    auth: "account.docusign.com",
    api: [
      "www.docusign.net",
      "na2.docusign.net",
      "na3.docusign.net",
      "na4.docusign.net",
      "eu.docusign.net",
      "au.docusign.net",
      "ca.docusign.net",
    ],
  },
} as const;

export type DocusignEnvironment = keyof typeof DOCUSIGN_ENVIRONMENTS;

/** The hidden custom fields `create` records, which `get` reads back for the approval. */
export const DOCUMENT_SHA256_FIELD = "introspection_document_sha256";
export const DOCUMENT_NAME_FIELD = "introspection_document_name";

const API_VERSION = "/restapi/v2.1";
const ENVELOPE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A typed failure the host reports as is. */
export class SignaturesError extends Error {
  readonly signatures: SignaturesErrorInfo;
  constructor(code: SignaturesErrorCode, message: string) {
    super(message);
    this.name = "SignaturesError";
    this.signatures = { code, message };
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parse(body: string): Record<string, unknown> {
  try {
    return record(JSON.parse(body));
  } catch {
    return {};
  }
}

/** DocuSign's error codes that mean the person's credential, not the request. */
const NOT_CONNECTED = new Set([
  "USER_AUTHENTICATION_FAILED",
  "AUTHORIZATION_INVALID_TOKEN",
  "PARTNER_AUTHENTICATION_FAILED",
  "consent_required",
  "invalid_grant",
]);

/** A failed answer as the family's error: DocuSign's `errorCode` and `message`, never the request. */
function failure(
  status: number,
  body: string,
  action: string,
): SignaturesError {
  const parsed = parse(body);
  const code = text(parsed.errorCode) ?? text(parsed.error) ?? "";
  const message =
    text(parsed.message) ?? text(parsed.error_description) ?? `HTTP ${status}`;
  const detail = `${code ? `${code}: ` : ""}${message}`.slice(0, 300);
  if (status === 401 || NOT_CONNECTED.has(code))
    return new SignaturesError(
      "not_connected",
      `DocuSign is not connected for this person (${detail}). Ask them to connect it, then try again.`,
    );
  if (status === 404 || code === "ENVELOPE_DOES_NOT_EXIST")
    return new SignaturesError("not_found", `${action}: ${detail}`);
  if (code.startsWith("ANCHOR_TAB"))
    return new SignaturesError("anchor_not_found", `${action}: ${detail}`);
  if (status === 400)
    return new SignaturesError("invalid_request", `${action}: ${detail}`);
  return new SignaturesError("provider_error", `${action}: ${detail}`);
}

function envelopeId(ref: string): string {
  if (!ENVELOPE_ID.test(ref))
    throw new SignaturesError(
      "not_found",
      `'${ref}' is not a DocuSign envelope id.`,
    );
  return ref.toLowerCase();
}

interface Account {
  id: string;
  /** `{base_uri}/restapi/v2.1/accounts/{id}` */
  base: string;
}

function environmentOf(value: unknown): DocusignEnvironment {
  if (value === undefined || value === "demo") return "demo";
  if (value === "production") return "production";
  throw new SignaturesError(
    "invalid_request",
    `The docusign option environment is demo or production, not '${String(value)}'.`,
  );
}

/** The envelope's recipients, signers then copies, in the family's shape. */
function recipientsOf(value: unknown): EnvelopeRecipient[] {
  const recipients = record(value);
  const of = (list: unknown, role: "signer" | "cc"): EnvelopeRecipient[] =>
    (Array.isArray(list) ? list : []).map((raw) => {
      const entry = record(raw);
      const signed = text(entry.signedDateTime);
      return {
        name: text(entry.name) ?? "",
        email: text(entry.email) ?? "",
        role,
        routing_order: Number(entry.routingOrder ?? 1),
        status: text(entry.status) ?? "created",
        ...(signed ? { signed_at: signed } : {}),
      };
    });
  return [
    ...of(recipients.signers, "signer"),
    ...of(recipients.carbonCopies, "cc"),
  ];
}

function customField(envelope: Record<string, unknown>, name: string) {
  const fields = record(envelope.customFields).textCustomFields;
  for (const raw of Array.isArray(fields) ? fields : []) {
    const field = record(raw);
    if (field.name === name) return text(field.value);
  }
  return undefined;
}

/** A `GET …/envelopes/{id}` answer in the family's shape. */
export function docusignEnvelope(value: unknown): ProviderEnvelope {
  const envelope = record(value);
  const ref = text(envelope.envelopeId);
  if (!ref)
    throw new SignaturesError(
      "provider_error",
      "DocuSign answered without an envelopeId",
    );
  const subject = text(envelope.emailSubject);
  const name = customField(envelope, DOCUMENT_NAME_FIELD);
  const sha256 = customField(envelope, DOCUMENT_SHA256_FIELD);
  const sent = text(envelope.sentDateTime);
  const completed = text(envelope.completedDateTime);
  return {
    ref,
    status: text(envelope.status) ?? "created",
    ...(subject ? { subject } : {}),
    ...(name ? { document: { name, ...(sha256 ? { sha256 } : {}) } } : {}),
    recipients: recipientsOf(envelope.recipients),
    ...(sent ? { sent_at: sent } : {}),
    ...(completed ? { completed_at: completed } : {}),
  };
}

/** One anchored tab: placed where the anchor's text starts, refused by DocuSign when it is absent. */
function anchored(anchorString: string) {
  return {
    anchorString,
    anchorUnits: "pixels",
    anchorXOffset: "0",
    anchorYOffset: "0",
    anchorIgnoreIfNotPresent: "false",
  };
}

/** The `POST …/envelopes` body for a draft: `status: created` emails no one. */
export function docusignEnvelopeDefinition(args: SignaturesCreateArgs) {
  const base64 = Buffer.from(args.document.bytes).toString("base64");
  let id = 0;
  const next = () => String((id += 1));
  return {
    status: "created",
    emailSubject: args.subject,
    ...(args.message ? { emailBlurb: args.message } : {}),
    documents: [
      {
        documentId: "1",
        name: args.document.name,
        fileExtension: args.document.extension,
        documentBase64: base64,
      },
    ],
    recipients: {
      signers: args.signers.map((signer) => ({
        recipientId: next(),
        routingOrder: String(signer.routing_order),
        name: signer.name,
        email: signer.email,
        tabs: {
          signHereTabs: [anchored(signer.placement.sign)],
          ...(signer.placement.date
            ? { dateSignedTabs: [anchored(signer.placement.date)] }
            : {}),
        },
      })),
      carbonCopies: args.cc.map((cc) => ({
        recipientId: next(),
        routingOrder: String(cc.routing_order),
        name: cc.name,
        email: cc.email,
      })),
    },
    customFields: {
      textCustomFields: [
        {
          name: DOCUMENT_SHA256_FIELD,
          value: args.document.sha256,
          show: "false",
          required: "false",
        },
        {
          name: DOCUMENT_NAME_FIELD,
          value: args.document.name,
          show: "false",
          required: "false",
        },
      ],
    },
  };
}

export interface DocusignSessionOptions {
  http: SignaturesHttp;
  environment?: DocusignEnvironment;
  /** The account to send from; default: the user's default account. */
  account?: string;
}

/** A DocuSign session over the host's HTTP. */
export function createDocusignSession(
  options: DocusignSessionOptions,
): SignaturesSession {
  const { http } = options;
  const environment = DOCUSIGN_ENVIRONMENTS[options.environment ?? "demo"];
  let account: Promise<Account> | undefined;

  const call = async (
    request: SignaturesHttpRequest,
    action: string,
  ): Promise<Record<string, unknown>> => {
    const response = await http({
      ...request,
      headers: {
        Accept: "application/json",
        ...(request.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...request.headers,
      },
    });
    const body = await response.text();
    if (!response.ok) throw failure(response.status, body, action);
    return parse(body);
  };

  const resolveAccount = async (signal?: AbortSignal): Promise<Account> => {
    const info = await call(
      {
        method: "GET",
        url: `https://${environment.auth}/oauth/userinfo`,
        template: "/oauth/userinfo",
        read: true,
        // It names the person and every account they hold.
        record: false,
        ...(signal ? { signal } : {}),
      },
      "Reading the DocuSign user",
    );
    const accounts = (Array.isArray(info.accounts) ? info.accounts : []).map(
      record,
    );
    const chosen = options.account
      ? accounts.find((entry) => entry.account_id === options.account)
      : (accounts.find((entry) => entry.is_default === true) ?? accounts[0]);
    if (!chosen)
      throw new SignaturesError(
        "not_connected",
        options.account
          ? `The connected DocuSign user has no access to account ${options.account}.`
          : "The connected DocuSign user has no account.",
      );
    const id = text(chosen.account_id);
    let base: URL | undefined;
    try {
      base = new URL(text(chosen.base_uri) ?? "");
    } catch {
      base = undefined;
    }
    if (
      !id ||
      !base ||
      base.protocol !== "https:" ||
      !(environment.api as readonly string[]).includes(base.hostname)
    )
      throw new SignaturesError(
        "provider_error",
        `DocuSign named a base URI outside ${environment.api.join(", ")}; nothing was sent.`,
      );
    return {
      id,
      base: `${base.origin}${API_VERSION}/accounts/${encodeURIComponent(id)}`,
    };
  };

  const accountFor = (signal?: AbortSignal) => {
    if (!account) {
      account = resolveAccount(signal);
      account.catch(() => {
        account = undefined;
      });
    }
    return account;
  };

  const get = async (
    ref: string,
    ctx: SignaturesCallContext,
  ): Promise<ProviderEnvelope> => {
    const id = envelopeId(ref);
    const { base } = await accountFor(ctx.signal);
    const envelope = await call(
      {
        method: "GET",
        url: `${base}/envelopes/${id}?include=recipients,custom_fields`,
        template: "/accounts/{accountId}/envelopes/{envelopeId}",
        read: true,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
      "Reading the envelope",
    );
    return docusignEnvelope(envelope);
  };

  return {
    async create(args, ctx) {
      const { base } = await accountFor(ctx.signal);
      const created = await call(
        {
          method: "POST",
          url: `${base}/envelopes`,
          template: "/accounts/{accountId}/envelopes",
          body: JSON.stringify(docusignEnvelopeDefinition(args)),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
        "Creating the envelope",
      );
      const ref = text(created.envelopeId);
      if (!ref)
        throw new SignaturesError(
          "provider_error",
          "DocuSign created no envelope id",
        );
      return {
        ref,
        status: text(created.status) ?? "created",
        subject: args.subject,
        document: { name: args.document.name, sha256: args.document.sha256 },
        recipients: [
          ...args.signers.map((signer) => ({
            name: signer.name,
            email: signer.email,
            role: "signer" as const,
            routing_order: signer.routing_order,
            status: "created",
          })),
          ...args.cc.map((cc) => ({
            name: cc.name,
            email: cc.email,
            role: "cc" as const,
            routing_order: cc.routing_order,
            status: "created",
          })),
        ],
      };
    },
    get: (args, ctx) => get(args.ref, ctx),
    async send(args, ctx) {
      const id = envelopeId(args.ref);
      const { base } = await accountFor(ctx.signal);
      await call(
        {
          method: "PUT",
          url: `${base}/envelopes/${id}`,
          template: "/accounts/{accountId}/envelopes/{envelopeId}",
          body: JSON.stringify({ status: "sent" }),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
        "Sending the envelope",
      );
      return get(id, ctx);
    },
  };
}

const ALL_HOSTS = [
  DOCUSIGN_ENVIRONMENTS.demo.auth,
  ...DOCUSIGN_ENVIRONMENTS.demo.api,
  DOCUSIGN_ENVIRONMENTS.production.auth,
  ...DOCUSIGN_ENVIRONMENTS.production.api,
];

export const docusignSignaturesProvider: RecipeSignaturesProviderModule = {
  kind: "signatures",
  apiVersion: 1,
  id: "docusign",
  capabilities: {
    commands: ["create", "send", "get"],
    extensions: ["docx"],
    hosts: ALL_HOSTS,
    options: { environment: "string", account: "string" },
  },
  createSession({ config, http }) {
    const environment = environmentOf(config.options.environment);
    const account = config.options.account;
    return createDocusignSession({
      http,
      environment,
      ...(typeof account === "string" && account ? { account } : {}),
    });
  },
};
