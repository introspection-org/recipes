/** An event and the calendar it lives on: Google addresses every event by both. */
export interface GoogleEventRef {
  readonly calendarId: string;
  readonly eventId: string;
}

export const PRIMARY_CALENDAR = "primary";

/**
 * The opaque event id the host stores behind an `evt_` handle. An event on
 * the primary calendar keeps its bare Google id; any other carries its
 * calendar, so a later read, update, respond or cancel reaches the same
 * calendar the event was listed from.
 */
export function encodeEventId(calendarId: string, eventId: string): string {
  return calendarId === PRIMARY_CALENDAR
    ? eventId
    : `${encodeURIComponent(calendarId)}/${encodeURIComponent(eventId)}`;
}

export function decodeEventId(id: string): GoogleEventRef {
  const slash = id.indexOf("/");
  if (slash < 0) return { calendarId: PRIMARY_CALENDAR, eventId: id };
  return {
    calendarId: decodeURIComponent(id.slice(0, slash)),
    eventId: decodeURIComponent(id.slice(slash + 1)),
  };
}
