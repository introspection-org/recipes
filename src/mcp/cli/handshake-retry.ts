import { setTimeout as delay } from "node:timers/promises";

import type { McpRuntime } from "./command-context.js";

type McpCallOptions = NonNullable<Parameters<McpRuntime["callTool"]>[2]>;

// A refused version probe means the connection never opened, so the tool did
// not run and the call can be made again. Any later failure may follow a
// remote side effect and is left to the caller.
const HANDSHAKE_RETRY_DELAYS_MS = [500, 1500];

function refusedHandshake(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    if (
      /Version negotiation failed: the server answered the probe with HTTP 5\d\d/.test(
        current.message,
      )
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function callToolWithHandshakeRetry(
  runtime: McpRuntime,
  server: string,
  tool: string,
  options: () => McpCallOptions,
  deadlineMs = Number.POSITIVE_INFINITY,
): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runtime.callTool(server, tool, options());
    } catch (error) {
      const wait = HANDSHAKE_RETRY_DELAYS_MS[attempt];
      if (
        wait === undefined ||
        !refusedHandshake(error) ||
        Date.now() + wait >= deadlineMs
      ) {
        throw error;
      }
      await delay(wait);
    }
  }
}
