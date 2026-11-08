/**
 * The `tools` command's way into the session (`tools.mode: cli`). For the
 * length of one `bash` call the session listens on a private socket; the
 * `tools` command in that shell sends `list` and `call` requests, and each
 * call runs as `ctx.executeTool()`: a nested call of the bash call, through
 * the same validation, hooks, spans and `behind` rules as a model's own.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

/** The socket a `tools` command connects to, set on the bash call's shell. */
export const TOOLS_SOCKET_ENV = "PI_RECIPES_TOOLS_SOCKET";

/** One request from the `tools` command, one JSON object per line. */
export type ToolsBridgeRequestBody =
  { op: "list" } | { op: "call"; tool: string; args: Record<string, unknown> };

export type ToolsBridgeRequest = ToolsBridgeRequestBody & { id: number };

export interface ToolsBridgeTool {
  name: string;
  description: string;
  parameters: unknown;
}

/** The answer to one request, one JSON object per line. */
export type ToolsBridgeResponse =
  | { id: number; tools: ToolsBridgeTool[] }
  | { id: number; text: string; isError: boolean }
  | { id: number; error: string };

const active = new AsyncLocalStorage<string>();

/** The socket of the bash call this code runs within, if it has one. */
export function activeToolsSocket(): string | undefined {
  return active.getStore();
}

function resultText(result: { content?: unknown }): string {
  return Array.isArray(result.content)
    ? (result.content as Array<{ type?: string; text?: string }>)
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
    : "";
}

async function answer(
  request: ToolsBridgeRequest,
  ctx: ExtensionToolContext,
  names: readonly string[],
): Promise<ToolsBridgeResponse> {
  const offered = ctx.tools.filter((tool) => names.includes(tool.name));
  if (request.op === "list")
    return {
      id: request.id,
      tools: offered.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    };
  if (!offered.some((tool) => tool.name === request.tool))
    return {
      id: request.id,
      error: `${request.tool} is not a first-party tool of this agent; tools list shows them`,
    };
  const outcome = await ctx.executeTool(request.tool, request.args);
  return {
    id: request.id,
    text: resultText(outcome.result),
    isError: outcome.isError,
  };
}

function serve(
  socket: Socket,
  ctx: ExtensionToolContext,
  names: readonly string[],
): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.trim()) continue;
      let request: ToolsBridgeRequest;
      try {
        request = JSON.parse(line) as ToolsBridgeRequest;
      } catch {
        socket.write(`${JSON.stringify({ id: -1, error: "not JSON" })}\n`);
        continue;
      }
      void answer(request, ctx, names).then(
        (response) => socket.write(`${JSON.stringify(response)}\n`),
        (error: unknown) =>
          socket.write(
            `${JSON.stringify({ id: request.id, error: error instanceof Error ? error.message : String(error) })}\n`,
          ),
      );
    }
  });
  socket.on("error", () => socket.destroy());
}

/**
 * Run `fn` (the bash call) with a socket serving the platform tools `names`
 * through `ctx`; the socket closes when `fn` settles.
 */
export async function withToolsBridge<T>(
  ctx: ExtensionToolContext | undefined,
  names: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  if (!ctx || names.length === 0) return fn();
  const path = join(tmpdir(), `pi-tools-${randomUUID().slice(0, 12)}.sock`);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    serve(socket, ctx, names);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  try {
    return await active.run(path, fn);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(path, { force: true });
  }
}
