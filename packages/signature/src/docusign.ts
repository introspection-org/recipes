/**
 * DocuSign as a `signature` provider, through the Docusign MCP Server
 * (`docs/signature/docusign.md`, tools captured in
 * `test/fixtures/signature/docusign-tools.json`). The server's
 * `createEnvelope` takes a document only by `remoteUrl`, so without the
 * host's signed link the envelope is created by one REST upload with the same
 * person's token; everything else is an MCP call.
 *
 * The provider holds no credential: the MCP server's connection and the
 * host's HTTP carry the person's token.
 */

import type {
  ProviderSignatureRequest,
  RecipeSignatureProviderModule,
  SignatureCallContext,
  SignatureErrorCode,
  SignatureErrorInfo,
  SignatureHttp,
  SignatureMcpCaller,
  SignatureMcpToolMapping,
  SignatureRecipientState,
  SignatureRecipientStatus,
  SignatureRequestStatus,
  SignatureSendArgs,
  SignatureSession,
} from "@introspection-ai/recipes/signature";

/** The MCP tools the provider calls, as the developer server's tool list names them. */
export const DOCUSIGN_MCP_TOOLS: readonly SignatureMcpToolMapping[] = [
  { tool: "getUserInfo", serves: ["setup"], verified: true },
  { tool: "createEnvelope", serves: ["send"], verified: true },
  { tool: "getEnvelope", serves: ["status"], verified: true },
  { tool: "listRecipients", serves: ["status"], verified: true },
  { tool: "updateEnvelope", serves: ["void"], verified: true },
];

/** The MCP servers and the REST hosts an account's `base_uri` may name. */
export const DOCUSIGN_HOSTS = {
  mcp: ["mcp-d.docusign.com", "mcp.docusign.com"],
  api: [
    "demo.docusign.net",
    "www.docusign.net",
    "na2.docusign.net",
    "na3.docusign.net",
    "na4.docusign.net",
    "eu.docusign.net",
    "au.docusign.net",
    "ca.docusign.net",
  ],
} as const;

