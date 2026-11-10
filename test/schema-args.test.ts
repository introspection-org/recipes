import { describe, expect, it } from "vitest";

import {
  type JsonSchema,
  parseSchemaArgs,
  SchemaArgsError,
  schemaGroupHelp,
  schemaHelp,
  takeOptions,
} from "../src/cli/schema-args.js";
import { webSearchParameters } from "../src/search/tool.js";

const search = {
  path: ["web_search"],
  description: "Search the web.",
  schema: webSearchParameters(["tavily", "exa"]) as unknown as JsonSchema,
};
const parse = (argv: string[], stdin = "") =>
  parseSchemaArgs(search, argv, () => stdin).args;

describe("a command line from a tool's schema", () => {
  it("decodes each flag to its property's type", () => {
    expect(
      parse([
        "--query",
        "croissants",
        "--max-results",
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

  it("reads a third-party schema: flags what it can, --json for the rest", () => {
    // An MCP server's inputSchema, as a server might write it.
    const command = {
      path: ["github", "create_issue"],
      description: "Create an issue in a repository.",
      schema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          title: { type: "string", description: "Issue title" },
          draft: { type: "boolean" },
          labels: { type: "array", items: { type: "string" } },
          state: { anyOf: [{ const: "open" }, { const: "closed" }] },
          priority: { enum: [1, 2, 3] },
          limit: { type: ["integer", "null"], minimum: 1, maximum: 50 },
          milestone: {},
          body: {
            type: "object",
            properties: { text: { type: "string" } },
          },
          assignee: {
            anyOf: [{ type: "string" }, { type: "object" }],
          },
          template: { $ref: "#/definitions/Template" },
          x_custom: { "x-vendor-extension": true, type: "string" },
        },
        required: ["title", "body"],
        definitions: { Template: { type: "object" } },
      },
    };
    const args = (argv: string[], stdin = "") =>
      parseSchemaArgs(command, argv, () => stdin).args;
    expect(
      args([
        "--title",
        "Broken build",
        "--draft",
        "--labels",
        "bug",
        "--labels",
        "ci",
        "--state",
        "open",
        "--priority",
        "2",
        "--limit",
        "10",
        "--milestone",
        "7",
        "--x_custom",
        "v",
      ]),
    ).toEqual({
      title: "Broken build",
      draft: true,
      labels: ["bug", "ci"],
      state: "open",
      priority: 2,
      limit: 10,
      milestone: 7,
      x_custom: "v",
    });
    expect(args(["--no-draft", "--milestone", "v1.2"])).toEqual({
      draft: false,
      milestone: "v1.2",
    });
    // Nested, union and $ref properties are --json only.
    expect(() => args(["--body", "{}"])).toThrow(SchemaArgsError);
    expect(
      args(
        ["--json", "-", "--title", "t"],
        '{"body":{"text":"x"},"template":{}}',
      ),
    ).toEqual({ body: { text: "x" }, template: {}, title: "t" });
    const help = schemaHelp(command, "mcp list github --schema");
    expect(help).toContain(
      "Every argument as one JSON object (`mcp list github --schema` prints its schema)",
    );
    expect(help.split("\n")[0]).toBe(
      "Usage: github create_issue --title <string> [--<argument> <value> ...]",
    );
    expect(help).toContain("--state <open|closed>");
    expect(help).toContain("--priority <1|2|3>");
    expect(help).toContain("--labels <string>...");
    expect(help).toContain("--milestone <value>");
    expect(help).toMatch(
      /Only through --json:\n {2}body +Required\.\n {2}assignee\n {2}template/,
    );
  });

  it("takes name=value words, and unknown arguments when asked", () => {
    const command = {
      path: ["mcp", "call", "s.t"],
      description: "",
      schema: {
        properties: {
          id: { type: "string" },
          limit: { type: "number" },
          filter: { type: "object" },
        },
      },
    };
    const parse = (argv: string[], unknown = false) =>
      parseSchemaArgs(command, argv, undefined, {
        assignments: true,
        unknown,
      });
    expect(parse(["id=7", "limit=5", 'filter={"a":1}'])).toEqual({
      help: false,
      args: { id: "7", limit: 5, filter: { a: 1 } },
    });
    expect(parse(['id="7"']).args).toEqual({ id: "7" });
    expect(() => parse(["nope=1"])).toThrow("unknown argument 'nope'");
    expect(() => parse(["loose"])).toThrow("is not name=value or a --flag");
    expect(parse(["nope=1", "--other", "x"], true).args).toEqual({
      nope: 1,
      other: "x",
    });
    expect(() => parseSchemaArgs(command, ["id=7"], undefined, {})).toThrow(
      SchemaArgsError,
    );
  });

  it("takes the caller's own options out and leaves every other word as it was", () => {
    const names = { timeout: "string", quiet: "boolean" } as const;
    expect(
      takeOptions(
        ["--flag", "--timeout", "100", "--other=x", "a=b", "--quiet"],
        names,
      ),
    ).toEqual({
      options: { timeout: "100", quiet: true },
      rest: ["--flag", "--other=x", "a=b"],
    });
    expect(takeOptions(["--timeout=5", "--note", "x"], names)).toEqual({
      options: { timeout: "5" },
      rest: ["--note", "x"],
    });
    // Nothing after -- is read; a value never starts with --.
    expect(takeOptions(["--", "--timeout", "1"], names).rest).toEqual([
      "--",
      "--timeout",
      "1",
    ]);
    expect(() => takeOptions(["--timeout", "--quiet"], names)).toThrow(
      "Flag '--timeout' requires a value.",
    );
  });

  it("refuses a name assigned twice, but not a flag's value that looks like one", () => {
    const command = {
      path: ["mcp", "call", "s.t"],
      description: "",
      schema: {
        properties: {
          tag: { type: "array", items: { type: "string" } },
          query: { type: "string" },
        },
      },
    };
    const parse = (argv: string[]) =>
      parseSchemaArgs(command, argv, undefined, { assignments: true }).args;
    expect(parse(["--tag", "name=a", "--tag", "name=b"])).toEqual({
      tag: ["name=a", "name=b"],
    });
    expect(() => parse(["query=Ada", "query=Grace"])).toThrow(
      "argument 'query' was passed more than once",
    );
  });

  it("names flags in kebab-case and keeps each property's own name as an alias", () => {
    const command = {
      path: ["t"],
      description: "",
      schema: {
        properties: {
          maxResults: { type: "integer" },
          time_zone: { type: "string" },
          multipleBlocks: { type: "boolean" },
        },
      },
    };
    const args = (argv: string[]) => parseSchemaArgs(command, argv).args;
    const expected = { maxResults: 5, time_zone: "UTC", multipleBlocks: true };
    expect(
      args(["--max-results", "5", "--time-zone", "UTC", "--multiple-blocks"]),
    ).toEqual(expected);
    expect(
      args(["--maxResults", "5", "--time_zone", "UTC", "--multipleBlocks"]),
    ).toEqual(expected);
    expect(args(["--no-multiple-blocks"])).toEqual({ multipleBlocks: false });
    expect(args(["--no-multipleBlocks"])).toEqual({ multipleBlocks: false });
    const help = schemaHelp(command, "tools list t --schema");
    expect(help).toContain("--max-results <integer>");
    expect(help).toContain("--time-zone <string>");
    expect(help).toContain("--no-multiple-blocks for false.");
    expect(help).not.toMatch(/--maxResults|--time_zone|--multipleBlocks/);
    expect(
      parseSchemaArgs(command, ["time_zone=UTC"], undefined, {
        assignments: true,
      }).args,
    ).toEqual({ time_zone: "UTC" });
  });

  it("reads a flag and its alias as one argument, in the order given", () => {
    const command = {
      path: ["t"],
      description: "",
      schema: {
        properties: {
          multipleBlocks: { type: "boolean" },
          orderedItems: { type: "array", items: { type: "string" } },
          query: { type: "string" },
          max_results: { type: "integer" },
        },
      },
    };
    const args = (argv: string[]) =>
      parseSchemaArgs(
        command,
        argv,
        () => {
          throw new Error("stdin was read");
        },
        { assignments: true },
      ).args;
    expect(args(["--multipleBlocks", "--no-multiple-blocks"])).toEqual({
      multipleBlocks: false,
    });
    expect(args(["--no-multiple-blocks", "--multipleBlocks"])).toEqual({
      multipleBlocks: true,
    });
    expect(args(["--no-multipleBlocks", "--multiple-blocks"])).toEqual({
      multipleBlocks: true,
    });
    expect(args(["--max_results", "3", "--max-results", "5"])).toEqual({
      max_results: 5,
    });
    expect(
      args(["--orderedItems", "first", "--ordered-items", "second"]),
    ).toEqual({ orderedItems: ["first", "second"] });
    // A flag's value is the flag's, whatever it looks like; stdin is not read.
    expect(args(["--query=--json"])).toEqual({ query: "--json" });
    expect(args(["--query", 'key="1"'])).toEqual({ query: 'key="1"' });
    expect(args(["--query", "-"])).toEqual({ query: "-" });
    expect(args(["--query=--multipleBlocks"])).toEqual({
      query: "--multipleBlocks",
    });
    expect(() => args(["--query", "a", "query=b"])).toThrow(
      "argument 'query' was passed more than once",
    );
  });

  it("gives no flag to a property whose flag the caller reserves", () => {
    const command = {
      path: ["mcp", "call", "s.t"],
      description: "",
      schema: {
        properties: {
          name: { type: "string" },
          timeout: { type: "integer" },
          oauth: { type: "boolean" },
          query: { type: "string" },
        },
      },
      reserved: ["name", "timeout", "no-oauth"],
    };
    const help = schemaHelp(command, "mcp list s.t --schema");
    expect(help).toContain("--query <string>");
    expect(help).not.toMatch(/--name|--timeout|--oauth|--no-oauth/);
    expect(help).toMatch(
      /Only through --json:\n {2}name\n {2}timeout\n {2}oauth/,
    );
    const parse = (argv: string[]) =>
      parseSchemaArgs(command, argv, undefined, { assignments: true }).args;
    expect(parse(["name=Ada", "timeout=5", "oauth=false"])).toEqual({
      name: "Ada",
      timeout: 5,
      oauth: false,
    });
    expect(() => parse(["--name", "Ada"])).toThrow(SchemaArgsError);
  });

  it("reads a nullable scalar as its type, and keeps a string a string", () => {
    const command = {
      path: ["mcp", "call", "s.t"],
      description: "",
      schema: {
        properties: {
          id: { anyOf: [{ type: "string" }, { type: "null" }] },
          count: { oneOf: [{ type: "integer" }, { type: "null" }] },
          key: { anyOf: [{ type: "string" }, { type: "object" }] },
        },
      },
    };
    const parse = (argv: string[]) =>
      parseSchemaArgs(command, argv, undefined, { assignments: true }).args;
    expect(parse(["id=123", "count=4", "key=55"])).toEqual({
      id: "123",
      count: 4,
      key: "55",
    });
    expect(parse(["--id", "123", "--count", "4"])).toEqual({
      id: "123",
      count: 4,
    });
    expect(parse(['key={"a":1}'])).toEqual({ key: { a: 1 } });
    expect(schemaHelp(command, "x")).toContain("--id <string>");
  });

  it("reads null for a property that takes it, and JSON for an untyped one", () => {
    const command = {
      path: ["mcp", "call", "s.t"],
      description: "",
      schema: {
        properties: {
          slaBreachesAt: { type: ["string", "null"] },
          slaType: { anyOf: [{ type: "string" }, { type: "null" }] },
          name: { type: "string" },
          payload: {},
        },
      },
    };
    const parse = (argv: string[], unknown = false) =>
      parseSchemaArgs(command, argv, undefined, { assignments: true, unknown })
        .args;
    expect(parse(["slaBreachesAt=null", "slaType=null", "name=null"])).toEqual({
      slaBreachesAt: null,
      slaType: null,
      name: "null",
    });
    expect(parse(['slaBreachesAt="null"'])).toEqual({ slaBreachesAt: "null" });
    expect(parse(["--sla-breaches-at", "null"])).toEqual({
      slaBreachesAt: null,
    });
    expect(parse(['payload={"a":1}'])).toEqual({ payload: { a: 1 } });
    expect(parse(["payload=[1,2]"])).toEqual({ payload: [1, 2] });
    expect(parse(["payload=null"])).toEqual({ payload: null });
    expect(parse(['payload="x"'])).toEqual({ payload: "x" });
    expect(parse(["--payload", '{"a":1}'])).toEqual({ payload: { a: 1 } });
    // With no schema to read, every argument is untyped.
    expect(parse(['other={"b":2}', "--more", "[3]"], true)).toEqual({
      other: { b: 2 },
      more: [3],
    });
  });

  it("keeps a boolean whose kebab flag would start with no- on its own name", () => {
    const command = {
      path: ["t"],
      description: "",
      schema: {
        properties: {
          no_cache: { type: "boolean" },
          noRetry: { type: "boolean" },
        },
      },
    };
    const parse = (argv: string[]) => parseSchemaArgs(command, argv).args;
    expect(parse(["--no_cache", "--noRetry"])).toEqual({
      no_cache: true,
      noRetry: true,
    });
    const help = schemaHelp(command, "x");
    expect(help).toContain("--no_cache");
    expect(help).toContain("--noRetry");
    expect(help).not.toMatch(/--no-cache|--no-retry/);
  });

  it("keeps the exact names where kebab-case would collide", () => {
    const command = {
      path: ["t"],
      description: "",
      schema: {
        properties: {
          page_size: { type: "integer" },
          pageSize: { type: "integer" },
          cache: { type: "boolean" },
          no_cache: { type: "string" },
          plain: { type: "string" },
        },
      },
    };
    const help = schemaHelp(command, "tools list t --schema");
    for (const flag of [
      "--page_size",
      "--pageSize",
      "--cache ",
      "--no_cache",
      "--plain",
    ])
      expect(help).toContain(flag);
    expect(help).not.toContain("--page-size");
    expect(help).not.toContain("--no-cache <");
    const args = (argv: string[]) => parseSchemaArgs(command, argv).args;
    expect(args(["--page_size", "1", "--pageSize", "2"])).toEqual({
      page_size: 1,
      pageSize: 2,
    });
    expect(args(["--no-cache", "--no_cache", "x"])).toEqual({
      cache: false,
      no_cache: "x",
    });
  });

  it("lists a group's commands with their first sentence", () => {
    expect(
      schemaGroupHelp(
        ["github"],
        "GitHub's tools. More text.",
        [
          {
            path: ["github", "create_issue"],
            description: "Create an issue. Then more.",
            schema: {},
          },
          { path: ["github", "list_issues"], description: "", schema: {} },
        ],
        "mcp list github --schema",
      ),
    ).toBe(
      [
        "Usage: github <command> [--<argument> <value> ...]",
        "",
        "GitHub's tools.",
        "",
        "Commands:",
        "  create_issue  Create an issue.",
        "  list_issues   ",
        "",
        "Run `github <command> --help` for a command's arguments, or `mcp list github --schema` for the JSON each takes.",
      ].join("\n"),
    );
  });

  it("writes --help from the schema: required, enum values, limits and defaults", () => {
    const help = schemaHelp(search, "tools list web_search --schema");
    expect(help.split("\n")[0]).toBe(
      "Usage: web_search --query <string> [--<argument> <value> ...]",
    );
    expect(help).toMatch(/--query <string> +Required\./);
    expect(help).toContain("--mode <fast|default|deep>");
    expect(help).toMatch(/--max-results <integer> +Default 5\. From 1 to 10\./);
    expect(help).not.toContain("--max_results");
    expect(help).toContain("--sites <string>...");
    expect(help).toContain("--json <object|->");
    const withDefault = schemaHelp(
      {
        path: ["mail", "search"],
        description: "",
        schema: {
          properties: { limit: { type: "integer", minimum: 1, default: 25 } },
        },
      },
      "tools list mail --schema",
    );
    expect(withDefault).toContain("At least 1. Default: 25.");
  });
});
