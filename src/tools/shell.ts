import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { COMMANDLESS_TOOLS } from "./cli.js";

import {
  activeToolsSocket,
  TOOLS_SOCKET_ENV,
  withToolsBridge,
} from "./bridge.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The compiled `tools` command, beside the `mcp` command's entry points. */
function toolsEntrypointPath(): string {
  return fileURLToPath(
    new URL("tools/entry.js", import.meta.resolve("@introspection-ai/recipes")),
  );
}

/** A tool name that is safe as a file name and a shell word. */
const COMMAND_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Write the `tools` shim into `binDir`, for a bash call's PATH, and one shim
 * per tool in `names`, so `issues list ...` is `tools issues list ...`. A
 * tool shim shadows a system command of the same name (`mail`) in the
 * agent's shell only; `tools <tool>` always reaches the tool.
 */
export async function materializeToolsShim(
  binDir: string,
  names: readonly string[] = [],
): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const exec = `exec ${shellQuote(process.execPath)} ${shellQuote(toolsEntrypointPath())}`;
  const write = async (name: string, line: string) => {
    const path = join(binDir, name);
    await writeFile(path, ["#!/bin/sh", line, ""].join("\n"));
    await chmod(path, 0o755);
    return path;
  };
  for (const name of names)
    if (COMMAND_NAME.test(name) && name !== "tools")
      await write(name, `${exec} ${shellQuote(name)} "$@"`);
  return write("tools", `${exec} "$@"`);
}

/** The shell environment of a bash call that serves the `tools` command. */
export function toolsShellEnv(
  env: NodeJS.ProcessEnv,
  binDir: string,
): NodeJS.ProcessEnv {
  const socket = activeToolsSocket();
  if (!socket) return env;
  const pathKey =
    Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  return {
    ...env,
    [TOOLS_SOCKET_ENV]: socket,
    [pathKey]: [binDir, env[pathKey]].filter(Boolean).join(":"),
  };
}

/** The call form for each of `names` that has no commands, as the description says it. */
function commandless(names: readonly string[]): string {
  const bare = names.filter((name) =>
    (COMMANDLESS_TOOLS as readonly string[]).includes(name),
  );
  if (!bare.length) return "";
  const tools = bare.map((name) => "`" + name + "`").join(", ");
  const calls = bare
    .map((name) => "`" + name + " --<argument> <value>`")
    .join(", ");
  return `; ${tools} ${bare.length === 1 ? "has" : "have"} no commands: ${calls}`;
}

/**
 * The bash tool with the `tools` command: each call serves the platform
 * tools `names` on a socket for its own shell, so a `tools call` in it is a
 * nested call of that bash call.
 */
export function withToolsCommand(
  bash: ToolDefinition,
  names: readonly string[],
): ToolDefinition {
  return {
    ...bash,
    // The tools are not declared, so this is how the model learns they exist;
    // the description reaches it even when a Recipe's SYSTEM.md replaces Pi's prompt.
    description: `${bash.description}\n\n${names.join(", ")} are not tools you call directly: each is a command in bash. \`<tool> --help\` lists its commands, \`<tool> <command> --help\` a command's arguments, and \`<tool> <command> --<argument> <value> ...\` makes one call${commandless(names)}. Any call takes every argument as JSON instead with \`--json -\` and the object on stdin in a quoted heredoc (\`<<'JSON'\`), so quotes in it need no escaping. \`tools list\` shows them all, and \`tools run\` with a script on stdin (\`await tools.<tool>.<command>({...})\`) makes several calls.`,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      withToolsBridge(ctx, names, () =>
        bash.execute(toolCallId, params, signal, onUpdate, ctx),
      ),
  } as ToolDefinition;
}
