import { AsyncLocalStorage } from "node:async_hooks";
import type { Readable, Writable } from "node:stream";

/**
 * What the `mcp` command and its daemon use of an MCP runtime: mcporter's, or
 * the pi-mcp one (`../pi-runtime.ts`).
 */
export interface McpRuntime {
  listServers(): string[];
  listTools(
    server: string,
    options?: {
      includeSchema?: boolean;
      autoAuthorize?: boolean;
      allowCachedAuth?: boolean;
      disableOAuth?: boolean;
    },
  ): Promise<unknown[]>;
  callTool(
    server: string,
    tool: string,
    options?: {
      args?: Record<string, unknown>;
      timeoutMs?: number;
      disableOAuth?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpCommandContext {
  runtime: McpRuntime;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  signal: AbortSignal;
}

const storage = new AsyncLocalStorage<McpCommandContext>();

export function currentMcpCommandContext(): McpCommandContext | undefined {
  return storage.getStore();
}

const envStorage = new AsyncLocalStorage<NodeJS.ProcessEnv>();

/**
 * The session environment an `mcp` command reads: the one its server was
 * started with, which a server hosted in a session's process does not share
 * with that process.
 */
export function mcpCommandEnv(): NodeJS.ProcessEnv {
  return envStorage.getStore() ?? process.env;
}

export function runWithMcpCommandEnv<T>(
  env: NodeJS.ProcessEnv,
  task: () => T,
): T {
  return envStorage.run(env, task);
}

export function runWithMcpCommandContext<T>(
  context: McpCommandContext,
  task: () => Promise<T>,
): Promise<T> {
  return storage.run(context, task);
}

let ioRoutingHolders = 0;
let restoreIoRouting: (() => void) | undefined;

/**
 * Routes `process.stdout` and `process.stderr` writes made inside an `mcp`
 * command to that command's streams. Holders share one patch, so servers
 * hosted in one process can each install it, and releasing the last one
 * restores the original writers unless something patched them since.
 */
export function installMcpCommandIoRouting(): () => void {
  if (ioRoutingHolders === 0) {
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    const boundStdout = stdoutWrite.bind(process.stdout);
    const boundStderr = stderrWrite.bind(process.stderr);

    const routedStdout = ((chunk: unknown, ...args: unknown[]) => {
      const target = currentMcpCommandContext()?.stdout;
      return target
        ? target.write(chunk as never)
        : boundStdout(chunk as never, ...(args as never[]));
    }) as typeof process.stdout.write;
    const routedStderr = ((chunk: unknown, ...args: unknown[]) => {
      const target = currentMcpCommandContext()?.stderr;
      return target
        ? target.write(chunk as never)
        : boundStderr(chunk as never, ...(args as never[]));
    }) as typeof process.stderr.write;
    process.stdout.write = routedStdout;
    process.stderr.write = routedStderr;
    restoreIoRouting = () => {
      if (process.stdout.write === routedStdout)
        process.stdout.write = stdoutWrite;
      if (process.stderr.write === routedStderr)
        process.stderr.write = stderrWrite;
    };
  }
  ioRoutingHolders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ioRoutingHolders -= 1;
    if (ioRoutingHolders === 0) {
      restoreIoRouting?.();
      restoreIoRouting = undefined;
    }
  };
}
