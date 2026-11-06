import { describe, expect, it } from "vitest";

import {
  composeRawMessage,
  decodeBase64Url,
  decodeEncodedWords,
  DRIVE_EXPORT_LIMIT_BYTES,
  GoogleRestBackend,
  GoogleTransport,
  htmlToText,
  MULTIPART_UPLOAD_LIMIT_BYTES,
  NATIVE_EXPORTS,
  parseMailPayload,
} from "../src/index.js";
import {
  bodyJson,
  fakeGoogle,
  type FakeHandler,
  googleError,
  json,
  recordingSleep,
} from "./fake-google.js";

const EVENT = {
  id: "e1",
  summary: "Review",
  description: "<p>Agenda: <b>roadmap</b></p>",
  start: { dateTime: "2025-11-10T10:00:00+01:00", timeZone: "Europe/Paris" },
  end: { dateTime: "2025-11-10T11:00:00+01:00", timeZone: "Europe/Paris" },
  organizer: { email: "grace@example.com" },
  attendees: [
    { email: "grace@example.com", organizer: true, responseStatus: "accepted" },
    { email: "person@example.com", self: true, responseStatus: "needsAction" },
    { email: "alan@example.com", responseStatus: "declined", comment: "away" },
  ],
  conferenceData: {
    entryPoints: [
      { entryPointType: "video", uri: "https://meet.google.com/abc" },
    ],
  },
};

function backend(routes: Array<[string, RegExp, FakeHandler | Response[]]>) {
  const fake = fakeGoogle(routes);
  return {
    calls: fake.calls,
    backend: new GoogleRestBackend(
      new GoogleTransport({
        env: { INTROSPECTION_TASK_ID: "t" },
        fetchImpl: fake.fetchImpl,
        sleep: recordingSleep().sleep,
      }),
    ),
  };
}

