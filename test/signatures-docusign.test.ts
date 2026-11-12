import { describe, expect, it } from "vitest";

import {
  createDocusignSession,
  DOCUMENT_NAME_FIELD,
  DOCUMENT_SHA256_FIELD,
  docusignSignaturesProvider,
} from "../packages/signatures/src/index.js";
import type {
  SignaturesCreateArgs,
  SignaturesHttp,
  SignaturesHttpRequest,
} from "../src/signatures/index.js";

const ACCOUNT = "0f0e0d0c-0b0a-4908-8706-050403020100";
const OTHER_ACCOUNT = "1f0e0d0c-0b0a-4908-8706-050403020100";
const ENVELOPE = "6f1c2a8e-1b2c-4d3e-8f90-1234567890ab";
const BASE = `https://demo.docusign.net/restapi/v2.1/accounts/${ACCOUNT}`;

/** `GET /oauth/userinfo`, as DocuSign answers it. */
const USERINFO = {
  sub: "00000000-0000-4000-8000-000000000001",
  name: "Example User",
  email: "user@example.com",
  accounts: [
    {
      account_id: OTHER_ACCOUNT,
      is_default: false,
      account_name: "Acme Sandbox Two",
      base_uri: "https://demo.docusign.net",
    },
    {
      account_id: ACCOUNT,
      is_default: true,
      account_name: "Acme Sandbox",
      base_uri: "https://demo.docusign.net",
    },
  ],
};

/** `GET /envelopes/{id}?include=recipients,custom_fields`, as DocuSign answers it. */
function envelope(status: string) {
  return {
    envelopeId: ENVELOPE,
    status,
    emailSubject: "Acme MSA for signature",
    createdDateTime: "2026-11-12T03:00:00.0000000Z",
    ...(status === "sent"
      ? { sentDateTime: "2026-11-12T03:05:00.0000000Z" }
      : {}),
    recipients: {
      signers: [
        {
          recipientId: "1",
          name: "Jane Doe",
          email: "jane@example.com",
          routingOrder: "1",
          status,
        },
      ],
      carbonCopies: [
        {
          recipientId: "2",
          name: "Legal",
          email: "legal@example.com",
          routingOrder: "2",
          status: "created",
        },
      ],
    },
    customFields: {
      textCustomFields: [
        {
          fieldId: "1",
          name: DOCUMENT_SHA256_FIELD,
          value: "a".repeat(64),
          show: "false",
        },
        {
          fieldId: "2",
          name: DOCUMENT_NAME_FIELD,
          value: "acme-msa.docx",
          show: "false",
        },
      ],
    },
  };
}

type Route = (
  request: SignaturesHttpRequest,
) => { status: number; body: unknown } | undefined;

function fakeHttp(...routes: Route[]) {
  const requests: SignaturesHttpRequest[] = [];
  const http: SignaturesHttp = async (request) => {
    requests.push(request);
    for (const route of routes) {
      const answer = route(request);
      if (answer)
        return {
          ok: answer.status < 400,
          status: answer.status,
          text: async () => JSON.stringify(answer.body),
        };
    }
    throw new Error(`unexpected ${request.method} ${request.url}`);
  };
  return { http, requests };
}

const userinfo: Route = (request) =>
  request.url === "https://account-d.docusign.com/oauth/userinfo"
    ? { status: 200, body: USERINFO }
    : undefined;

const ARGS: SignaturesCreateArgs = {
  document: {
    name: "acme-msa.docx",
    extension: "docx",
    bytes: new TextEncoder().encode("docx bytes"),
    sha256: "a".repeat(64),
  },
  subject: "Acme MSA for signature",
  message: "Please sign.",
  signers: [
    {
      name: "Jane Doe",
      email: "jane@example.com",
      routing_order: 1,
      placement: { sign: "\\s1\\", date: "\\d1\\" },
    },
    {
      name: "Alex Acme",
      email: "alex@example.com",
      routing_order: 2,
      placement: { sign: "\\s2\\" },
    },
  ],
  cc: [{ name: "Legal", email: "legal@example.com", routing_order: 3 }],
};

