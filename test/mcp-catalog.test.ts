import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearMcpCatalogPreload,
  preloadMcpCatalogs,
} from "../src/mcp-catalog.js";
import { callMcpDaemonTool } from "../src/mcp/daemon/client.js";
import {
  MCP_DAEMON_FINGERPRINT_ENV,
  MCP_DAEMON_SOCKET_ENV,
  MCP_DAEMON_TOKEN_ENV,
  serializeMcpDaemonEnvelope,
} from "../src/mcp/daemon/protocol.js";

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("MCP catalog preload", () => {
  it("rejects oversized daemon envelopes before writing them", () => {
    expect(() =>
      serializeMcpDaemonEnvelope(
        { id: "large", result: { text: "x".repeat(1_000) } },
        128
      )
    ).toThrow("exceeded the frame limit");
  });

  it("delegates retry ownership to the daemon and reuses the successful result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "recipes-catalog-"));
    directories.push(directory);
    const socketPath = join(directory, "mcp.sock");
    const token = "test-token";
    const fingerprint = "test-fingerprint";
    let catalogAttempts = 0;
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (chunk) => {
        const request = JSON.parse(String(chunk).split("\n")[0]!);
        if (request.token !== token) {
          socket.end(`${JSON.stringify({ id: request.id, error: "unauthorized" })}\n`);
          return;
        }
        if (request.type === "ping") {
          socket.end(
            `${JSON.stringify({ id: request.id, ready: true, fingerprint })}\n`
          );
          return;
        }
        catalogAttempts += 1;
        socket.end(
          `${JSON.stringify({
            id: request.id,
            catalogs: [
              {
                id: "crm",
                name: "CRM",
                tools: [{ name: "search_contacts", input_schema: { type: "object" } }],
              },
            ],
          })}\n`
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [MCP_DAEMON_SOCKET_ENV]: socketPath,
      [MCP_DAEMON_TOKEN_ENV]: token,
      [MCP_DAEMON_FINGERPRINT_ENV]: fingerprint,
    };

    const catalogs = await preloadMcpCatalogs({ env, timeoutMs: 100 });
    expect(catalogAttempts).toBe(1);
    expect(catalogs[0]?.tools.map((tool) => tool.name)).toEqual([
      "search_contacts",
    ]);

    await preloadMcpCatalogs({ env, timeoutMs: 100 });
    expect(catalogAttempts).toBe(1);
    clearMcpCatalogPreload(env);
  });

  it("returns promptly on cancellation and sends a daemon cancel request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "recipes-call-cancel-"));
    directories.push(directory);
    const socketPath = join(directory, "mcp.sock");
    const token = "test-token";
    const fingerprint = "test-fingerprint";
    let callSocket: import("node:net").Socket | undefined;
    let callSeen: (() => void) | undefined;
    const sawCall = new Promise<void>((resolve) => {
      callSeen = resolve;
    });
    let cancelledRequestId: string | undefined;
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (chunk) => {
        const request = JSON.parse(String(chunk).split("\n")[0]!);
        if (request.type === "ping") {
          socket.end(
            `${JSON.stringify({ id: request.id, ready: true, fingerprint })}\n`
          );
          return;
        }
        if (request.type === "call") {
          callSocket = socket;
          callSeen?.();
          return;
        }
        if (request.type === "cancel") {
          cancelledRequestId = request.requestId;
          socket.end(
            `${JSON.stringify({ id: request.id, exitCode: 130 })}\n`
          );
          callSocket?.end(
            `${JSON.stringify({
              id: request.requestId,
              error: "cancelled; remote outcome is unknown",
            })}\n`
          );
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const env: NodeJS.ProcessEnv = {
      [MCP_DAEMON_SOCKET_ENV]: socketPath,
      [MCP_DAEMON_TOKEN_ENV]: token,
      [MCP_DAEMON_FINGERPRINT_ENV]: fingerprint,
    };
    const controller = new AbortController();
    const call = callMcpDaemonTool("contacts", "update_contact", {}, {
      env,
      signal: controller.signal,
    });
    await sawCall;
    controller.abort();

    await expect(call).rejects.toThrow("remote outcome is unknown");
    for (
      let attempt = 0;
      attempt < 20 && cancelledRequestId === undefined;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(cancelledRequestId).toBeDefined();
  });

  it("marks a lost post-dispatch daemon response as outcome unknown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "recipes-call-lost-response-"));
    directories.push(directory);
    const socketPath = join(directory, "mcp.sock");
    const token = "test-token";
    const fingerprint = "test-fingerprint";
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (chunk) => {
        const request = JSON.parse(String(chunk).split("\n")[0]!);
        if (request.type === "ping") {
          socket.end(
            `${JSON.stringify({ id: request.id, ready: true, fingerprint })}\n`
          );
          return;
        }
        if (request.type === "call") socket.destroy();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const env: NodeJS.ProcessEnv = {
      [MCP_DAEMON_SOCKET_ENV]: socketPath,
      [MCP_DAEMON_TOKEN_ENV]: token,
      [MCP_DAEMON_FINGERPRINT_ENV]: fingerprint,
    };

    await expect(
      callMcpDaemonTool("contacts", "update_contact", {}, { env })
    ).rejects.toThrow("remote outcome is unknown; do not retry automatically");
  });
});
