import { describe, expect, it } from "vitest";

import {
  parseSchemaArgs,
  SchemaArgsError,
  schemaCommand,
  schemaHelp,
} from "../src/cli/schema-args.js";
import { webSearchParameters } from "../src/search/tool.js";

const search = schemaCommand(
  "web_search",
  "Search the web.",
  webSearchParameters(["tavily", "exa"]),
);
const parse = (argv: string[], stdin = "") =>
  parseSchemaArgs(search, argv, () => stdin).args;

describe("a command line from a tool's schema", () => {
  it("makes a typed flag of each top-level property", () => {
    expect(
      search.flags.map((flag) => [
        flag.name,
        flag.kind,
        flag.array,
        flag.required,
      ]),
    ).toEqual([
      ["query", "string", false, true],
      ["provider", "string", false, false],
      ["mode", "string", false, false],
      ["max_results", "integer", false, false],
      ["freshness", "string", false, false],
      ["sites", "string", true, false],
      ["content", "string", false, false],
      ["country", "string", false, false],
    ]);
  });

  it("converts each value to its property's type", () => {
    expect(
      parse([
        "--query",
        "croissants",
        "--max_results",
        "5",
        "--mode",
        "fast",
        "--sites",
        "sfchronicle.com",
        "--sites",
        "eater.com",
      ]),
    ).toEqual({
      query: "croissants",
      max_results: 5,
      mode: "fast",
      sites: ["sfchronicle.com", "eater.com"],
    });
    expect(
      parse(["--query", "x", "--sites", '["a.com","b.com"]']).sites,
    ).toEqual(["a.com", "b.com"]);
  });

  it("refuses what the schema would, before any call", () => {
    const refused = (argv: string[]) => () => parse(argv);
    expect(refused(["--query", "x", "--max_results", "five"])).toThrow(
      "--max_results takes an integer, not 'five'",
    );
    expect(refused(["--query", "x", "--mode", "slow"])).toThrow(
      "--mode must be one of fast, default, deep, not 'slow'",
    );
    expect(refused(["--max_results", "3"])).toThrow(
      "web_search: missing --query",
    );
    expect(refused(["--query", "x", "--limit", "3"])).toThrow(SchemaArgsError);
    expect(refused(["croissants"])).toThrow(SchemaArgsError);
  });

  it("takes every argument as --json too, with flags over it", () => {
    expect(parse(["--json", "-"], '{"query":"a","max_results":2}')).toEqual({
      query: "a",
      max_results: 2,
    });
    expect(parse(["--json", '{"query":"a"}', "--query", "b"])).toEqual({
      query: "b",
    });
    expect(parseSchemaArgs(search, ["--help"]).help).toBe(true);
  });

  it("takes booleans as --flag and --no-flag, and anything else as JSON", () => {
    const command = schemaCommand("issues list", "", {
      type: "object",
      properties: {
        includeArchived: { type: "boolean" },
        filter: { type: "object" },
        state: { anyOf: [{ const: "open" }, { const: "closed" }] },
        limit: { type: ["integer", "null"], minimum: 1, maximum: 50 },
      },
    });
    const args = (argv: string[]) => parseSchemaArgs(command, argv).args;
    expect(
      args([
        "--includeArchived",
        "--filter",
        '{"team":"INT"}',
        "--state",
        "open",
        "--limit",
        "10",
      ]),
    ).toEqual({
      includeArchived: true,
      filter: { team: "INT" },
      state: "open",
      limit: 10,
    });
    expect(args(["--no-includeArchived"])).toEqual({ includeArchived: false });
    expect(() => args(["--limit", "51"])).toThrow(
      "--limit must be from 1 to 50, not 51",
    );
  });

  it("writes --help from the same schema", () => {
    const help = schemaHelp(search);
    expect(help.split("\n")[0]).toBe(
      "Usage: web_search --query <string> [--<argument> <value> ...]",
    );
    expect(help).toContain("--mode <fast|default|deep>");
    expect(help).toContain("--sites <string>...");
    expect(help).toContain("--json <object|->");
  });
});
