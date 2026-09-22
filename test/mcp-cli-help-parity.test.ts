import { describe, expect, it } from "vitest";

import {
  compactListArgumentError,
  mcpCallHelpText,
  mcpListHelpText,
  mcpRunHelpText,
  mcpSearchHelpText,
  parseSearchArgs,
} from "../src/mcp-cli-core.js";
import {
  createMcpCliSessionPolicy,
  validateDelegatedMcpCommand,
} from "../src/mcp-cli-policy.js";

/**
 * Help text is what an agent reads before it writes a command, so a flag
 * documented but not accepted costs a turn and a retry. These derive the
 * documented set from the help itself rather than restating it, so the two
 * cannot drift apart the way they did while help lived in two modules.
 */
/**
 * The usage line and the indented flag entries, never prose — help
 * cross-references other commands' flags (`mcp list <server.tool> --schema`)
 * and those are not this command's to accept.
 */
function documentedFlags(help: string): string[] {
  const lines = help
    .split("\n")
    .filter((line) => line.startsWith("Usage:") || line.trim().startsWith("--"));
  return [...new Set(lines.join("\n").match(/--[a-z][a-z-]+/g) ?? [])];
}

const policy = () =>
  createMcpCliSessionPolicy({
    version: 1,
    servers: [
      {
        id: "contacts",
        name: "contacts",
        base_url: "https://mcp.example.com/mcp",
        package_tools: { include: ["search_contacts"] },
        agent_tools: [{ include: ["search_contacts"] }],
        catalog: [{ name: "search_contacts" }],
      },
    ],
  });

describe("documented flags are accepted", () => {
  it("mcp search", () => {
    for (const flag of documentedFlags(mcpSearchHelpText())) {
      // --limit is the only one taking a value; the rest are bare.
      const args = flag === "--limit" ? ["q", flag, "5"] : ["q", flag];
      expect(parseSearchArgs(args).error, flag).toBeUndefined();
    }
  });

  it("mcp list", () => {
    for (const flag of documentedFlags(mcpListHelpText())) {
      const args =
        flag === "--timeout" ? ["list", flag, "5000"] : ["list", flag];
      expect(compactListArgumentError(args), flag).toBeUndefined();
    }
  });

  it("mcp call", () => {
    for (const flag of documentedFlags(mcpCallHelpText())) {
      const value = flag === "--json" ? '{"query":"Ada"}' : "text";
      expect(
        validateDelegatedMcpCommand(
          ["call", "contacts.search_contacts", flag, value],
          policy()
        ).error,
        flag
      ).toBeUndefined();
    }
  });
});

describe("the help text names the commands that exist", () => {
  it.each([
    ["search", mcpSearchHelpText],
    ["list", mcpListHelpText],
    ["call", mcpCallHelpText],
    ["run", mcpRunHelpText],
  ])("%s states its own usage line", (command, help) => {
    expect(help()).toContain(`mcp ${command}`);
  });
});
