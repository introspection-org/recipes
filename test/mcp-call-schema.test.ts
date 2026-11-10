import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type JsonSchema,
  parseSchemaArgs,
  schemaHelp,
  takeOptions,
} from "../src/cli/schema-args.js";

// The public MCP reference server's app servers, which list their tools with
// no credential (its main /mcp endpoint needs OAuth). Refresh with:
//   node scripts/capture-mcp-tools.mjs test/fixtures/mcp/example-server-apps.json \
//     https://example-server.modelcontextprotocol.io/{debug,map,pdf,customer-segmentation,scenario-modeler,threejs}/mcp
// MCP_EXAMPLE_LIVE=1 checks the fixture against the live servers.
const FIXTURE = "test/fixtures/mcp/example-server-apps.json";

interface FixtureTool {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}
interface Fixture {
  servers: Array<{ url: string; tools: FixtureTool[] }>;
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
const serverOf = (url: string) => url.split("/").at(-2)!;
const tools = fixture.servers.flatMap((server) =>
  server.tools.map((tool) => ({ server: serverOf(server.url), tool })),
);

function command(server: string, name: string) {
  const { tool } = tools.find(
    (entry) => entry.server === server && entry.tool.name === name,
  )!;
  return {
    path: ["mcp", "call", `${server}.${name}`],
    description: tool.description ?? "",
    schema: tool.inputSchema,
  };
}
const help = (server: string, name: string) =>
  schemaHelp(command(server, name), `mcp list ${server}.${name} --schema`);
const decode = (server: string, name: string, argv: string[], stdin = "") =>
  parseSchemaArgs(command(server, name), argv, () => stdin, {
    assignments: true,
  }).args;

/** The arguments a help lists: flags, then those only --json reaches. */
function listed(text: string): string[] {
  const flags = [...text.matchAll(/^ {2}--(\w+)/gm)].map((match) => match[1]!);
  const jsonOnly = text.includes("Only through --json:")
    ? [
        ...text
          .split("Only through --json:\n")[1]!
          .split("\n\n")[0]!
          .matchAll(/^ {2}(\w+)/gm),
      ].map((match) => match[1]!)
    : [];
  return [...flags, ...jsonOnly].filter(
    (name) => name !== "json" && name !== "help",
  );
}

describe("the schema CLI on a real MCP server's tools", () => {
  it("builds help for every tool the fixture holds", () => {
    expect(tools.length).toBeGreaterThan(10);
    for (const { server, tool } of tools) {
      const text = help(server, tool.name);
      expect(listed(text).sort(), `${server}.${tool.name}`).toEqual(
        Object.keys(
          (tool.inputSchema.properties as Record<string, unknown>) ?? {},
        ).sort(),
      );
    }
  });

  it("shows required arguments, enums, defaults and descriptions", () => {
    const geocode = help("map", "geocode");
    expect(geocode.split("\n")[0]).toBe(
      "Usage: mcp call map.geocode --query <string>",
    );
    expect(geocode).toMatch(/--query <string> +Required\./);
    const debug = help("debug", "debug-tool");
    expect(debug).toContain(
      "--contentType <text|image|audio|resource|resourceLink|mixed>",
    );
    expect(debug).toMatch(/Default: "text"\./);
    expect(debug).toMatch(
      /--simulateError +.*Default: false\..*--no-simulateError for false\./,
    );
    expect(debug).toContain(
      "(`mcp list debug.debug-tool --schema` prints its schema)",
    );
  });

  it("leaves a nested object and an untyped argument where they can be reached", () => {
    const scenario = help("scenario-modeler", "get-scenario-data");
    expect(scenario).toMatch(/Only through --json:\n {2}customInputs/);
    expect(
      decode("scenario-modeler", "get-scenario-data", [
        'customInputs={"months":12}',
      ]),
    ).toEqual({ customInputs: { months: 12 } });
    const log = help("debug", "debug-log");
    expect(log).toMatch(/--type <string> +Required\./);
    expect(listed(log)).toContain("payload");
  });

  it("decodes key=value, --flag and --json to the same arguments", () => {
    const expected = {
      contentType: "text",
      multipleBlocks: true,
      delayMs: 5,
    };
    expect(
      decode("debug", "debug-tool", [
        "contentType=text",
        "multipleBlocks=true",
        "delayMs=5",
      ]),
    ).toEqual(expected);
    expect(
      decode("debug", "debug-tool", [
        "--contentType",
        "text",
        "--multipleBlocks",
        "--delayMs",
        "5",
      ]),
    ).toEqual(expected);
    expect(
      decode("debug", "debug-tool", ["--json", "-"], JSON.stringify(expected)),
    ).toEqual(expected);
  });

  it("keeps a numeric-looking value of a string argument a string", () => {
    expect(decode("map", "geocode", ["query=94110"])).toEqual({
      query: "94110",
    });
    expect(decode("map", "geocode", ["--query", "94110"])).toEqual({
      query: "94110",
    });
    expect(decode("pdf", "read_pdf_bytes", ["url=x", "offset=10"])).toEqual({
      url: "x",
      offset: 10,
    });
  });

  it("reads name=@path as the file's text, and @@ as a literal @", () => {
    const dir = mkdtempSync(join(tmpdir(), "schema-args-"));
    writeFileSync(join(dir, "q.txt"), "Mission District");
    expect(decode("map", "geocode", [`query=@${join(dir, "q.txt")}`])).toEqual({
      query: "Mission District",
    });
    expect(decode("map", "geocode", ["query=@@home"])).toEqual({
      query: "@home",
    });
  });

  it("reads booleans and --timeout anywhere, as mcp call does", () => {
    // mcp call takes its own options out first, then reads the rest by schema.
    const call = (argv: string[]) => {
      const { options, rest } = takeOptions(argv, {
        timeout: "string",
        output: "string",
      });
      return { options, args: decode("debug", "debug-tool", rest) };
    };
    expect(call(["--multipleBlocks"]).args).toEqual({ multipleBlocks: true });
    expect(call(["--no-multipleBlocks"]).args).toEqual({
      multipleBlocks: false,
    });
    expect(call(["--simulateError", "--delayMs", "5"]).args).toEqual({
      simulateError: true,
      delayMs: 5,
    });
    expect(
      call(["--timeout", "100", "--includeMeta", "contentType=text"]),
    ).toEqual({
      options: { timeout: "100" },
      args: { includeMeta: true, contentType: "text" },
    });
    expect(call(["--includeMeta", "--timeout", "100"])).toEqual({
      options: { timeout: "100" },
      args: { includeMeta: true },
    });
  });

  it("keeps a file's text and a quoted string exact, whatever the schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "schema-args-"));
    writeFileSync(join(dir, "n.txt"), "123");
    const payload = (argv: string[], stdin = "") =>
      decode("debug", "debug-log", ["type=info", ...argv], stdin).payload;
    expect(payload([`payload=@${join(dir, "n.txt")}`])).toBe("123");
    expect(payload(['payload="123"'])).toBe("123");
    expect(payload(["payload=123"])).toBe(123);
    expect(payload(["--json", "-"], '{"payload":"123"}')).toBe("123");
    expect(
      decode("pdf", "read_pdf_bytes", ["url=x", 'offset="10"']).offset,
    ).toBe("10");
  });

  it.skipIf(!process.env.MCP_EXAMPLE_LIVE)("matches the live servers", () => {
    const out = join(mkdtempSync(join(tmpdir(), "mcp-live-")), "tools.json");
    execFileSync(process.execPath, [
      "scripts/capture-mcp-tools.mjs",
      out,
      ...fixture.servers.map((server) => server.url),
    ]);
    const live = JSON.parse(readFileSync(out, "utf8")) as Fixture;
    const names = (value: Fixture) =>
      value.servers.map((server) => server.tools.map((tool) => tool.name));
    expect(names(live)).toEqual(names(fixture));
  });
});
