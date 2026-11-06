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

  /** `calendarList.list`: the calendars on the person's list, for `calendar` by name. */
  async listCalendars(signal?: AbortSignal): Promise<
    Array<{
      id: string;
      summary?: string;
      timeZone?: string;
      primary?: boolean;
    }>
  > {
    const body = await this.transport.json<{
      items?: Array<{
        id: string;
        summary?: string;
        timeZone?: string;
        primary?: boolean;
      }>;
    }>(`${this.transport.endpoints.calendar}/users/me/calendarList`, {
      scope: CALENDAR_SCOPES.read,
      signal,
    });
    return body.items ?? [];
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
      { scope: CALENDAR_SCOPES.read, signal },
    );
  }

  insertEvent(
    calendarId: string,
    event: CalendarEvent,
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    return this.transport.json<CalendarEvent>(this.eventsUrl(calendarId), {
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
        method: "POST",
        json: request,
        scope: CALENDAR_SCOPES.read,
        signal,
      },
    );
  }
}
