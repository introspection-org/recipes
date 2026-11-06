import { describe, expect, it } from "vitest";

import {
  createGoogleProductivitySession,
  EXPECTED_MCP_TOOLS,
  GOOGLE_MCP_SERVERS,
} from "../src/index.js";
import { fakeGoogle, json, recordingSleep } from "./fake-google.js";
import { type FakeTool, fakeMcp, structured } from "./fake-mcp.js";

const GMAIL = new URL(GOOGLE_MCP_SERVERS.gmail).host;
const CALENDAR = new URL(GOOGLE_MCP_SERVERS.calendar).host;
const DRIVE = new URL(GOOGLE_MCP_SERVERS.drive).host;

const CONFIG = {
  provider: "google",
  tools: {
    mail: [
      "search",
      "read",
      "fetch_attachment",
      "draft",
      "update_draft",
      "send",
      "move",
      "label",
    ],
    calendar: [
      "list",
      "read",
      "free_busy",
      "create",
      "update",
      "respond",
      "cancel",
    ],
    drive: ["search", "read", "download", "upload"],
  },
} as const;

const b64 = (text: string) => Buffer.from(text).toString("base64url");

const MESSAGE = {
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX", "Label_1"],
  snippet: "hello",
  internalDate: "1762250400000",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "Ada <ada@example.com>" },
      { name: "To", value: "person@example.com" },
      { name: "Subject", value: "Hi" },
    ],
    body: { data: b64("Hello from MCP") },
  },
};

/** The REST side, for whatever MCP does not serve. */
function restFake() {
  return fakeGoogle([
    [
      "GET",
      /\/labels$/,
      () => json({ labels: [{ id: "Label_1", name: "Clients" }] }),
    ],
    [
      "GET",
      /\/messages\/m1$/,
      () =>
        json({
          ...MESSAGE,
          payload: {
            ...MESSAGE.payload,
            body: { data: b64("Hello from REST") },
          },
        }),
    ],
    ["POST", /\/drafts\/send$/, () => json({ id: "sent1", threadId: "t1" })],
    [
      "GET",
      /\/drive\/v3\/files\/f1$/,
      () =>
        json({
          id: "f1",
          name: "Plan",
          mimeType: "application/vnd.google-apps.document",
        }),
    ],
  ]);
}

async function sessionWithRest(
  servers: Record<string, Record<string, FakeTool>>,
  options: Parameters<typeof fakeMcp>[1] = {},
) {
  const mcp = fakeMcp(servers, options);
  const rest = restFake();
  const google = await createGoogleProductivitySession(
    {
      config: CONFIG,
      env: { INTROSPECTION_TASK_ID: "task-1" },
      cwd: process.cwd(),
      fetch: rest.fetchImpl,
    },
    { mcpFetch: mcp.fetchImpl, sleep: recordingSleep().sleep },
  );
  return { google, mcp, rest };
}

