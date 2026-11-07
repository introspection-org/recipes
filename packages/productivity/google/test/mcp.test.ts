import { describe, expect, it } from "vitest";

import {
  createGoogleProductivitySession,
  EXPECTED_MCP_TOOLS,
  mcpToolFor,
  mcpToolName,
} from "../src/index.js";
import { fakeGoogle, json, recordingSleep } from "./fake-google.js";
import {
  type FakeTool,
  fakeTools,
  httpFailure,
  structured,
} from "./fake-tools.js";

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

async function sessionWithRest(tools: Record<string, FakeTool>) {
  const pi = fakeTools(tools);
  const rest = restFake();
  const google = await createGoogleProductivitySession(
    {
      config: CONFIG,
      env: { INTROSPECTION_TASK_ID: "task-1" },
      cwd: process.cwd(),
      fetch: rest.fetchImpl,
    },
    { sleep: recordingSleep().sleep },
  );
  return { google, ctx: pi.ctx, mcp: pi.calls, rest };
}

describe("MCP tool names", () => {
  it("names each expected tool as Pi does: mcp__<server>__<tool>", () => {
    expect(mcpToolFor("mail.read")).toBe("mcp__gmail__get_message");
    expect(mcpToolFor("calendar.list")).toBe("mcp__calendar__list_events");
    expect(mcpToolFor("drive.search")).toBe("mcp__drive__search_files");
    expect(mcpToolName("google-mail", "a.b")).toBe("mcp__google_mail__a_b");
    // Pi shortens a name past 64 characters; none of ours comes near.
    for (const command of Object.keys(EXPECTED_MCP_TOOLS))
      expect(
        mcpToolFor(command as keyof typeof EXPECTED_MCP_TOOLS).length,
      ).toBeLessThanOrEqual(64);
  });
});

describe("MCP backend selection per call", () => {
  it("serves a command over MCP when the session can call its tool", async () => {
    const { google, ctx, mcp, rest } = await sessionWithRest({
      mcp__gmail__get_message: structured({ message: MESSAGE }),
    });
    expect(google.backendFor("mail.read", ctx)).toBe("mcp");

    const { messages } = await google.mail.read({ message_id: "m1" }, ctx);
    expect(messages[0]).toMatchObject({
      id: "m1",
      from: { email: "ada@example.com", name: "Ada" },
      labels: ["INBOX", "Clients"],
      body: { content_type: "text", content: "Hello from MCP" },
    });
    expect(mcp).toEqual([
      { name: "mcp__gmail__get_message", arguments: { messageId: "m1" } },
    ]);
    expect(
      rest.calls.some((c) => c.url.pathname.endsWith("/messages/m1")),
    ).toBe(false);
  });

  it("falls back to REST for a command whose tool the session cannot call", async () => {
    const { google, ctx, mcp, rest } = await sessionWithRest({
      mcp__gmail__search_messages: structured({ messages: [] }),
    });
    expect(google.backendFor("mail.search", ctx)).toBe("mcp");
    expect(google.backendFor("mail.read", ctx)).toBe("rest");

    const { messages } = await google.mail.read({ message_id: "m1" }, ctx);
    expect(messages[0]!.body?.content).toBe("Hello from REST");
    expect(
      rest.calls.some((c) => c.url.pathname.endsWith("/messages/m1")),
    ).toBe(true);
    expect(mcp).toEqual([]);
  });

  it("serves every command over REST when the host runs no other tool (Pi before ctx.executeTool)", async () => {
    const { google, rest } = await sessionWithRest({
      mcp__gmail__get_message: structured({ message: MESSAGE }),
    });
    for (const command of Object.keys(EXPECTED_MCP_TOOLS))
      expect(
        google.backendFor(command as keyof typeof EXPECTED_MCP_TOOLS),
        command,
      ).toBe("rest");
    const { messages } = await google.mail.read({ message_id: "m1" });
    expect(messages[0]!.body?.content).toBe("Hello from REST");
    expect(rest.calls.length).toBeGreaterThan(0);
  });

  it("sends mail only through REST, even when the server offers a send tool", async () => {
    const send: FakeTool = () => {
      throw new Error("mail send must not go through MCP");
    };
    const { google, ctx, mcp, rest } = await sessionWithRest({
      mcp__gmail__send_draft: send,
      mcp__gmail__send_message: send,
      mcp__gmail__create_draft: structured({ id: "d1" }),
    });
    await expect(google.mail.send({ draft_id: "d1" }, ctx)).resolves.toEqual({
      message_id: "sent1",
      thread_id: "t1",
    });
    expect(mcp).toEqual([]);
    expect(rest.calls.at(-1)!.url.pathname).toBe(
      "/gmail/v1/users/me/drafts/send",
    );
  });
});

