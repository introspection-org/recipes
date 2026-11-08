import {
  createProductivityHttp,
  pages,
} from "@introspection-ai/recipes/productivity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createGoogleProductivitySession,
  type GoogleProductivitySession,
} from "../src/index.js";
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
let google: GoogleProductivitySession;

const ALL = {
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
  google = await createGoogleProductivitySession(
    {
      config: ALL,
      env: EGRESS_ENV,
      cwd: process.cwd(),
      http: createProductivityHttp({ provider: "google", env: EGRESS_ENV }),
      pages,
    },
    { endpoints: emulator.endpoints },
  );
});

afterAll(async () => {
  await emulator?.close();
});

describe("mail, against the Google emulator", () => {
  it("searches with neutral filters, label names and nextPageToken paging", async () => {
    const unread = await google.mail.search({
      unread: true,
      folder: "inbox",
      limit: 20,
    });
    expect(unread.messages.map((m) => m.id)).toEqual(["m_plain"]);
    expect(unread.messages[0]).toMatchObject({
      from: { email: "grace@example.com", name: "Grace" },
      to: [{ email: PERSON }],
      subject: "Lunch on Friday",
      labels: expect.arrayContaining(["INBOX", "UNREAD"]),
      unread: true,
      has_attachments: false,
    });

    const first = await google.mail.search({
      from: "news@example.com",
      limit: 2,
    });
    expect(first.messages).toHaveLength(2);
    expect(first.cursor).toBeTruthy();
    const second = await google.mail.search({
      from: "news@example.com",
      limit: 10,
      cursor: first.cursor,
    });
    expect(second.messages).toHaveLength(3);
    expect(second.cursor).toBeUndefined();
    const all = [...first.messages, ...second.messages].map((m) => m.id);
    expect(new Set(all).size).toBe(5);

    const dated = await google.mail.search({
      from: "news@example.com",
      after: "2025-10-03T00:00:00Z",
      limit: 20,
    });
    expect(dated.messages.map((m) => m.subject).sort()).toEqual([
      "Digest 2",
      "Digest 3",
      "Digest 4",
    ]);
  });

  it("reads an HTML-only message as HTML for the host, and fetches its attachment", async () => {
    const { messages } = await google.mail.read({ message_id: "m_html" });
    const message = messages[0]!;
    expect(message.subject).toBe("Quarterly notes – draft");
    expect(message.body).toEqual({
      content_type: "html",
      content: expect.stringContaining(
        "<p>Hello <b>there</b> &amp; welcome.</p>",
      ),
    });
    expect(message.has_attachments).toBe(true);
    expect(message.attachments).toEqual([
      expect.objectContaining({ name: "notes.txt", mime_type: "text/plain" }),
    ]);

    const file = await google.mail.fetchAttachment({
      message_id: "m_html",
      attachment_id: message.attachments![0]!.id,
    });
    expect(file.name).toBe("notes.txt");
    expect(Buffer.from(file.bytes).toString("utf8")).toBe("attached notes\n");

    const thread = await google.mail.read({ thread_id: "t_plain" });
    expect(thread.messages.map((m) => m.body?.content)).toEqual([
      "Shall we meet at noon?",
    ]);
  });

  it("drafts a reply, updates it, sends it, and reads the sent message back", async () => {
    const draft = await google.mail.draft({
      to: ["grace@example.com"],
      subject: "",
      body: "Noon works.",
      reply_to_id: "m_plain",
    });
    expect(draft).toMatchObject({
      thread_id: "t_plain",
      subject: "Re: Lunch on Friday",
    });

    const updated = await google.mail.updateDraft({
      draft_id: draft.id,
      body: "Noon works. **See you**.",
    });
    expect(updated.to).toEqual([{ email: "grace@example.com" }]);

    const sent = await google.mail.send({ draft_id: draft.id });
    const { messages } = await google.mail.read({
      message_id: sent.message_id!,
    });
    expect(messages[0]).toMatchObject({
      subject: "Re: Lunch on Friday",
      to: [{ email: "grace@example.com" }],
      labels: expect.arrayContaining(["SENT"]),
      thread_id: "t_plain",
    });
    expect(messages[0]!.body?.content.trim()).toBe("Noon works. **See you**.");
  });

  it("labels by name and moves to a label out of the inbox", async () => {
    const labelled = await google.mail.label({
      message_id: "m_plain",
      add: ["clients"],
      remove: ["UNREAD"],
    });
    expect(labelled.labels).toEqual(
      expect.arrayContaining(["Clients", "INBOX"]),
    );
    expect(labelled.unread).toBe(false);

    const moved = await google.mail.move({
      message_id: "m_html",
      folder: "Clients",
    });
    expect(moved.labels).toContain("Clients");
    expect(moved.labels).not.toContain("INBOX");

    await expect(
      google.mail.label({ message_id: "m_plain", add: ["No such label"] }),
    ).rejects.toMatchObject({ productivity: { code: "invalid_request" } });
  });
});