describe("calendar commands the emulator lacks (events.get, events.patch)", () => {
  it("reads an event with its zone, attendee responses, meeting link and text body", async () => {
    const { backend: b, calls } = backend([
      ["GET", /\/calendars\/primary\/events\/e1$/, () => json(EVENT)],
    ]);
    const event = await b.calendarRead("e1");
    expect(event).toMatchObject({
      title: "Review",
      start: {
        date_time: "2025-11-10T10:00:00+01:00",
        time_zone: "Europe/Paris",
      },
      online_meeting_url: "https://meet.google.com/abc",
      body: { text: "Agenda: roadmap", truncated: false },
    });
    expect(event.attendees.map((a) => [a.email, a.response])).toEqual([
      ["grace@example.com", "accept"],
      ["person@example.com", "none"],
      ["alan@example.com", "decline"],
    ]);
    expect(calls[0]!.url.host).toBe("www.googleapis.com");
    expect(calls[0]!.url.pathname).toBe(
      "/calendar/v3/calendars/primary/events/e1",
    );
  });

  it("updates only the fields given, notifying attendees", async () => {
    const { backend: b, calls } = backend([
      [
        "PATCH",
        /\/events\/e1$/,
        () => json({ ...EVENT, summary: "Review (moved)" }),
      ],
    ]);
    await b.calendarUpdate("e1", {
      title: "Review (moved)",
      location: "Room 4",
    });
    expect(bodyJson(calls[0]!)).toEqual({
      summary: "Review (moved)",
      location: "Room 4",
    });
    expect(calls[0]!.url.searchParams.get("sendUpdates")).toBe("all");
  });

  it("requests a Meet link with conferenceDataVersion=1", async () => {
    const { backend: b, calls } = backend([
      ["POST", /\/events$/, () => json(EVENT)],
    ]);
    await b.calendarCreate({
      title: "x",
      start: "2025-11-10T10:00:00+01:00",
      end: "2025-11-10T11:00:00+01:00",
      time_zone: "Europe/Paris",
      online_meeting: true,
    });
    expect(calls[0]!.url.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(bodyJson(calls[0]!)).toMatchObject({
      start: {
        dateTime: "2025-11-10T10:00:00+01:00",
        timeZone: "Europe/Paris",
      },
      conferenceData: {
        createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } },
      },
    });
  });

  it("responds by setting only the person's own responseStatus", async () => {
    const { backend: b, calls } = backend([
      ["GET", /\/events\/e1$/, () => json(EVENT)],
      ["PATCH", /\/events\/e1$/, () => json(EVENT)],
    ]);
    await b.calendarRespond("e1", "tentative", "may be late");
    const patch = bodyJson(calls[1]!) as {
      attendees: Array<Record<string, unknown>>;
    };
    expect(Object.keys(patch)).toEqual(["attendees"]);
    expect(patch.attendees).toEqual([
      EVENT.attendees[0],
      {
        ...EVENT.attendees[1],
        responseStatus: "tentative",
        comment: "may be late",
      },
      EVENT.attendees[2],
    ]);
  });

  it("refuses to respond to an event the person is not invited to", async () => {
    const { backend: b, calls } = backend([
      [
        "GET",
        /\/events\/e1$/,
        () => json({ ...EVENT, attendees: [EVENT.attendees[0]] }),
      ],
    ]);
    await expect(
      b.calendarRespond("e1", "accept", undefined),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("drive exports (the emulator has no files.export)", () => {
  it("exports each native type per the table, for read and for download", () => {
    expect(
      NATIVE_EXPORTS.map((e) => [
        e.kind,
        e.read.mimeType,
        e.download.extension,
      ]),
    ).toEqual([
      ["document", "text/plain", ".docx"],
      ["spreadsheet", "text/csv", ".xlsx"],
      ["presentation", "text/plain", ".pptx"],
    ]);
  });

  for (const entry of NATIVE_EXPORTS) {
    it(`reads and downloads a ${entry.kind}`, async () => {
      const { backend: b, calls } = backend([
        [
          "GET",
          /\/files\/n1$/,
          () => json({ id: "n1", name: "Plan", mimeType: entry.nativeType }),
        ],
        [
          "GET",
          /\/files\/n1\/export$/,
          (call) =>
            new Response(
              `exported as ${call.url.searchParams.get("mimeType")}`,
            ),
        ],
      ]);
      const read = await b.driveRead("n1");
      expect(read).toMatchObject({
        text: `exported as ${entry.read.mimeType}`,
        exported_as: entry.read.mimeType,
        file: { native: entry.kind },
      });
      const download = await b.driveDownload("n1");
      expect(download).toMatchObject({
        filename: `Plan${entry.download.extension}`,
        mime_type: entry.download.mimeType,
      });
      expect(
        calls.filter((c) => c.url.pathname.endsWith("/export")),
      ).toHaveLength(2);
    });
  }

  it("reports Google's export limit instead of truncating (403 exportSizeLimitExceeded)", async () => {
    const { backend: b } = backend([
      [
        "GET",
        /\/files\/n1$/,
        () =>
          json({
            id: "n1",
            name: "Big",
            mimeType: NATIVE_EXPORTS[0]!.nativeType,
          }),
      ],
      ["GET", /\/export$/, () => googleError(403, "exportSizeLimitExceeded")],
    ]);
    await expect(b.driveRead("n1")).rejects.toMatchObject({
      code: "export_too_large",
      limitBytes: DRIVE_EXPORT_LIMIT_BYTES,
    });
  });

  it("refuses an export body over the limit rather than cutting it", async () => {
    const { backend: b } = backend([
      [
        "GET",
        /\/files\/n1$/,
        () =>
          json({
            id: "n1",
            name: "Big",
            mimeType: NATIVE_EXPORTS[0]!.nativeType,
          }),
      ],
      [
        "GET",
        /\/export$/,
        () =>
          new Response("x", {
            headers: { "Content-Length": String(DRIVE_EXPORT_LIMIT_BYTES + 1) },
          }),
      ],
    ]);
    await expect(b.driveDownload("n1")).rejects.toMatchObject({
      code: "export_too_large",
    });
  });

  it("uploads above 5 MB through a resumable session on the upload host only", async () => {
    const big = new Uint8Array(MULTIPART_UPLOAD_LIMIT_BYTES + 1);
    const session =
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=u1";
    const { backend: b, calls } = backend([
      [
        "POST",
        /\/upload\/drive\/v3\/files$/,
        () => new Response(null, { headers: { Location: session } }),
      ],
      [
        "PUT",
        /\/upload\/drive\/v3\/files$/,
        () =>
          json({
            id: "new",
            name: "big.bin",
            mimeType: "application/octet-stream",
          }),
      ],
    ]);
    await expect(
      b.driveUpload({
        name: "big.bin",
        mime_type: "application/octet-stream",
        data: big,
        folder: "f",
      }),
    ).resolves.toMatchObject({ id: "new" });
    expect(calls[0]!.url.searchParams.get("uploadType")).toBe("resumable");
    expect(bodyJson(calls[0]!)).toEqual({ name: "big.bin", parents: ["f"] });
    expect(calls[1]!.url.toString()).toBe(session);

    const elsewhere = backend([
      [
        "POST",
        /\/upload\/drive\/v3\/files$/,
        () =>
          new Response(null, {
            headers: { Location: "https://evil.example/x" },
          }),
      ],
    ]);
    await expect(
      elsewhere.backend.driveUpload({ name: "b", mime_type: "x/y", data: big }),
    ).rejects.toMatchObject({ code: "provider_error" });
    expect(elsewhere.calls).toHaveLength(1);
  });

  it("builds a Drive query with escaped literals", async () => {
    const { backend: b, calls } = backend([
      ["GET", /\/drive\/v3\/files$/, () => json({ files: [] })],
    ]);
    await b.driveSearch({
      query: "Bob's plan",
      folder: "f1",
      modified_after: "2025-01-01T00:00:00Z",
    });
    expect(calls[0]!.url.searchParams.get("q")).toBe(
      "trashed = false and fullText contains 'Bob\\'s plan' and 'f1' in parents and modifiedTime > '2025-01-01T00:00:00Z'",
    );
  });
});

describe("mail parsing", () => {
  const b64 = (text: string, encoding: BufferEncoding = "utf8") =>
    Buffer.from(text, encoding).toString("base64url");

  it("prefers text/plain in a nested multipart, decoding its charset", () => {
    const parsed = parseMailPayload({
      mimeType: "multipart/mixed",
      parts: [
        {
          partId: "0",
          mimeType: "multipart/alternative",
          parts: [
            {
              partId: "0.0",
              mimeType: "text/html",
              body: { data: b64("<p>html</p>") },
            },
            {
              partId: "0.1",
              mimeType: "text/plain",
              headers: [
                {
                  name: "Content-Type",
                  value: "text/plain; charset=ISO-8859-1",
                },
              ],
              body: {
                data: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString(
                  "base64url",
                ),
              },
            },
          ],
        },
        {
          partId: "1",
          mimeType: "application/pdf",
          filename: "a.pdf",
          body: { attachmentId: "ATT", size: 12 },
        },
      ],
    });
    expect(parsed).toEqual({
      text: "café",
      fromHtml: false,
      attachments: [
        {
          partId: "1",
          filename: "a.pdf",
          mimeType: "application/pdf",
          size: 12,
        },
      ],
    });
  });

  it("decodes RFC 2047 words and base64url", () => {
    expect(
      decodeEncodedWords("=?UTF-8?Q?Caf=C3=A9_au_lait?= =?UTF-8?B?4pyT?="),
    ).toBe("Café au lait✓");
    expect(new TextDecoder().decode(decodeBase64Url("aGk_"))).toBe("hi?");
  });

  it("drops remote content and scripts from HTML", () => {
    const text = htmlToText(
      "<html><head><style>p{}</style></head><body><script>x()</script><p>Hi&nbsp;you</p>" +
        '<img src="https://t.example/p.gif"><iframe src="https://x.example"></iframe>' +
        "<ul><li>one</li><li>two</li></ul></body></html>",
    );
    expect(text).toBe("Hi you\n\n- one\n- two");
  });

  it("composes a draft whose headers cannot be injected", () => {
    const raw = Buffer.from(
      composeRawMessage({
        to: ["a@example.com"],
        subject: "Héllo",
        body: "**hi**",
      }),
      "base64url",
    ).toString("utf8");
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(() =>
      composeRawMessage({
        to: ["a@example.com"],
        subject: "x\r\nBcc: spy@example.com",
        body: "",
      }),
    ).toThrow(/line break/);
    expect(() =>
      composeRawMessage({
        to: ["a@example.com\nBcc: spy@example.com"],
        subject: "x",
        body: "",
      }),
    ).toThrow(/line break/);
  });
});
