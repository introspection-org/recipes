import { mkdtempSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Attributes, Span, SpanStatus, Tracer } from "@opentelemetry/api";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import microsoft, {
  createMicrosoftSession,
  MICROSOFT_PRODUCTIVITY_CAPABILITIES,
  MICROSOFT_SCOPES,
  SIMPLE_UPLOAD_LIMIT_BYTES,
  UPLOAD_CHUNK_BYTES,
  wallTime,
} from "../packages/productivity/microsoft/src/index.js";
import {
  httpRequestSpan,
  httpResponseAttributes,
  MAX_RECORDED_BODY_BYTES,
  RESPONSE_BODY_ATTRIBUTE,
} from "../packages/productivity/microsoft/src/telemetry.js";
import {
  loadRecipeProductivity,
  PRODUCTIVITY_COMMANDS,
  PRODUCTIVITY_MODULE_API_VERSION,
  productivityCapabilitiesProblem,
  productivityCommandsFor,
  type ProductivitySession,
} from "../src/productivity/index.js";
import { readPiPackageManifest } from "../src/recipe/package.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

type Reply = {
  status?: number;
  json?: unknown;
  bytes?: Buffer;
  headers?: Record<string, string>;
};
type Route = (request: Recorded) => Reply | undefined;

const requests: Recorded[] = [];
let routes: Route[] = [];
let base = "";

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const url = new URL(req.url!, "http://fake");
    const recorded: Recorded = {
      method: req.method!,
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      headers: req.headers,
      body: Buffer.concat(chunks),
    };
    requests.push(recorded);
    const reply = routes
      .map((route) => route(recorded))
      .find((value) => value !== undefined) ?? {
      status: 404,
      json: { error: { code: "ErrorItemNotFound", message: "No route" } },
    };
    res.writeHead(reply.status ?? 200, {
      ...(reply.json !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...reply.headers,
    });
    res.end(
      reply.bytes ??
        (reply.json !== undefined ? JSON.stringify(reply.json) : undefined),
    );
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  requests.length = 0;
  spans.length = 0;
  routes = [];
});

interface RecordedSpan {
  name: string;
  attributes: Attributes;
  status?: SpanStatus;
  ended: boolean;
}

/** A tracer that keeps every span it starts, for the request-span tests. */
function recordingTracer(spans: RecordedSpan[]): Tracer {
  return {
    startSpan(name, options) {
      const recorded: RecordedSpan = {
        name,
        attributes: { ...options?.attributes },
        ended: false,
      };
      spans.push(recorded);
      const span = {
        setAttribute(key: string, value: Attributes[string]) {
          recorded.attributes[key] = value;
          return span;
        },
        setAttributes(attributes: Attributes) {
          Object.assign(recorded.attributes, attributes);
          return span;
        },
        setStatus(status: SpanStatus) {
          recorded.status = status;
          return span;
        },
        end() {
          recorded.ended = true;
        },
      };
      return span as unknown as Span;
    },
    startActiveSpan() {
      throw new Error("not used");
    },
  };
}

