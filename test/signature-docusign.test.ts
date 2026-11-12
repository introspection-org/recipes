import { readFileSync } from "node:fs";

import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

import {
  createDocusignSession,
  DOCUSIGN_MCP_TOOLS,
  docusignSignatureProvider,
} from "../packages/signature/src/index.js";
import type {
  SignatureCallContext,
  SignatureHttp,
  SignatureHttpRequest,
  SignatureMcpCallToolResult,
  SignatureSendArgs,
} from "../src/signature/index.js";

const ACCOUNT = "0f0e0d0c-0b0a-4908-8706-050403020100";
const OTHER_ACCOUNT = "1f0e0d0c-0b0a-4908-8706-050403020100";
const ENVELOPE = "6f1c2a8e-1b2c-4d3e-8f90-1234567890ab";

interface CapturedTool {
  name: string;
  inputSchema: Record<string, unknown>;
}

/** The tools the provider calls, as the developer server listed them. */
const CAPTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/signature/docusign-tools.json", import.meta.url),
    "utf8",
  ),
) as { tools: CapturedTool[]; all_tools: string[] };

/** `getUserInfo`, as the server answers it (the person's details left out). */
const USERINFO = {
  accounts: [
    {
      account_id: OTHER_ACCOUNT,
      is_default: false,
      base_uri: "https://demo.docusign.net",
    },
    {
      account_id: ACCOUNT,
      is_default: true,
      base_uri: "https://demo.docusign.net",
    },
  ],
};

function envelope(status: string) {
  return {
    envelopeId: ENVELOPE,
    status,
    statusDateTime: "2026-11-12T04:37:35.2300000Z",
    ...(status !== "created"
      ? { sentDateTime: "2026-11-12T04:37:35.2300000Z" }
      : {}),
    ...(status === "completed"
      ? { completedDateTime: "2026-11-12T04:45:17.5200000Z" }
      : {}),
  };
}

function recipients(status: string) {
  return {
    signers: [
      {
        recipientId: "1",
        name: "Jane Doe",
        email: "jane@example.com",
        routingOrder: "1",
        status,
        ...(status === "completed"
          ? { signedDateTime: "2026-11-12T04:45:17.5200000Z" }
          : {}),
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
  };
}

/**
 * A fake of the DocuSign MCP server: it validates every call against the
 * captured input schema, refuses a tool it does not list, and answers as the
 * server does, with JSON in a text block.
 */
function fakeServer(state = { status: "sent" }) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validators = new Map(
    CAPTURE.tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
  );
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const json = (value: unknown): SignatureMcpCallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
  });
  const mcp = {
    hasTool: (tool: string) => CAPTURE.all_tools.includes(tool),
    async callTool(tool: string, args: Record<string, unknown>) {
      const validate = validators.get(tool);
      if (!validate) throw new Error(`the fake has no capture of ${tool}`);
      if (!validate(args))
        throw new Error(
          `${tool} arguments break the captured schema: ${ajv.errorsText(validate.errors)}`,
        );
      calls.push({ tool, args });
      switch (tool) {
        case "getUserInfo":
          return json(USERINFO);
        case "createEnvelope":
          return json({ envelopeId: ENVELOPE, status: "sent" });
        case "getEnvelope":
          return json(envelope(state.status));
        case "listRecipients":
          return json(recipients(state.status));
        case "updateEnvelope": {
          const update = args.envelopeUpdate as { status?: string };
          if (state.status === "completed")
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    errorCode: "ENVELOPE_CANNOT_VOID_INVALID_STATE",
                    message:
                      "Only envelopes in the 'Sent' or 'Delivered' states may be voided.",
                  }),
                },
              ],
            };
          state.status = update.status ?? state.status;
          return json({ envelopeId: ENVELOPE });
        }
      }
      throw new Error(`unexpected ${tool}`);
    },
  };
  return { mcp, calls, state };
}

/** The host's HTTP, recording each request, for the upload. */
function fakeHttp(
  status = 201,
  body: unknown = { envelopeId: ENVELOPE, status: "sent" },
) {
  const requests: SignatureHttpRequest[] = [];
  const http: SignatureHttp = async (request) => {
    requests.push(request);
    return {
      ok: status < 400,
      status,
      text: async () => JSON.stringify(body),
    };
  };
  return { http, requests };
}

const ARGS: SignatureSendArgs = {
  document: {
    name: "acme-sow.docx",
    extension: "docx",
    sha256: "a".repeat(64),
    bytes: new TextEncoder().encode("the marked copy"),
  },
  subject: "Acme SOW for signature",
  message: "Please sign.",
  signers: [
    {
      name: "Jane Doe",
      email: "jane@example.com",
      order: 1,
      placement: { sign: "\\s1\\", date: "\\d1\\" },
    },
  ],
  cc: [{ name: "Legal", email: "legal@example.com", order: 2 }],
};

