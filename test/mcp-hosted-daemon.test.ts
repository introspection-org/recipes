import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { preloadMcpCatalogs } from "../src/mcp/catalog.js";
import {
  callMcpDaemonTool,
  ensureMcpDaemon,
} from "../src/mcp/daemon/client.js";
import { hostedMcpDaemon } from "../src/mcp/daemon/hosted.js";
import { startMcpDaemonServer } from "../src/mcp/daemon/server.js";
import {
  materializeMcpSession,
  materializeSessionMcpCli,
  nativeMcpClientPath,
  stopMcpDaemon,
} from "../src/mcp/index.js";
import type { RecipePackageManifest } from "../src/recipe/package.js";

/** An MCP server whose `slow` tool answers after `ms`, counting calls in flight. */
async function startSlowMcp() {
  const stats = { inFlight: 0, maxInFlight: 0, calls: 0, cancelled: 0 };
  let sessions = 0;
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(req.method === "DELETE" ? 200 : 405).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body) as {
        id?: number;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      const reply = (result: unknown, headers: Record<string, string> = {}) =>
        res
          .writeHead(200, { "content-type": "application/json", ...headers })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      if (message.method === "initialize") {
        sessions += 1;
        reply(
          {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "slow", version: "1.0.0" },
          },
          { "mcp-session-id": `session-${sessions}` },
        );
        return;
      }
      if (message.method === "notifications/cancelled") stats.cancelled += 1;
      if (message.method?.startsWith("notifications/")) {
        res.writeHead(202).end();
        return;
      }
      if (message.method === "tools/list") {
        reply({
          tools: ["slow", "hidden"].map((name) => ({
            name,
            description: `The ${name} tool.`,
            inputSchema: {
              type: "object",
              properties: { ms: { type: "number" } },
            },
          })),
        });
        return;
      }
      stats.calls += 1;
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      const ms = Number(message.params?.arguments?.ms ?? 0);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        stats.inFlight -= 1;
      };
      res.once("close", finish);
      setTimeout(() => {
        if (res.destroyed) return;
        finish();
        reply({
          content: [{ type: "text", text: `slept ${ms}` }],
          structuredContent: { slept: ms },
        });
      }, ms);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    stats,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function manifest(recipeDir: string): RecipePackageManifest {
  return {
    name: "demo",
    version: "1.0.0",
    path: recipeDir,
    resources: { agents: [], extensions: [], skills: [], prompts: [] },
    mcp: {
      manifests: [],
      servers: [{ id: "slow", required: true, tools: { include: ["slow"] } }],
    },
  };
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A materialized `mcp` session whose only server is the slow one. */
async function session(extraEnv: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "recipes-hosted-"));
  const stub = await startSlowMcp();
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => stub.close());
  const cwd = join(root, "workspace");
  const recipeDir = join(root, "recipe");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(recipeDir, { recursive: true });
  const local = join(cwd, ".pi", "mcp.local.json");
  writeFileSync(
    local,
    JSON.stringify({
      servers: [{ id: "slow", transport: "streamable_http", url: stub.url }],
    }),
  );
  const env: NodeJS.ProcessEnv = {
    PI_RECIPES_MCP_LOCAL_CONFIG: local,
    ...extraEnv,
  };
  const { shimPath } = await materializeSessionMcpCli({ cwd, env });
  await materializeMcpSession({
    cwd,
    env,
    manifest: manifest(recipeDir),
    agentMcp: [{ serverId: "slow", tools: { include: ["slow"] } }],
  });
  cleanups.push(() => stopMcpDaemon({ ...env }));
  const shellEnv = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const ids = {
    socketPath: env.PI_RECIPES_MCP_DAEMON_SOCKET!,
    token: env.PI_RECIPES_MCP_DAEMON_TOKEN!,
    fingerprint: env.PI_RECIPES_MCP_DAEMON_FINGERPRINT!,
  };
  return { env, shellEnv, shimPath, stub, ids };
}

function run(
  command: string,
  args: string[],
  env: Record<string, string>,
  options: { interruptAfterMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (options.interruptAfterMs !== undefined) {
      setTimeout(() => child.kill("SIGTERM"), options.interruptAfterMs);
    }
  });
}

const nativeClient = nativeMcpClientPath();

