import type {
  CalendarCommand,
  DriveCommand,
  MailCommand,
} from "@introspection-ai/recipes/productivity";

/**
 * The delegated Graph permission each command needs, as
 * `docs/productivity/microsoft.md` states them. A `missing_scope` error
 * names the command's scope; the connector requests these plus
 * `offline_access`.
 */
export const MICROSOFT_SCOPES: {
  readonly mail: Readonly<Record<MailCommand, string>>;
  readonly calendar: Readonly<Record<CalendarCommand, string>>;
  readonly drive: Readonly<Record<DriveCommand, string>>;
} = {
  mail: {
    search: "Mail.Read",
    read: "Mail.Read",
    fetch_attachment: "Mail.Read",
    draft: "Mail.ReadWrite",
    update_draft: "Mail.ReadWrite",
    send: "Mail.Send",
    move: "Mail.ReadWrite",
    label: "Mail.ReadWrite",
  },
  calendar: {
    list: "Calendars.Read",
    read: "Calendars.Read",
    free_busy: "Calendars.Read",
    create: "Calendars.ReadWrite",
    update: "Calendars.ReadWrite",
    respond: "Calendars.ReadWrite",
    cancel: "Calendars.ReadWrite",
  },
  drive: {
    search: "Files.Read",
    read: "Files.Read",
    download: "Files.Read",
    upload: "Files.ReadWrite",
  },
};