describe("MCP backend selection at session start", () => {
  it("serves a command over MCP when the server lists its tool", async () => {
    const { google, mcp, rest } = await sessionWithRest({
      [GMAIL]: { get_message: structured({ message: MESSAGE }) },
    });
    expect(google.backends["mail.read"]).toBe("mcp");

    const { messages } = await google.mail.read({ message_id: "m1" });
    expect(messages[0]).toMatchObject({
      id: "m1",
      from: { email: "ada@example.com", name: "Ada" },
      labels: ["INBOX", "Clients"],
      body: { content_type: "text", content: "Hello from MCP" },
    });
    expect(mcp.calls.find((c) => c.tool === "get_message")?.arguments).toEqual({
      messageId: "m1",
    });
    expect(
      rest.calls.some((c) => c.url.pathname.endsWith("/messages/m1")),
    ).toBe(false);
    await google.close?.();
  });

  it("falls back to REST for a command whose tool the server does not list", async () => {
    const { google, mcp, rest } = await sessionWithRest({
      [GMAIL]: { search_messages: structured({ messages: [] }) },
    });
    expect(google.backends).toMatchObject({
      "mail.search": "mcp",
      "mail.read": "rest",
    });

    const { messages } = await google.mail.read({ message_id: "m1" });
    expect(messages[0]!.body?.content).toBe("Hello from REST");
    expect(
      rest.calls.some((c) => c.url.pathname.endsWith("/messages/m1")),
    ).toBe(true);
    expect(mcp.calls.some((c) => c.method === "tools/call")).toBe(false);
  });

  it("falls back to REST for every command of a server that is down", async () => {
    const { google } = await sessionWithRest(
      {},
      { down: [GMAIL, CALENDAR, DRIVE] },
    );
    for (const command of Object.keys(EXPECTED_MCP_TOOLS)) {
      expect(
        google.backends[command as keyof typeof EXPECTED_MCP_TOOLS],
        command,
      ).toBe("rest");
    }
    const { messages } = await google.mail.read({ message_id: "m1" });
    expect(messages[0]!.body?.content).toBe("Hello from REST");
  });

  it("opens only the servers the enabled commands need", async () => {
    const mcp = fakeMcp({ [GMAIL]: {}, [CALENDAR]: {}, [DRIVE]: {} });
    await createGoogleProductivitySession(
      {
        config: { provider: "google", tools: { drive: ["search"] } },
        env: { INTROSPECTION_TASK_ID: "t" },
        cwd: process.cwd(),
        fetch: restFake().fetchImpl,
      },
      { mcpFetch: mcp.fetchImpl },
    );
    expect(new Set(mcp.calls.map((c) => c.server))).toEqual(new Set([DRIVE]));
  });

  it("sends only the placeholder bearer to the MCP servers", async () => {
    const { mcp } = await sessionWithRest({ [GMAIL]: {} });
    expect(mcp.calls.length).toBeGreaterThan(0);
    for (const call of mcp.calls)
      expect(call.authorization).toBe("Bearer introspection-egress");
  });

  it("sends mail only through REST, even when the server offers a send tool", async () => {
    const send: FakeTool = () => {
      throw new Error("mail send must not go through MCP");
    };
    const { google, mcp, rest } = await sessionWithRest({
      [GMAIL]: {
        send_draft: send,
        send_message: send,
        create_draft: structured({ id: "d1" }),
      },
    });
    await expect(google.mail.send({ draft_id: "d1" })).resolves.toEqual({
      message_id: "sent1",
      thread_id: "t1",
    });
    expect(mcp.calls.some((c) => c.method === "tools/call")).toBe(false);
    expect(rest.calls.at(-1)!.url.pathname).toBe(
      "/gmail/v1/users/me/drafts/send",
    );
  });
});

describe("MCP errors", () => {
  it("maps a tool's error result to provider_error with its message", async () => {
    const { google } = await sessionWithRest({
      [GMAIL]: {
        get_message: () => ({
          isError: true,
          content: [{ type: "text", text: "Backend unavailable" }],
        }),
      },
    });
    await expect(google.mail.read({ message_id: "m1" })).rejects.toMatchObject({
      productivity: {
        code: "provider_error",
        message: expect.stringContaining("Backend unavailable"),
      },
    });
  });

  it("maps HTTP 401 on a call to not_connected and 403 to missing_scope", async () => {
    const unauthorized = await sessionWithRest(
      { [GMAIL]: { get_message: structured({}) } },
      { failCalls: { [GMAIL]: 401 } },
    );
    await expect(
      unauthorized.google.mail.read({ message_id: "m1" }),
    ).rejects.toMatchObject({
      productivity: { code: "not_connected" },
    });

    const forbidden = await sessionWithRest(
      { [DRIVE]: { search_files: structured({ files: [] }) } },
      { failCalls: { [DRIVE]: 403 } },
    );
    await expect(
      forbidden.google.drive.search({ query: "x", limit: 5 }),
    ).rejects.toMatchObject({
      productivity: {
        code: "missing_scope",
        scope: "https://www.googleapis.com/auth/drive.readonly",
      },
    });
  });

  it("refuses a result it does not recognise rather than guessing", async () => {
    const { google } = await sessionWithRest({
      [CALENDAR]: {
        get_event: () => ({ content: [{ type: "text", text: "not json" }] }),
      },
    });
    await expect(
      google.calendar.read({ event_id: "e1" }),
    ).rejects.toMatchObject({
      productivity: { code: "provider_error" },
    });
  });
});

