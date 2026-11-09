import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRecipeClock,
  createTodayTool,
  currentDateContext,
  readClock,
  startOfDay,
  todayExtension,
  withCurrentDate,
  zonedTime,
} from "../src/clock.js";
import { createRecipeExtensionRegistrationRegistry } from "../src/extensions.js";
import type { RecipeSessionHandle } from "../src/session.js";
import { writeFixtureRecipe } from "../src/test-utils.js";
import { modelView, openRecipeSession } from "./helpers/mcp-session.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const at = (iso: string) => () => new Date(iso);
// Sunday afternoon in Los Angeles, Monday morning in Sydney.
const NOW = at("2026-11-09T00:19:00Z");

describe("the session clock", () => {
  it("falls back to the host's time zone and locale, and refuses an unknown zone", () => {
    const host = Intl.DateTimeFormat().resolvedOptions();
    const clock = createRecipeClock();
    expect(clock.timeZone).toBe(host.timeZone);
    expect(clock.locale).toBe(host.locale);
    expect(createRecipeClock({ locale: "en-gb" }).locale).toBe("en-GB");
    expect(() => createRecipeClock({ timeZone: "Mars/Olympus" })).toThrow(
      "not an IANA time zone name",
    );
  });

  it("reads the date, weekday, time and offset in its zone", () => {
    expect(
      readClock(
        createRecipeClock({ timeZone: "America/Los_Angeles", now: NOW }),
      ),
    ).toMatchObject({
      date: "2026-11-08",
      weekday: "Sunday",
      time: "16:19",
      time_zone: "America/Los_Angeles",
      utc_offset: "-08:00",
    });
    const clock = createRecipeClock({
      timeZone: "Australia/Sydney",
      locale: "en-AU",
      now: NOW,
    });
    expect(readClock(clock)).toMatchObject({
      date: "2026-11-09",
      weekday: "Monday",
      time: "11:19",
      utc_offset: "+11:00",
    });
    expect(readClock(clock, "Asia/Kolkata")).toMatchObject({
      date: "2026-11-09",
      time: "05:49",
      utc_offset: "+05:30",
    });
  });

  it("puts one instant on days two apart across the date line", () => {
    const clock = createRecipeClock({ now: at("2026-11-09T10:30:00Z") });
    expect(readClock(clock, "Pacific/Kiritimati")).toMatchObject({
      date: "2026-11-10",
      weekday: "Tuesday",
      time: "00:30",
      utc_offset: "+14:00",
    });
    expect(readClock(clock, "Pacific/Pago_Pago")).toMatchObject({
      date: "2026-11-08",
      weekday: "Sunday",
      time: "23:30",
      utc_offset: "-11:00",
    });
  });

  it("follows daylight saving time within a day", () => {
    const zone = "America/Los_Angeles";
    const before = createRecipeClock({
      timeZone: zone,
      now: at("2026-03-08T09:00:00Z"),
    });
    const after = createRecipeClock({
      timeZone: zone,
      now: at("2026-03-08T11:00:00Z"),
    });
    expect(readClock(before)).toMatchObject({
      date: "2026-03-08",
      time: "01:00",
      utc_offset: "-08:00",
    });
    expect(readClock(after)).toMatchObject({
      date: "2026-03-08",
      time: "04:00",
      utc_offset: "-07:00",
    });
    // Midnight that day was still standard time; two days on is daylight time.
    const now = after.now();
    expect(zonedTime(startOfDay(now, zone, 0), zone)).toBe(
      "2026-03-08T00:00:00-08:00",
    );
    expect(zonedTime(startOfDay(now, zone, 2), zone)).toBe(
      "2026-03-10T00:00:00-07:00",
    );
  });
});

describe("the date in the prompt", () => {
  const clock = createRecipeClock({
    timeZone: "America/Los_Angeles",
    locale: "en-US",
    now: NOW,
  });

  it("names the day in the person's locale, not the time", () => {
    expect(currentDateContext(clock, false)).toBe(
      'Today is Sunday, November 8, 2026 (2026-11-08), in America/Los_Angeles (UTC-08:00). Read dates the person gives, such as "tomorrow", in this time zone.',
    );
    // ICU versions differ on the comma after the weekday.
    const london = currentDateContext(
      createRecipeClock({
        timeZone: "Europe/London",
        locale: "en-GB",
        now: NOW,
      }),
      true,
    );
    expect(london).toMatch(
      /^Today is Monday,? 9 November 2026 \(2026-11-09\), in Europe\/London \(UTC\+00:00\)\./,
    );
    expect(london).toMatch(
      /Call today for the current time, or the time elsewhere\.$/,
    );
  });

  it("stays the same all day, so a cached prompt stays valid", () => {
    const morning = createRecipeClock({
      timeZone: "America/Los_Angeles",
      now: at("2026-11-08T08:01:00Z"),
    });
    expect(currentDateContext(morning, false)).toBe(
      currentDateContext(clock, false),
    );
  });

  it("is a prompt section unless a prompt is forced", () => {
    const sections: Record<string, string> = {};
    expect(
      withCurrentDate(
        { systemPrompt: "Base", systemPromptOptions: { sections } },
        clock,
      ),
    ).toEqual({});
    expect(sections.current_date).toContain("Sunday, November 8, 2026");

    const block = `<current_date>\n${currentDateContext(clock, true)}\n</current_date>`;
    expect(
      withCurrentDate(
        {
          systemPrompt: "Base",
          systemPromptOptions: { sections: {}, selectedTools: ["today"] },
        },
        clock,
        "Recipe prompt",
      ),
    ).toEqual({ systemPrompt: `Recipe prompt\n\n${block}` });
    expect(
      withCurrentDate(
        {
          systemPrompt: "Forced earlier",
          systemPromptOptions: {
            sections: {},
            forceSystemPrompt: "Forced earlier",
            selectedTools: ["today"],
          },
        },
        clock,
      ),
    ).toEqual({ systemPrompt: `Forced earlier\n\n${block}` });
  });
});