const spans: RecordedSpan[] = [];
const waits: number[] = [];
function session(
  env: Record<string, string> = { INTROSPECTION_TASK_ID: "task" },
): ProductivitySession {
  waits.length = 0;
  return createMicrosoftSession({
    env,
    tracer: recordingTracer(spans),
    baseUrl: `${base}/v1.0`,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
}

/** Answer `method path` with `reply`, recording nothing else. */
function on(
  method: string,
  path: string,
  reply: Reply | ((request: Recorded) => Reply),
) {
  routes.push((request) =>
    request.method === method && request.path === `/v1.0${path}`
      ? typeof reply === "function"
        ? reply(request)
        : reply
      : undefined,
  );
}

const json = (request: Recorded) =>
  JSON.parse(request.body.toString("utf8")) as Record<string, any>;
const ctx = {};

describe("Microsoft productivity provider: descriptor", () => {
  it("is a valid module serving every command over REST", () => {
    expect(microsoft).toMatchObject({
      kind: "productivity",
      apiVersion: PRODUCTIVITY_MODULE_API_VERSION,
      provider: "microsoft",
    });
    expect(
      productivityCapabilitiesProblem(MICROSOFT_PRODUCTIVITY_CAPABILITIES),
    ).toBeUndefined();
    for (const tool of ["mail", "calendar", "drive"] as const) {
      expect(
        productivityCommandsFor(MICROSOFT_PRODUCTIVITY_CAPABILITIES, tool),
      ).toEqual([...PRODUCTIVITY_COMMANDS[tool]]);
      for (const command of PRODUCTIVITY_COMMANDS[tool])
        expect(
          (MICROSOFT_SCOPES[tool] as Record<string, string>)[command],
        ).toMatch(/^(Mail|Calendars|Files)\./);
    }
    expect(MICROSOFT_PRODUCTIVITY_CAPABILITIES.mail).toMatchObject({
      labels: "categories",
      folders: "folders",
    });
    expect(
      MICROSOFT_PRODUCTIVITY_CAPABILITIES.mail!.commands.label!.note,
    ).toContain("categories");
  });

  it("implements every declared command", () => {
    const created = session();
    expect(Object.keys(created.mail!).sort()).toEqual(
      [
        "draft",
        "fetchAttachment",
        "label",
        "move",
        "read",
        "search",
        "send",
        "updateDraft",
      ].sort(),
    );
    expect(Object.keys(created.calendar!).sort()).toEqual(
      [
        "cancel",
        "create",
        "freeBusy",
        "list",
        "read",
        "respond",
        "update",
      ].sort(),
    );
    expect(Object.keys(created.drive!).sort()).toEqual([
      "download",
      "read",
      "search",
      "upload",
    ]);
  });
});

describe("Microsoft productivity provider: the Graph client", () => {
  it("sends the placeholder bearer in proxy-native mode, and the session locator through the egress URL", async () => {
    on("GET", "/me/messages", { json: { value: [] } });
    await session().mail!.search!({ limit: 5 }, ctx);
    expect(requests[0]!.headers.authorization).toBe(
      "Bearer introspection-egress",
    );

    await session({
      INTROSPECTION_TOKEN: "locator",
      INTROSPECTION_EGRESS_URL: "http://egress:8080",
    }).mail!.search!({ limit: 5 }, ctx);
    expect(requests[1]!.headers.authorization).toBe("Bearer locator");

    await expect(
      session({}).mail!.search!({ limit: 5 }, ctx),
    ).rejects.toMatchObject({
      productivity: { code: "provider_error" },
    });
  });

  it("follows @odata.nextLink up to the limit and returns the next link as the cursor", async () => {
    on("GET", "/me/messages", (request) =>
      request.query.get("page") === "2"
        ? {
            json: {
              value: [{ id: "m3" }],
              "@odata.nextLink": `${base}/v1.0/me/messages?page=3`,
            },
          }
        : {
            json: {
              value: [{ id: "m1" }, { id: "m2" }],
              "@odata.nextLink": `${base}/v1.0/me/messages?page=2`,
            },
          },
    );
    const first = await session().mail!.search!({ limit: 3 }, ctx);
    expect(first.messages.map((message) => message.id)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    expect(first.cursor).toBe(`${base}/v1.0/me/messages?page=3`);
    expect(requests).toHaveLength(2);

    on("GET", "/me/messages", { json: { value: [{ id: "m4" }] } });
    const next = await session().mail!.search!(
      { limit: 3, cursor: `${base}/v1.0/me/messages?page=2` },
      ctx,
    );
    expect(next.messages[0]!.id).toBe("m3");

    // A page longer than the limit comes back whole; the host keeps the rest.
    on("GET", "/me/drive/root/search(q='x')", {
      json: {
        value: [{ id: "f1" }, { id: "f2" }, { id: "f3" }],
        "@odata.nextLink": `${base}/v1.0/me/drive/root/search(q='x')?page=2`,
      },
    });
    const files = await session().drive!.search!({ query: "x", limit: 2 }, ctx);
    expect(files.files.map((file) => file.id)).toEqual(["f1", "f2", "f3"]);
    expect(files.cursor).toBe(
      `${base}/v1.0/me/drive/root/search(q='x')?page=2`,
    );
    await expect(
      session().mail!.search!(
        { limit: 3, cursor: "https://evil.example/v1.0/me/messages" },
        ctx,
      ),
    ).rejects.toMatchObject({ productivity: { code: "invalid_request" } });
  });

  it("retries a throttled read after Retry-After", async () => {
    let calls = 0;
    on("GET", "/me/events/e1", () =>
      ++calls < 3
        ? {
            status: calls === 1 ? 429 : 503,
            headers: { "Retry-After": "2" },
            json: { error: { code: "TooManyRequests" } },
          }
        : {
            json: {
              id: "e1",
              start: {
                dateTime: "2026-03-02T09:00:00.0000000",
                timeZone: "UTC",
              },
            },
          },
    );
    const event = await session().calendar!.read!({ event_id: "e1" }, ctx);
    expect(event.start).toBe("2026-03-02T09:00:00");
    expect(waits).toEqual([2000, 2000]);
    expect(requests).toHaveLength(3);
  });

  it("hands a wait longer than it will sleep back as rate_limited", async () => {
    on("GET", "/me/messages", {
      status: 429,
      headers: { "Retry-After": "120" },
    });
    await expect(
      session().mail!.search!({ limit: 5 }, ctx),
    ).rejects.toMatchObject({
      productivity: {
        code: "rate_limited",
        retry_after_seconds: 120,
        status: 429,
      },
    });
    expect(waits).toEqual([]);
  });

  it("never retries a write", async () => {
    on("POST", "/me/messages/d1/send", {
      status: 503,
      headers: { "Retry-After": "1" },
    });
    await expect(
      session().mail!.send!({ draft_id: "d1" }, ctx),
    ).rejects.toMatchObject({
      productivity: { code: "provider_error", status: 503 },
    });
    on("POST", "/me/events", { status: 429, headers: { "Retry-After": "1" } });
    await expect(
      session().calendar!.create!(
        {
          title: "x",
          start: "2026-03-02T09:00:00",
          end: "2026-03-02T10:00:00",
          time_zone: "UTC",
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      productivity: { code: "rate_limited", retry_after_seconds: 1 },
    });
    expect(requests).toHaveLength(2);
    expect(waits).toEqual([]);
  });

  it("maps Graph errors to the shared codes", async () => {
    const cases: Array<[number, string, Record<string, unknown>]> = [
      [401, "not_connected", {}],
      [403, "missing_scope", { scope: "Mail.Send" }],
      [404, "not_found", {}],
      [400, "invalid_request", {}],
      [500, "provider_error", {}],
    ];
    for (const [status, code, extra] of cases) {
      routes = [];
      on("POST", "/me/messages/d1/send", {
        status,
        json: { error: { code: "Something", message: "Graph says no" } },
      });
      await expect(
        session().mail!.send!({ draft_id: "d1" }, ctx),
      ).rejects.toMatchObject({
        productivity: { code, status, ...extra },
      });
    }
  });
});

describe("Microsoft productivity provider: mail", () => {
  it("search: $filter and $orderby without text, KQL with it", async () => {
    on("GET", "/me/mailFolders/inbox/messages", {
      json: {
        value: [
          {
            id: "m1",
            conversationId: "c1",
            subject: "Hi",
            from: { emailAddress: { address: "a@x.test", name: "A" } },
            toRecipients: [{ emailAddress: { address: "me@x.test" } }],
            receivedDateTime: "2026-03-01T10:00:00Z",
            isRead: false,
            hasAttachments: true,
            categories: ["Red"],
            bodyPreview: "Hello",
          },
        ],
      },
    });
    const result = await session().mail!.search!(
      {
        folder: "Inbox",
        from: "a@x.test",
        after: "2026-03-01T00:00:00Z",
        unread: true,
        limit: 10,
      },
      ctx,
    );
    expect(result.messages[0]).toEqual({
      id: "m1",
      thread_id: "c1",
      from: { email: "a@x.test", name: "A" },
      to: [{ email: "me@x.test" }],
      subject: "Hi",
      snippet: "Hello",
      sent_at: "2026-03-01T10:00:00Z",
      unread: true,
      has_attachments: true,
      labels: ["Red"],
    });
    const query = requests[0]!.query;
    expect(query.get("$filter")).toBe(
      "receivedDateTime ge 2026-03-01T00:00:00.000Z and from/emailAddress/address eq 'a@x.test' and isRead eq false",
    );
    expect(query.get("$orderby")).toBe("receivedDateTime desc");
    expect(query.get("$top")).toBe("10");

    routes = [];
    on("GET", "/me/messages", {
      json: {
        value: [
          { id: "r", isRead: true },
          { id: "u", isRead: false },
        ],
      },
    });
    const text = await session().mail!.search!(
      { query: 'budget "Q3"', from: "a@x.test", unread: true, limit: 10 },
      ctx,
    );
    expect(requests[1]!.query.get("$search")).toBe(
      '"budget \\"Q3\\" from:a@x.test"',
    );
    expect(requests[1]!.query.get("$filter")).toBeNull();
    expect(text.messages.map((message) => message.id)).toEqual(["u"]);
  });

  it("search applies the exact after and before instants with text as without", async () => {
    const received = [
      "2026-03-02T09:00:00Z",
      "2026-03-02T12:00:00Z",
      "2026-03-02T12:30:00Z",
      "2026-03-02T13:00:00Z",
    ];
    on("GET", "/me/messages", {
      json: {
        value: received.map((at, n) => ({ id: `m${n}`, receivedDateTime: at })),
      },
    });
    const bounds = {
      after: "2026-03-02T12:00:00Z",
      before: "2026-03-02T14:00:00+01:00",
      limit: 10,
    };
    const text = await session().mail!.search!(
      { query: "budget", ...bounds },
      ctx,
    );
    expect(requests[0]!.query.get("$search")).toBe(
      '"budget received>=2026-03-01 received<=2026-03-03"',
    );
    expect(text.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    const plain = await session().mail!.search!(bounds, ctx);
    expect(requests[1]!.query.get("$filter")).toBe(
      "receivedDateTime ge 2026-03-02T12:00:00.000Z and receivedDateTime lt 2026-03-02T13:00:00.000Z",
    );
    expect(plain.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
  });

  it("search resolves a custom folder by display name", async () => {
    on("GET", "/me/mailFolders", {
      json: { value: [{ id: "F1", displayName: "Clients" }] },
    });
    on("GET", "/me/mailFolders/F1/messages", { json: { value: [] } });
    await session().mail!.search!({ folder: "Clients", limit: 5 }, ctx);
    expect(requests[0]!.query.get("$filter")).toBe("displayName eq 'Clients'");
    expect(requests[1]!.path).toBe("/v1.0/me/mailFolders/F1/messages");
  });

  it("read: one message with body and attachments, or a thread oldest first", async () => {
    on("GET", "/me/messages/m1", {
      json: {
        id: "m1",
        body: { contentType: "html", content: "<p>Hi</p>" },
        attachments: [
          {
            id: "a1",
            name: "x.pdf",
            contentType: "application/pdf",
            size: 3,
            isInline: false,
          },
        ],
      },
    });
    const one = await session().mail!.read!({ message_id: "m1" }, ctx);
    expect(one.messages[0]).toMatchObject({
      body: { content_type: "html", content: "<p>Hi</p>" },
      attachments: [
        { id: "a1", name: "x.pdf", mime_type: "application/pdf", size: 3 },
      ],
    });
    expect(requests[0]!.query.get("$expand")).toBe(
      "attachments($select=id,name,contentType,size,isInline)",
    );

    on("GET", "/me/messages", {
      json: {
        value: [
          { id: "b", receivedDateTime: "2026-03-02T00:00:00Z" },
          { id: "a", receivedDateTime: "2026-03-01T00:00:00Z" },
        ],
      },
    });
    const thread = await session().mail!.read!({ thread_id: "c'1" }, ctx);
    expect(thread.messages.map((message) => message.id)).toEqual(["a", "b"]);
    expect(thread.unavailable).toBeUndefined();
    expect(requests[1]!.query.get("$filter")).toBe(
      "receivedDateTime ge 1900-01-01T00:00:00Z and conversationId eq 'c''1'",
    );
    expect(requests[1]!.query.get("$orderby")).toBe("receivedDateTime desc");
  });

  it("reads a long thread past one page, and says so when it is cut at 500", async () => {
    // Pages of 50, newest first, for a thread of 520 messages.
    const at = (n: number) =>
      new Date(Date.UTC(2026, 0, 1) + (520 - n) * 60_000).toISOString();
    on("GET", "/me/messages", (request) => {
      const page = Number(request.query.get("page") ?? "0");
      const ids = Array.from({ length: 50 }, (_, i) => page * 50 + i).filter(
        (n) => n < 520,
      );
      return {
        json: {
          value: ids.map((n) => ({ id: `m${n}`, receivedDateTime: at(n) })),
          ...((page + 1) * 50 < 520
            ? {
                "@odata.nextLink": `${base}/v1.0/me/messages?page=${page + 1}`,
              }
            : {}),
        },
      };
    });
    const thread = await session().mail!.read!({ thread_id: "c1" }, ctx);
    expect(requests).toHaveLength(10);
    expect(thread.messages).toHaveLength(500);
    expect(thread.messages[0]!.id).toBe("m499");
    expect(thread.messages.at(-1)!.id).toBe("m0");
    expect(thread.unavailable).toContain("more than 500 messages");
  });

  it("fetch_attachment: metadata, then the raw $value", async () => {
    on("GET", "/me/messages/m1/attachments/a1", {
      json: { id: "a1", name: "x.pdf", contentType: "application/pdf" },
    });
    on("GET", "/me/messages/m1/attachments/a1/$value", {
      bytes: Buffer.from("%PDF"),
    });
    const file = await session().mail!.fetchAttachment!(
      { message_id: "m1", attachment_id: "a1" },
      ctx,
    );
    expect(file).toMatchObject({ name: "x.pdf", mime_type: "application/pdf" });
    expect(Buffer.from(file.bytes).toString()).toBe("%PDF");
  });

  it("draft: a new message, or a reply through createReply with the text as comment", async () => {
    on("POST", "/me/messages", (request) => ({
      status: 201,
      json: { id: "d1", conversationId: "c1", ...json(request) },
    }));
    const draft = await session().mail!.draft!(
      { to: ["b@x.test"], cc: ["c@x.test"], subject: "Plan", body: "**Hi**" },
      ctx,
    );
    expect(json(requests[0]!)).toEqual({
      subject: "Plan",
      body: { contentType: "text", content: "**Hi**" },
      toRecipients: [{ emailAddress: { address: "b@x.test" } }],
      ccRecipients: [{ emailAddress: { address: "c@x.test" } }],
    });
    expect(draft).toMatchObject({
      id: "d1",
      thread_id: "c1",
      to: [{ email: "b@x.test" }],
    });

    on("POST", "/me/messages/m1/createReply", {
      status: 201,
      json: { id: "d2", conversationId: "c1" },
    });
    await session().mail!.draft!(
      { to: [], subject: "Re: Plan", body: "Thanks", reply_to_id: "m1" },
      ctx,
    );
    expect(json(requests[1]!)).toEqual({
      comment: "Thanks",
      message: { subject: "Re: Plan" },
    });
  });

  it("update_draft patches; send posts to /send", async () => {
    on("PATCH", "/me/messages/d1", { json: { id: "d1", subject: "New" } });
    const updated = await session().mail!.updateDraft!(
      { draft_id: "d1", subject: "New", body: "x" },
      ctx,
    );
    expect(updated.subject).toBe("New");
    expect(json(requests[0]!)).toEqual({
      subject: "New",
      body: { contentType: "text", content: "x" },
    });
    on("POST", "/me/messages/d1/send", { status: 202 });
    await expect(
      session().mail!.send!({ draft_id: "d1" }, ctx),
    ).resolves.toEqual({});
    expect(requests[1]!.body.length).toBe(0);
  });

  it("move posts the folder's id; label rewrites categories", async () => {
    on("POST", "/me/messages/m1/move", { status: 201, json: { id: "m1-new" } });
    const moved = await session().mail!.move!(
      { message_id: "m1", folder: "Archive" },
      ctx,
    );
    expect(json(requests[0]!)).toEqual({ destinationId: "archive" });
    expect(moved.id).toBe("m1-new");

    on("GET", "/me/messages/m2", {
      json: { id: "m2", categories: ["Red", "Blue"] },
    });
    on("PATCH", "/me/messages/m2", (request) => ({
      json: { id: "m2", ...json(request) },
    }));
    const labelled = await session().mail!.label!(
      { message_id: "m2", add: ["Green", "red"], remove: ["blue"] },
      ctx,
    );
    expect(json(requests[2]!)).toEqual({ categories: ["Red", "Green"] });
    expect(labelled.labels).toEqual(["Red", "Green"]);
  });
});

describe("Microsoft productivity provider: calendar", () => {
  const event = {
    id: "e1",
    subject: "Review",
    start: {
      dateTime: "2026-03-02T09:00:00.0000000",
      timeZone: "Europe/London",
    },
    end: { dateTime: "2026-03-02T10:00:00.0000000", timeZone: "Europe/London" },
    isOrganizer: true,
    responseStatus: { response: "organizer" },
    attendees: [
      {
        emailAddress: { address: "b@x.test" },
        type: "required",
        status: { response: "tentativelyAccepted" },
      },
    ],
    onlineMeeting: { joinUrl: "https://teams.example/j" },
  };

  it("list: calendarView between two times, on a named calendar", async () => {
    on("GET", "/me/calendars", {
      json: { value: [{ id: "C1", name: "Team" }] },
    });
    on("GET", "/me/calendars/C1/calendarView", { json: { value: [event] } });
    const listed = await session().calendar!.list!(
      {
        from: "2026-03-02T00:00:00Z",
        to: "2026-03-03T00:00:00Z",
        calendar: "Team",
        limit: 20,
      },
      ctx,
    );
    expect(requests[1]!.query.get("startDateTime")).toBe(
      "2026-03-02T00:00:00Z",
    );
    expect(requests[1]!.query.get("endDateTime")).toBe("2026-03-03T00:00:00Z");
    expect(listed.events[0]).toMatchObject({
      id: "C1/e1",
      title: "Review",
      start: "2026-03-02T09:00:00",
      time_zone: "Europe/London",
      response: "organizer",
      online_meeting_url: "https://teams.example/j",
    });
  });

  it("keeps a listed event's calendar for every later command", async () => {
    // A calendar shared from another mailbox is not reachable as /me/events/{id}.
    on("GET", "/me/calendars", {
      json: { value: [{ id: "C/1", name: "Shared" }] },
    });
    on("GET", "/me/calendars/C/1/calendarView", { json: { value: [event] } });
    on("GET", "/me/calendars/C/1/events/e1", { json: event });
    on("PATCH", "/me/calendars/C/1/events/e1", { json: event });
    on("POST", "/me/calendars/C/1/events/e1/accept", { status: 202 });
    on("POST", "/me/calendars/C/1/events/e1/cancel", { status: 202 });
    const s = session();
    const listed = await s.calendar!.list!(
      {
        from: "2026-03-02T00:00:00Z",
        to: "2026-03-03T00:00:00Z",
        calendar: "Shared",
        limit: 20,
      },
      ctx,
    );
    const id = listed.events[0]!.id;
    expect((await s.calendar!.read!({ event_id: id }, ctx)).id).toBe(id);
    expect(
      (await s.calendar!.update!({ event_id: id, title: "x" }, ctx)).id,
    ).toBe(id);
    await s.calendar!.respond!({ event_id: id, response: "accept" }, ctx);
    await s.calendar!.cancel!({ event_id: id }, ctx);
    expect(requests.slice(2).map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v1.0/me/calendars/C/1/events/e1",
      "PATCH /v1.0/me/calendars/C/1/events/e1",
      "POST /v1.0/me/calendars/C/1/events/e1/accept",
      "POST /v1.0/me/calendars/C/1/events/e1/cancel",
    ]);
    expect(requests[2]!.path).toBe("/v1.0/me/calendars/C/1/events/e1");
  });

  it("refuses a body change on an online meeting, whose join details live in the body", async () => {
    on("GET", "/me/events/e1", (request) => ({
      json: {
        id: "e1",
        isOnlineMeeting: request.query.get("$select") !== null,
      },
    }));
    on("PATCH", "/me/events/e1", { json: event });
    await expect(
      session().calendar!.update!({ event_id: "e1", body: "New agenda" }, ctx),
    ).rejects.toMatchObject({ productivity: { code: "invalid_request" } });
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
    expect(requests[0]!.query.get("$select")).toBe("id,isOnlineMeeting");

    requests.length = 0;
    routes = [];
    on("GET", "/me/events/e1", { json: { id: "e1", isOnlineMeeting: false } });
    on("PATCH", "/me/events/e1", { json: event });
    await session().calendar!.update!(
      { event_id: "e1", body: "New agenda" },
      ctx,
    );
    expect(json(requests[1]!)).toEqual({
      body: { contentType: "text", content: "New agenda" },
    });
  });

  it("read returns attendees and their responses", async () => {
    on("GET", "/me/events/e1", { json: event });
    const read = await session().calendar!.read!({ event_id: "e1" }, ctx);
    expect(read.attendees).toEqual([
      { email: "b@x.test", type: "required", response: "tentative" },
    ]);
  });

  it("free_busy: getSchedule in UTC, answered in the asked zone", async () => {
    on("POST", "/me/calendar/getSchedule", {
      json: {
        value: [
          {
            scheduleId: "b@x.test",
            scheduleItems: [
              {
                status: "busy",
                start: { dateTime: "2026-03-02T09:00:00.0000000" },
                end: { dateTime: "2026-03-02T10:00:00.0000000" },
              },
              {
                status: "free",
                start: { dateTime: "2026-03-02T11:00:00" },
                end: { dateTime: "2026-03-02T12:00:00" },
              },
              {
                status: "oof",
                start: { dateTime: "2026-03-02T13:00:00" },
                end: { dateTime: "2026-03-02T14:00:00" },
              },
            ],
          },
        ],
      },
    });
    const result = await session().calendar!.freeBusy!(
      {
        attendees: ["b@x.test"],
        from: "2026-03-02T00:00:00Z",
        to: "2026-03-03T00:00:00+00:00",
        time_zone: "Europe/London",
      },
      ctx,
    );
    expect(requests[0]!.headers.prefer).toBe(
      'outlook.timezone="Europe/London"',
    );
    expect(json(requests[0]!)).toEqual({
      schedules: ["b@x.test"],
      startTime: { dateTime: "2026-03-02T00:00:00", timeZone: "UTC" },
      endTime: { dateTime: "2026-03-03T00:00:00", timeZone: "UTC" },
      availabilityViewInterval: 30,
    });
    expect(result.schedules[0]!.busy).toEqual([
      {
        start: "2026-03-02T09:00:00",
        end: "2026-03-02T10:00:00",
        status: "busy",
      },
      {
        start: "2026-03-02T13:00:00",
        end: "2026-03-02T14:00:00",
        status: "out_of_office",
      },
    ]);
  });

  it("create and update send wall times in the event's zone", async () => {
    on("POST", "/me/events", { status: 201, json: event });
    await session().calendar!.create!(
      {
        title: "Review",
        start: "2026-03-02T09:00",
        end: "2026-03-02T10:00:00Z",
        time_zone: "America/New_York",
        attendees: ["b@x.test"],
        location: "Room 1",
        body: "Agenda",
        online_meeting: true,
      },
      ctx,
    );
    expect(requests[0]!.headers.prefer).toBe(
      'outlook.timezone="America/New_York"',
    );
    expect(json(requests[0]!)).toEqual({
      subject: "Review",
      start: { dateTime: "2026-03-02T09:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-03-02T05:00:00", timeZone: "America/New_York" },
      attendees: [{ emailAddress: { address: "b@x.test" }, type: "required" }],
      location: { displayName: "Room 1" },
      body: { contentType: "text", content: "Agenda" },
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",
    });

    on("PATCH", "/me/events/e1", { json: event });
    await session().calendar!.update!(
      {
        event_id: "e1",
        start: "2026-03-05",
        end: "2026-03-06",
        time_zone: "UTC",
        all_day: true,
      },
      ctx,
    );
    expect(json(requests[1]!)).toEqual({
      start: { dateTime: "2026-03-05T00:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-03-06T00:00:00", timeZone: "UTC" },
      isAllDay: true,
    });
    expect(wallTime("2026-07-01T12:00:00Z", "Europe/London")).toBe(
      "2026-07-01T13:00:00",
    );
  });

  it("respond and cancel post to their actions", async () => {
    on("POST", "/me/events/e1/tentativelyAccept", { status: 202 });
    on("POST", "/me/events/e1/decline", { status: 202 });
    on("POST", "/me/events/e1/cancel", { status: 202 });
    await session().calendar!.respond!(
      { event_id: "e1", response: "tentative", comment: "Maybe" },
      ctx,
    );
    await session().calendar!.respond!(
      { event_id: "e1", response: "decline" },
      ctx,
    );
    await session().calendar!.cancel!(
      { event_id: "e1", comment: "Moved" },
      ctx,
    );
    expect(requests.map((request) => [request.path, json(request)])).toEqual([
      [
        "/v1.0/me/events/e1/tentativelyAccept",
        { comment: "Maybe", sendResponse: true },
      ],
      ["/v1.0/me/events/e1/decline", { sendResponse: true }],
      ["/v1.0/me/events/e1/cancel", { comment: "Moved" }],
    ]);
  });
});

describe("Microsoft productivity provider: drive", () => {
  const item = {
    id: "I1",
    name: "notes.md",
    size: 5,
    file: { mimeType: "text/markdown" },
    parentReference: { driveId: "D1", id: "P1" },
    lastModifiedDateTime: "2026-03-01T00:00:00Z",
  };

  it("search: root or folder search with the drive kept in the id", async () => {
    on("GET", "/me/drive/root/search(q='it''s')", {
      json: {
        value: [
          item,
          { ...item, id: "I2", lastModifiedDateTime: "2025-01-01T00:00:00Z" },
          {
            id: "F1",
            name: "Docs",
            folder: { childCount: 2 },
            parentReference: { driveId: "D1" },
          },
        ],
      },
    });
    const found = await session().drive!.search!(
      { query: "it's", modified_after: "2026-01-01T00:00:00Z", limit: 10 },
      ctx,
    );
    expect(found.files.map((file) => file.id)).toEqual(["D1/I1"]);
    expect(found.files[0]).toMatchObject({
      name: "notes.md",
      mime_type: "text/markdown",
      parent_id: "D1/P1",
    });

    on("GET", "/drives/D1/items/F1/search(q='plan')", { json: { value: [] } });
    await session().drive!.search!(
      { query: "plan", folder_id: "D1/F1", limit: 10 },
      ctx,
    );
    expect(requests[1]!.path).toBe("/v1.0/drives/D1/items/F1/search(q='plan')");
  });

  it("read returns a text file's content and says why another has none", async () => {
    on("GET", "/drives/D1/items/I1", { json: item });
    on("GET", "/drives/D1/items/I1/content", {
      status: 302,
      headers: { Location: `${base}/download/notes.md?sig=1` },
    });
    routes.push((request) =>
      request.path === "/download/notes.md"
        ? { bytes: Buffer.from("# Hi\n") }
        : undefined,
    );
    const read = await session().drive!.read!(
      { file_id: "D1/I1", max_bytes: 1000 },
      ctx,
    );
    expect(read.content).toEqual({ content_type: "text", content: "# Hi\n" });
    const download = requests.find(
      (request) => request.path === "/download/notes.md",
    )!;
    expect(download.headers.authorization).toBeUndefined();

    routes = [];
    on("GET", "/me/drive/items/W1", {
      json: {
        id: "W1",
        name: "MSA.docx",
        file: {
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      },
    });
    const word = await session().drive!.read!(
      { file_id: "W1", max_bytes: 1000 },
      ctx,
    );
    expect(word.unavailable).toContain("drive download");
  });

  it("download follows the redirect without the bearer", async () => {
    on("GET", "/drives/D1/items/I1", {
      json: {
        ...item,
        name: "MSA.docx",
        file: { mimeType: "application/msword" },
      },
    });
    on("GET", "/drives/D1/items/I1/content", {
      status: 302,
      headers: { Location: `${base}/download/MSA.docx` },
    });
    routes.push((request) =>
      request.path === "/download/MSA.docx"
        ? { bytes: Buffer.from("PK") }
        : undefined,
    );
    const file = await session().drive!.download!({ file_id: "D1/I1" }, ctx);
    expect(file).toMatchObject({
      name: "MSA.docx",
      mime_type: "application/msword",
    });
    expect(Buffer.from(file.bytes).toString()).toBe("PK");
    expect(requests.at(-1)!.headers.authorization).toBeUndefined();
  });

  it("upload: one PUT up to 4 MB, never overwriting", async () => {
    on("PUT", "/drives/D1/items/F1:/out.docx:/content", {
      status: 201,
      json: { ...item, id: "N1", name: "out.docx" },
    });
    const uploaded = await session().drive!.upload!(
      {
        name: "out.docx",
        bytes: new Uint8Array([1, 2, 3]),
        folder_id: "D1/F1",
      },
      ctx,
    );
    expect(uploaded.id).toBe("D1/N1");
    expect(requests[0]!.query.get("@microsoft.graph.conflictBehavior")).toBe(
      "rename",
    );
    expect([...requests[0]!.body]).toEqual([1, 2, 3]);
    expect(requests[0]!.headers.authorization).toBe(
      "Bearer introspection-egress",
    );
  });

  it("upload: an upload session in 320 KiB-multiple ranges above 4 MB, without the bearer", async () => {
    const size = UPLOAD_CHUNK_BYTES + 1000;
    expect(size).toBeGreaterThan(SIMPLE_UPLOAD_LIMIT_BYTES);
    on("POST", "/me/drive/root:/big.bin:/createUploadSession", {
      json: { uploadUrl: `${base}/upload/session-1` },
    });
    routes.push((request) =>
      request.path === "/upload/session-1"
        ? request.headers["content-range"]!.endsWith(`-${size - 1}/${size}`)
          ? {
              status: 201,
              json: {
                id: "B1",
                name: "big.bin",
                parentReference: { driveId: "D1" },
              },
            }
          : { status: 202, json: { nextExpectedRanges: [] } }
        : undefined,
    );
    const uploaded = await session().drive!.upload!(
      { name: "big.bin", bytes: new Uint8Array(size) },
      ctx,
    );
    expect(uploaded.id).toBe("D1/B1");
    expect(json(requests[0]!)).toEqual({
      item: { "@microsoft.graph.conflictBehavior": "rename" },
    });
    const ranges = requests.slice(1);
    expect(UPLOAD_CHUNK_BYTES % (320 * 1024)).toBe(0);
    expect(ranges.map((request) => request.headers["content-range"])).toEqual([
      `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${size}`,
      `bytes ${UPLOAD_CHUNK_BYTES}-${size - 1}/${size}`,
    ]);
    expect(
      ranges.every((request) => request.headers.authorization === undefined),
    ).toBe(true);
  });

  it("does not retry a failed upload range", async () => {
    on("POST", "/me/drive/root:/big.bin:/createUploadSession", {
      json: { uploadUrl: `${base}/upload/s2` },
    });
    routes.push((request) =>
      request.path === "/upload/s2"
        ? { status: 503, headers: { "Retry-After": "1" } }
        : undefined,
    );
    await expect(
      session().drive!.upload!(
        {
          name: "big.bin",
          bytes: new Uint8Array(SIMPLE_UPLOAD_LIMIT_BYTES + 1),
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      productivity: { code: "provider_error", status: 503 },
    });
    expect(requests).toHaveLength(2);
  });
});

describe("Microsoft productivity provider: request spans", () => {
  it("names a span after the method and the OpenAPI path template, recording no path or query", () => {
    expect(
      httpRequestSpan({
        method: "GET",
        url: "https://graph.microsoft.com/v1.0/me/messages/AAMk%3D?$search=%22secret%22",
        template: "/me/messages/{message-id}",
      }),
    ).toEqual({
      name: "GET /me/messages/{message-id}",
      attributes: {
        "http.request.method": "GET",
        "server.address": "graph.microsoft.com",
        "server.port": 443,
        "url.template": "/me/messages/{message-id}",
      },
    });
    expect(
      httpRequestSpan({
        method: "GET",
        url: "https://tenant.sharepoint.com/download.aspx?tempauth=token",
      }),
    ).toEqual({
      name: "GET",
      attributes: {
        "http.request.method": "GET",
        "server.address": "tenant.sharepoint.com",
        "server.port": 443,
      },
    });
  });

  it("records a JSON body up to the cap, and only its size above it", () => {
    expect(httpResponseAttributes(200, '{"id":"m1"}')).toEqual({
      "http.response.status_code": 200,
      "http.response.body.size": 11,
      [RESPONSE_BODY_ATTRIBUTE]: '{"id":"m1"}',
    });
    const large = "x".repeat(MAX_RECORDED_BODY_BYTES + 1);
    expect(httpResponseAttributes(200, large)).toEqual({
      "http.response.status_code": 200,
      "http.response.body.size": MAX_RECORDED_BODY_BYTES + 1,
    });
    expect(httpResponseAttributes(404)).toEqual({
      "http.response.status_code": 404,
      "error.type": "404",
    });
  });

  it("records one span per Graph request, with the answer's body and never the bearer", async () => {
    on("GET", "/me/messages/m1", {
      json: {
        id: "m1",
        subject: "Hi",
        body: { contentType: "text", content: "x" },
      },
    });
    const read = await session({
      INTROSPECTION_TOKEN: "locator-secret",
      INTROSPECTION_EGRESS_URL: "http://egress:8080",
    }).mail!.read!({ message_id: "m1" }, ctx);
    expect(read.messages[0]!.subject).toBe("Hi");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: "GET /me/messages/{message-id}",
      ended: true,
      attributes: {
        "http.request.method": "GET",
        "server.address": "127.0.0.1",
        "url.template": "/me/messages/{message-id}",
        "http.response.status_code": 200,
      },
    });
    expect(
      JSON.parse(String(spans[0]!.attributes[RESPONSE_BODY_ATTRIBUTE])),
    ).toMatchObject({ id: "m1", subject: "Hi" });
    expect(JSON.stringify(spans)).not.toContain("locator-secret");
    expect(JSON.stringify(spans)).not.toContain("$expand");
  });

  it("templates each call site: folders, actions, drive items and uploads", async () => {
    on("GET", "/me/mailFolders/inbox/messages", { json: { value: [] } });
    on("POST", "/me/events/e1/tentativelyAccept", { status: 202 });
    on("GET", "/drives/D1/items/I1", {
      json: { id: "I1", name: "a.bin", file: { mimeType: "application/x" } },
    });
    on("GET", "/drives/D1/items/I1/content", {
      status: 302,
      headers: { Location: `${base}/download/a.bin?tempauth=token` },
    });
    routes.push((request) =>
      request.path === "/download/a.bin"
        ? { bytes: Buffer.from("PK") }
        : undefined,
    );
    on("PUT", "/me/drive/root:/out.txt:/content", {
      status: 201,
      json: { id: "N1", name: "out.txt" },
    });
    const graph = session();
    await graph.mail!.search!({ folder: "inbox", limit: 5 }, ctx);
    await graph.calendar!.respond!(
      { event_id: "e1", response: "tentative" },
      ctx,
    );
    await graph.drive!.download!({ file_id: "D1/I1" }, ctx);
    await graph.drive!.upload!(
      { name: "out.txt", bytes: new TextEncoder().encode("hi") },
      ctx,
    );
    expect(spans.map((span) => span.name)).toEqual([
      "GET /me/mailFolders/{mailFolder-id}/messages",
      "POST /me/events/{event-id}/tentativelyAccept",
      "GET /drives/{drive-id}/items/{driveItem-id}",
      "GET /drives/{drive-id}/items/{driveItem-id}/content",
      "GET",
      "PUT /me/drive/root:/{filename}:/content",
    ]);
    expect(
      spans.map((span) => span.attributes["http.response.status_code"]),
    ).toEqual([200, 202, 200, 302, 200, 201]);
    // Bytes are never recorded, only JSON.
    expect(spans[4]!.attributes[RESPONSE_BODY_ATTRIBUTE]).toBeUndefined();
    expect(JSON.stringify(spans)).not.toContain("tempauth");
  });

  it("records each retried attempt, and a failure as an error span", async () => {
    let calls = 0;
    on("GET", "/me/events/e1", () =>
      ++calls < 2
        ? {
            status: 429,
            headers: { "Retry-After": "1" },
            json: { error: { code: "TooManyRequests" } },
          }
        : { status: 404, json: { error: { code: "ErrorItemNotFound" } } },
    );
    await expect(
      session().calendar!.read!({ event_id: "e1" }, ctx),
    ).rejects.toMatchObject({ productivity: { code: "not_found" } });
    expect(
      spans.map((span) => [
        span.name,
        span.attributes["http.response.status_code"],
        span.attributes["error.type"],
        span.status?.code,
      ]),
    ).toEqual([
      ["GET /me/events/{event-id}", 429, "429", 2],
      ["GET /me/events/{event-id}", 404, "404", 2],
    ]);
  });
});

describe("Microsoft productivity provider: through the host", () => {
  it("loads as the companion beside Recipes and serves mail with handles through a host's fetch hook", async () => {
    const recipeDir = mkdtempSync(
      join(tmpdir(), "productivity-microsoft-recipe-"),
    );
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "r",
        version: "0.1.0",
        type: "module",
        pi: {
          productivity: [
            { provider: "microsoft", tools: { mail: ["search", "read"] } },
          ],
        },
      }),
    );
    const seen: string[] = [];
    const loaded = await loadRecipeProductivity(
      readPiPackageManifest(recipeDir).productivity!,
      ["mail"],
      {
        recipeDir,
        env: {},
        cwd: recipeDir,
        // A host's request hook: it would attach the person's credential here.
        fetch: (url, init) => {
          seen.push(String(init.headers?.Authorization));
          return fetch(
            url.replace("https://graph.microsoft.com", base),
            init as RequestInit,
          );
        },
      },
    );
    on("GET", "/me/messages", {
      json: { value: [{ id: "AAMk-1", subject: "Hi" }] },
    });
    const pi = createMockExtensionAPI();
    await loaded.extension!.factory(pi as never);
    const result = (await pi.tools
      .get("mail")!
      .execute(
        "c",
        { command: "search" } as never,
        undefined,
        undefined,
        undefined as never,
      )) as {
      details: { messages: Array<{ message: string; subject: string }> };
    };
    expect(result.details.messages).toEqual([
      { message: expect.stringMatching(/^msg_/), subject: "Hi" },
    ]);
    expect(seen).toEqual(["Bearer introspection-egress"]);
  });
});
