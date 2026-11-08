import type {
  CalendarSession,
  DriveSession,
  MailSession,
  ProductivityCapabilities,
  ProductivitySession,
  ProductivitySessionOptions,
} from "@introspection-ai/recipes/productivity";

import { type GoogleEndpoints, GoogleTransport } from "./http.js";
import { GoogleRestBackend } from "./rest.js";

/**
 * What the package serves, every command over Google's REST APIs
 * (docs/productivity/google.md). The effects restate the host's fixed table,
 * which the host checks; a companion imports the host's types only.
 */
export const GOOGLE_PRODUCTIVITY_CAPABILITIES = {
  mail: {
    labels: "labels",
    folders: "labels",
    commands: {
      search: { effect: "read", backend: "rest" },
      read: { effect: "read", backend: "rest" },
      fetch_attachment: { effect: "read", backend: "rest" },
      draft: { effect: "reversible", backend: "rest" },
      update_draft: { effect: "reversible", backend: "rest" },
      send: { effect: "irreversible", backend: "rest" },
      move: {
        effect: "reversible",
        backend: "rest",
        note: "Gmail has no folders: a folder is a label, moving takes the message out of the inbox, and `archive` only does that.",
      },
      label: {
        effect: "reversible",
        backend: "rest",
        note: "Labels are Gmail labels, named as Gmail shows them.",
      },
    },
  },
  calendar: {
    commands: {
      list: { effect: "read", backend: "rest" },
      read: { effect: "read", backend: "rest" },
      free_busy: { effect: "read", backend: "rest" },
      create: { effect: "sends", backend: "rest" },
      update: { effect: "sends", backend: "rest" },
      respond: { effect: "sends", backend: "rest" },
      cancel: {
        effect: "irreversible",
        backend: "rest",
        note: "Google sends attendees its own cancellation notice; a comment is not delivered.",
      },
    },
  },
  drive: {
    commands: {
      search: { effect: "read", backend: "rest" },
      read: {
        effect: "read",
        backend: "rest",
        note: "Google Docs, Sheets and Slides are read as text (a Sheet as CSV of its first sheet over REST); Google refuses exports above 10 MB.",
      },
      download: {
        effect: "read",
        backend: "rest",
        note: "Google Docs, Sheets and Slides download as .docx, .xlsx and .pptx.",
      },
      upload: { effect: "reversible", backend: "rest" },
    },
  },
  hosts: ["gmail.googleapis.com", "www.googleapis.com"],
} as const satisfies ProductivityCapabilities;

/** What tests may override: Google's base URLs, for an emulator or a fake. */
export interface GoogleSessionOverrides {
  endpoints?: Partial<GoogleEndpoints>;
}

/** A tool session with every method present and the call context optional. */
type CompleteSession<S> = {
  [K in keyof S]-?: S[K] extends
    ((args: infer A, ctx: infer C) => infer R) | undefined
    ? (args: A, ctx?: C) => R
    : never;
};

export interface GoogleProductivitySession extends ProductivitySession {
  readonly mail: CompleteSession<MailSession>;
  readonly calendar: CompleteSession<CalendarSession>;
  readonly drive: CompleteSession<DriveSession>;
}

/** One person's Google connection, over Google's REST APIs. */
export async function createGoogleProductivitySession(
  options: ProductivitySessionOptions,
  overrides: GoogleSessionOverrides = {},
): Promise<GoogleProductivitySession> {
  const rest = new GoogleRestBackend(
    new GoogleTransport(options.http, options.pages, overrides.endpoints),
  );
  return {
    provider: "google",
    mail: {
      search: (args, ctx) => rest.mail.search(args, ctx),
      read: (args, ctx) => rest.mail.read(args, ctx),
      fetchAttachment: (args, ctx) => rest.mail.fetchAttachment(args, ctx),
      draft: (args, ctx) => rest.mail.draft(args, ctx),
      updateDraft: (args, ctx) => rest.mail.updateDraft(args, ctx),
      send: (args, ctx) => rest.mail.send(args, ctx),
      move: (args, ctx) => rest.mail.move(args, ctx),
      label: (args, ctx) => rest.mail.label(args, ctx),
    },
    calendar: {
      list: (args, ctx) => rest.calendar.list(args, ctx),
      read: (args, ctx) => rest.calendar.read(args, ctx),
      freeBusy: (args, ctx) => rest.calendar.freeBusy(args, ctx),
      create: (args, ctx) => rest.calendar.create(args, ctx),
      update: (args, ctx) => rest.calendar.update(args, ctx),
      respond: (args, ctx) => rest.calendar.respond(args, ctx),
      cancel: (args, ctx) => rest.calendar.cancel(args, ctx),
    },
    drive: {
      search: (args, ctx) => rest.drive.search(args, ctx),
      read: (args, ctx) => rest.drive.read(args, ctx),
      download: (args, ctx) => rest.drive.download(args, ctx),
      upload: (args, ctx) => rest.drive.upload(args, ctx),
    },
  };
}