describe("the mcp command's socket served from the session's process", () => {
  it("answers the shim from the host, with concurrent calls", async () => {
    const { env, shellEnv, shimPath, stub, ids } = await session({
      PI_RECIPES_MCP_CLIENT: "",
    });
    await preloadMcpCatalogs({ env });

    expect(hostedMcpDaemon(ids)).toBeDefined();
    expect(statSync(dirname(ids.socketPath)).mode & 0o777).toBe(0o700);

    const [left, right] = await Promise.all([
      run(shimPath, ["call", "slow.slow", "ms=300"], shellEnv),
      run(shimPath, ["call", "slow.slow", "ms=300"], shellEnv),
    ]);
    expect(left).toMatchObject({ code: 0, stderr: "" });
    expect(right).toMatchObject({ code: 0, stderr: "" });
    expect(left.stdout).toContain("300");
    expect(stub.stats.maxInFlight).toBe(2);

    const refused = await run(shimPath, ["call", "slow.hidden"], shellEnv);
    expect(refused.code).not.toBe(0);
    expect(stub.stats.calls).toBe(2);
  }, 30_000);

  it.runIf(nativeClient)(
    "cancels a call the shell interrupts",
    async () => {
      const { env, shellEnv, stub, ids } = await session({
        PI_RECIPES_MCP_CLIENT: "",
      });
      await preloadMcpCatalogs({ env });
      expect(hostedMcpDaemon(ids)).toBeDefined();

      const interrupted = await run(
        nativeClient!,
        ["call", "slow.slow", "ms=10000"],
        shellEnv,
        { interruptAfterMs: 500 },
      );
      expect(interrupted.code).toBe(130);
      for (let i = 0; i < 100 && stub.stats.cancelled === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(stub.stats.cancelled).toBe(1);

      const controller = new AbortController();
      const call = callMcpDaemonTool(
        "slow",
        "slow",
        { ms: 10_000 },
        { env, signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 300);
      await expect(call).rejects.toThrow(/was cancelled/);
      for (let i = 0; i < 100 && stub.stats.cancelled === 1; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(stub.stats.cancelled).toBe(2);
    },
    30_000,
  );

  it("closes the server and its socket when the session ends", async () => {
    const { env, ids } = await session({ PI_RECIPES_MCP_CLIENT: "" });
    await preloadMcpCatalogs({ env });
    const server = hostedMcpDaemon(ids)!;
    expect(existsSync(ids.socketPath)).toBe(true);

    await stopMcpDaemon({ ...env });
    await server.closed;
    expect(hostedMcpDaemon(ids)).toBeUndefined();
    expect(existsSync(ids.socketPath)).toBe(false);
    expect(existsSync(dirname(ids.socketPath))).toBe(false);
  }, 30_000);

  it("replaces a stale socket file before it binds", async () => {
    const { env, shellEnv, shimPath, ids } = await session({
      PI_RECIPES_MCP_CLIENT: "",
    });
    mkdirSync(dirname(ids.socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(ids.socketPath, "stale");

    await preloadMcpCatalogs({ env });
    expect(hostedMcpDaemon(ids)).toBeDefined();
    const result = await run(shimPath, ["call", "slow.slow", "ms=1"], shellEnv);
    expect(result).toMatchObject({ code: 0, stderr: "" });
  }, 30_000);

  it("starts the standalone daemon when no session is listening", async () => {
    const { shellEnv, shimPath, ids } = await session({
      PI_RECIPES_MCP_CLIENT: "",
    });

    const result = await run(shimPath, ["call", "slow.slow", "ms=1"], shellEnv);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(hostedMcpDaemon(ids)).toBeUndefined();
    expect(existsSync(ids.socketPath)).toBe(true);
  }, 30_000);

  it("keeps the standalone daemon for a session on mcporter", async () => {
    const { env, ids } = await session({ PI_RECIPES_MCP_CLIENT: "mcporter" });

    await ensureMcpDaemon(env);
    expect(hostedMcpDaemon(ids)).toBeUndefined();
    expect(existsSync(ids.socketPath)).toBe(true);
  }, 30_000);

  it("queues requests beyond its in-flight limit", async () => {
    const { env, stub } = await session({ PI_RECIPES_MCP_CLIENT: "" });
    const socketPath = join(
      mkdtempSync(join(tmpdir(), "recipes-hosted-socket-")),
      "mcp.sock",
    );
    const server = await startMcpDaemonServer({
      socketPath,
      token: "token",
      fingerprint: "fingerprint",
      env: { ...process.env, ...env },
      maxInFlight: 1,
      unref: true,
    });
    cleanups.push(async () => {
      await server.close();
      rmSync(dirname(socketPath), { recursive: true, force: true });
    });

    const signal = new AbortController().signal;
    const call = () =>
      server.callTool(
        {
          server: "slow",
          tool: "slow",
          arguments: { ms: 200 },
          timeoutMs: 5_000,
        },
        signal,
      );
    const results = await Promise.all([call(), call(), call()]);
    expect(results).toHaveLength(3);
    expect(stub.stats.calls).toBe(3);
    expect(stub.stats.maxInFlight).toBe(1);
  }, 30_000);
});
