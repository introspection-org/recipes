import { afterEach, describe, expect, it } from "vitest";

import {
  compactListArgumentError,
  parseListTimeoutMs,
  parseSearchArgs,
} from "../src/mcp/cli/core.js";

/**
 * The CLI's option parsing is `node:util` parseArgs rather than hand-rolled
 * index walks. These pin the agent-facing behaviour across that change: the
 * messages steer what the model tries next, so their wording is part of the
 * contract, not incidental.
 */
describe("mcp search arguments", () => {
  it("joins positionals into the query and defaults the rest", () => {
    expect(parseSearchArgs(["contact", "lookup"])).toEqual({
      query: "contact lookup",
      limit: 8,
      regex: false,
    });
  });

  it.each([
    [["q", "--limit", "3"], 3],
    [["q", "--limit=3"], 3],
  ])("accepts %j in either form", (args, limit) => {
    expect(parseSearchArgs(args as string[])).toMatchObject({ limit });
  });

  it("reads --regex as a flag", () => {
    expect(parseSearchArgs(["q", "--regex"])).toMatchObject({ regex: true });
  });

  it.each([["0"], ["-1"], ["abc"], ["1.5"]])(
    "rejects --limit %s",
    (value) => {
      expect(parseSearchArgs(["q", "--limit", value]).error).toBe(
        `--limit expects a positive integer, got '${value}'.`
      );
    }
  );

  it("reports a --limit with no value", () => {
    expect(parseSearchArgs(["q", "--limit"]).error).toBe(
      "--limit expects a positive integer, got ''."
    );
  });

  it("reserves --json for tool results", () => {
    expect(parseSearchArgs(["q", "--json"]).error).toContain(
      "JSON is reserved for tool results"
    );
  });

  it.each([["--nope"], ["-x"]])("names the unknown option %s", (flag) => {
    expect(parseSearchArgs(["q", flag]).error).toBe(
      `Unknown mcp search option '${flag}'.`
    );
  });
});

describe("mcp list --timeout", () => {
  const configured = process.env.MCPORTER_LIST_TIMEOUT;
  afterEach(() => {
    if (configured === undefined) delete process.env.MCPORTER_LIST_TIMEOUT;
    else process.env.MCPORTER_LIST_TIMEOUT = configured;
  });

  it("defaults when nothing asks for one", () => {
    delete process.env.MCPORTER_LIST_TIMEOUT;
    expect(parseListTimeoutMs(["list"])).toBe(30_000);
  });

  it("takes the configured default", () => {
    process.env.MCPORTER_LIST_TIMEOUT = "4000";
    expect(parseListTimeoutMs(["list"])).toBe(4000);
  });

  it.each([
    [["list", "--timeout", "5000"]],
    [["list", "--timeout=5000"]],
    [["list", "contacts", "--schema", "--timeout", "5000"]],
  ])("reads the flag out of %j", (args) => {
    expect(parseListTimeoutMs(args as string[])).toBe(5000);
  });

  it("reports a --timeout with no value", () => {
    expect(parseListTimeoutMs(["list", "--timeout"])).toBe(
      "mcp list: --timeout requires a value."
    );
  });

  it.each([["0"], ["abc"], ["-5"]])("rejects --timeout %s", (value) => {
    expect(parseListTimeoutMs(["list", "--timeout", value])).toBe(
      "mcp list: --timeout must be a positive integer (milliseconds)."
    );
  });
});

describe("mcp list arguments", () => {
  it.each([
    [["list"]],
    [["list", "contacts"]],
    [["list", "contacts.search_contacts", "--schema"]],
    [["list", "--all-parameters", "--verbose", "--status"]],
    [["list", "--quiet", "--exit-code", "--no-oauth"]],
  ])("accepts %j", (args) => {
    expect(compactListArgumentError(args as string[])).toBeUndefined();
  });

  // The value has to be consumed by the flag; a stray positional would read
  // as a second target and be rejected.
  it("does not mistake a --timeout value for a target", () => {
    expect(
      compactListArgumentError(["list", "contacts", "--timeout", "90"])
    ).toBeUndefined();
  });

  it("rejects a second target", () => {
    expect(compactListArgumentError(["list", "contacts", "extra"])).toBe(
      "Unexpected mcp list argument 'extra'."
    );
  });

  it("names an unknown option", () => {
    expect(compactListArgumentError(["list", "--nope"])).toBe(
      "Unknown mcp list option '--nope'."
    );
  });

  // Both of these parse cleanly but are invisible to execution, which reads the
  // target from args[1] and tests exact tokens like `args.includes("--schema")`.
  it("rejects a target hiding behind a flag", () => {
    expect(compactListArgumentError(["list", "--quiet", "contacts"])).toBe(
      "Unexpected mcp list argument 'contacts'."
    );
  });

  it("rejects a value on a boolean flag", () => {
    expect(
      compactListArgumentError(["list", "contacts.search_contacts", "--schema=false"])
    ).toBe("Unknown mcp list option '--schema=false'.");
  });
});
