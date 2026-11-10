/**
 * The `tools` command: the first-party tools of the session's agent
 * (`issues`, `mail`, `calendar`, `drive`, `web_search`) from a shell, with
 * `tools.mode: cli`. Its namespace is those tools only; a Recipe's MCP
 * servers stay on the `mcp` command. Every call goes to the session through
 * the bash call's socket ({@link TOOLS_SOCKET_ENV}).
 */

import { readFileSync } from "node:fs";
import { createConnection } from "node:net";

import {
  type JsonSchema,
  parseSchemaArgs,
  SchemaArgsError,
  type SchemaCommand,
  schemaGroupHelp,
  schemaHelp,
  usageOf,
} from "../cli/schema-args.js";
import {
  TOOLS_SOCKET_ENV,
  type ToolsBridgeRequestBody,
  type ToolsBridgeResponse,
  type ToolsBridgeTool,
} from "./bridge.js";

/** First-party tools with no commands: each is called by its name alone. */
export const COMMANDLESS_TOOLS = ["web_search"] as const;

const HELP = [
  "tools: the platform's own tools (issues, mail, calendar, drive, web_search).",
  "",
  "  Each tool is also a command of its own:",
  "  <tool> --help                       Its commands.",
  "  <tool> <command> --help             A command's arguments, from its schema.",
  "  <tool> <command> --<argument> <value> ...   One call.",
  "  A tool with no commands takes its arguments directly: web_search --query '...'.",
  "",
  "  tools list [tool] [--schema]        What this agent has; a tool's commands.",
  '  tools search "what you need" [--limit N]   Commands matching the words.',
  "  tools <tool> <command> ...          The same as <tool> <command> ...",
  "  tools call <tool>.<command> [--json '{...}' | --<argument> <value> ...]",
  "  tools run <<'JS' ... JS             Two or more calls, in one script.",
  "",
  "  Any call takes --json '{...}', or --json - to read the object from stdin.",
  "",
  "  tools run <<'JS'",
  '  const found = await tools.issues.search({ query: "checkout" });',
  "  return found;",
  "  JS",
  "",
  "  A Recipe's MCP servers are on the `mcp` command, not here.",
].join("\n");

class UsageError extends Error {}

/** One command of a tool, with the schema its arguments follow. */
interface Command {
  tool: string;
  command?: string;
  description: string;
  /** The command's own schema; `command`, which the call's name carries, set aside. */
  schema: JsonSchema;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `schema` without `command`, which the call's name carries. */
function argumentsOf(schema: Record<string, unknown>): JsonSchema {
  const { command: _command, ...properties } = record(schema.properties);
  const required = Array.isArray(schema.required)
    ? schema.required.map(String).filter((name) => name !== "command")
    : [];
  return { properties, required };
}

/** A tool's commands, from its schema: one variant per command, an enum on `command`, or none. */
function commandsOf(tool: ToolsBridgeTool): Command[] {
  const schema = record(tool.parameters);
  const variants = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined;
  if (Array.isArray(variants))
    return variants.map((variant) => ({
      tool: tool.name,
      command: String(record(record(record(variant).properties).command).const),
      description: String(record(variant).description ?? ""),
      schema: argumentsOf(record(variant)),
    }));
  const names = record(record(schema.properties).command).enum;
  if (Array.isArray(names))
    return names.map((name) => ({
      tool: tool.name,
      command: String(name),
      description: "",
      schema: argumentsOf(schema),
    }));
  return [
    {
      tool: tool.name,
      description: tool.description.split("\n")[0] ?? "",
      schema: argumentsOf(schema),
    },
  ];
}

/** The adapter's command for one of a tool's commands. */
function specOf(command: Command): SchemaCommand {
  return {
    path: command.command ? [command.tool, command.command] : [command.tool],
    description: command.description,
    schema: command.schema,
  };
}

const isHelp = (arg: string | undefined) =>
  arg === "--help" || arg === "-h" || arg === "help";

/** How a command is typed in the shell: `issues search`, or `web_search`. */
function shownAs(command: Command): string {
  return command.command ? `${command.tool} ${command.command}` : command.tool;
}

function nameOf(command: Command): string {
  return command.command ? `${command.tool}.${command.command}` : command.tool;
}

async function request(
  socket: string,
  requests: ToolsBridgeRequestBody[],
): Promise<ToolsBridgeResponse[]> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    const answers = new Map<number, ToolsBridgeResponse>();
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("error", reject);
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const response = JSON.parse(
          buffer.slice(0, newline),
        ) as ToolsBridgeResponse;
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        answers.set(response.id, response);
        if (answers.size === requests.length) {
          connection.end();
          resolve(requests.map((_, index) => answers.get(index)!));
        }
      }
    });
    connection.on("connect", () => {
      for (const [index, body] of requests.entries())
        connection.write(`${JSON.stringify({ ...body, id: index })}\n`);
    });
  });
}

