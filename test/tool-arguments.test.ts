import { describe, expect, it } from "vitest";

import { CHANNELS_ARGUMENTS } from "../src/channels/arguments.generated.js";
import {
  registerChannelTools,
  type ChannelAdapter,
} from "../src/channels/index.js";
import {
  commandSignature,
  type ObjectSchema,
} from "../src/command-parameters.js";
import {
  CALENDAR_ARGUMENTS,
  DRIVE_ARGUMENTS,
  MAIL_ARGUMENTS,
} from "../src/productivity/arguments.generated.js";
import { ISSUES_ARGUMENTS } from "../src/issues/arguments.generated.js";
import { registerProductivityTools } from "../src/productivity/index.js";
import {
  PRODUCTIVITY_COMMAND_EFFECTS,
  PRODUCTIVITY_COMMANDS,
  PRODUCTIVITY_TOOLS,
  type ProductivityCapabilities,
} from "../src/productivity/types.js";
import { registerIssuesTool } from "../src/issues/tool.js";
import { activeToolsSocket, withToolsBridge } from "../src/tools/bridge.js";
import { runToolsCommand } from "../src/tools/cli.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const GENERATED: Record<string, Record<string, ObjectSchema>> = {
  mail: MAIL_ARGUMENTS,
  calendar: CALENDAR_ARGUMENTS,
  drive: DRIVE_ARGUMENTS,
  channels: CHANNELS_ARGUMENTS,
  issues: ISSUES_ARGUMENTS,
};

interface RegisteredTool {
  description: string;
  parameters: { anyOf: ObjectSchema[] };
}

/** Every command of `tool` has its own line, led by its signature. */
function expectSignatures(tool: RegisteredTool) {
  expect(tool.description).not.toMatch(/\{\w+\}/);
  for (const variant of tool.parameters.anyOf) {
    const command = (variant.properties.command as { const: string }).const;
    const lines = tool.description
      .split("\n")
      .filter(
        (line) =>
          line.startsWith(`${command} {`) || line.startsWith(`${command}:`),
      );
    expect(lines, command).toEqual([
      `${commandSignature(command, variant)}: ${variant.description}`,
    ]);
  }
}

function everyCommand(mail: {
  labels: "labels" | "categories";
  folders: "folders" | "labels";
}): ProductivityCapabilities {
  const capabilities: Record<string, unknown> = {};
  for (const tool of PRODUCTIVITY_TOOLS) {
    const effects = PRODUCTIVITY_COMMAND_EFFECTS[tool] as Record<
      string,
      string
    >;
    capabilities[tool] = {
      ...(tool === "mail" ? mail : {}),
      commands: Object.fromEntries(
        PRODUCTIVITY_COMMANDS[tool].map((command) => [
          command,
          { effect: effects[command], backend: "rest" },
        ]),
      ),
    };
  }
  return capabilities as ProductivityCapabilities;
}

const implemented = async () => ({}) as never;
const STUB_ADAPTER = {
  provider: "stub",
  capabilities: {
    targeting: true,
    list: true,
    react: true,
    edit: true,
    retract: true,
    read: "channel",
    attach: true,
    fetchFile: true,
    documents: "native",
  },
  reply: implemented,
  send: implemented,
  list: implemented,
  read: implemented,
  react: implemented,
  edit: implemented,
  retract: implemented,
  attach: implemented,
  fetchFile: implemented,
  postDocument: implemented,
} as unknown as ChannelAdapter;