describe("calendar, against the Google emulator", () => {
  it("lists events in a window with their zones, all-day events as dates", async () => {
    const page = await google.calendar.list({
      from: "2025-11-01T00:00:00Z",
      to: "2025-11-30T00:00:00Z",
      limit: 20,
    });
    const byId = Object.fromEntries(
      page.events.map((event) => [event.id, event]),
    );
    expect(byId.e_review).toMatchObject({
      title: "Design review",
      start: expect.stringMatching(/^2025-11-10T09:00:00/),
      time_zone: expect.any(String),
    });
    expect(byId.e_offsite).toMatchObject({
      start: "2025-11-12",
      all_day: true,
    });
  });

  it("creates an event, sees it busy, then cancels it", async () => {
    const created = await google.calendar.create({
      title: "1:1",
      start: "2025-11-20T15:00:00",
      end: "2025-11-20T15:30:00",
      time_zone: "Europe/Paris",
      attendees: ["grace@example.com"],
      location: "Room 2",
    });
    expect(created).toMatchObject({ title: "1:1", location: "Room 2" });

    const window = {
      attendees: [PERSON],
      from: "2025-11-20T00:00:00Z",
      to: "2025-11-21T00:00:00Z",
      time_zone: "Europe/Paris",
    };
    const busy = await google.calendar.freeBusy(window);
    expect(busy.schedules[0]!.busy).toHaveLength(1);
    // Calendar's discovery document reads an offset-less dateTime in its
    // timeZone (15:00 Paris, 14:00Z); the emulator reads it as UTC, so the
    // instant is pinned by the fake-tested request shape instead.
    expect(created.start).toMatch(/^2025-11-20T15:00:00/);

    await google.calendar.cancel({ event_id: created.id });
    const after = await google.calendar.freeBusy(window);
    expect(after.schedules[0]!.busy).toEqual([]);
  });
});

describe("drive, against the Google emulator", () => {
  it("searches a folder, pages, and reads a text file", async () => {
    const first = await google.drive.search({
      query: "",
      folder_id: "f_folder",
      limit: 1,
    });
    expect(first.files).toHaveLength(1);
    const second = await google.drive.search({
      query: "",
      folder_id: "f_folder",
      limit: 10,
      cursor: first.cursor,
    });
    expect([...first.files, ...second.files].map((f) => f.name).sort()).toEqual(
      ["plan.md", "scan.pdf"],
    );

    const read = await google.drive.read({
      file_id: "f_text",
      max_bytes: 1000,
    });
    expect(read.content).toEqual({
      content_type: "text",
      content: "# Plan\n\nShip it.",
    });
    expect(read.file).toMatchObject({
      name: "plan.md",
      mime_type: "text/markdown",
    });

    const cut = await google.drive.read({ file_id: "f_text", max_bytes: 6 });
    expect(cut.content?.content).toBe("# Plan");

    const binary = await google.drive.read({
      file_id: "f_pdf",
      max_bytes: 1000,
    });
    expect(binary.content).toBeUndefined();
    expect(binary.unavailable).toMatch(/no text form/);
  });

  it("uploads a file into a folder and downloads the same bytes", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const uploaded = await google.drive.upload({
      name: "result.bin",
      mime_type: "application/octet-stream",
      bytes,
      folder_id: "f_folder",
    });
    expect(uploaded).toMatchObject({ name: "result.bin", is_folder: false });

    const downloaded = await google.drive.download({ file_id: uploaded.id });
    expect(downloaded.name).toBe("result.bin");
    expect([...downloaded.bytes]).toEqual([...bytes]);
  });

  it("maps a missing file to not_found", async () => {
    await expect(
      google.drive.read({ file_id: "f_missing", max_bytes: 10 }),
    ).rejects.toMatchObject({
      productivity: { code: "not_found", status: 404 },
    });
  });
});
