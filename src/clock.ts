/**
 * The session's clock: the one source of the date the agent is told, the
 * built-in `today` tool, and the productivity tools' default ranges.
 */

import type {
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { RecipeExtensionRegistrationRegistry } from "./extensions.js";

const TODAY_TOOL_NAME = "today";

const BUILTIN_OWNER = "<builtin:today>";

/** The prompt section the date is rendered in. */
const CURRENT_DATE_SECTION = "current_date";

export interface RecipeClockOptions {
  /** The person's IANA time zone, such as `America/Los_Angeles`. Default: the host's. */
  timeZone?: string;
  /** The person's BCP 47 locale, such as `en-US`, used to format dates. Default: the host's. */
  locale?: string;
  /** The current instant. Default: the system clock. */
  now?: () => Date;
}

export interface RecipeClock {
  readonly timeZone: string;
  readonly locale: string;
  now(): Date;
}

/** The time in one zone, as the `today` tool returns it. */
export interface ClockReading {
  /** `2026-11-08` */
  date: string;
  /** `Sunday` */
  weekday: string;
  /** `16:19`, on a 24-hour clock. */
  time: string;
  time_zone: string;
  /** `-08:00` */
  utc_offset: string;
  /** The same, formatted in the clock's locale. */
  local: string;
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The clock a session reads, from the host's options. An unknown time zone or
 * malformed locale fails construction.
 */
export function createRecipeClock(
  options: RecipeClockOptions = {},
): RecipeClock {
  const host = Intl.DateTimeFormat().resolvedOptions();
  const timeZone = options.timeZone?.trim() || host.timeZone;
  if (!isTimeZone(timeZone))
    throw new RangeError(
      `Clock time zone '${timeZone}' is not an IANA time zone name`,
    );
  const locale = options.locale?.trim()
    ? Intl.getCanonicalLocales(options.locale.trim())[0]!
    : host.locale;
  return { timeZone, locale, now: options.now ?? (() => new Date()) };
}

/** `zone`'s offset from UTC at `at`, in minutes. */
function offsetMinutes(at: Date, zone: string): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "longOffset",
  })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName")!.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  return (
    (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
  );
}

function formatOffset(minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${pad(Math.trunc(abs / 60))}:${pad(abs % 60)}`;
}

/** `at` as RFC 3339 in `zone`, with its offset: 2026-03-02T09:00:00-08:00. */
export function zonedTime(at: Date, zone: string): string {
  const offset = offsetMinutes(at, zone);
  const local = new Date(at.getTime() + offset * 60_000)
    .toISOString()
    .slice(0, 19);
  return `${local}${formatOffset(offset)}`;
}

/** Midnight in `zone`, `days` after the day `at` falls on there. */
export function startOfDay(at: Date, zone: string, days: number): Date {
  const today = zonedTime(at, zone).slice(0, 10);
  const guess = Date.parse(`${today}T00:00:00Z`) + days * 86_400_000;
  return new Date(guess - offsetMinutes(new Date(guess), zone) * 60_000);
}

/** The clock's time now, in `zone` (default the clock's own). */
export function readClock(
  clock: RecipeClock,
  zone = clock.timeZone,
): ClockReading {
  const at = clock.now();
  const stamp = zonedTime(at, zone);
  return {
    date: stamp.slice(0, 10),
    weekday: new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "long",
    }).format(at),
    time: stamp.slice(11, 16),
    time_zone: zone,
    utc_offset: stamp.slice(19),
    local: new Intl.DateTimeFormat(clock.locale, {
      timeZone: zone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(at),
  };
}

/**
 * What the agent is told about the date. It names the day, not the time, so
 * the prompt stays the same all day and a cached prompt prefix stays valid.
 */
export function currentDateContext(
  clock: RecipeClock,
  offersToday: boolean,
): string {
  const at = clock.now();
  const stamp = zonedTime(at, clock.timeZone);
  const day = new Intl.DateTimeFormat(clock.locale, {
    timeZone: clock.timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(at);
  return [
    `Today is ${day} (${stamp.slice(0, 10)}), in ${clock.timeZone} (UTC${stamp.slice(19)}).`,
    'Read dates the person gives, such as "tomorrow", in this time zone.',
    ...(offersToday
      ? [`Call ${TODAY_TOOL_NAME} for the current time, or the time elsewhere.`]
      : []),
  ].join(" ");
}

/** The parts of a `before_agent_start` event the date is added to. */
export interface CurrentDateEvent {
  readonly systemPrompt: string;
  readonly systemPromptOptions: {
    readonly selectedTools?: readonly string[];
    readonly forceSystemPrompt?: string;
    sections?: Record<string, string>;
  };
}

/**
 * Add the date to a `before_agent_start` event's prompt. Unless a prompt is
 * forced (`forced`, or an earlier handler's), it is a prompt section, which
 * Pi updates as its own section when the day changes; otherwise it is
 * appended to the forced prompt.
 */
export function withCurrentDate(
  event: CurrentDateEvent,
  clock: RecipeClock,
  forced?: string,
): { systemPrompt?: string } {
  const options = event.systemPromptOptions;
  const text = currentDateContext(
    clock,
    options.selectedTools?.includes(TODAY_TOOL_NAME) ?? false,
  );
  if (
    forced === undefined &&
    options.forceSystemPrompt === undefined &&
    options.sections
  ) {
    options.sections[CURRENT_DATE_SECTION] = text;
    return {};
  }
  return {
    systemPrompt: `${forced ?? event.systemPrompt}\n\n<${CURRENT_DATE_SECTION}>\n${text}\n</${CURRENT_DATE_SECTION}>`,
  };
}

/** Tells every turn's prompt the date. */
export function currentDateExtension(clock: RecipeClock): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event) => withCurrentDate(event, clock));
  };
}

const parameters = Type.Object(
  {
    time_zone: Type.Optional(
      Type.String({
        description:
          "An IANA time zone, such as Australia/Sydney, for the time there. Default: the person's.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createTodayTool(
  clock: RecipeClock,
): ToolDefinition<typeof parameters> {
  return {
    name: TODAY_TOOL_NAME,
    label: "Today",
    description:
      "The current date, weekday and time, with the time zone and its UTC offset: the person's, or another time zone's.",
    promptSnippet: "The current date and time, here or in another time zone",
    parameters,
    async execute(_toolCallId, params) {
      const zone = params.time_zone?.trim() || clock.timeZone;
      if (!isTimeZone(zone))
        throw new Error(
          `time_zone '${zone}' is not an IANA time zone name, such as Australia/Sydney`,
        );
      const reading = readClock(clock, zone);
      return {
        content: [{ type: "text", text: JSON.stringify(reading) }],
        details: reading,
      };
    },
  };
}

/** The built-in `today`, unless a Recipe extension already registered one. */
export function todayExtension(
  clock: RecipeClock,
  registrations?: RecipeExtensionRegistrationRegistry,
): ExtensionFactory {
  return (pi) => {
    if (registrations?.owner("tool", TODAY_TOOL_NAME)) return;
    registrations?.claim("tool", TODAY_TOOL_NAME, BUILTIN_OWNER);
    pi.registerTool(createTodayTool(clock));
  };
}

/** Whether the agent opted into the built-in tool. */
export function wantsToday(agentTools: readonly string[]): boolean {
  return agentTools.includes(TODAY_TOOL_NAME);
}