describe("the today tool", () => {
  const clock = createRecipeClock({
    timeZone: "America/Los_Angeles",
    locale: "en-US",
    now: NOW,
  });
  const run = (params: { time_zone?: string }) =>
    createTodayTool(clock).execute(
      "call",
      params,
      undefined,
      undefined,
      undefined as never,
    );

  it("answers in the person's zone, or another", async () => {
    const here = await run({});
    expect(here.details).toMatchObject({
      date: "2026-11-08",
      weekday: "Sunday",
      time: "16:19",
      time_zone: "America/Los_Angeles",
      utc_offset: "-08:00",
    });
    expect(JSON.parse((here.content[0] as { text: string }).text)).toEqual(
      here.details,
    );
    expect(
      (await run({ time_zone: "Australia/Sydney" })).details,
    ).toMatchObject({ date: "2026-11-09", weekday: "Monday", time: "11:19" });
    await expect(run({ time_zone: "Sydney" })).rejects.toThrow(
      "not an IANA time zone name",
    );
  });

  it("is not registered over a Recipe's own today", () => {
    const registrations = createRecipeExtensionRegistrationRegistry();
    registrations.claim("tool", "today", "extensions/booking.js");
    const pi = createMockExtensionAPI();
    todayExtension(clock, registrations)(pi as never);
    expect(pi.tools.has("today")).toBe(false);

    const fresh = createMockExtensionAPI();
    todayExtension(
      clock,
      createRecipeExtensionRegistrationRegistry(),
    )(fresh as never);
    expect(fresh.tools.has("today")).toBe(true);
  });
});

describe("the date reaches the model", () => {
  const handles: RecipeSessionHandle[] = [];
  const cleanups: Array<() => void> = [];
  afterEach(async () => {
    for (const handle of handles.splice(0))
      await handle.dispose().catch(() => {});
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("in every turn's system prompt, from the session's clock", async () => {
    const fixture = writeFixtureRecipe({ tools: ["read", "today"] });
    cleanups.push(fixture.cleanup);
    const prompts: string[] = [];
    const tools: string[][] = [];
    const respond = (context: { messages: readonly unknown[] }) => {
      const view = modelView(context);
      prompts.push(view.prompt);
      tools.push(view.tools.map((tool) => tool.name));
      return fauxAssistantMessage("done");
    };
    const handle = await openRecipeSession({
      ...fixture,
      bindings: [],
      responses: [respond, respond, respond],
      clock: { timeZone: "Australia/Sydney", locale: "en-AU", now: () => now },
    });
    handles.push(handle);
    let now = NOW();
    await handle.session.prompt("What day is it?");
    await handle.session.prompt("And now?");
    now = new Date("2026-11-09T13:30:00Z");
    await handle.session.prompt("Past midnight?");

    expect(prompts).toHaveLength(3);
    const monday =
      /Today is Monday,? 9 November 2026 \(2026-11-09\), in Australia\/Sydney \(UTC\+11:00\)\./g;
    for (const prompt of prompts) {
      expect(prompt).toContain("You are a conformance fixture.");
      expect(prompt).toContain("Call today for the current time");
      // The same day is said once: a second turn adds nothing to the prompt.
      expect(prompt.match(monday)).toHaveLength(1);
    }
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[2]).toMatch(/Today is Tuesday,? 10 November 2026/);
    expect(tools[0]).toContain("today");
    const result = await handle.session
      .getToolDefinition("today")!
      .execute("call", {} as never, undefined, undefined, undefined as never);
    expect(result.details).toMatchObject({
      date: "2026-11-10",
      time: "00:30",
      time_zone: "Australia/Sydney",
    });
  });

  it("keeps a Recipe extension's own today over the built-in", async () => {
    const fixture = writeFixtureRecipe({
      manifestPi: { extensions: ["extensions/booking.ts"] },
      tools: ["today"],
    });
    cleanups.push(fixture.cleanup);
    mkdirSync(join(fixture.recipeDir, "extensions"), { recursive: true });
    writeFileSync(
      join(fixture.recipeDir, "extensions", "booking.ts"),
      [
        "export default (pi) => {",
        "  pi.registerTool({",
        "    name: 'today',",
        "    label: 'Recipe today',",
        "    description: 'The Recipe-owned today tool.',",
        "    parameters: { type: 'object', properties: {} },",
        "    async execute() { return { content: [], details: {} }; }",
        "  });",
        "};",
      ].join("\n"),
    );
    const handle = await openRecipeSession({ ...fixture, bindings: [] });
    handles.push(handle);

    expect(handle.session.getActiveToolNames()).toContain("today");
    expect(handle.session.getToolDefinition("today")?.description).toBe(
      "The Recipe-owned today tool.",
    );
  });

  it("refuses a clock in an unknown time zone", async () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    await expect(
      openRecipeSession({
        ...fixture,
        bindings: [],
        clock: { timeZone: "Mars/Olympus" },
      }),
    ).rejects.toThrow("not an IANA time zone name");
  });
});
