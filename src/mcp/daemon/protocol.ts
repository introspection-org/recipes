import type { McpToolCatalogEntry } from "../index.js";

export const MCP_DAEMON_SOCKET_ENV = "PI_RECIPES_MCP_DAEMON_SOCKET";
export const MCP_DAEMON_TOKEN_ENV = "PI_RECIPES_MCP_DAEMON_TOKEN";
export const MCP_DAEMON_FINGERPRINT_ENV = "PI_RECIPES_MCP_DAEMON_FINGERPRINT";
export const MCP_DAEMON_PARENT_PID_ENV = "PI_RECIPES_MCP_DAEMON_PARENT_PID";
export const MCP_SESSION_ROOT_ENV = "PI_RECIPES_MCP_SESSION_ROOT";
export const MCP_DAEMON_GENERATION_ENV = "PI_RECIPES_MCP_DAEMON_GENERATION";
export const MCP_DAEMON_MAX_FRAME_BYTES = 10 * 1024 * 1024;

export interface McpDaemonTraceContext {
  traceparent: string;
  tracestate?: string;
}

export interface McpDaemonExecuteRequest {
  type: "execute";
  id: string;
  token: string;
  fingerprint: string;
  args: string[];
  stdin: string;
  trace?: McpDaemonTraceContext;
}

export interface McpDaemonCancelRequest {
  type: "cancel";
  id: string;
  token: string;
  requestId: string;
}

export interface McpDaemonStopRequest {
  type: "stop";
  id: string;
  token: string;
}

export interface McpDaemonPingRequest {
  type: "ping";
  id: string;
  token: string;
  fingerprint: string;
}

export interface McpDaemonCatalogRequest {
  type: "catalog";
  id: string;
  token: string;
  fingerprint: string;
  timeoutMs: number;
  allowPartial?: boolean;
}

export interface McpDaemonCallRequest {
  type: "call";
  id: string;
  token: string;
  fingerprint: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
  trace?: McpDaemonTraceContext;
}

export interface McpCatalogServer {
  id: string;
  name: string;
  tools: McpToolCatalogEntry[];
  error?: string;
}

export type McpDaemonRequest =
  | McpDaemonExecuteRequest
  | McpDaemonCancelRequest
  | McpDaemonStopRequest
  | McpDaemonPingRequest
  | McpDaemonCatalogRequest
  | McpDaemonCallRequest;

export type McpDaemonEnvelope =
  | { id: string; stream: "stdout" | "stderr"; data: string }
  | { id: string; ready: true; fingerprint: string }
  | { id: string; catalogs: McpCatalogServer[] }
  | { id: string; result: unknown }
  | { id: string; exitCode: number }
  | { id: string; error: string };

export function serializeMcpDaemonEnvelope(
  envelope: McpDaemonEnvelope,
  maxBytes = MCP_DAEMON_MAX_FRAME_BYTES
): string {
  let estimatedBytes = 0;
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(envelope, (key, value: unknown) => {
    estimatedBytes += Buffer.byteLength(key, "utf8") + 4;
    if (typeof value === "string") {
      estimatedBytes += Buffer.byteLength(value, "utf8") + 2;
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      estimatedBytes += 16;
    } else if (value && typeof value === "object") {
      if (seen.has(value)) {
        throw new Error("MCP daemon envelope contains a circular value.");
      }
      seen.add(value);
    }
    if (estimatedBytes > maxBytes) {
      throw new Error("MCP daemon envelope exceeded the frame limit.");
    }
    return value;
  });
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error("MCP daemon envelope exceeded the frame limit.");
  }
  return `${serialized}\n`;
}
