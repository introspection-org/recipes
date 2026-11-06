import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GoogleRestBackend, GoogleTransport } from "../src/index.js";
import {
  EGRESS_ENV,
  PERSON,
  type RunningEmulator,
  startGoogleEmulator,
} from "./emulator.js";

/** A multipart message: HTML only (with a tracking pixel) plus a text attachment. */
const RAW_WITH_ATTACHMENT = Buffer.from(
  [
    "From: Ada <ada@example.com>",
    `To: ${PERSON}`,
    "Subject: =?UTF-8?B?UXVhcnRlcmx5IG5vdGVzIOKAkyBkcmFmdA==?=",
    "Message-ID: <notes-1@example.com>",
    "Date: Tue, 04 Nov 2025 10:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    '<p>Hello <b>there</b> &amp; welcome.</p><img src="https://track.example.com/p.gif" width="1"><p><a href="https://example.com/q3">the Q3 plan</a></p>',
    "--b1",
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("attached notes\n").toString("base64"),
    "--b1--",
    "",
  ].join("\r\n"),
).toString("base64url");

let emulator: RunningEmulator;
let backend: GoogleRestBackend;

beforeAll(async () => {
  emulator = await startGoogleEmulator({
    users: [{ email: PERSON, name: "Person" }],
    labels: [{ id: "Label_clients", user_email: PERSON, name: "Clients" }],
    messages: [
      {
        id: "m_plain",
        thread_id: "t_plain",
        user_email: PERSON,
        from: "Grace <grace@example.com>",
        to: PERSON,
        subject: "Lunch on Friday",
        body_text: "Shall we meet at noon?",
        label_ids: ["INBOX", "UNREAD"],
        date: "2025-11-03T09:00:00.000Z",
        message_id: "<lunch-1@example.com>",
      },
      {
        id: "m_html",
        thread_id: "t_html",
        user_email: PERSON,
        raw: RAW_WITH_ATTACHMENT,
        label_ids: ["INBOX"],
        date: "2025-11-04T10:00:00.000Z",
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `m_bulk_${index}`,
        user_email: PERSON,
        from: "Newsletter <news@example.com>",
        to: PERSON,
        subject: `Digest ${index}`,
        body_text: `Issue ${index}`,
        label_ids: ["INBOX"],
        date: `2025-10-0${index + 1}T08:00:00.000Z`,
      })),
    ],
    calendars: [
      {
        id: PERSON,
        user_email: PERSON,
        summary: PERSON,
        primary: true,
        time_zone: "Europe/Paris",
      },
    ],
    calendar_events: [
      {
        id: "e_review",
        user_email: PERSON,
        calendar_id: PERSON,
        summary: "Design review",
        start_date_time: "2025-11-10T09:00:00.000Z",
        end_date_time: "2025-11-10T10:00:00.000Z",
        attendees: [
          { email: PERSON },
          { email: "grace@example.com", display_name: "Grace" },
        ],
      },
      {
        id: "e_offsite",
        user_email: PERSON,
        calendar_id: PERSON,
        summary: "Offsite",
        start_date: "2025-11-12",
        end_date: "2025-11-13",
      },
    ],
    drive_items: [
      {
        id: "f_folder",
        user_email: PERSON,
        name: "Plans",
        mime_type: "application/vnd.google-apps.folder",
      },
      {
        id: "f_text",
        user_email: PERSON,
        name: "plan.md",
        mime_type: "text/markdown",
        parent_ids: ["f_folder"],
        data: "# Plan\n\nShip it.",
      },
      {
        id: "f_pdf",
        user_email: PERSON,
        name: "scan.pdf",
        mime_type: "application/pdf",
        parent_ids: ["f_folder"],
        data: "%PDF-1.4",
      },
    ],
  });
  backend = new GoogleRestBackend(
    new GoogleTransport({ env: EGRESS_ENV, endpoints: emulator.endpoints }),
  );
});

afterAll(async () => {
  await emulator?.close();
});

