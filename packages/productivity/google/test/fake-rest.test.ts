import { describe, expect, it } from "vitest";

import {
  composeRawMessage,
  decodeBase64Url,
  decodeEncodedWords,
  DRIVE_EXPORT_LIMIT_BYTES,
  createGoogleProductivitySession,
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

async function backend(
  routes: Array<[string, RegExp, FakeHandler | Response[]]>,
) {
  const fake = fakeGoogle(routes);
  const session = await createGoogleProductivitySession(
    {
      config: CONFIG,
      env: { INTROSPECTION_TASK_ID: "t" },
      cwd: process.cwd(),
      fetch: fake.fetchImpl,
    },
    { sleep: recordingSleep().sleep },
  );
  return { calls: fake.calls, backend: session };
}

describe("calendar commands the emulator lacks (events.get, events.patch)", () => {
  it("reads an event with its zone, attendee responses, meeting link and text body", async () => {
    const { backend: b, calls } = await backend([
      ["GET", /\/calendars\/primary\/events\/e1$/, () => json(EVENT)],
    ]);
    const event = await b.calendar.read({ event_id: "e1" });
    expect(event).toMatchObject({
      title: "Review",
      start: "2025-11-10T10:00:00+01:00",
      time_zone: "Europe/Paris",
      online_meeting_url: "https://meet.google.com/abc",
      organizer: { email: "grace@example.com" },
      response: "none",
      body: { content_type: "html", content: "<p>Agenda: <b>roadmap</b></p>" },
    });
    expect(event.attendees!.map((a) => [a.email, a.response])).toEqual([
      ["grace@example.com", "organizer"],
      ["person@example.com", "none"],
      ["alan@example.com", "declined"],
    ]);
    expect(calls[0]!.url.host).toBe("www.googleapis.com");
    expect(calls[0]!.url.pathname).toBe(
      "/calendar/v3/calendars/primary/events/e1",
    );
  });

  it("shows an event without its own zone in its calendar's zone, on read as on list", async () => {
    const team = "team@group.calendar.google.com";
    const zoneless = {
      id: "e2",
      summary: "Standup",
      start: { dateTime: "2025-11-10T10:00:00+01:00" },
      end: { dateTime: "2025-11-10T10:15:00+01:00" },
    };
    const { backend: b, calls } = await backend([
      [
        "GET",
        /\/users\/me\/calendarList$/,
        () => json({ items: [{ id: team, summary: "Team" }] }),
      ],
      [
        "GET",
        /\/events$/,
        () => json({ items: [zoneless], timeZone: "Europe/Paris" }),
      ],
      ["GET", /\/events\/e2$/, () => json(zoneless)],
      ["GET", /\/calendars\/[^/]+$/, () => json({ timeZone: "Europe/Paris" })],
    ]);
    const listed = await b.calendar.list({
      calendar: "Team",
      from: "2025-11-10T00:00:00Z",
      to: "2025-11-11T00:00:00Z",
      limit: 5,
    });
    expect(listed.events[0]!.time_zone).toBe("Europe/Paris");
    const read = await b.calendar.read({ event_id: listed.events[0]!.id });
    await b.calendar.read({ event_id: listed.events[0]!.id });
    expect(read.time_zone).toBe("Europe/Paris");
    // The calendar's zone is read once per session.
    expect(
      calls.filter((call) =>
        call.url.pathname.endsWith(encodeURIComponent(team)),
      ).length,
    ).toBe(1);
  });

  it("keeps a listed event's calendar for every later command", async () => {
    const team = "team#x@group.calendar.google.com";
    const teamPath = `/calendar/v3/calendars/${encodeURIComponent(team)}/events`;
    const { backend: b, calls } = await backend([
      [
        "GET",
        /\/users\/me\/calendarList$/,
        () => json({ items: [{ id: team, summary: "Team" }] }),
      ],
      ["GET", /\/events$/, () => json({ items: [EVENT] })],
      ["GET", /\/events\/e1$/, () => json(EVENT)],
      ["PATCH", /\/events\/e1$/, () => json(EVENT)],
      ["DELETE", /\/events\/e1$/, () => new Response(null, { status: 204 })],
    ]);
    const listed = await b.calendar.list({
      from: "2025-11-10T00:00:00Z",
      to: "2025-11-11T00:00:00Z",
      calendar: "Team",
      limit: 10,
    });
    const id = listed.events[0]!.id;
    expect(id).not.toBe("e1");
    expect((await b.calendar.read({ event_id: id })).id).toBe(id);
    expect((await b.calendar.update({ event_id: id, title: "x" })).id).toBe(id);
    await b.calendar.respond({ event_id: id, response: "accept" });
    await b.calendar.cancel({ event_id: id });
    expect(calls.slice(1).map((call) => call.url.pathname)).toEqual([
      teamPath,
      ...Array<string>(5).fill(`${teamPath}/e1`),
    ]);
  });

  it("updates only the fields given, notifying attendees", async () => {
    const { backend: b, calls } = await backend([
      [
        "PATCH",
        /\/events\/e1$/,
        () => json({ ...EVENT, summary: "Review (moved)" }),
      ],
    ]);
    await b.calendar.update({
      event_id: "e1",
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
    const { backend: b, calls } = await backend([
      ["POST", /\/events$/, () => json(EVENT)],
    ]);
    await b.calendar.create({
      title: "x",
      start: "2025-11-10T10:00:00",
      end: "2025-11-10T11:00:00",
      time_zone: "Europe/Paris",
      online_meeting: true,
    });
    expect(calls[0]!.url.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(bodyJson(calls[0]!)).toMatchObject({
      start: { dateTime: "2025-11-10T10:00:00", timeZone: "Europe/Paris" },
      conferenceData: {
        createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } },
      },
    });
  });

  it("responds by setting only the person's own responseStatus", async () => {
    const { backend: b, calls } = await backend([
      ["GET", /\/events\/e1$/, () => json(EVENT)],
      ["PATCH", /\/events\/e1$/, () => json(EVENT)],
    ]);
    await b.calendar.respond({
      event_id: "e1",
      response: "tentative",
      comment: "may be late",
    });
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
    const { backend: b, calls } = await backend([
      [
        "GET",
        /\/events\/e1$/,
        () => json({ ...EVENT, attendees: [EVENT.attendees[0]] }),
      ],
    ]);
    await expect(
      b.calendar.respond({ event_id: "e1", response: "accept" }),
    ).rejects.toMatchObject({
      productivity: { code: "invalid_request" },
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
      const { backend: b, calls } = await backend([
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
      const read = await b.drive.read({ file_id: "n1", max_bytes: 1000 });
      expect(read).toMatchObject({
        content: {
          content_type: "text",
          content: `exported as ${entry.read.mimeType}`,
        },
        exported_as: entry.read.mimeType,
        file: { native_type: entry.nativeType },
      });
      const download = await b.drive.download({ file_id: "n1" });
      expect(download).toMatchObject({
        name: `Plan${entry.download.extension}`,
        mime_type: entry.download.mimeType,
      });
      expect(
        calls.filter((c) => c.url.pathname.endsWith("/export")),
      ).toHaveLength(2);
    });
  }

  it("reports Google's export limit instead of truncating (403 exportSizeLimitExceeded)", async () => {
    const { backend: b } = await backend([
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
    const read = await b.drive.read({ file_id: "n1", max_bytes: 1000 });
    expect(read.content).toBeUndefined();
    expect(read.unavailable).toMatch(/export limit of 10 MB/);
    await expect(b.drive.download({ file_id: "n1" })).rejects.toMatchObject({
      limitBytes: DRIVE_EXPORT_LIMIT_BYTES,
      productivity: { code: "invalid_request", status: 403 },
    });
  });

  it("refuses an export body over the limit rather than cutting it", async () => {
    const { backend: b } = await backend([
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
    await expect(b.drive.download({ file_id: "n1" })).rejects.toMatchObject({
      limitBytes: DRIVE_EXPORT_LIMIT_BYTES,
      productivity: { code: "invalid_request" },
    });
  });

  it("uploads above 5 MB through a resumable session on the upload host only", async () => {
    const big = new Uint8Array(MULTIPART_UPLOAD_LIMIT_BYTES + 1);
    const session =
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=u1";
    const { backend: b, calls } = await backend([
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
      b.drive.upload({
        name: "big.bin",
        mime_type: "application/octet-stream",
        bytes: big,
        folder_id: "f",
      }),
    ).resolves.toMatchObject({ id: "new" });
    expect(calls[0]!.url.searchParams.get("uploadType")).toBe("resumable");
    expect(bodyJson(calls[0]!)).toEqual({ name: "big.bin", parents: ["f"] });
    expect(calls[1]!.url.toString()).toBe(session);

    const elsewhere = await backend([
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
      elsewhere.backend.drive.upload({
        name: "b",
        mime_type: "x/y",
        bytes: big,
      }),
    ).rejects.toMatchObject({ productivity: { code: "provider_error" } });
    expect(elsewhere.calls).toHaveLength(1);
  });

  it("keeps mail search bounds to the second, with or without text", async () => {
    const { backend: b, calls } = await backend([
      ["GET", /\/messages$/, () => json({ messages: [] })],
    ]);
    const after = "2026-03-02T12:00:00Z";
    const before = "2026-03-02T13:30:00+01:00";
    await b.mail.search({ after, before, limit: 5 });
    await b.mail.search({ query: "plan", after, before, limit: 5 });
    const bounds = `after:${Date.parse(after) / 1000} before:${Date.parse(before) / 1000}`;
    expect(calls.map((call) => call.url.searchParams.get("q"))).toEqual([
      bounds,
      `plan ${bounds}`,
    ]);
  });

  it("builds a Drive query with escaped literals", async () => {
    const { backend: b, calls } = await backend([
      ["GET", /\/drive\/v3\/files$/, () => json({ files: [] })],
    ]);
    await b.drive.search({
      query: "Bob's plan",
      folder_id: "f1",
      modified_after: "2025-01-01T00:00:00Z",
      limit: 10,
    });
    expect(calls[0]!.url.searchParams.get("q")).toBe(
      "trashed = false and fullText contains 'Bob\\'s plan' and 'f1' in parents and modifiedTime > '2025-01-01T00:00:00Z'",
    );
  });
});

describe("mail summaries and stored bodies", () => {
  const b64 = (text: string) => Buffer.from(text).toString("base64url");
  const withAttachment = {
    id: "m1",
    threadId: "t1",
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "Subject", value: "Plan" }],
      parts: [
        {
          partId: "0",
          mimeType: "text/plain",
          body: { size: 2, data: b64("hi") },
        },
        {
          partId: "1",
          mimeType: "application/pdf",
          filename: "a.pdf",
          body: { size: 9, attachmentId: "ATT" },
        },
      ],
    },
  };

  it("searches with the part structure, so a summary knows its attachments", async () => {
    const { backend: b, calls } = await backend([
      ["GET", /\/messages$/, () => json({ messages: [{ id: "m1" }] })],
      ["GET", /\/messages\/m1$/, () => json(withAttachment)],
      ["GET", /\/labels$/, () => json({ labels: [] })],
    ]);
    const { messages } = await b.mail.search({ query: "plan", limit: 5 });
    expect(messages[0]!.has_attachments).toBe(true);
    const read = calls[1]!.url;
    expect(read.searchParams.get("format")).toBe("full");
    expect(read.searchParams.get("fields")).toContain("parts(");
    expect(read.searchParams.get("fields")).not.toContain("data");
  });

  it("asks for spam and trash only when searching either folder", async () => {
    const { backend: b, calls } = await backend([
      ["GET", /\/messages$/, () => json({ messages: [] })],
    ]);
    for (const folder of ["TRASH", "spam", "INBOX"])
      await b.mail.search({ query: "x", folder, limit: 5 });
    expect(
      calls.map((call) => [
        call.url.searchParams.get("labelIds"),
        call.url.searchParams.get("includeSpamTrash"),
      ]),
    ).toEqual([
      ["TRASH", "true"],
      ["SPAM", "true"],
      ["INBOX", null],
    ]);
  });

  const stored = (size: number) => ({
    id: "m2",
    threadId: "t1",
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "Subject", value: "Long" }],
      body: { size, attachmentId: "BODY" },
    },
  });

  it("fetches a body Gmail stores apart from the message", async () => {
    const { backend: b } = await backend([
      ["GET", /\/messages\/m2$/, () => json(stored(5))],
      ["GET", /\/attachments\/BODY$/, () => json({ data: b64("hello") })],
      ["GET", /\/labels$/, () => json({ labels: [] })],
    ]);
    const read = await b.mail.read({ message_id: "m2" });
    expect(read.messages[0]!.body?.content).toBe("hello");
    expect(read.unavailable).toBeUndefined();
  });

  it("says so when a stored body is too large or cannot be fetched", async () => {
    const large = await backend([
      ["GET", /\/messages\/m2$/, () => json(stored(6 * 1024 * 1024))],
      ["GET", /\/labels$/, () => json({ labels: [] })],
    ]);
    const tooLarge = await large.backend.mail.read({ message_id: "m2" });
    expect(tooLarge.messages[0]!.body?.content).toBe("");
    expect(tooLarge.unavailable).toContain("larger than 5 MB");
    expect(
      large.calls.some((c) => c.url.pathname.includes("/attachments/")),
    ).toBe(false);

    const failing = await backend([
      ["GET", /\/messages\/m2$/, () => json(stored(5))],
      ["GET", /\/attachments\/BODY$/, () => googleError(404, "notFound")],
      ["GET", /\/labels$/, () => json({ labels: [] })],
    ]);
    const missing = await failing.backend.mail.read({ message_id: "m2" });
    expect(missing.unavailable).toContain("could not be read");
  });
});

describe("mail parsing", () => {
  const b64 = (text: string, encoding: BufferEncoding = "utf8") =>
    Buffer.from(text, encoding).toString("base64url");

  /** An HTML body beside an attachment, or an attached message, that holds text/plain. */
  const htmlBesideText = (enclosing: {
    mimeType: string;
    filename?: string;
  }) => ({
    mimeType: "multipart/mixed",
    parts: [
      {
        partId: "0",
        mimeType: "text/html",
        body: { data: b64("<p>body</p>") },
      },
      {
        partId: "1",
        ...enclosing,
        parts: [
          {
            partId: "1.0",
            mimeType: "text/plain",
            body: { data: b64("inner") },
          },
        ],
      },
    ],
  });

  for (const [name, enclosing] of [
    [
      "a multipart attachment",
      { mimeType: "multipart/mixed", filename: "a.zip" },
    ],
    ["an attached message", { mimeType: "message/rfc822" }],
  ] as const) {
    it(`reads the body around ${name}, never the text inside it`, async () => {
      expect(parseMailPayload(htmlBesideText(enclosing)).body).toEqual({
        content_type: "html",
        content: "<p>body</p>",
      });
      const { backend: b, calls } = await backend([
        [
          "GET",
          /\/drafts\/d1$/,
          () =>
            json({
              id: "d1",
              message: { id: "m1", payload: htmlBesideText(enclosing) },
            }),
        ],
        [
          "PUT",
          /\/drafts\/d1$/,
          () => json({ id: "d1", message: { id: "m1" } }),
        ],
      ]);
      await b.mail.updateDraft({
        draft_id: "d1",
        to: ["a@example.com"],
        subject: "Plan",
      });
      const raw = new TextDecoder().decode(
        decodeBase64Url(
          (bodyJson(calls[1]!) as { message: { raw: string } }).message.raw,
        ),
      );
      // The body is base64 encoded: the HTML body is kept as HTML, "inner" is not.
      expect(raw).toContain('Content-Type: text/html; charset="UTF-8"');
      expect(raw).toContain(Buffer.from("<p>body</p>").toString("base64"));
      expect(raw).not.toContain(Buffer.from("inner").toString("base64"));
    });
  }

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
      body: { content_type: "text", content: "café" },
      part: expect.objectContaining({ partId: "0.1" }),
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

  for (const [name, labels, headers, expected] of [
    [
      "the parent's Reply-To",
      ["INBOX"],
      [
        { name: "From", value: "Ada <ada@example.com>" },
        { name: "Reply-To", value: "Lists <list@example.com>" },
        { name: "To", value: "person@example.com, bob@example.com" },
      ],
      "list@example.com",
    ],
    [
      "the parent's From",
      ["INBOX"],
      [
        { name: "From", value: "=?UTF-8?B?w4lsaXNl?= <elise@example.com>" },
        { name: "To", value: "person@example.com, bob@example.com" },
      ],
      "elise@example.com",
    ],
    [
      "the parent's To when the person sent it",
      ["SENT"],
      [
        { name: "From", value: "person@example.com" },
        { name: "To", value: "Bob <bob@example.com>" },
      ],
      "bob@example.com",
    ],
  ] as const) {
    it(`addresses a reply with no recipients to ${name}`, async () => {
      const { backend: b, calls } = await backend([
        [
          "GET",
          /\/messages\/p1$/,
          () =>
            json({
              id: "p1",
              threadId: "t1",
              labelIds: labels,
              payload: {
                mimeType: "text/plain",
                headers: [
                  ...headers,
                  { name: "Subject", value: "Plan" },
                  { name: "Message-ID", value: "<p1@example.com>" },
                ],
              },
            }),
        ],
        [
          "POST",
          /\/drafts$/,
          () => json({ id: "d1", message: { id: "m2", threadId: "t1" } }),
        ],
      ]);
      const draft = await b.mail.draft({
        to: [],
        subject: "",
        body: "Thanks",
        reply_to_id: "p1",
      });
      expect(draft.to).toEqual([{ email: expected }]);
      const raw = new TextDecoder().decode(
        decodeBase64Url(
          (bodyJson(calls[1]!) as { message: { raw: string } }).message.raw,
        ),
      );
      expect(raw).toContain(`To: ${expected}\r\n`);
      expect(raw).toContain("Subject: Re: Plan\r\n");
    });
  }

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