describe("first-party tool arguments", () => {
  it("describe every field of every command", () => {
    for (const [tool, commands] of Object.entries(GENERATED)) {
      for (const [command, schema] of Object.entries(commands)) {
        for (const [field, property] of Object.entries(schema.properties)) {
          expect(
            String(property.description ?? "").trim(),
            `${tool} ${command} ${field}`,
          ).not.toBe("");
        }
      }
    }
  });

  it("cover every productivity command", () => {
    for (const tool of PRODUCTIVITY_TOOLS)
      expect(Object.keys(GENERATED[tool]!)).toEqual([
        ...PRODUCTIVITY_COMMANDS[tool],
      ]);
  });

  it("lead each productivity command's description line with its signature", () => {
    for (const mail of [
      { labels: "labels", folders: "labels" },
      { labels: "categories", folders: "folders" },
    ] as const) {
      const pi = createMockExtensionAPI();
      registerProductivityTools(pi as never, {
        provider: "fake",
        capabilities: everyCommand(mail),
        tools: Object.fromEntries(
          PRODUCTIVITY_TOOLS.map((tool) => [tool, PRODUCTIVITY_COMMANDS[tool]]),
        ),
        cwd: "/nonexistent",
        downloadsDir: "/nonexistent",
        session: () => {
          throw new Error("not called");
        },
      });
      for (const tool of PRODUCTIVITY_TOOLS)
        expectSignatures(pi.tools.get(tool) as unknown as RegisteredTool);
    }
    expect(commandSignature("draft", MAIL_ARGUMENTS.draft)).toBe(
      "draft { body, to?, cc?, subject?, reply_to? }",
    );
    expect(commandSignature("list", CALENDAR_ARGUMENTS.list)).toBe(
      "list { from?, to?, calendar?, limit?, cursor? }",
    );
  });

  it("leave the signature out in codemode, whose TypeScript type carries it", () => {
    const pi = createMockExtensionAPI();
    registerProductivityTools(pi as never, {
      provider: "fake",
      capabilities: everyCommand({ labels: "labels", folders: "labels" }),
      tools: { mail: PRODUCTIVITY_COMMANDS.mail },
      exposure: () => "codemode",
      cwd: "/nonexistent",
      downloadsDir: "/nonexistent",
      session: () => {
        throw new Error("not called");
      },
    });
    const description = (pi.tools.get("mail") as unknown as RegisteredTool)
      .description;
    expect(description).toMatch(/^draft: /m);
    expect(description).not.toMatch(/^draft \{/m);
  });

  it("lead each channels command's description line with its signature", () => {
    const pi = createMockExtensionAPI();
    registerChannelTools(pi, STUB_ADAPTER, {
      target: { provider: "stub", conversation: "C1" },
    });
    const tool = pi.tools.get("channels") as unknown as RegisteredTool;
    expect(tool.parameters.anyOf).toHaveLength(
      Object.keys(CHANNELS_ARGUMENTS).length,
    );
    expectSignatures(tool);
  });
});

/** `tools <argv>` over a bridge serving `tool`, as a bash call's shell runs it. */
async function help(tool: RegisteredTool & { name: string }, argv: string[]) {
  let stdout = "";
  const code = await withToolsBridge(
    { tools: [tool], executeTool: async () => ({ isError: true }) } as never,
    [tool.name],
    () =>
      runToolsCommand(argv, {
        env: { PI_RECIPES_TOOLS_SOCKET: activeToolsSocket()! },
        stdout: { write: (text: string) => (stdout += text) },
        stderr: { write: () => {} },
      }),
  );
  expect(code, argv.join(" ")).toBe(0);
  return stdout;
}

/** The flags a command's `--help` lists, `--json` and `--help` aside. */
const flagsOf = (text: string) =>
  [...text.matchAll(/^ {2}--(\w+)/gm)]
    .map((match) => match[1]!)
    .filter((flag) => flag !== "json" && flag !== "help");

function registered() {
  const pi = createMockExtensionAPI();
  registerProductivityTools(pi as never, {
    provider: "fake",
    capabilities: everyCommand({ labels: "labels", folders: "labels" }),
    tools: Object.fromEntries(
      PRODUCTIVITY_TOOLS.map((tool) => [tool, PRODUCTIVITY_COMMANDS[tool]]),
    ),
    cwd: "/nonexistent",
    downloadsDir: "/nonexistent",
    session: () => {
      throw new Error("not called");
    },
  });
  const module = (id: string) => ({
    kind: "issues",
    apiVersion: 1,
    id,
    capabilities: {
      commands: Object.fromEntries(
        ["search", "get", "create", "update", "comment", "transition"].map(
          (command) => [command, {}],
        ),
      ),
      fields: ["description", "assignee", "labels", "priority"],
      hosts: [],
    },
  });
  registerIssuesTool(pi, {
    providers: ["linear", "jira"].map((id) => ({
      module: module(id) as never,
      config: { provider: id, options: {} },
      fallback: false,
    })),
  });
  registerChannelTools(pi, STUB_ADAPTER, {
    target: { provider: "stub", conversation: "C1" },
  });
  return (name: string) => ({
    name,
    ...(pi.tools.get(name) as unknown as RegisteredTool),
  });
}

describe("the generated schemas, as each tool's --help reads them", () => {
  const tool = registered();

  it("list every command of every generated tool with its description", async () => {
    for (const name of [...PRODUCTIVITY_TOOLS, "channels", "issues"]) {
      const registeredTool = tool(name);
      const text = await help(registeredTool, [name, "--help"]);
      for (const variant of registeredTool.parameters.anyOf) {
        const command = (variant.properties.command as { const: string }).const;
        expect(text, `${name} ${command}`).toMatch(
          new RegExp(`^ {2}${command} +\\S`, "m"),
        );
      }
    }
  });

  it("show exactly a command's own arguments, from its TypeScript type", async () => {
    const cases: Array<[string, string, Record<string, ObjectSchema>]> = [
      ["mail", "search", MAIL_ARGUMENTS],
      ["mail", "draft", MAIL_ARGUMENTS],
      ["calendar", "create", CALENDAR_ARGUMENTS],
      ["drive", "search", DRIVE_ARGUMENTS],
      ["channels", "send", CHANNELS_ARGUMENTS],
      ["issues", "create", ISSUES_ARGUMENTS],
      ["issues", "transition", ISSUES_ARGUMENTS],
    ];
    for (const [name, command, generated] of cases) {
      const text = await help(tool(name), [name, command, "--help"]);
      expect(flagsOf(text), `${name} ${command}`).toEqual(
        Object.keys(generated[command]!.properties),
      );
    }
    const search = await help(tool("mail"), ["mail", "search", "--help"]);
    expect(search).toMatch(
      /--limit <integer> +At most this many results\. From 1 to 100\. Default: 25\./,
    );
    expect(search).toMatch(/--unread +true for unread messages only/);
    const draft = await help(tool("mail"), ["mail", "draft", "--help"]);
    expect(draft.split("\n")[0]).toBe(
      "Usage: mail draft --body <string> [--<argument> <value> ...]",
    );
    const create = await help(tool("issues"), ["issues", "create", "--help"]);
    expect(create).toMatch(/--title <string> +Required\. The issue's title\./);
    expect(create).toContain("--priority <none|low|medium|high|urgent>");
    expect(create).toContain("--provider <linear|jira>");
    const transition = await help(tool("issues"), [
      "issues",
      "transition",
      "--help",
    ]);
    expect(transition.split("\n")[0]).toBe(
      "Usage: issues transition --handle <string> --status <string>",
    );
    expect(transition).toContain(
      "A status name or open, in_progress, done, cancelled.",
    );
  });
});
