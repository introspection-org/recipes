import {
  createTraceState,
  ROOT_CONTEXT,
  trace,
  type Context,
} from "@opentelemetry/api";

import type { McpDaemonTraceContext } from "./mcp/daemon/protocol.js";

const TRACEPARENT =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export function mcpTraceContextFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): McpDaemonTraceContext | undefined {
  const traceparent = env.TRACEPARENT?.trim();
  if (!traceparent) return undefined;
  const tracestate = env.TRACESTATE?.trim();
  return { traceparent, ...(tracestate ? { tracestate } : {}) };
}

/** Rebuild the caller's remote parent without sharing mutable process env. */
export function mcpDaemonRequestContext(
  carrier: McpDaemonTraceContext | undefined,
  base: Context = ROOT_CONTEXT,
): Context {
  const match = carrier?.traceparent.match(TRACEPARENT);
  if (!match) return base;
  const [, version, traceId, spanId, flags] = match;
  if (
    version?.toLowerCase() === "ff" ||
    traceId === "0".repeat(32) ||
    spanId === "0".repeat(16)
  ) {
    return base;
  }
  return trace.setSpanContext(base, {
    traceId: traceId!.toLowerCase(),
    spanId: spanId!.toLowerCase(),
    traceFlags: Number.parseInt(flags!, 16),
    isRemote: true,
    ...(carrier?.tracestate
      ? { traceState: createTraceState(carrier.tracestate) }
      : {}),
  });
}
