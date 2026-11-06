import {
  type Attributes,
  type Span,
  SpanKind,
  type SpanOptions,
  type SpanStatus,
  type Tracer,
} from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { createGoogleProductivitySession } from "../src/index.js";
import {
  httpRequestSpan,
  httpResponseAttributes,
  MAX_RECORDED_BODY_BYTES,
  mcpResultAttributes,
  OPERATION_ID_ATTRIBUTE,
  RESPONSE_BODY_ATTRIBUTE,
  toolCallSpan,
} from "../src/telemetry.js";
import {
  fakeGoogle,
  googleError,
  json,
  recordingSleep,
} from "./fake-google.js";
import { fakeTools, httpFailure, structured } from "./fake-tools.js";

interface RecordedSpan {
  name: string;
  kind?: number;
  attributes: Attributes;
  status?: SpanStatus;
  ended: boolean;
}

/** A tracer that keeps every span it starts. */
function recordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer = {
    startSpan(name: string, options?: SpanOptions) {
      const recorded: RecordedSpan = {
        name,
        ...(options?.kind !== undefined ? { kind: options.kind } : {}),
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
    startActiveSpan(
      name: string,
      options: SpanOptions,
      fn: (span: Span) => unknown,
    ) {
      return fn(tracer.startSpan(name, options));
    },
  };
  return { tracer: tracer as unknown as Tracer, spans };
}

const CONFIG = {
  provider: "google",
  tools: {
    mail: ["search", "read"],
    calendar: ["list", "read"],
    drive: ["read", "download"],
  },
} as const;

describe("request span attributes", () => {
  it("names a REST span after the method and the discovery path template, recording no path or query", () => {
    expect(
      httpRequestSpan({
        method: "GET",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=full&q=secret",
        template: "/gmail/v1/users/{userId}/messages/{id}",
        operation: "gmail.users.messages.get",
      }),
    ).toEqual({
      name: "GET /gmail/v1/users/{userId}/messages/{id}",
      attributes: {
        "http.request.method": "GET",
        "server.address": "gmail.googleapis.com",
        "server.port": 443,
        "url.template": "/gmail/v1/users/{userId}/messages/{id}",
        [OPERATION_ID_ATTRIBUTE]: "gmail.users.messages.get",
      },
    });
  });

  it("records a JSON body up to the cap, and only its size above it", () => {
    expect(httpResponseAttributes(200, '{"id":"m1"}')).toEqual({
      "http.response.status_code": 200,
      "http.response.body.size": 11,
      [RESPONSE_BODY_ATTRIBUTE]: '{"id":"m1"}',
    });
    expect(
      httpResponseAttributes(200, "x".repeat(MAX_RECORDED_BODY_BYTES + 1)),
    ).toEqual({
      "http.response.status_code": 200,
      "http.response.body.size": MAX_RECORDED_BODY_BYTES + 1,
    });
    expect(httpResponseAttributes(403)).toEqual({
      "http.response.status_code": 403,
      "error.type": "403",
    });
  });

  it("names an MCP tool call span after the server and tool, and records the result", () => {
    expect(toolCallSpan({ server: "gmail", tool: "get_message" })).toEqual({
      name: "gmail/get_message",
      attributes: {
        "mcp.server.id": "gmail",
        "mcp.tool.name": "get_message",
      },
    });
    const result = { content: [{ type: "text", text: "no" }], isError: true };
    expect(mcpResultAttributes(result)).toEqual({
      "error.type": "tool_error",
      "http.response.body.size": JSON.stringify(result).length,
      [RESPONSE_BODY_ATTRIBUTE]: JSON.stringify(result),
    });
  });
});

describe("request spans from a session", () => {
  it("records one span per REST request, with its operation, status and body, never the bearer", async () => {
    const { tracer, spans } = recordingTracer();
    const rest = fakeGoogle([
      [
        "GET",
        /\/drive\/v3\/files\/f1$/,
        (call) =>
          call.url.searchParams.get("alt") === "media"
            ? new Response("PK", {
                headers: { "Content-Type": "application/zip" },
              })
            : json({ id: "f1", name: "a.zip", mimeType: "application/zip" }),
      ],
      [
        "GET",
        /\/calendars\/primary\/events\/e1$/,
        [
          googleError(429, "rateLimitExceeded"),
          json({ id: "e1", summary: "Sync" }),
        ],
      ],
    ]);
    const withFake = await createGoogleProductivitySession(
      {
        config: CONFIG,
        env: { INTROSPECTION_TASK_ID: "task-1" },
        cwd: process.cwd(),
        fetch: rest.fetchImpl,
      },
      { tracer, sleep: recordingSleep().sleep },
    );
    const file = await withFake.drive.download({ file_id: "f1" });
    expect(Buffer.from(file.bytes).toString()).toBe("PK");
    await withFake.calendar.read({ event_id: "e1" });

    expect(
      spans.map((span) => [
        span.name,
        span.attributes[OPERATION_ID_ATTRIBUTE],
        span.attributes["http.response.status_code"],
        span.ended,
      ]),
    ).toEqual([
      ["GET /drive/v3/files/{fileId}", "drive.files.get", 200, true],
      ["GET /drive/v3/files/{fileId}", "drive.files.get", 200, true],
      [
        "GET /calendar/v3/calendars/{calendarId}/events/{eventId}",
        "calendar.events.get",
        429,
        true,
      ],
      [
        "GET /calendar/v3/calendars/{calendarId}/events/{eventId}",
        "calendar.events.get",
        200,
        true,
      ],
    ]);
    expect(
      JSON.parse(String(spans[0]!.attributes[RESPONSE_BODY_ATTRIBUTE])),
    ).toEqual({ id: "f1", name: "a.zip", mimeType: "application/zip" });
    // Bytes are never recorded, only JSON.
    expect(spans[1]!.attributes[RESPONSE_BODY_ATTRIBUTE]).toBeUndefined();
    expect(spans[2]!.status?.code).toBe(2);
    expect(JSON.stringify(spans)).not.toContain("introspection-egress");
    expect(JSON.stringify(spans)).not.toContain("alt=media");
  });

  it("records one internal span per MCP tool call through Pi, with the tool's result and no wire attributes", async () => {
    const { tracer, spans } = recordingTracer();
    const pi = fakeTools({
      mcp__gmail__get_message: structured({
        message: { id: "m1", threadId: "t1", snippet: "hello" },
      }),
      mcp__calendar__get_event: httpFailure(500),
    });
    const google = await createGoogleProductivitySession(
      {
        config: { provider: "google", tools: { mail: ["read"] } },
        env: { INTROSPECTION_TASK_ID: "task-1" },
        cwd: process.cwd(),
        fetch: fakeGoogle([["GET", /\/labels$/, () => json({ labels: [] })]])
          .fetchImpl,
      },
      { tracer, sleep: recordingSleep().sleep },
    );
    await google.mail.read({ message_id: "m1" }, pi.ctx);
    await expect(
      google.calendar.read({ event_id: "e1" }, pi.ctx),
    ).rejects.toMatchObject({ productivity: { code: "provider_error" } });

    const calls = spans.filter((span) => span.kind === SpanKind.INTERNAL);
    expect(calls.map((span) => span.name)).toEqual([
      "gmail/get_message",
      "calendar/get_event",
    ]);
    expect(calls[0]!.attributes).toMatchObject({
      "mcp.server.id": "gmail",
      "mcp.tool.name": "get_message",
    });
    // The request on the wire is the runtime's `tools/call` span, not this one.
    expect(calls[0]!.attributes["mcp.method.name"]).toBeUndefined();
    expect(calls[0]!.attributes["gen_ai.operation.name"]).toBeUndefined();
    expect(
      JSON.parse(String(calls[0]!.attributes[RESPONSE_BODY_ATTRIBUTE])),
    ).toMatchObject({
      structuredContent: { message: { id: "m1" } },
    });
    expect(calls[1]!.attributes).toMatchObject({ "error.type": "call_failed" });
    expect(calls[1]!.attributes[RESPONSE_BODY_ATTRIBUTE]).toBeUndefined();
    expect(calls[1]!.status?.code).toBe(2);
    expect(spans.every((span) => span.ended)).toBe(true);
  });
});
