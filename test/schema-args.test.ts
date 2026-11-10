import { describe, expect, it } from "vitest";

import {
  type CommandSchema,
  parseSchemaArgs,
  SchemaArgsError,
  schemaHelp,
} from "../src/cli/schema-args.js";
import { webSearchParameters } from "../src/search/tool.js";

const search = {
  usage: "web_search",
  description: "Search the web.",
  schema: webSearchParameters(["tavily", "exa"]) as unknown as CommandSchema,
};
const parse = (argv: string[], stdin = "") =>
  parseSchemaArgs(search, argv, () => stdin).args;

describe("a command line from a tool's schema", () => {
  it("decodes each flag to its property's type", () => {
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

  it("leaves what the values must be to the pipeline, as --json does", () => {
    expect(parse(["--query", "x", "--max_results", "999"])).toEqual(
      parse(["--json", '{"query":"x","max_results":999}']),
    );
    expect(parse(["--query", "x", "--mode", "slow"]).mode).toBe("slow");
    expect(parse(["--max_results", "five"])).toEqual({ max_results: "five" });
  });

  it("refuses only a line it cannot read, naming the command", () => {
    const refused = (argv: string[]) => {
      try {
        parse(argv);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    for (const argv of [
      ["--query", "x", "--limit", "3"],
      ["croissants"],
      ["--json", "[1]"],
    ]) {
      const error = refused(argv);
      expect(error).toBeInstanceOf(SchemaArgsError);
      expect((error as SchemaArgsError).usage).toBe("web_search");
    }
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
    const command = {
      usage: "issues list",
      description: "",
      schema: {
        properties: {
          includeArchived: { type: "boolean" },
          filter: { type: "object" },
          state: { anyOf: [{ const: "open" }, { const: "closed" }] },
          limit: { type: ["integer", "null"], minimum: 1, maximum: 50 },
        },
      },
    };
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
  });

  it("writes --help from the schema: required, enum values, limits and defaults", () => {
    const help = schemaHelp(search);
    expect(help.split("\n")[0]).toBe(
      "Usage: web_search --query <string> [--<argument> <value> ...]",
    );
    expect(help).toMatch(/--query <string> +Required\./);
    expect(help).toContain("--mode <fast|default|deep>");
    expect(help).toMatch(/--max_results <integer> +Default 5\. From 1 to 10\./);
    expect(help).toContain("--sites <string>...");
    expect(help).toContain("--json <object|->");
    const withDefault = schemaHelp({
      usage: "mail search",
      description: "",
      schema: {
        properties: { limit: { type: "integer", minimum: 1, default: 25 } },
      },
    });
    expect(withDefault).toContain("At least 1. Default: 25.");
  });
});