/** A client over the bash call's socket. */
function client(socket: string) {
  let catalog: Promise<ToolsBridgeTool[]> | undefined;
  const list = () =>
    (catalog ??= request(socket, [{ op: "list" }]).then(([answer]) => {
      if (!answer || !("tools" in answer))
        throw new Error(
          answer && "error" in answer ? answer.error : "no answer",
        );
      return answer.tools;
    }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const [tool, command] = name.split(".", 2) as [string, string | undefined];
    const [answer] = await request(socket, [
      {
        op: "call",
        tool,
        args: command ? { ...args, command } : args,
      },
    ]);
    if (!answer || "error" in answer)
      throw new UsageError(
        answer && "error" in answer ? answer.error : "no answer",
      );
    if (!("text" in answer)) throw new Error("unexpected answer");
    if (answer.isError) throw new Error(answer.text);
    return answer;
  };
  // In a script a call resolves to the tool's structured result, so one
  // call's output can build the next; `tools call` prints the text.
  const value = async (name: string, args: Record<string, unknown>) => {
    const { text, details } = await call(name, args);
    return details ?? text;
  };
  return { list, call, value };
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

export async function runToolsCommand(
  argv: string[],
  io: {
    env: NodeJS.ProcessEnv;
    stdout: { write(text: string): unknown };
    stderr: { write(text: string): unknown };
    stdin?: () => string;
  },
): Promise<number> {
  const args = [...argv];
  const verb = args.shift();
  if (!verb || verb === "--help" || verb === "-h" || verb === "help") {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }
  const socket = io.env[TOOLS_SOCKET_ENV];
  if (!socket) {
    io.stderr.write(
      "tools: no first-party tools here; the agent's tools.mode is not cli, or this shell is not one of its bash calls\n",
    );
    return 69;
  }
  const tools = client(socket);
  /** `<tool> [<command>] [arguments]`: one call, or its help. */
  const invoke = async (toolName: string, rest: string[]): Promise<number> => {
    const catalog = await tools.list();
    const tool = catalog.find((entry) => entry.name === toolName);
    if (!tool)
      throw new UsageError(
        `${toolName} is not a first-party tool of this agent (${catalog.map((entry) => entry.name).join(", ")}); tools --help shows the commands`,
      );
    const commands = commandsOf(tool);
    let command: Command;
    const first = rest[0];
    if (commands.some((entry) => entry.command)) {
      if (first === undefined || isHelp(first)) {
        io[first ? "stdout" : "stderr"].write(
          `${schemaGroupHelp([tool.name], tool.description, commands.map(specOf))}\n`,
        );
        return first ? 0 : 64;
      }
      const found = commands.find((entry) => entry.command === first);
      if (!found)
        throw new UsageError(
          `${tool.name} has no command '${first}'; it has ${commands.map((entry) => entry.command).join(", ")}. ${tool.name} --help`,
        );
      rest.shift();
      command = found;
    } else {
      command = commands[0]!;
      if (first === "help") rest[0] = "--help";
      else if (first !== undefined && !first.startsWith("-"))
        throw new UsageError(
          `${tool.name} has no commands: pass its arguments as flags or --json -. ${tool.name} --help`,
        );
    }
    const spec = specOf(command);
    const usage = usageOf(spec);
    const parsed = parseSchemaArgs(spec, rest, io.stdin);
    if (parsed.help) {
      io.stdout.write(`${schemaHelp(spec)}\n`);
      return 0;
    }
    let answer: Awaited<ReturnType<typeof tools.call>>;
    try {
      answer = await tools.call(nameOf(command), parsed.args);
    } catch (error) {
      // The pipeline checked the arguments against the schema and refused them.
      if (
        error instanceof Error &&
        error.message.startsWith("Validation failed")
      )
        throw new SchemaArgsError(usage, error.message);
      throw error;
    }
    io.stdout.write(`${answer.text}\n`);
    return 0;
  };
  try {
    if (verb === "list") {
      const schema = args.includes("--schema");
      const target = args.find((arg) => !arg.startsWith("--"));
      const catalog = await tools.list();
      if (!target) {
        for (const tool of catalog)
          io.stdout.write(
            `${tool.name} — ${tool.description.split("\n")[0] ?? ""}\n`,
          );
        return 0;
      }
      const tool = catalog.find((entry) => entry.name === target);
      if (!tool)
        throw new UsageError(
          `${target} is not one of: ${catalog.map((entry) => entry.name).join(", ")}`,
        );
      for (const command of commandsOf(tool))
        io.stdout.write(
          schema
            ? `${shownAs(command)} ${JSON.stringify(command.schema)}\n`
            : `${shownAs(command)}${command.description ? ` — ${command.description}` : ""}\n`,
        );
      return 0;
    }
    if (verb === "search") {
      const limit = Number(flag(args, "--limit") ?? "10");
      const words = (args[0] ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0)
        throw new UsageError('Usage: tools search "what you need" [--limit N]');
      const ranked = (await tools.list())
        .flatMap(commandsOf)
        .map((command) => {
          const text =
            `${shownAs(command)} ${command.description}`.toLowerCase();
          return {
            command,
            score: words.filter((word) => text.includes(word)).length,
          };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      for (const { command } of ranked)
        io.stdout.write(
          `${shownAs(command)}${command.description ? ` — ${command.description}` : ""}\n`,
        );
      return 0;
    }
    if (verb === "call") {
      const name = args.shift();
      if (!name || name.startsWith("-"))
        throw new UsageError(
          "Usage: tools call <tool>.<command> [--json '{...}' | --<argument> <value> ...]",
        );
      const [toolName, commandName] = name.split(".", 2) as [
        string,
        string | undefined,
      ];
      return await invoke(
        toolName,
        commandName ? [commandName, ...args] : args,
      );
    }
    if (verb === "run") {
      const file = args[0];
      const source = file ? readFileSync(file, "utf8") : (io.stdin?.() ?? "");
      if (!source.trim())
        throw new UsageError("Usage: tools run [file], or the script on stdin");
      const catalog = await tools.list();
      // A proxy per tool: `tools.issues.search(args)`, or `tools.web_search(args)`.
      const scope = Object.fromEntries(
        catalog.map((tool) => {
          const commands = commandsOf(tool);
          const callable = (args: Record<string, unknown> = {}) =>
            tools.value(tool.name, args);
          return [
            tool.name,
            commands.some((command) => command.command)
              ? Object.fromEntries(
                  commands.map((command) => [
                    command.command,
                    (args: Record<string, unknown> = {}) =>
                      tools.value(nameOf(command), args),
                  ]),
                )
              : callable,
          ];
        }),
      );
      const AsyncFunction = Object.getPrototypeOf(async () => {})
        .constructor as new (
        ...args: string[]
      ) => (tools: unknown) => Promise<unknown>;
      const value = await new AsyncFunction("tools", source)(scope);
      io.stdout.write(
        `${typeof value === "string" ? value : JSON.stringify(value ?? null)}\n`,
      );
      return 0;
    }
    return await invoke(verb, args);
  } catch (error) {
    io.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (error instanceof SchemaArgsError)
      io.stderr.write(`Run \`${error.usage} --help\` for its arguments.\n`);
    return error instanceof UsageError || error instanceof SchemaArgsError
      ? 64
      : 1;
  }
}

/** The shell entry point the session's `tools` shim runs. */
export async function main(): Promise<void> {
  process.exitCode = await runToolsCommand(process.argv.slice(2), {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: () => readFileSync(0, "utf8"),
  });
}
