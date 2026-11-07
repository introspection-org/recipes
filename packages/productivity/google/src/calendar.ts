import { type GooglePage, type GoogleTransport } from "./http.js";

export const CALENDAR_SCOPES = {
  read: "https://www.googleapis.com/auth/calendar.readonly",
  write: "https://www.googleapis.com/auth/calendar.events",
} as const;

/** calendar/v3 `EventDateTime`: `date` for an all-day event, else `dateTime`. */
export interface CalendarDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface CalendarAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  optional?: boolean;
  organizer?: boolean;
  self?: boolean;
  resource?: boolean;
  comment?: string;
}

/** calendar/v3 `Event`, the fields the commands read and write. */
export interface CalendarEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarDateTime;
  end?: CalendarDateTime;
  attendees?: CalendarAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  hangoutLink?: string;
  htmlLink?: string;
  recurringEventId?: string;
  conferenceData?: {
    createRequest?: {
      requestId: string;
      conferenceSolutionKey: { type: string };
    };
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
}

export interface FreeBusyResult {
  calendars: Record<
    string,
    {
      busy?: Array<{ start: string; end: string }>;
      errors?: Array<{ reason?: string }>;
    }
  >;
}

/** The Calendar REST API (`calendar/v3`). Writes notify attendees (`sendUpdates=all`). */
export class CalendarClient {
  constructor(private readonly transport: GoogleTransport) {}

  private eventsUrl(calendarId: string): string {
    return `${this.transport.endpoints.calendar}/calendars/${encodeURIComponent(calendarId)}/events`;
  }

  /** `calendarList.list`, every page up to 2,500 calendars, for `calendar` by name. */
  async listCalendars(signal?: AbortSignal): Promise<
    Array<{
      id: string;
      summary?: string;
      timeZone?: string;
      primary?: boolean;
    }>
  > {
    const items: Array<{ id: string; summary?: string; primary?: boolean }> =
      [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const body = await this.transport.json<{
        items?: Array<{
          id: string;
          summary?: string;
          timeZone?: string;
          primary?: boolean;
        }>;
        nextPageToken?: string;
      }>(`${this.transport.endpoints.calendar}/users/me/calendarList`, {
        operation: "calendar.calendarList.list",
        template: "/calendar/v3/users/me/calendarList",
        query: { maxResults: 250, pageToken },
        scope: CALENDAR_SCOPES.read,
        signal,
      });
      items.push(...(body.items ?? []));
      pageToken = body.nextPageToken;
      if (!pageToken) break;
    }
    return items;
  }

  /** `calendars.get`: the calendar's own time zone. */
  async calendarZone(
    calendarId: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const body = await this.transport.json<{ timeZone?: string }>(
      `${this.transport.endpoints.calendar}/calendars/${encodeURIComponent(calendarId)}`,
      {
        operation: "calendar.calendars.get",
        template: "/calendar/v3/calendars/{calendarId}",
        query: { fields: "timeZone" },
        scope: CALENDAR_SCOPES.read,
        signal,
      },
    );
    return body.timeZone;
  }

  /** `events.list`, recurring events expanded and ordered by start. */
  async listEvents(
    calendarId: string,
    options: {
      timeMin: string;
      timeMax: string;
      maxResults?: number;
      pageToken?: string;
      timeZone?: string;
    },
    signal?: AbortSignal,
  ): Promise<GooglePage<CalendarEvent> & { timeZone?: string }> {
    const body = await this.transport.json<{
      items?: CalendarEvent[];
      nextPageToken?: string;
      timeZone?: string;
    }>(this.eventsUrl(calendarId), {
      operation: "calendar.events.list",
      template: "/calendar/v3/calendars/{calendarId}/events",
      query: {
        timeMin: options.timeMin,
        timeMax: options.timeMax,
        maxResults: options.maxResults,
        pageToken: options.pageToken,
        timeZone: options.timeZone,
        singleEvents: true,
        orderBy: "startTime",
      },
      scope: CALENDAR_SCOPES.read,
      signal,
    });
    return {
      items: body.items ?? [],
      nextPageToken: body.nextPageToken,
      timeZone: body.timeZone,
    };
  }

  getEvent(
    calendarId: string,
    eventId: string,
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    return this.transport.json<CalendarEvent>(
      `${this.eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`,
      {
        operation: "calendar.events.get",
        template: "/calendar/v3/calendars/{calendarId}/events/{eventId}",
        scope: CALENDAR_SCOPES.read,
        signal,
      },
    );
  }

  insertEvent(
    calendarId: string,
    event: CalendarEvent,
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    return this.transport.json<CalendarEvent>(this.eventsUrl(calendarId), {
      operation: "calendar.events.insert",
      template: "/calendar/v3/calendars/{calendarId}/events",
      method: "POST",
      query: {
        sendUpdates: "all",
        conferenceDataVersion: event.conferenceData ? 1 : undefined,
      },
      json: event,
      write: true,
      scope: CALENDAR_SCOPES.write,
      signal,
    });
  }

  patchEvent(
    calendarId: string,
    eventId: string,
    patch: CalendarEvent,
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    return this.transport.json<CalendarEvent>(
      `${this.eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`,
      {
        operation: "calendar.events.patch",
        template: "/calendar/v3/calendars/{calendarId}/events/{eventId}",
        method: "PATCH",
        query: {
          sendUpdates: "all",
          conferenceDataVersion: patch.conferenceData ? 1 : undefined,
        },
        json: patch,
        write: true,
        scope: CALENDAR_SCOPES.write,
        signal,
      },
    );
  }

  async deleteEvent(
    calendarId: string,
    eventId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.transport.send(
      `${this.eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`,
      {
        operation: "calendar.events.delete",
        template: "/calendar/v3/calendars/{calendarId}/events/{eventId}",
        method: "DELETE",
        query: { sendUpdates: "all" },
        write: true,
        scope: CALENDAR_SCOPES.write,
        signal,
      },
    );
  }

  /** `freebusy.query`; a read, though it is a POST. */
  freeBusy(
    request: {
      timeMin: string;
      timeMax: string;
      timeZone?: string;
      items: Array<{ id: string }>;
    },
    signal?: AbortSignal,
  ): Promise<FreeBusyResult> {
    return this.transport.json<FreeBusyResult>(
      `${this.transport.endpoints.calendar}/freeBusy`,
      {
        operation: "calendar.freebusy.query",
        template: "/calendar/v3/freeBusy",
        method: "POST",
        json: request,
        scope: CALENDAR_SCOPES.read,
        signal,
      },
    );
  }
}
