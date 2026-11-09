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
import { registerProductivityTools } from "../src/productivity/index.js";
import {
  PRODUCTIVITY_COMMAND_EFFECTS,
  PRODUCTIVITY_COMMANDS,
  PRODUCTIVITY_TOOLS,
  type ProductivityCapabilities,
} from "../src/productivity/types.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const GENERATED: Record<string, Record<string, ObjectSchema>> = {
  mail: MAIL_ARGUMENTS,
  calendar: CALENDAR_ARGUMENTS,
  drive: DRIVE_ARGUMENTS,
  channels: CHANNELS_ARGUMENTS,
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
      "draft { to, subject, body, cc?, reply_to? }",
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
    const implemented = async () => ({}) as never;
    const adapter = {
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
    const pi = createMockExtensionAPI();
    registerChannelTools(pi, adapter, {
      target: { provider: "stub", conversation: "C1" },
    });
    const tool = pi.tools.get("channels") as unknown as RegisteredTool;
    expect(tool.parameters.anyOf).toHaveLength(
      Object.keys(CHANNELS_ARGUMENTS).length,
    );
    expectSignatures(tool);
  });
});