describe("docusign provider", () => {
  it("maps every command to a captured tool", () => {
    for (const mapping of DOCUSIGN_MCP_TOOLS) {
      expect(CAPTURE.all_tools).toContain(mapping.tool);
      expect(mapping.verified).toBe(true);
    }
    expect(docusignSignatureProvider.mcp?.tools).toBe(DOCUSIGN_MCP_TOOLS);
  });

  it("uploads over REST without a link, with anchored tabs and the default account", async () => {
    const server = fakeServer();
    const host = fakeHttp();
    const session = createDocusignSession({ http: host.http });
    const ctx: SignatureCallContext = { mcp: server.mcp };
    const sent = await session.send(ARGS, ctx);
    expect(sent).toMatchObject({ ref: ENVELOPE, status: "sent" });
    const [request] = host.requests;
    expect(request).toMatchObject({
      method: "POST",
      url: `https://demo.docusign.net/restapi/v2.1/accounts/${ACCOUNT}/envelopes`,
    });
    const body = JSON.parse(request!.body!);
    expect(body.status).toBe("sent");
    expect(body.documents[0]).toEqual({
      documentId: "1",
      name: "acme-sow.docx",
      fileExtension: "docx",
      documentBase64: Buffer.from("the marked copy").toString("base64"),
    });
    expect(body.recipients.signers[0].tabs.signHereTabs[0]).toMatchObject({
      anchorString: "\\s1\\",
      anchorIgnoreIfNotPresent: "false",
      documentId: "1",
      recipientId: "1",
    });
    expect(body.recipients.carbonCopies[0]).toMatchObject({
      recipientId: "2",
      routingOrder: "2",
    });
    expect(server.calls.map((call) => call.tool)).toEqual([
      "getUserInfo",
      "getEnvelope",
      "listRecipients",
    ]);
  });

  it("creates through the MCP server from a signed link, never uploading", async () => {
    const server = fakeServer();
    const host = fakeHttp();
    const session = createDocusignSession({ http: host.http });
    await session.send(
      {
        ...ARGS,
        document: {
          ...ARGS.document,
          url: "https://files.acme.test/signed/abc",
        },
      },
      { mcp: server.mcp },
    );
    expect(host.requests).toEqual([]);
    const create = server.calls.find((call) => call.tool === "createEnvelope");
    const definition = create!.args.envelopeDefinition as {
      documents: Array<Record<string, unknown>>;
    };
    expect(create!.args.accountId).toBe(ACCOUNT);
    expect(definition.documents[0]).toEqual({
      documentId: "1",
      name: "acme-sow.docx",
      fileExtension: "docx",
      remoteUrl: "https://files.acme.test/signed/abc",
    });
  });

  it("reads status in the family's terms", async () => {
    const server = fakeServer({ status: "completed" });
    const session = createDocusignSession({ http: fakeHttp().http });
    expect(
      await session.status({ ref: ENVELOPE }, { mcp: server.mcp }),
    ).toEqual({
      ref: ENVELOPE,
      status: "completed",
      sent_at: "2026-11-12T04:37:35.2300000Z",
      completed_at: "2026-11-12T04:45:17.5200000Z",
      recipients: [
        {
          name: "Jane Doe",
          email: "jane@example.com",
          role: "signer",
          order: 1,
          status: "signed",
          signed_at: "2026-11-12T04:45:17.5200000Z",
        },
        {
          name: "Legal",
          email: "legal@example.com",
          role: "cc",
          order: 2,
          status: "pending",
        },
      ],
    });
  });

  it("voids through updateEnvelope, and reports DocuSign's refusal", async () => {
    const server = fakeServer();
    const session = createDocusignSession({ http: fakeHttp().http });
    const voided = await session.void!(
      { ref: ENVELOPE, reason: "Wrong version" },
      { mcp: server.mcp },
    );
    expect(voided.status).toBe("voided");
    const update = server.calls.find((call) => call.tool === "updateEnvelope");
    expect(update!.args.envelopeUpdate).toEqual({
      status: "voided",
      voidedReason: "Wrong version",
    });
    const done = fakeServer({ status: "completed" });
    await expect(
      session.void!({ ref: ENVELOPE, reason: "Too late" }, { mcp: done.mcp }),
    ).rejects.toMatchObject({ signature: { code: "provider_error" } });
  });

  it("chooses the declared account, and refuses a host outside DocuSign's", async () => {
    const server = fakeServer();
    const host = fakeHttp();
    await createDocusignSession({
      http: host.http,
      account: OTHER_ACCOUNT,
    }).send(ARGS, {
      mcp: server.mcp,
    });
    expect(host.requests[0]!.url).toContain(`/accounts/${OTHER_ACCOUNT}/`);

    const elsewhere = {
      ...server.mcp,
      async callTool(tool: string, args: Record<string, unknown>) {
        if (tool === "getUserInfo")
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  accounts: [
                    {
                      account_id: ACCOUNT,
                      is_default: true,
                      base_uri: "https://evil.example",
                    },
                  ],
                }),
              },
            ],
          };
        return server.mcp.callTool(tool, args);
      },
    };
    await expect(
      createDocusignSession({ http: host.http }).send(ARGS, { mcp: elsewhere }),
    ).rejects.toMatchObject({ signature: { code: "provider_error" } });
  });

  it("maps a failed upload and a missing server to the family's errors", async () => {
    const server = fakeServer();
    await expect(
      createDocusignSession({
        http: fakeHttp(400, {
          errorCode: "ANCHOR_TAB_STRING_NOT_FOUND",
          message:
            "The specified Anchor Tab string was not found in the document.",
        }).http,
      }).send(ARGS, { mcp: server.mcp }),
    ).rejects.toMatchObject({ signature: { code: "anchor_not_found" } });
    await expect(
      createDocusignSession({
        http: fakeHttp(401, { errorCode: "USER_AUTHENTICATION_FAILED" }).http,
      }).send(ARGS, { mcp: server.mcp }),
    ).rejects.toMatchObject({ signature: { code: "not_connected" } });
    await expect(
      createDocusignSession({ http: fakeHttp().http }).status(
        { ref: ENVELOPE },
        {},
      ),
    ).rejects.toMatchObject({ signature: { code: "not_connected" } });
  });
});
