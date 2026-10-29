import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { PiMcpRuntime } from "../src/mcp/pi-runtime.js";

interface Behaviour {
  /** Statuses to answer the next requests of a method with, in order. */
  fail?: Record<string, number[]>;
  /** Milliseconds to hold a `tools/call` before answering. */
  callDelayMs?: number;
}

async function startServer(behaviour: Behaviour = {}) {
  const seen: Array<{ method: string; authorization?: string; session?: string }> = [];
  const cancelled: unknown[] = [];
  const sessions = new Set<string>();
  let nextSession = 0;
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body) as {
        id?: number;
        method: string;
        params?: Record<string, unknown>;
      };
      const session = req.headers["mcp-session-id"] as string | undefined;
      seen.push({ method: message.method, authorization: req.headers.authorization, session });
      const failure = behaviour.fail?.[message.method]?.shift();
      if (failure) {
        res.writeHead(failure).end("failing on purpose");
        return;
      }
      if (message.method !== "initialize" && (!session || !sessions.has(session))) {
        res.writeHead(404).end("unknown session");
        return;
      }
      const reply = (result: unknown, headers: Record<string, string> = {}) =>
        res
          .writeHead(200, { "content-type": "application/json", ...headers })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      switch (message.method) {
        case "initialize": {
          const id = `session-${++nextSession}`;
          sessions.add(id);
          reply(
            {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            },
            { "mcp-session-id": id }
          );
          return;
        }
        case "notifications/initialized":
          res.writeHead(202).end();
          return;
        case "notifications/cancelled":
          cancelled.push(message.params);
          res.writeHead(202).end();
          return;
        case "tools/list":
          reply({
            tools: [
              { name: "echo", inputSchema: { type: "object" } },
              { name: "delete_everything", inputSchema: { type: "object" } },
            ],
          });
          return;
        case "tools/call":
          setTimeout(
            () =>
              reply({
                content: [{ type: "text", text: `Echo: ${String((message.params?.arguments as { message?: string })?.message)}` }],
              }),
            behaviour.callDelayMs ?? 0
          );
          return;
        default:
          reply({});
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    cancelled,
    expireSessions: () => sessions.clear(),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("the pi-mcp runtime behind the mcp command", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function fixture(behaviour?: Behaviour, server: Record<string, unknown> = {}) {
    const mcp = await startServer(behaviour);
    const runtime = new PiMcpRuntime(
      {
        imports: [],
        mcpServers: {
          hello: { baseUrl: mcp.url, headers: { Authorization: "Bearer ${HELLO_TOKEN}" }, ...server },
        },
      },
      { HELLO_TOKEN: "secret" }
    );
    cleanups.push(async () => {
      await runtime.close();
      await mcp.close();
    });
    return { mcp, runtime };
  }

  it("keeps one connection, sending headers with ${VAR} resolved", async () => {
    const { mcp, runtime } = await fixture();

    expect(runtime.listServers()).toEqual(["hello"]);
    expect((await runtime.listTools("hello")).map((tool) => (tool as { name: string }).name)).toEqual([
      "echo",
      "delete_everything",
    ]);
    await runtime.callTool("hello", "echo", { args: { message: "one" } });
    await runtime.callTool("hello", "echo", { args: { message: "two" } });

    expect(mcp.seen.filter((request) => request.method === "initialize")).toHaveLength(1);
    expect(new Set(mcp.seen.map((request) => request.authorization))).toEqual(
      new Set(["Bearer secret"])
    );
  });

  it("holds calls to the session's allowed tools", async () => {
    const { runtime } = await fixture(undefined, { allowedTools: ["echo"] });

    expect((await runtime.listTools("hello")).map((tool) => (tool as { name: string }).name)).toEqual([
      "echo",
    ]);
    await expect(runtime.callTool("hello", "delete_everything")).rejects.toThrow(
      /not in this session's allowed tools/
    );
  });

  it("sends a call once more on a new session when the server forgot the old one", async () => {
    const { mcp, runtime } = await fixture();
    await runtime.callTool("hello", "echo", { args: { message: "before" } });
    mcp.expireSessions();

    const result = (await runtime.callTool("hello", "echo", { args: { message: "after" } })) as {
      content: Array<{ text: string }>;
    };

    expect(result.content[0]!.text).toBe("Echo: after");
    expect(mcp.seen.filter((request) => request.method === "initialize")).toHaveLength(2);
  });

  it("never sends a tools/call twice after it may have run", async () => {
    const { mcp, runtime } = await fixture({ fail: { "tools/call": [503] } });

    await expect(runtime.callTool("hello", "echo", { args: { message: "once" } })).rejects.toThrow(
      /HTTP 503/
    );
    expect(mcp.seen.filter((request) => request.method === "tools/call")).toHaveLength(1);
  });

  it("retries a read, and a connect the server answered with a transient status", async () => {
    const { mcp, runtime } = await fixture({ fail: { initialize: [503], "tools/list": [502] } });

    expect(await runtime.listTools("hello")).toHaveLength(2);
    expect(mcp.seen.filter((request) => request.method === "initialize")).toHaveLength(2);
    expect(mcp.seen.filter((request) => request.method === "tools/list")).toHaveLength(2);
  });

  it("fails at once on a server that refuses connections", async () => {
    const runtime = new PiMcpRuntime({
      imports: [],
      mcpServers: { offline: { baseUrl: "http://127.0.0.1:9/mcp", headers: {} } },
    });
    const startedAt = Date.now();

    await expect(runtime.listTools("offline")).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("cancels a call on the server when its signal aborts", async () => {
    const { mcp, runtime } = await fixture({ callDelayMs: 2_000 });
    const controller = new AbortController();

    const call = runtime.callTool("hello", "echo", { args: {}, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);

    await expect(call).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mcp.cancelled).toHaveLength(1);
  });

  it("refuses an OAuth binding rather than running without it", () => {
    expect(
      () =>
        new PiMcpRuntime({
          imports: [],
          mcpServers: { oauth: { baseUrl: "https://example.test/mcp", headers: {}, auth: "oauth" } },
        })
    ).toThrow(/OAuth flow, which the pi-mcp client does not run/);
  });
});