describe("MCP request and result shapes (to confirm against the live servers)", () => {
  it("searches Drive with the server's query language, reading `title` as the name", async () => {
    const { google, mcp } = await sessionWithRest({
      [DRIVE]: {
        search_files: structured({
          files: [
            {
              id: "f1",
              title: "Plan",
              mimeType: "application/vnd.google-apps.document",
            },
          ],
          nextPageToken: "p2",
        }),
      },
    });
    const result = await google.drive.search({
      query: "Bob's plan",
      folder_id: "root",
      limit: 5,
    });
    expect(result).toEqual({
      files: [
        expect.objectContaining({
          id: "f1",
          name: "Plan",
          native_type: "application/vnd.google-apps.document",
        }),
      ],
      cursor: "p2",
    });
    expect(mcp.calls.find((c) => c.tool === "search_files")?.arguments).toEqual(
      {
        query:
          "trashed = false and fullText contains 'Bob\\'s plan' and parentId = 'root'",
        pageSize: 5,
        excludeContentSnippets: true,
      },
    );
  });

  it("reads a Drive file as the server's text, within max_bytes", async () => {
    const { google } = await sessionWithRest({
      [DRIVE]: {
        read_file_content: () => ({
          content: [{ type: "text", text: "Plan text from MCP" }],
        }),
      },
    });
    const read = await google.drive.read({ file_id: "f1", max_bytes: 9 });
    expect(read).toMatchObject({
      file: { id: "f1", name: "Plan" },
      content: { content_type: "text", content: "Plan text" },
    });
  });

  it("creates an event by passing the REST Event body, notifying attendees", async () => {
    const created = {
      id: "e9",
      summary: "1:1",
      start: {
        dateTime: "2025-11-20T15:00:00+01:00",
        timeZone: "Europe/Paris",
      },
      end: { dateTime: "2025-11-20T15:30:00+01:00", timeZone: "Europe/Paris" },
    };
    const { google, mcp } = await sessionWithRest({
      [CALENDAR]: { create_event: structured(created) },
    });
    const event = await google.calendar.create({
      title: "1:1",
      start: "2025-11-20T15:00:00+01:00",
      end: "2025-11-20T15:30:00+01:00",
      time_zone: "Europe/Paris",
      attendees: ["grace@example.com"],
    });
    expect(event).toMatchObject({
      id: "e9",
      title: "1:1",
      time_zone: "Europe/Paris",
    });
    expect(mcp.calls.find((c) => c.tool === "create_event")?.arguments).toEqual(
      {
        calendarId: "primary",
        sendUpdates: "all",
        event: {
          summary: "1:1",
          start: {
            dateTime: "2025-11-20T15:00:00+01:00",
            timeZone: "Europe/Paris",
          },
          end: {
            dateTime: "2025-11-20T15:30:00+01:00",
            timeZone: "Europe/Paris",
          },
          attendees: [{ email: "grace@example.com" }],
        },
      },
    );
  });

  it("labels through MCP with label IDs resolved from names", async () => {
    const { google, mcp } = await sessionWithRest({
      [GMAIL]: { modify_message_labels: structured({ message: MESSAGE }) },
    });
    const summary = await google.mail.label({
      message_id: "m1",
      add: ["clients"],
      remove: ["unread"],
    });
    expect(summary.labels).toEqual(["INBOX", "Clients"]);
    expect(
      mcp.calls.find((c) => c.tool === "modify_message_labels")?.arguments,
    ).toEqual({
      messageId: "m1",
      addLabelIds: ["Label_1"],
      removeLabelIds: ["UNREAD"],
    });
  });
});
