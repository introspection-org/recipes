import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from "@modelcontextprotocol/server";

import type { McpFetch } from "../src/index.js";

type FakeToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type FakeTool = (args: Record<string, unknown>) => FakeToolResult;

export interface FakeMcpCall {
  server: string;
  method: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  authorization: string | null;
}

/**
 * Fake Workspace MCP servers, keyed by host, built on the MCP SDK's own server
 * and answered in process. `failCalls` answers `tools/call` with that HTTP
 * status, after the session started cleanly; `down` refuses every request.
 */
export function fakeMcp(
  servers: Record<string, Record<string, FakeTool>>,
  options: { failCalls?: Record<string, number>; down?: string[] } = {},
): { fetchImpl: McpFetch; calls: FakeMcpCall[] } {
  const calls: FakeMcpCall[] = [];
  const handlers = Object.fromEntries(
    Object.entries(servers).map(([host, tools]) => [
      host,
      createMcpHandler(() => {
        const server = new McpServer({
          name: `fake-${host}`,
          version: "1.0.0",
        });
        for (const [name, handler] of Object.entries(tools)) {
          server.registerTool(
            name,
            {
              description: name,
              inputSchema: fromJsonSchema<Record<string, unknown>>({
                type: "object",
                additionalProperties: true,
              }),
            },
            async (args: Record<string, unknown>) => {
              const result = handler(args);
              return { content: [], ...result };
            },
          );
        }
        return server;
      }),
    ]),
  );
  const fetchImpl: McpFetch = async (url, init) => {
    const request = new Request(url, init);
    const host = new URL(request.url).host;
    const body = request.method === "POST" ? await request.clone().text() : "";
    let message: {
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    } = {};
    try {
      message = body ? JSON.parse(body) : {};
    } catch {
      message = {};
    }
    calls.push({
      server: host,
      method: message.method ?? request.method,
      tool: message.params?.name,
      arguments: message.params?.arguments,
      authorization: request.headers.get("Authorization"),
    });
    if (options.down?.includes(host))
      return new Response("unavailable", { status: 503 });
    const failure = options.failCalls?.[host];
    if (failure && message.method === "tools/call") {
      return new Response(JSON.stringify({ error: { code: failure } }), {
        status: failure,
      });
    }
    const handler = handlers[host];
    if (!handler) return new Response("not found", { status: 404 });
    return handler.fetch(request);
  };
  return { fetchImpl, calls };
}

/** A tool answering with a structured result. */
export function structured(value: Record<string, unknown>): FakeTool {
  return () => ({
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }],
  });
}
