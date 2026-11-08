import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

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

/** Write the `tools` shim into `binDir`, for a bash call's PATH. */
export async function materializeToolsShim(binDir: string): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const shimPath = join(binDir, "tools");
  await writeFile(
    shimPath,
    [
      "#!/bin/sh",
      `exec ${shellQuote(process.execPath)} ${shellQuote(toolsEntrypointPath())} "$@"`,
      "",
    ].join("\n"),
  );
  await chmod(shimPath, 0o755);
  return shimPath;
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
    description: `${bash.description}\n\n${names.join(", ")} are not tools you call directly: reach them from bash with the \`tools\` command. \`tools list\` shows them, \`tools list <tool> --schema\` a tool's commands and arguments, \`tools call <tool>.<command> --json '{...}'\` makes one call, and \`tools run\` with a script on stdin (\`await tools.<tool>.<command>({...})\`) makes several.`,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      withToolsBridge(ctx, names, () =>
        bash.execute(toolCallId, params, signal, onUpdate, ctx),
      ),
  } as ToolDefinition;
}
