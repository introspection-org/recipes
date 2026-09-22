import { Readable, Writable } from "node:stream";
import { parentPort, workerData } from "node:worker_threads";

import { executeMcpCommand } from "./core.js";
import {
  installMcpCommandIoRouting,
  type McpRuntime,
} from "./command-context.js";

interface RunWorkerData {
  args: string[];
  stdin: string;
  servers: string[];
}

type ParentMessage =
  | { type: "toolResult"; id: number; result: unknown }
  | { type: "toolError"; id: number; message: string };

if (!parentPort) throw new Error("mcp run worker requires a parent port");
const port = parentPort;

let nextCallId = 0;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

port.on("message", (message: ParentMessage) => {
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id);
  if (message.type === "toolResult") call.resolve(message.result);
  else call.reject(new Error(message.message));
});

function output(stream: "stdout" | "stderr"): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      port.postMessage({ type: "stream", stream, data: String(chunk) });
      callback();
    },
  });
}

const data = workerData as RunWorkerData;
const runtime = {
  listServers: () => data.servers,
  callTool: (server: string, tool: string, options: unknown) => {
    const id = ++nextCallId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port.postMessage({ type: "toolCall", id, server, tool, options });
    });
  },
  close: async () => {},
} as unknown as McpRuntime;

installMcpCommandIoRouting();
executeMcpCommand({
  args: data.args,
  runtime,
  stdin: Readable.from([data.stdin]),
  stdout: output("stdout"),
  stderr: output("stderr"),
  signal: new AbortController().signal,
})
  .then((exitCode) => port.postMessage({ type: "complete", exitCode }))
  .catch((error) =>
    port.postMessage({
      type: "failed",
      message: error instanceof Error ? error.message : String(error),
    })
  );