describe("mail, against the Google emulator", () => {
  it("searches with neutral filters, label names and nextPageToken paging", async () => {
    const unread = await backend.mailSearch({ unread: true, folder: "inbox" });
    expect(unread.items.map((m) => m.id)).toEqual(["m_plain"]);
    expect(unread.items[0]).toMatchObject({
      from: "Grace <grace@example.com>",
      to: [PERSON],
      subject: "Lunch on Friday",
      labels: expect.arrayContaining(["INBOX", "UNREAD"]),
      unread: true,
    });

    const first = await backend.mailSearch({
      from: "news@example.com",
      limit: 2,
    });
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();
    const second = await backend.mailSearch({
      from: "news@example.com",
      limit: 10,
      cursor: first.next_cursor,
    });
    expect(second.items).toHaveLength(3);
    expect(second.next_cursor).toBeUndefined();
    const all = [...first.items, ...second.items].map((m) => m.id);
    expect(new Set(all).size).toBe(5);

    const dated = await backend.mailSearch({
      from: "news@example.com",
      after: "2025-10-03T00:00:00Z",
    });
    expect(dated.items.map((m) => m.subject).sort()).toEqual([
      "Digest 2",
      "Digest 3",
      "Digest 4",
    ]);
  });

  it("reads HTML mail as text without remote content, and lists its attachment", async () => {
    const message = await backend.mailRead("m_html");
    expect(message.subject).toBe("Quarterly notes – draft");
    expect(message.body.from_html).toBe(true);
    expect(message.body.text).toContain("Hello there & welcome.");
    expect(message.body.text).toContain("the Q3 plan <https://example.com/q3>");
    expect(message.body.text).not.toContain("track.example.com");
    expect(message.attachments).toEqual([
      expect.objectContaining({
        filename: "notes.txt",
        mime_type: "text/plain",
      }),
    ]);

    const file = await backend.mailFetchAttachment(message.attachments[0]!.id);
    expect(file.filename).toBe("notes.txt");
    expect(Buffer.from(file.data).toString("utf8")).toBe("attached notes\n");

    const thread = await backend.mailReadThread("t_plain");
    expect(thread.messages.map((m) => m.body.text)).toEqual([
      "Shall we meet at noon?",
    ]);
  });

  it("drafts a reply, updates it, sends it, and reads the sent message back", async () => {
    const draft = await backend.mailDraft({
      to: ["grace@example.com"],
      subject: "",
      body: "Noon works.",
      reply_to: "m_plain",
    });
    expect(draft.thread_id).toBe("t_plain");

    await backend.mailUpdateDraft(draft.draft_id, {
      body: "Noon works. **See you**.",
    });

    const sent = await backend.mailSend(draft.draft_id);
    const read = await backend.mailRead(sent.message_id);
    expect(read).toMatchObject({
      subject: "Re: Lunch on Friday",
      to: ["grace@example.com"],
      labels: expect.arrayContaining(["SENT"]),
    });
    expect(read.body.text.trim()).toBe("Noon works. **See you**.");
    expect(read.thread_id).toBe("t_plain");
  });

  it("labels by name and moves to a label out of the inbox", async () => {
    const labelled = await backend.mailLabel("m_plain", {
      add: ["clients"],
      remove: ["UNREAD"],
    });
    expect(labelled.labels).toEqual(
      expect.arrayContaining(["Clients", "INBOX"]),
    );
    expect(labelled.unread).toBe(false);

    const moved = await backend.mailMove("m_html", "Clients");
    expect(moved.labels).toContain("Clients");
    expect(moved.labels).not.toContain("INBOX");

    await expect(
      backend.mailLabel("m_plain", { add: ["No such label"] }),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});

describe("calendar, against the Google emulator", () => {
  it("lists events in a window with their zones, all-day events as dates", async () => {
    const page = await backend.calendarList({
      from: "2025-11-01T00:00:00Z",
      to: "2025-11-30T00:00:00Z",
    });
    const byId = Object.fromEntries(
      page.items.map((event) => [event.id, event]),
    );
    expect(byId.e_review).toMatchObject({
      title: "Design review",
      start: { date_time: expect.stringMatching(/^2025-11-10T09:00:00/) },
      attendees: expect.arrayContaining([
        expect.objectContaining({ email: "grace@example.com", name: "Grace" }),
      ]),
    });
    expect(byId.e_offsite?.start).toEqual({ date: "2025-11-12" });
  });

  it("creates an event, sees it busy, then cancels it", async () => {
    const created = await backend.calendarCreate({
      title: "1:1",
      start: "2025-11-20T15:00:00+01:00",
      end: "2025-11-20T15:30:00+01:00",
      time_zone: "Europe/Paris",
      attendees: ["grace@example.com"],
      location: "Room 2",
    });
    expect(created).toMatchObject({ title: "1:1", location: "Room 2" });

    const busy = await backend.calendarFreeBusy({
      attendees: [PERSON],
      from: "2025-11-20T00:00:00Z",
      to: "2025-11-21T00:00:00Z",
    });
    expect(busy[0]!.busy).toHaveLength(1);
    expect(Date.parse(busy[0]!.busy[0]!.start)).toBe(
      Date.parse("2025-11-20T14:00:00Z"),
    );

    await backend.calendarCancel(created.id);
    const after = await backend.calendarFreeBusy({
      attendees: [PERSON],
      from: "2025-11-20T00:00:00Z",
      to: "2025-11-21T00:00:00Z",
    });
    expect(after[0]!.busy).toEqual([]);
  });

  it("refuses an event without an IANA zone before calling Google", async () => {
    await expect(
      backend.calendarCreate({
        title: "x",
        start: "2025-11-20T15:00:00Z",
        end: "2025-11-20T16:00:00Z",
        time_zone: "CET+1",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("drive, against the Google emulator", () => {
  it("searches a folder, pages, and reads a text file", async () => {
    const first = await backend.driveSearch({ folder: "f_folder", limit: 1 });
    expect(first.items).toHaveLength(1);
    const second = await backend.driveSearch({
      folder: "f_folder",
      cursor: first.next_cursor,
    });
    expect([...first.items, ...second.items].map((f) => f.name).sort()).toEqual(
      ["plan.md", "scan.pdf"],
    );

    const read = await backend.driveRead("f_text");
    expect(read).toMatchObject({
      text: "# Plan\n\nShip it.",
      truncated: false,
    });
    expect(read.file).toMatchObject({
      name: "plan.md",
      mime_type: "text/markdown",
    });

    const binary = await backend.driveRead("f_pdf");
    expect(binary).toMatchObject({ binary: true, text: "" });
  });

  it("uploads a file into a folder and downloads the same bytes", async () => {
    const data = new Uint8Array([0, 1, 2, 250, 255]);
    const uploaded = await backend.driveUpload({
      name: "result.bin",
      mime_type: "application/octet-stream",
      data,
      folder: "f_folder",
    });
    expect(uploaded).toMatchObject({ name: "result.bin" });

    const downloaded = await backend.driveDownload(uploaded.id);
    expect(downloaded.filename).toBe("result.bin");
    expect([...downloaded.data]).toEqual([...data]);
  });

  it("maps a missing file to not_found", async () => {
    await expect(backend.driveRead("f_missing")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
