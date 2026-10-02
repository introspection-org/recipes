import { describe, expect, it } from "vitest";
import {
  CURRENT_TIME_ENV,
  CURRENT_TIME_TOOL_NAME,
  createCurrentTimeTool,
  currentTimeUtc,
} from "../src/current-time.js";

describe("currentTimeUtc", () => {
  it("returns live UTC ISO when unset", () => {
    const before = Date.now();
    const value = currentTimeUtc();
    const after = Date.now();
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const ms = Date.parse(value);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });

  it("normalizes a frozen UTC override", () => {
    expect(currentTimeUtc("2026-09-22T12:00:00.000Z")).toBe(
      "2026-09-22T12:00:00.000Z"
    );
    expect(currentTimeUtc("2026-09-22T12:00:00Z")).toBe(
      "2026-09-22T12:00:00.000Z"
    );
  });

  it("rejects a non-UTC override", () => {
    expect(() => currentTimeUtc("2026-09-22T12:00:00+07:00")).toThrow(
      `${CURRENT_TIME_ENV} must be an ISO 8601 UTC timestamp`
    );
    expect(() => currentTimeUtc("tomorrow")).toThrow(
      `${CURRENT_TIME_ENV} must be an ISO 8601 UTC timestamp`
    );
  });
});

describe("createCurrentTimeTool", () => {
  it("returns the frozen clock without bash", async () => {
    const tool = createCurrentTimeTool({
      [CURRENT_TIME_ENV]: "2026-09-22T12:00:00.000Z",
    });
    expect(tool.name).toBe(CURRENT_TIME_TOOL_NAME);
    const result = await tool.execute(
      "call-1",
      {},
      undefined,
      undefined,
      undefined as never
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "2026-09-22T12:00:00.000Z" }],
      details: { utc: "2026-09-22T12:00:00.000Z" },
    });
  });
});
