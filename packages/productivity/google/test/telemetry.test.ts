import {
  type Attributes,
  type Span,
  type SpanOptions,
  type SpanStatus,
  type Tracer,
} from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import {
  OPERATION_ID_ATTRIBUTE,
  RESPONSE_BODY_ATTRIBUTE,
} from "@introspection-ai/recipes/productivity";

import { createGoogleProductivitySession } from "../src/index.js";
import { fakeGoogle, googleError, json, fakeHttp } from "./fake-google.js";

interface RecordedSpan {
  name: string;
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
          json({
            id: "e1",
            summary: "Sync",
            start: { timeZone: "UTC" },
          }),
        ],
      ],
    ]);
    const withFake = await createGoogleProductivitySession({
      config: CONFIG,
      env: { INTROSPECTION_TASK_ID: "task-1" },
      cwd: process.cwd(),
      http: fakeHttp(rest.fetchImpl, { tracer }),
    });
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
});
