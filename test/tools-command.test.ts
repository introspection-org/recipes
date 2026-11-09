import { describe, expect, it } from "vitest";

import { activeToolsSocket, withToolsBridge } from "../src/tools/bridge.js";
import { runToolsCommand } from "../src/tools/cli.js";

const ISSUES = {
  name: "issues",
  description: "Track work in the issue tracker.\nlinear: ...",
  parameters: {
    type: "object",
    properties: {
      command: { enum: ["search", "get"], type: "string" },
      query: { type: "string" },
      handle: { type: "string" },
    },
  },
};
const MAIL = {
  name: "mail",
  description: "The person's mail.",
  parameters: {
    anyOf: [
      {
        description: "Search the person's mail.",
        properties: { command: { const: "search" }, query: { type: "string" } },
      },
      {
        description: "Read one message.",
        properties: { command: { const: "read" }, message: { type: "string" } },
      },
    ],
  },
};
const SEARCH = {
  name: "web_search",
  description: "Search the web.",
  parameters: { type: "object", properties: { query: { type: "string" } } },
};

/**
 * Run `tools …` inside a bridge whose context answers with the call it got,
 * and with `details(name, args)` as the structured result when given.
 */
async function tools(
  argv: string[],
  stdin = "",
  details?: (name: string, args: Record<string, unknown>) => unknown,
) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const ctx = {
    tools: [
      ISSUES,
      MAIL,
      SEARCH,
      { name: "read", description: "", parameters: {} },
    ],
    executeTool: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return {
        result: {
          content: [{ type: "text", text: `${name} ${JSON.stringify(args)}` }],
          details: details?.(name, args as Record<string, unknown>),
        },
        isError: (args as { query?: string }).query === "fail",
      };
    },
  };
  let stdout = "";
  let stderr = "";
  const code = await withToolsBridge(
    ctx as never,
    ["issues", "mail", "web_search"],
    () =>
      runToolsCommand(argv, {
        env: { PI_RECIPES_TOOLS_SOCKET: activeToolsSocket()! },
        stdout: { write: (text: string) => (stdout += text) },
        stderr: { write: (text: string) => (stderr += text) },
        stdin: () => stdin,
      }),
  );
  return { code, stdout, stderr, calls };
}

describe("the tools command", () => {
  it("prints help, and refuses outside a cli agent's bash call", async () => {
    expect((await tools(["--help"])).stdout).toContain(
      "tools call <tool>.<command>",
    );
    let stderr = "";
    const code = await runToolsCommand(["list"], {
      env: {},
      stdout: { write: () => true },
      stderr: { write: (text: string) => (stderr += text) },
    });
    expect(code).toBe(69);
    expect(stderr).toContain("tools.mode is not cli");
  });

  it("lists only the platform tools, and a tool's commands", async () => {
    const all = await tools(["list"]);
    expect(all.stdout).toBe(
      "issues — Track work in the issue tracker.\nmail — The person's mail.\nweb_search — Search the web.\n",
    );
    expect((await tools(["list", "issues"])).stdout).toBe(
      "issues.search\nissues.get\n",
    );
    expect((await tools(["list", "mail"])).stdout).toBe(
      "mail.search — Search the person's mail.\nmail.read — Read one message.\n",
    );
    expect((await tools(["list", "mail", "--schema"])).stdout).toContain(
      'mail.read {"message":{"type":"string"}}',
    );
    expect((await tools(["list", "read"])).code).toBe(64);
  });

  it("searches commands by their words", async () => {
    const found = await tools(["search", "mail read"]);
    expect(found.stdout.split("\n")[0]).toMatch(/^mail\.read/);
  });

  it("calls one command, and a tool with none, through the session", async () => {
    const one = await tools([
      "call",
      "issues.search",
      "--json",
      '{"query":"checkout"}',
    ]);
    expect(one.calls).toEqual([
      { name: "issues", args: { query: "checkout", command: "search" } },
    ]);
    expect(one.stdout).toBe('issues {"query":"checkout","command":"search"}\n');
    const plain = await tools([
      "call",
      "web_search",
      "--json",
      '{"query":"pi"}',
    ]);
    expect(plain.calls).toEqual([
      { name: "web_search", args: { query: "pi" } },
    ]);
    const failed = await tools([
      "call",
      "issues.search",
      "--json",
      '{"query":"fail"}',
    ]);
    expect(failed.code).toBe(1);
    const outside = await tools(["call", "read", "--json", "{}"]);
    expect(outside.code).toBe(64);
    expect(outside.stderr).toContain("not a first-party tool");
  });

  it("runs a script composing several calls", async () => {
    const run = await tools(
      ["run"],
      [
        'const found = await tools.issues.search({ query: "a" });',
        'const mail = await tools.mail.read({ message: "m1" });',
        "return [found, mail];",
      ].join("\n"),
    );
    expect(run.code).toBe(0);
    expect(run.calls.map((call) => call.name)).toEqual(["issues", "mail"]);
    expect(JSON.parse(run.stdout)).toEqual([
      'issues {"query":"a","command":"search"}',
      'mail {"message":"m1","command":"read"}',
    ]);
  });

  it("hands a script each call's structured result, so one call builds the next", async () => {
    const details = (name: string, args: Record<string, unknown>) =>
      name !== "issues"
        ? undefined
        : args.command === "search"
          ? { issues: [{ handle: "ENG-1", title: "Checkout fails" }] }
          : { handle: args.handle, title: "Checkout fails" };
    const run = await tools(
      ["run"],
      [
        'const found = await tools.issues.search({ query: "checkout" });',
        "return await tools.issues.get({ handle: found.issues[0].handle });",
      ].join("\n"),
      details,
    );
    expect(run.stderr).toBe("");
    expect(run.calls[1]).toEqual({
      name: "issues",
      args: { handle: "ENG-1", command: "get" },
    });
    expect(JSON.parse(run.stdout)).toEqual({
      handle: "ENG-1",
      title: "Checkout fails",
    });
    const call = await tools(
      ["call", "issues.search", "--json", '{"query":"checkout"}'],
      "",
      details,
    );
    expect(call.stdout).toBe(
      'issues {"query":"checkout","command":"search"}\n',
    );
  });
});