const ENVELOPE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A typed failure the host reports as is. */
export class SignatureError extends Error {
  readonly signature: SignatureErrorInfo;
  constructor(code: SignatureErrorCode, message: string) {
    super(message);
    this.name = "SignatureError";
    this.signature = { code, message };
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

/** A DocuSign failure as the family's error: its `errorCode` and `message`, never the request. */
function failure(status: number | undefined, body: string, action: string) {
  const parsed = parse(body);
  const code = text(parsed.errorCode) ?? text(parsed.error) ?? "";
  const message =
    text(parsed.message) ??
    text(parsed.error_description) ??
    (body.trim().slice(0, 200) || `HTTP ${status ?? "error"}`);
  const detail = `${code ? `${code}: ` : ""}${message}`.slice(0, 300);
  if (status === 401 || NOT_CONNECTED.has(code))
    return new SignatureError(
      "not_connected",
      `DocuSign is not connected for this person (${detail}). Ask them to connect it, then try again.`,
    );
  if (status === 429 || code === "HOURLY_APIINVOCATION_LIMIT_EXCEEDED")
    return new SignatureError("rate_limited", `${action}: ${detail}`);
  if (status === 404 || code === "ENVELOPE_DOES_NOT_EXIST")
    return new SignatureError("not_found", `${action}: ${detail}`);
  if (code.startsWith("ANCHOR_TAB"))
    return new SignatureError("anchor_not_found", `${action}: ${detail}`);
  if (status === 400)
    return new SignatureError("invalid_request", `${action}: ${detail}`);
  return new SignatureError("provider_error", `${action}: ${detail}`);
}

function envelopeId(ref: string): string {
  if (!ENVELOPE_ID.test(ref))
    throw new SignatureError(
      "not_found",
      `'${ref}' is not a DocuSign envelope id.`,
    );
  return ref.toLowerCase();
}

const ENVELOPE_STATUS: Record<string, SignatureRequestStatus> = {
  created: "draft",
  sent: "sent",
  delivered: "viewed",
  signed: "completed",
  completed: "completed",
  declined: "declined",
  voided: "voided",
  timedout: "voided",
};

const RECIPIENT_STATUS: Record<string, SignatureRecipientStatus> = {
  created: "pending",
  sent: "sent",
  autoresponded: "sent",
  delivered: "viewed",
  signed: "signed",
  completed: "signed",
  declined: "declined",
};

/** An envelope's status as the family's. `deleted` is gone. */
export function docusignStatus(value: unknown): SignatureRequestStatus {
  const status = text(value) ?? "";
  if (status === "deleted")
    throw new SignatureError(
      "not_found",
      "The envelope was deleted in DocuSign.",
    );
  return ENVELOPE_STATUS[status] ?? "sent";
}

/** A `listRecipients` answer: signers, then copies. */
export function docusignRecipients(value: unknown): SignatureRecipientState[] {
  const recipients = record(value);
  const of = (list: unknown, role: "signer" | "cc") =>
    (Array.isArray(list) ? list : []).map((raw): SignatureRecipientState => {
      const entry = record(raw);
      const signed = text(entry.signedDateTime);
      return {
        name: text(entry.name) ?? "",
        email: text(entry.email) ?? "",
        role,
        order: Number(entry.routingOrder ?? 1),
        status: RECIPIENT_STATUS[text(entry.status) ?? ""] ?? "pending",
        ...(signed ? { signed_at: signed } : {}),
      };
    });
  return [
    ...of(recipients.signers, "signer"),
    ...of(recipients.carbonCopies, "cc"),
  ];
}

/** One anchored tab on recipient `id`: DocuSign refuses the envelope when the anchor is absent. */
function anchored(anchorString: string, recipientId: string) {
  return {
    anchorString,
    anchorUnits: "pixels",
    anchorXOffset: "0",
    anchorYOffset: "0",
    anchorIgnoreIfNotPresent: "false",
    anchorMatchWholeWord: "true",
    documentId: "1",
    recipientId,
  };
}

/** The envelope definition `send` creates, sent at once; the document goes by link or upload. */
export function docusignEnvelopeDefinition(args: SignatureSendArgs) {
  let id = 0;
  const next = () => String((id += 1));
  const document = args.document.url
    ? { remoteUrl: args.document.url }
    : { documentBase64: Buffer.from(args.document.bytes).toString("base64") };
  return {
    status: "sent",
    emailSubject: args.subject,
    ...(args.message ? { emailBlurb: args.message } : {}),
    documents: [
      {
        documentId: "1",
        name: args.document.name,
        fileExtension: args.document.extension,
        ...document,
      },
    ],
    recipients: {
      signers: args.signers.map((signer) => {
        const recipientId = next();
        return {
          recipientId,
          routingOrder: String(signer.order),
          name: signer.name,
          email: signer.email,
          tabs: {
            signHereTabs: [anchored(signer.placement.sign, recipientId)],
            ...(signer.placement.date
              ? {
                  dateSignedTabs: [
                    anchored(signer.placement.date, recipientId),
                  ],
                }
              : {}),
          },
        };
      }),
      carbonCopies: args.cc.map((cc) => ({
        recipientId: next(),
        routingOrder: String(cc.order),
        name: cc.name,
        email: cc.email,
      })),
    },
  };
}

/** The JSON a DocuSign MCP tool answered, or its failure. */
async function mcpCall(
  mcp: SignatureMcpCaller | undefined,
  tool: string,
  args: Record<string, unknown>,
  ctx: SignatureCallContext,
  action: string,
): Promise<Record<string, unknown>> {
  if (!mcp || !mcp.hasTool(tool))
    throw new SignatureError(
      "not_connected",
      `The DocuSign MCP server is not connected (no ${tool}). Bind it behind the signature tool and ask the person to connect it.`,
    );
  const result = await mcp.callTool(tool, args, ctx.signal);
  const body = (result.content ?? [])
    .map((block) => block.text ?? "")
    .join("\n");
  if (result.isError) throw failure(undefined, body, action);
  const structured = record(result.structuredContent);
  return Object.keys(structured).length ? structured : parse(body);
}

interface Account {
  id: string;
  /** `{base_uri}/restapi/v2.1/accounts/{id}`, for the upload. */
  base: string;
}

export interface DocusignSessionOptions {
  /** The host's HTTP, for the upload. */
  http: SignatureHttp;
  /** The account to send from; default: the user's default account. */
  account?: string;
}

/** A DocuSign session: MCP for every call but the upload. */
export function createDocusignSession(
  options: DocusignSessionOptions,
): SignatureSession {
  const { http } = options;
  let account: Promise<Account> | undefined;

  const resolveAccount = async (
    ctx: SignatureCallContext,
  ): Promise<Account> => {
    const info = await mcpCall(
      ctx.mcp,
      "getUserInfo",
      {},
      ctx,
      "Reading the DocuSign user",
    );
    const accounts = (Array.isArray(info.accounts) ? info.accounts : []).map(
      record,
    );
    const chosen = options.account
      ? accounts.find((entry) => entry.account_id === options.account)
      : (accounts.find((entry) => entry.is_default === true) ?? accounts[0]);
    if (!chosen)
      throw new SignatureError(
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
      !(DOCUSIGN_HOSTS.api as readonly string[]).includes(base.hostname)
    )
      throw new SignatureError(
        "provider_error",
        "DocuSign named an account host outside its known API hosts; nothing was sent.",
      );
    return {
      id,
      base: `${base.origin}/restapi/v2.1/accounts/${encodeURIComponent(id)}`,
    };
  };

  const accountFor = (ctx: SignatureCallContext) => {
    if (!account) {
      account = resolveAccount(ctx);
      account.catch(() => {
        account = undefined;
      });
    }
    return account;
  };

  const status = async (
    ref: string,
    ctx: SignatureCallContext,
  ): Promise<ProviderSignatureRequest> => {
    const envelopeIdValue = envelopeId(ref);
    const { id } = await accountFor(ctx);
    const envelope = await mcpCall(
      ctx.mcp,
      "getEnvelope",
      { accountId: id, envelopeId: envelopeIdValue },
      ctx,
      "Reading the envelope",
    );
    const recipients = await mcpCall(
      ctx.mcp,
      "listRecipients",
      { accountId: id, envelopeId: envelopeIdValue },
      ctx,
      "Reading the recipients",
    );
    const sent = text(envelope.sentDateTime);
    const completed = text(envelope.completedDateTime);
    return {
      ref: envelopeIdValue,
      status: docusignStatus(envelope.status),
      recipients: docusignRecipients(recipients),
      ...(sent ? { sent_at: sent } : {}),
      ...(completed ? { completed_at: completed } : {}),
    };
  };

  return {
    async send(args, ctx) {
      const { id, base } = await accountFor(ctx);
      const definition = docusignEnvelopeDefinition(args);
      let created: Record<string, unknown>;
      if (args.document.url)
        created = await mcpCall(
          ctx.mcp,
          "createEnvelope",
          { accountId: id, envelopeDefinition: definition },
          ctx,
          "Creating the envelope",
        );
      else {
        const response = await http({
          method: "POST",
          url: `${base}/envelopes`,
          template: "/accounts/{accountId}/envelopes",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(definition),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const body = await response.text();
        if (!response.ok)
          throw failure(response.status, body, "Creating the envelope");
        created = parse(body);
      }
      const ref = text(created.envelopeId);
      if (!ref)
        throw new SignatureError(
          "provider_error",
          "DocuSign created no envelope id",
        );
      return status(ref, ctx);
    },
    status: (args, ctx) => status(args.ref, ctx),
    async void(args, ctx) {
      const envelopeIdValue = envelopeId(args.ref);
      const { id } = await accountFor(ctx);
      await mcpCall(
        ctx.mcp,
        "updateEnvelope",
        {
          accountId: id,
          envelopeId: envelopeIdValue,
          envelopeUpdate: {
            status: "voided",
            voidedReason: args.reason.slice(0, 200),
          },
        },
        ctx,
        "Voiding the envelope",
      );
      return status(envelopeIdValue, ctx);
    },
  };
}

export const docusignSignatureProvider: RecipeSignatureProviderModule = {
  kind: "signature",
  apiVersion: 2,
  id: "docusign",
  capabilities: {
    commands: ["send", "status", "void"],
    extensions: ["docx"],
    document: ["link", "upload"],
    status_interval_seconds: 900,
    hosts: [...DOCUSIGN_HOSTS.mcp, ...DOCUSIGN_HOSTS.api],
    options: { account: "string", server: "string" },
  },
  mcp: {
    url: "https://mcp.docusign.com/mcp",
    server: "docusign",
    tools: DOCUSIGN_MCP_TOOLS,
  },
  createSession({ config, http }) {
    const account = config.options.account;
    return createDocusignSession({
      http,
      ...(typeof account === "string" && account ? { account } : {}),
    });
  },
};
