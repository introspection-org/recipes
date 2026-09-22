/**
 * The program runner for `mcp.mode: execute`.
 *
 * Runs as its own process so three properties are structural rather than
 * argued: it is spawned with `env: {}`, so the MCP daemon token, the session
 * locator and the egress URL are absent; it is spawned under `--permission`
 * with two file-granular fs grants, so a program that escapes the `vm` context
 * still cannot spawn a shell, start a worker, or read the session directory;
 * and it reaches a provider only by asking the parent, which re-applies the
 * agent's MCP policy before any call leaves.
 *
 * ⚠️ Import only `node:` builtins here. The fs grants cover this file's
 * directory and the package manifest above it, so a dependency would not be
 * readable at load, and widening them to fix that would hand an escaped
 * program the session files the grants exist to keep out.
 */

import { createContext, runInContext } from "node:vm";

/**
 * Capture the runner's own stdio, then take the capability root away.
 *
 * Node's permission model gates the filesystem, subprocesses, workers and
 * addons, but it has no network gate — and removing `fetch` alone is not
 * enough, because `process.getBuiltinModule("node:http")` hands back a working
 * socket API synchronously, with no import to block. Deleting `process`
 * removes that, `process.binding` and everything else reachable through it in
 * one move, while the captured streams keep this runner working.
 *
 * ⚠️ This is defence in depth, not a boundary. It removes the paths that are
 * known and reachable; it cannot prove none remains. What bounds network
 * reachability is the sandbox's egress policy, and what makes an escape
 * low-value is that this process is spawned with `env: {}` and holds no
 * credential to present.
 */
const stdout = process.stdout;
const stdin = process.stdin;

for (const name of [
  "fetch",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
  "Response",
  "Request",
  "Headers",
  "FormData",
  "process",
  // `console._stdout.constructor` is `net.Socket`, which connects under
  // `--permission` — a retained stream object is a capability root just as
  // `process` was. The program gets a synthetic console; this is the runner
  // realm's, which nothing here uses.
  "console",
]) {
  try {
    delete (globalThis as Record<string, unknown>)[name];
  } catch {
    // A non-configurable global stays; the sandbox egress policy still applies.
  }
}

interface ChildToolRef {
  server: string;
  tool: string;
}

interface StartMessage {
  type: "start";
  code: string;
  tools: ChildToolRef[];
  /** Server ids the host advertised as bare globals. */
  globals: string[];
}

interface CallResultMessage {
  type: "result";
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

type ParentMessage = StartMessage | CallResultMessage;

const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
let nextCallId = 0;
let started = false;

function send(message: unknown): void {
  stdout.write(`${JSON.stringify(message)}\n`);
}

function callParent(server: string, tool: string, args: unknown): Promise<unknown> {
  const id = nextCallId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: "call", id, server, tool, args });
  });
}

function buildSurface(tools: readonly ChildToolRef[]): Record<string, unknown> {
  const byServer: Record<string, Record<string, unknown>> = Object.create(null);
  for (const { server, tool } of tools) {
    const namespace = (byServer[server] ??= Object.create(null) as Record<string, unknown>);
    namespace[tool] = (args: unknown = {}) => callParent(server, tool, args);
  }
  for (const namespace of Object.values(byServer)) Object.freeze(namespace);
  return byServer;
}

function textOf(values: readonly unknown[]): string {
  return values
    .map((value) =>
      typeof value === "string" ? value : safeStringify(value)
    )
    .join(" ");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

async function run(message: StartMessage): Promise<void> {
  const surface = buildSurface(message.tools);
  const logs: unknown[] = [];
  const log = (level: string) => (...values: unknown[]) => {
    logs.push({ level, text: textOf(values) });
  };
  const globals: Record<string, unknown> = {
    tools: Object.freeze(surface),
    console: Object.freeze({
      log: log("log"),
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
      debug: log("debug"),
    }),
    sleep: (ms: unknown) =>
      new Promise((resolve) =>
        setTimeout(resolve, Math.min(Math.max(Number(ms) || 0, 0), 30_000))
      ),
  };
  for (const server of message.globals) {
    const namespace = surface[server];
    if (!namespace || Object.hasOwn(globals, server)) continue;
    // Defined, not assigned: `globals.__proto__ = ns` runs Object.prototype's
    // setter and installs nothing, so the host would advertise a bare global
    // the program cannot call.
    Object.defineProperty(globals, server, {
      value: namespace,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  const context = createContext(globals);
  try {
    const value = await runInContext(
      `(async function recipeExecuteProgram() {\n${message.code}\n})()`,
      context,
      { filename: "program.js" }
    );
    send({ type: "done", value: value === undefined ? null : value, logs });
  } catch (error) {
    send({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      logs,
    });
  }
}

function handle(message: ParentMessage): void {
  if (message.type === "start") {
    if (started) return;
    started = true;
    void run(message);
    return;
  }
  const waiting = pending.get(message.id);
  if (!waiting) return;
  pending.delete(message.id);
  if (message.ok) waiting.resolve(message.value);
  else waiting.reject(new Error(message.error ?? "MCP tool call failed."));
}

let buffer = "";
stdin.setEncoding("utf8");
stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        handle(JSON.parse(line) as ParentMessage);
      } catch {
        // A malformed frame from the parent is not the program's business.
      }
    }
    newline = buffer.indexOf("\n");
  }
});