describe("MCP errors", () => {
  it("maps a tool's error result to provider_error with its message", async () => {
    const { google, ctx } = await sessionWithRest({
      mcp__gmail__get_message: () => ({
        isError: true,
        content: [{ type: "text", text: "Backend unavailable" }],
      }),
    });
    await expect(
      google.mail.read({ message_id: "m1" }, ctx),
    ).rejects.toMatchObject({
      productivity: {
        code: "provider_error",
        message: expect.stringContaining("Backend unavailable"),
      },
    });
  });

  it("maps Pi's HTTP 401 on a call to not_connected and 403 to missing_scope", async () => {
    const unauthorized = await sessionWithRest({
      mcp__gmail__get_message: httpFailure(401),
    });
    await expect(
      unauthorized.google.mail.read({ message_id: "m1" }, unauthorized.ctx),
    ).rejects.toMatchObject({
      productivity: { code: "not_connected" },
    });

    const forbidden = await sessionWithRest({
      mcp__drive__search_files: httpFailure(403),
    });
    await expect(
      forbidden.google.drive.search({ query: "x", limit: 5 }, forbidden.ctx),
    ).rejects.toMatchObject({
      productivity: {
        code: "missing_scope",
        scope: "https://www.googleapis.com/auth/drive.readonly",
      },
    });
  });

  it("maps any other failed call (blocked, invalid) to provider_error with Pi's message", async () => {
    const { google, ctx } = await sessionWithRest({
      mcp__calendar__get_event: () => {
        throw new Error("Tool call blocked by policy");
      },
    });
    await expect(
      google.calendar.read({ event_id: "e1" }, ctx),
    ).rejects.toMatchObject({
      productivity: {
        code: "provider_error",
        message: expect.stringContaining("Tool call blocked by policy"),
      },
    });
  });

  it("refuses a result it does not recognise rather than guessing", async () => {
    const { google, ctx } = await sessionWithRest({
      mcp__calendar__get_event: () => ({
        content: [{ type: "text", text: "not json" }],
      }),
    });
    await expect(
      google.calendar.read({ event_id: "e1" }, ctx),
    ).rejects.toMatchObject({
      productivity: { code: "provider_error" },
    });
  });
});

describe("MCP request and result shapes (to confirm against the live servers)", () => {
  it("searches Drive with the server's query language, reading `title` as the name", async () => {
    const { google, ctx, mcp } = await sessionWithRest({
      mcp__drive__search_files: structured({
        files: [
          {
            id: "f1",
            title: "Plan",
            mimeType: "application/vnd.google-apps.document",
          },
        ],
        nextPageToken: "p2",
      }),
    });
    const result = await google.drive.search(
      { query: "Bob's plan", folder_id: "root", limit: 5 },
      ctx,
    );
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
    expect(
      mcp.find((c) => c.name === "mcp__drive__search_files")?.arguments,
    ).toEqual({
      query:
        "trashed = false and fullText contains 'Bob\\'s plan' and parentId = 'root'",
      pageSize: 5,
      excludeContentSnippets: true,
    });
  });

  it("reads a Drive file as the server's text, within max_bytes", async () => {
    const { google, ctx } = await sessionWithRest({
      mcp__drive__read_file_content: () => ({
        content: [{ type: "text", text: "Plan text from MCP" }],
      }),
    });
    const read = await google.drive.read({ file_id: "f1", max_bytes: 9 }, ctx);
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
    const { google, ctx, mcp } = await sessionWithRest({
      mcp__calendar__create_event: structured(created),
    });
    const event = await google.calendar.create(
      {
        title: "1:1",
        start: "2025-11-20T15:00:00+01:00",
        end: "2025-11-20T15:30:00+01:00",
        time_zone: "Europe/Paris",
        attendees: ["grace@example.com"],
      },
      ctx,
    );
    expect(event).toMatchObject({
      id: "e9",
      title: "1:1",
      time_zone: "Europe/Paris",
    });
    expect(
      mcp.find((c) => c.name === "mcp__calendar__create_event")?.arguments,
    ).toEqual({
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
    });
  });

  it("keeps a listed event's calendar for every later MCP command", async () => {
    const team = "team@group.calendar.google.com";
    const event = {
      id: "e1",
      summary: "Standup",
      start: { dateTime: "2025-11-20T09:00:00Z" },
      end: { dateTime: "2025-11-20T09:15:00Z" },
    };
    const pi = fakeTools({
      mcp__calendar__list_events: structured({ items: [event] }),
      mcp__calendar__get_event: structured(event),
      mcp__calendar__update_event: structured(event),
      mcp__calendar__respond_to_event: structured({}),
      mcp__calendar__delete_event: structured({}),
    });
    const rest = fakeGoogle([
      [
        "GET",
        /\/users\/me\/calendarList$/,
        () => json({ items: [{ id: team, summary: "Team" }] }),
      ],
    ]);
    const google = await createGoogleProductivitySession(
      {
        config: CONFIG,
        env: { INTROSPECTION_TASK_ID: "task-1" },
        cwd: process.cwd(),
        fetch: rest.fetchImpl,
      },
      { sleep: recordingSleep().sleep },
    );
    const listed = await google.calendar.list(
      {
        from: "2025-11-20T00:00:00Z",
        to: "2025-11-21T00:00:00Z",
        calendar: "Team",
        limit: 5,
      },
      pi.ctx,
    );
    const id = listed.events[0]!.id;
    expect((await google.calendar.read({ event_id: id }, pi.ctx)).id).toBe(id);
    await google.calendar.update({ event_id: id, title: "x" }, pi.ctx);
    await google.calendar.respond({ event_id: id, response: "accept" }, pi.ctx);
    await google.calendar.cancel({ event_id: id }, pi.ctx);
    expect(
      pi.calls.map((call) => [
        call.arguments.calendarId,
        call.arguments.eventId,
      ]),
    ).toEqual([
      [team, undefined],
      [team, "e1"],
      [team, "e1"],
      [team, "e1"],
      [team, "e1"],
    ]);
  });

  it("labels through MCP with label IDs resolved from names", async () => {
    const { google, ctx, mcp } = await sessionWithRest({
      mcp__gmail__modify_message_labels: structured({ message: MESSAGE }),
    });
    const summary = await google.mail.label(
      { message_id: "m1", add: ["clients"], remove: ["unread"] },
      ctx,
    );
    expect(summary.labels).toEqual(["INBOX", "Clients"]);
    expect(
      mcp.find((c) => c.name === "mcp__gmail__modify_message_labels")
        ?.arguments,
    ).toEqual({
      messageId: "m1",
      addLabelIds: ["Label_1"],
      removeLabelIds: ["UNREAD"],
    });
  });
});
