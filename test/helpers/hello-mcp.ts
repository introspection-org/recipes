import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An MCP server over streamable HTTP (JSON responses), shaped like
 * the Harbor MCP example's hello server: `echo` and `get_greeting`.
 */
export interface HelloMcp {
  url: string;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** A tool the server lists, and the text its call answers. */
export interface HelloMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  answer(args: Record<string, unknown>): string;
}

const HELLO_TOOLS: HelloMcpTool[] = [
  {
    name: "echo",
    description: "Echo a message back.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    answer: (args) => `Echo: ${String(args.message)}`,
  },
  {
    name: "get_greeting",
    description: "Return a fixed greeting.",
    inputSchema: { type: "object", properties: {} },
    answer: () => "hello from the local MCP",
  },
];

export async function startHelloMcp(
  options: {
    bearer?: string;
    initializeDelayMs?: number;
    /** In place of `echo` and `get_greeting`. */
    tools?: HelloMcpTool[];
  } = {},
): Promise<HelloMcp> {
  const tools = options.tools ?? HELLO_TOOLS;
  const calls: HelloMcp["calls"] = [];
  let sessions = 0;
  const server: Server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (
        options.bearer &&
        req.headers.authorization !== `Bearer ${options.bearer}`
      ) {
        res.writeHead(401).end();
        return;
      }
      const message = JSON.parse(body) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      const reply = (result: unknown, headers: Record<string, string> = {}) =>
        res
          .writeHead(200, { "content-type": "application/json", ...headers })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      switch (message.method) {
        case "initialize":
          sessions += 1;
          setTimeout(
            () =>
              reply(
                {
                  protocolVersion:
                    message.params?.protocolVersion ?? "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "hello", version: "1.0.0" },
                },
                { "mcp-session-id": `session-${sessions}` },
              ),
            options.initializeDelayMs ?? 0,
          );
          return;
        case "notifications/initialized":
          res.writeHead(202).end();
          return;
        case "tools/list":
          reply({
            tools: tools.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          });
          return;
        case "tools/call": {
          const name = String(message.params?.name);
          const args = (message.params?.arguments ?? {}) as Record<
            string,
            unknown
          >;
          calls.push({ name, arguments: args });
          const text =
            tools.find((tool) => tool.name === name)?.answer(args) ?? "";
          reply({
            content: [{ type: "text", text }],
            structuredContent: { result: text },
          });
          return;
        }
        default:
          reply({});
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
