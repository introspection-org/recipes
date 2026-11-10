import { describe, expect, it } from "vitest";

import {
  type JsonSchema,
  parseSchemaArgs,
  SchemaArgsError,
  schemaGroupHelp,
  schemaHelp,
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
    expect(help).toMatch(/--max_results <integer> +Default 5\. From 1 to 10\./);
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
