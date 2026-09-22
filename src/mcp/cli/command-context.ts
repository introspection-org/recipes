import { AsyncLocalStorage } from "node:async_hooks";
import type { Readable, Writable } from "node:stream";

export type McpRuntime = Awaited<ReturnType<typeof import("mcporter").createRuntime>>;

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

export function runWithMcpCommandContext<T>(
  context: McpCommandContext,
  task: () => Promise<T>
): Promise<T> {
  return storage.run(context, task);
}

export function installMcpCommandIoRouting(): () => void {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    const target = currentMcpCommandContext()?.stdout;
    return target
      ? target.write(chunk as never)
      : stdoutWrite(chunk as never, ...(args as never[]));
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    const target = currentMcpCommandContext()?.stderr;
    return target
      ? target.write(chunk as never)
      : stderrWrite(chunk as never, ...(args as never[]));
  }) as typeof process.stderr.write;

  return () => {
    process.stdout.write = stdoutWrite as typeof process.stdout.write;
    process.stderr.write = stderrWrite as typeof process.stderr.write;
  };
}