describe("DocuSign provider", () => {
  it("creates a draft from the user's default account, with anchored tabs and the document's digest", async () => {
    const { http, requests } = fakeHttp(userinfo, (request) =>
      request.method === "POST" && request.url === `${BASE}/envelopes`
        ? {
            status: 201,
            body: {
              envelopeId: ENVELOPE,
              uri: `/envelopes/${ENVELOPE}`,
              statusDateTime: "2026-11-12T03:00:00.0000000Z",
              status: "created",
            },
          }
        : undefined,
    );
    const session = createDocusignSession({ http });
    const created = await session.create(ARGS, {});
    expect(created).toMatchObject({
      ref: ENVELOPE,
      status: "created",
      document: { name: "acme-msa.docx", sha256: "a".repeat(64) },
    });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET https://account-d.docusign.com/oauth/userinfo",
      `POST ${BASE}/envelopes`,
    ]);
    // The userinfo answer names the person: it is never recorded on a span.
    expect(requests[0]!.record).toBe(false);
    const body = JSON.parse(requests[1]!.body!) as Record<string, unknown>;
    const anchor = (anchorString: string) => ({
      anchorString,
      anchorUnits: "pixels",
      anchorXOffset: "0",
      anchorYOffset: "0",
      anchorIgnoreIfNotPresent: "false",
    });
    expect(body).toEqual({
      status: "created",
      emailSubject: "Acme MSA for signature",
      emailBlurb: "Please sign.",
      documents: [
        {
          documentId: "1",
          name: "acme-msa.docx",
          fileExtension: "docx",
          documentBase64: Buffer.from("docx bytes").toString("base64"),
        },
      ],
      recipients: {
        signers: [
          {
            recipientId: "1",
            routingOrder: "1",
            name: "Jane Doe",
            email: "jane@example.com",
            tabs: {
              signHereTabs: [anchor("\\s1\\")],
              dateSignedTabs: [anchor("\\d1\\")],
            },
          },
          {
            recipientId: "2",
            routingOrder: "2",
            name: "Alex Acme",
            email: "alex@example.com",
            tabs: { signHereTabs: [anchor("\\s2\\")] },
          },
        ],
        carbonCopies: [
          {
            recipientId: "3",
            routingOrder: "3",
            name: "Legal",
            email: "legal@example.com",
          },
        ],
      },
      customFields: {
        textCustomFields: [
          {
            name: DOCUMENT_SHA256_FIELD,
            value: "a".repeat(64),
            show: "false",
            required: "false",
          },
          {
            name: DOCUMENT_NAME_FIELD,
            value: "acme-msa.docx",
            show: "false",
            required: "false",
          },
        ],
      },
    });
  });

  it("reads an envelope back with its recipients and recorded document, and sends a draft", async () => {
    let status = "created";
    const at = (account: string) =>
      `https://demo.docusign.net/restapi/v2.1/accounts/${account}/envelopes/${ENVELOPE}`;
    const { http, requests } = fakeHttp(userinfo, (request) => {
      if (
        [ACCOUNT, OTHER_ACCOUNT].some(
          (account) =>
            request.url === `${at(account)}?include=recipients,custom_fields`,
        )
      )
        return { status: 200, body: envelope(status) };
      if (request.method === "PUT" && request.url === at(ACCOUNT)) {
        expect(JSON.parse(request.body!)).toEqual({ status: "sent" });
        status = "sent";
        return { status: 200, body: { envelopeId: ENVELOPE } };
      }
      return undefined;
    });
    const session = createDocusignSession({ http, account: OTHER_ACCOUNT });
    const draft = await session.get({ ref: ENVELOPE }, {});
    expect(draft).toEqual({
      ref: ENVELOPE,
      status: "created",
      subject: "Acme MSA for signature",
      document: { name: "acme-msa.docx", sha256: "a".repeat(64) },
      recipients: [
        {
          name: "Jane Doe",
          email: "jane@example.com",
          role: "signer",
          routing_order: 1,
          status: "created",
        },
        {
          name: "Legal",
          email: "legal@example.com",
          role: "cc",
          routing_order: 2,
          status: "created",
        },
      ],
    });
    // The account option chose the account; without it, the default one.
    expect(requests[1]!.url).toContain(`/accounts/${OTHER_ACCOUNT}/`);
    const sent = await createDocusignSession({ http }).send(
      { ref: ENVELOPE },
      {},
    );
    expect(sent).toMatchObject({
      status: "sent",
      sent_at: "2026-11-12T03:05:00.0000000Z",
    });
  });

  it("refuses a base URI outside the environment's hosts, and an envelope id that is not one", async () => {
    const { http } = fakeHttp((request) =>
      request.url.endsWith("/oauth/userinfo")
        ? {
            status: 200,
            body: {
              accounts: [
                {
                  account_id: ACCOUNT,
                  is_default: true,
                  base_uri: "https://attacker.example.com",
                },
              ],
            },
          }
        : undefined,
    );
    await expect(
      createDocusignSession({ http }).get({ ref: ENVELOPE }, {}),
    ).rejects.toMatchObject({
      signatures: { code: "provider_error" },
    });
    // A production account's base URI is not a demo one.
    const prod = fakeHttp((request) =>
      request.url === "https://account-d.docusign.com/oauth/userinfo"
        ? {
            status: 200,
            body: {
              accounts: [
                {
                  account_id: ACCOUNT,
                  is_default: true,
                  base_uri: "https://na3.docusign.net",
                },
              ],
            },
          }
        : undefined,
    );
    await expect(
      createDocusignSession({ http: prod.http }).get({ ref: ENVELOPE }, {}),
    ).rejects.toThrow(/outside demo\.docusign\.net/);
    await expect(
      createDocusignSession({ http: fakeHttp(userinfo).http }).get(
        { ref: "../../users" },
        {},
      ),
    ).rejects.toMatchObject({ signatures: { code: "not_found" } });
  });

  it("maps DocuSign's errors to the family's codes", async () => {
    const answering = (status: number, body: unknown) =>
      createDocusignSession({
        http: fakeHttp(userinfo, (request) =>
          request.url.includes("/envelopes") ? { status, body } : undefined,
        ).http,
      });
    for (const [status, body, code] of [
      [
        401,
        { errorCode: "USER_AUTHENTICATION_FAILED", message: "token expired" },
        "not_connected",
      ],
      [
        404,
        { errorCode: "ENVELOPE_DOES_NOT_EXIST", message: "gone" },
        "not_found",
      ],
      [
        400,
        { errorCode: "ANCHOR_TAB_STRING_NOT_FOUND", message: "\\s1\\" },
        "anchor_not_found",
      ],
      [
        400,
        { errorCode: "ENVELOPE_INVALID_STATUS", message: "sent" },
        "invalid_request",
      ],
      [
        503,
        { errorCode: "SERVICE_UNAVAILABLE", message: "later" },
        "provider_error",
      ],
    ] as const)
      await expect(
        answering(status, body).get({ ref: ENVELOPE }, {}),
      ).rejects.toMatchObject({
        signatures: { code },
      });
    const consent = createDocusignSession({
      http: fakeHttp((request) =>
        request.url.endsWith("/oauth/userinfo")
          ? { status: 400, body: { error: "consent_required" } }
          : undefined,
      ).http,
    });
    await expect(consent.get({ ref: ENVELOPE }, {})).rejects.toMatchObject({
      signatures: { code: "not_connected" },
    });
  });

  it("is demo unless the declaration says production", async () => {
    const seen: string[] = [];
    const http: SignaturesHttp = async (request) => {
      seen.push(request.url);
      return { ok: false, status: 401, text: async () => "{}" };
    };
    const config = (options: Record<string, string>) => ({
      config: { provider: "docusign", options },
      env: {},
      http,
    });
    for (const options of [{}, { environment: "production" }] as Array<
      Record<string, string>
    >)
      await (
        await docusignSignaturesProvider.createSession(config(options))
      )
        .get({ ref: ENVELOPE }, {})
        .catch(() => undefined);
    expect(seen).toEqual([
      "https://account-d.docusign.com/oauth/userinfo",
      "https://account.docusign.com/oauth/userinfo",
    ]);
    expect(() =>
      docusignSignaturesProvider.createSession(
        config({ environment: "staging" }),
      ),
    ).toThrow(/demo or production/);
  });
});
