#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { stdin, stderr, stdout } from "node:process";

import {
  ensureMcpDaemon,
  exchangeMcpDaemon,
  mcpDaemonEnvironment,
} from "./mcp/daemon/client.js";
import { mcpTraceContextFromEnv } from "./mcp-trace-context.js";

function commandNeedsStdin(args: readonly string[]): boolean {
  if (args.some((arg, index) => arg === "--json" && args[index + 1] === "-")) return true;
  if (args[0] !== "run") return false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json-errors") continue;
    if (arg === "--var") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--var=")) continue;
    return false;
  }
  return true;
}

function readStdin(): Promise<string> {
  if (!commandNeedsStdin(process.argv.slice(2))) return Promise.resolve("");
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.on("data", (chunk) => (value += chunk));
    stdin.once("end", () => resolve(value));
    stdin.once("error", reject);
  });
}

async function sendCancel(requestId: string): Promise<void> {
  const { token } = mcpDaemonEnvironment();
  await exchangeMcpDaemon(
    { type: "cancel", id: randomUUID(), token, requestId },
    () => {}
  ).catch(() => {});
}

async function main(args = process.argv.slice(2)): Promise<number> {
  await ensureMcpDaemon();
  if (args.length === 1 && args[0] === "--start-daemon") return 0;
  const { token, fingerprint } = mcpDaemonEnvironment();
  const id = randomUUID();
  const input = await readStdin();
  let exitCode: number | undefined;
  let daemonError: string | undefined;
  let interrupted = false;
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    void sendCancel(id);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const traceContext = mcpTraceContextFromEnv();
    await exchangeMcpDaemon(
      {
        type: "execute",
        id,
        token,
        fingerprint,
        args,
        stdin: input,
        ...(traceContext ? { trace: traceContext } : {}),
      },
      (envelope, socket) => {
        if ("stream" in envelope) {
          (envelope.stream === "stdout" ? stdout : stderr).write(envelope.data);
        } else if ("exitCode" in envelope) {
          exitCode = envelope.exitCode;
          socket.end();
        } else if ("error" in envelope) {
          daemonError = envelope.error;
          socket.end();
        }
      }
    );
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  if (daemonError) throw new Error(`MCP daemon: ${daemonError}`);
  return interrupted ? 130 : (exitCode ?? 1);
}

main()
  .then((code) => (process.exitCode = code))
  .catch((error) => {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
