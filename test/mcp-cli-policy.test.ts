import { describe, expect, it } from "vitest";
import {
  createMcpCliSessionPolicy,
  validateDelegatedMcpCommand,
} from "../src/mcp/cli/policy.js";

function policy() {
  return createMcpCliSessionPolicy(
    {
      version: 1,
      servers: [
        {
          id: "contacts",
          name: "contacts",
          base_url: "https://mcp.example.com/mcp",
          package_tools: { include: ["search_contacts", "get_contact"] },
          agent_tools: [{ include: ["search_contacts", "get_contact"] }],
          catalog: [
            {
              name: "search_contacts",
              input_schema: {
                type: "object",
                properties: { query: { type: "string" }, pageSize: { type: "number" } },
              },
            },
            { name: "get_contact" },
          ],
        },
      ],
    }
  );
}

describe("recipe-session mcporter policy", () => {
  it("allows documented list flags and forces headless authentication", () => {
    expect(
      validateDelegatedMcpCommand(
        ["list", "contacts.search_contacts", "--schema", "--timeout", "1000"],
        policy()
      )
    ).toEqual({
      command: {
        args: [
          "list",
          "contacts.search_contacts",
          "--schema",
          "--timeout",
          "1000",
          "--no-oauth",
        ],
      },
    });
  });

  it.each([
    ["--schema", "--all-parameters"],
    ["--schema", "--status"],
  ])("rejects combined list output modes: %s %s", (left, right) => {
    expect(
      validateDelegatedMcpCommand(
        ["list", "contacts.search_contacts", left, right],
        policy()
      ).error
    ).toBe(
      "mcp list accepts only one output mode: --schema, --all-parameters, or --status."
    );
  });

  it("allows safe call formatting and file arguments", () => {
    const result = validateDelegatedMcpCommand(
      [
        "call",
        "contacts.search_contacts",
        "query=@request.txt",
        "--output",
        "json",
      ],
      policy()
    );
    expect(result.command?.args.at(-1)).toBe("--no-oauth");
  });

  it("rejects image persistence in recipe sessions", () => {
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.search_contacts", "--save-images", "artifacts"],
        policy()
      ).error
    ).toContain("unavailable");
  });

  it("rejects overlapping call syntaxes", () => {
    expect(
      validateDelegatedMcpCommand(
        ['call', 'contacts.search_contacts(query: "docs/readme.md")'],
        policy()
      ).error
    ).toContain("requires an exact session tool selector");
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.search_contacts", "--future-mcporter-option", "value"],
        policy()
      ).error
    ).toContain("use key=value or --json");
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.search_contacts", "--query", "Ada", "--page-size=25"],
        policy()
      ).error
    ).toContain("use key=value or --json");
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.search_contacts", "query:Ada"],
        policy()
      ).error
    ).toContain("must use key=value syntax");
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.search_contacts", "--", "Ada"],
        policy()
      ).error
    ).toContain("positional arguments are unavailable");
  });

  it("corrects a split server and tool selector", () => {
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts", "search_contacts", '{"query":"Ada"}'],
        policy()
      ).error
    ).toContain("Use mcp call contacts.search_contacts key=value or --json");
  });

  it.each([
    ["list", "contacts", "--brief"],
    ["list", "contacts", "--signatures"],
    ["list", "contacts", "--no-oauth"],
    ["call", "contacts.search_contacts", "--args", "{}"],
    ["call", "contacts.search_contacts", "--no-oauth"],
    ["call", "contacts.search_contacts", "--raw-strings"],
  ])("rejects removed compatibility syntax: %j", (...args) => {
    const error = validateDelegatedMcpCommand(args as string[], policy()).error;
    if (args.includes("--args")) expect(error).toContain("use --json");
    else expect(error).toContain("unavailable");
  });

  it.each([
    ["list", "--http-url", "https://attacker.example/mcp"],
    ["list", "https://attacker.example/mcp"],
    ["list", "--verbose", "https://attacker.example/mcp"],
    ["list", "--verbose", "attacker.example/mcp"],
    ["call", "https://attacker.example/mcp.fetch"],
    ["call", "contacts.search_contacts", "--config", "/tmp/other.json"],
    ["call", "contacts.search_contacts", "--stdio", "node rogue.mjs"],
    ["call", "contacts.search_contacts", "--tail-log"],
    ["call", "contacts.search_contacts", "--timeout", "--config", "/tmp/other.json"],
    ["config", "add", "rogue", "https://attacker.example/mcp"],
    ["resource", "contacts"],
    ["generate-cli", "contacts"],
    ["emit-ts", "contacts", "--out", "/tmp/client.ts"],
    ["record", "capture"],
    ["daemon", "start"],
    ["serve", "--http", "9999"],
  ])("blocks commands or escape hatches: %j", (...args) => {
    const result = validateDelegatedMcpCommand(args as string[], policy());
    expect(result.error).toMatch(/unavailable|only tools materialized|only servers materialized/);
  });

  it("rejects tools outside the final materialized inventory", () => {
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.delete_workspace"],
        policy()
      ).error
    ).toContain("is not available");
  });

  it("suggests close session server and tool names without auto-calling them", () => {
    expect(
      validateDelegatedMcpCommand(
        ["call", "contact.search_contacts"],
        policy()
      ).error
    ).toContain("Did you mean 'contacts'");
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.search_contact"],
        policy()
      ).error
    ).toContain("Did you mean 'search_contacts'");
  });

  it("keeps calls headless even when the projected transport uses OAuth", () => {
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.search_contacts"],
        policy()
      )
    ).toEqual({
      command: {
        args: ["call", "contacts.search_contacts", "--no-oauth"],
      },
    });
  });

  it("rejects interactive authentication with deployment-neutral recovery", () => {
    expect(validateDelegatedMcpCommand(["auth", "contacts"], policy()).error).toContain(
      "Ask the user to authenticate this MCP connection outside the agent session"
    );
  });
});
