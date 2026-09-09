import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  callJsonArgumentError,
  describeUnavailableRunTool,
  describeUnknownRunServer,
  searchMcpTools,
} from "../src/mcp-cli.js";
import { preloadMcpCatalogs } from "../src/mcp-catalog.js";
import { callMcpDaemonTool } from "../src/mcp-daemon-client.js";
import {
  buildMcporterConfig,
  clearMcpSession,
  defaultMcporterConfigPath,
  defaultMcpSessionPath,
  filterMcpCatalog,
  materializeMcpSession,
  materializeSessionMcpCli,
  mcpSessionAllowsTool,
  nativeMcpClientPath,
  isolateMcpEnvironment,
  restoreMcpEnvironment,
  snapshotMcpEnvironment,
  stopMcpDaemon,
  type McpSessionConfig,
} from "../src/mcp.js";
import type { RecipePackageManifest } from "../src/recipe-package.js";

describe("MCP environment leasing", () => {
  it("preserves daemon generation across isolation and restoration", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      PI_RECIPES_MCP_DAEMON_GENERATION: "host-generation",
    };
    const snapshot = snapshotMcpEnvironment(env);

    isolateMcpEnvironment(env);
    expect(env.PI_RECIPES_MCP_DAEMON_GENERATION).toBeUndefined();

    env.PI_RECIPES_MCP_DAEMON_GENERATION = "leased-generation";
    restoreMcpEnvironment(env, snapshot);
    expect(env.PI_RECIPES_MCP_DAEMON_GENERATION).toBe("host-generation");
  });
});

function recipeManifest(
  recipeDir: string,
  servers: Array<{
    id: string;
    required?: boolean;
    include: string[];
    exclude?: string[];
  }>
): RecipePackageManifest {
  return {
    name: "demo",
    version: "1.0.0",
    path: recipeDir,
    resources: { agents: [], extensions: [], skills: [], prompts: [] },
    mcp: {
      manifests: [],
      servers: servers.map((server) => ({
        id: server.id,
        required: server.required ?? false,
        tools: {
          include: server.include,
          ...(server.exclude ? { exclude: server.exclude } : {}),
        },
      })),
    },
  };
}

function writeLocalConfig(
  cwd: string,
  servers: Array<Record<string, unknown>>
): string {
  const path = join(cwd, ".pi", "mcp.local.json");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(path, JSON.stringify({ servers }));
  return path;
}

function catalogLockPath(
  cwd: string,
  server: McpSessionConfig["servers"][number]
): string {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        id: server.id,
        baseUrl: server.base_url,
        packageTools: server.package_tools,
        agentTools: server.agent_tools,
      })
    )
    .digest("hex")
    .slice(0, 20);
  return join(cwd, ".pi", "mcp-catalogs", `${server.id}-${fingerprint}.json.lock`);
}

function runMcpCli(
  args: string[],
  env: Record<string, string>,
  stdin?: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "dist", "mcp-cli.js"), ...args],
      {
        env: { ...process.env, ...env },
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin!.end(stdin);
  });
}

function runMcpShim(
  shimPath: string,
  args: string[],
  env: Record<string, string>,
  stdin?: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(shimPath, args, {
      env: { ...process.env, ...env },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin!.end(stdin);
  });
}

function interruptNativeMcp(
  clientPath: string,
  args: string[],
  env: Record<string, string>,
  stdin: string,
  afterMs = 100
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(clientPath, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin!.end(stdin);
    setTimeout(() => child.kill("SIGTERM"), afterMs);
  });
}

function startStubMcpServer(options: { failListAttempts?: number } = {}): Promise<{
  server: Server;
  url: string;
  stats: { initialize: number; list: number; call: number };
}> {
  const sessions = new Set<string>();
  const stats = { initialize: 0, list: 0, call: 0 };
  const server = createServer((req, res) => {
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
      if (req.headers.authorization !== "Bearer test-token") {
        res.writeHead(401).end();
        return;
      }
      const message = JSON.parse(body) as {
        id?: number;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (message.method === "initialize") {
        stats.initialize += 1;
        const sessionId = `session-${stats.initialize}`;
        sessions.add(sessionId);
        headers["mcp-session-id"] = sessionId;
        res.writeHead(200, headers).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "stub", version: "1.0.0" },
            },
          })
        );
        return;
      }
      const sessionId = req.headers["mcp-session-id"];
      if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
        res.writeHead(400, headers).end();
        return;
      }
      if (message.method === "notifications/initialized") {
        res.writeHead(202, headers).end();
        return;
      }
      if (message.method === "tools/list") {
        stats.list += 1;
        if (stats.list <= (options.failListAttempts ?? 0)) {
          res.writeHead(503, headers).end("temporarily unavailable");
          return;
        }
        setTimeout(() => {
          res.writeHead(200, headers).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                tools: [
                  {
                    name: "search_profiles",
                    description: "Search candidate profiles",
                    inputSchema: {
                      type: "object",
                      properties: { query: { type: "string" } },
                      required: ["query"],
                    },
                  },
                  {
                    name: "lookup_profile",
                    description: "Look up one profile",
                    inputSchema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        limit: { type: "number" },
                      },
                      required: ["id"],
                    },
                  },
                  {
                    name: "text_only",
                    description: "Return plain text",
                    inputSchema: {
                      type: "object",
                      properties: {},
                    },
                  },
                  {
                    name: "requires_auth",
                    description: "Return an authentication error",
                    inputSchema: {
                      type: "object",
                      properties: {},
                    },
                  },
                  {
                    name: "hidden_tool",
                    description: "Must not escape policy",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              },
            })
          );
        }, 100);
        return;
      }
      if (message.method === "tools/call") {
        stats.call += 1;
        if (message.params?.name === "requires_auth") {
          res.writeHead(401, headers).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32001, message: "Unauthorized" },
            })
          );
          return;
        }
        const result =
          message.params?.name === "text_only"
            ? { content: [{ type: "text", text: "plain output" }] }
            : {
                structuredContent: {
                  tool: message.params?.name,
                  arguments: message.params?.arguments,
                },
                content: [{ type: "text", text: "ok" }],
              };
        res.writeHead(200, headers).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result,
          })
        );
        return;
      }
      res.writeHead(200, headers).end(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        server,
        url: `http://127.0.0.1:${port}/mcp`,
        stats,
      });
    });
  });
}

describe("static MCP session materialization", () => {
  it("settles daemon shutdown when the socket closes without an end event", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipes-mcp-stop-"));
    const socketPath = join(root, "daemon.sock");
    const server = createNetServer((socket) => {
      socket.once("data", () => socket.destroy());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      await expect(
        stopMcpDaemon({
          PI_RECIPES_MCP_DAEMON_SOCKET: socketPath,
          PI_RECIPES_MCP_DAEMON_TOKEN: "token",
        })
      ).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes policy and credential references without network discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipes-mcp-static-"));
    try {
      const cwd = join(root, "workspace");
      const recipeDir = join(root, "recipe");
      mkdirSync(recipeDir, { recursive: true });
      const local = writeLocalConfig(cwd, [
        {
          id: "nextplay",
          transport: "streamable_http",
          url: "https://mcp.example.test/mcp",
          headers: { Authorization: "Bearer ${SESSION_TOKEN}" },
          httpFetch: "default",
        },
      ]);
      const env: NodeJS.ProcessEnv = {
        PI_RECIPES_MCP_LOCAL_CONFIG: local,
        SESSION_TOKEN: "secret-value",
      };

      const session = await materializeMcpSession({
        cwd,
        env,
        manifest: recipeManifest(recipeDir, [
          {
            id: "nextplay",
            required: true,
            include: ["*"],
            exclude: ["delete_everything"],
          },
        ]),
        agentMcp: [
          {
            serverId: "nextplay",
            tools: { include: ["search_profiles", "get_profile"] },
          },
        ],
      });

      expect(session.servers).toHaveLength(1);
      expect(session.servers[0]?.catalog).toBeUndefined();
      expect(mcpSessionAllowsTool(session.servers[0]!, "search_profiles")).toBe(
        true
      );
      expect(mcpSessionAllowsTool(session.servers[0]!, "other_tool")).toBe(false);
      const serializedSession = readFileSync(defaultMcpSessionPath(cwd), "utf8");
      const serializedTransport = readFileSync(
        defaultMcporterConfigPath(cwd),
        "utf8"
      );
      expect(serializedSession).not.toContain("secret-value");
      expect(serializedTransport).not.toContain("secret-value");
      expect(serializedTransport).toContain("${SESSION_TOKEN}");
      expect(JSON.parse(serializedTransport).mcpServers.nextplay.httpFetch).toBe(
        "default"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails immediately when a required binding is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipes-mcp-required-"));
    try {
      const recipeDir = join(root, "recipe");
      mkdirSync(recipeDir, { recursive: true });
      await expect(
        materializeMcpSession({
          cwd: join(root, "workspace"),
          env: {},
          manifest: recipeManifest(recipeDir, [
            { id: "required", required: true, include: ["*"] },
          ]),
          agentMcp: [
            { serverId: "required", tools: { include: ["*"] } },
          ],
        })
      ).rejects.toThrow("Required MCP server binding(s) missing: required");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes stale policy and writes a closed transport config", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipes-mcp-clear-"));
    try {
      mkdirSync(join(root, ".pi"), { recursive: true });
      writeFileSync(defaultMcpSessionPath(root), "stale");
      const env: NodeJS.ProcessEnv = { PI_RECIPES_MCP_SESSION: "stale" };
      await clearMcpSession(env, root);
      expect(env.PI_RECIPES_MCP_SESSION).toBeUndefined();
      expect(() => readFileSync(defaultMcpSessionPath(root))).toThrow();
      expect(
        JSON.parse(readFileSync(defaultMcporterConfigPath(root), "utf8"))
      ).toEqual({ imports: [], mcpServers: {} });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits mcporter allowedTools only for a policy containing wildcards", () => {
    const base = {
      id: "server",
      name: "server",
      base_url: "https://mcp.example.test/mcp",
      agent_tools: [{ include: ["*"] }],
    };
    const wildcard = buildMcporterConfig({
      version: 1,
      servers: [{ ...base, package_tools: { include: ["*"] } }],
    });
    const explicit = buildMcporterConfig({
      version: 1,
      servers: [
        {
          ...base,
          package_tools: { include: ["search", "read"] },
          agent_tools: [{ include: ["read"] }],
        },
      ],
    });
    expect(wildcard.mcpServers.server?.allowedTools).toBeUndefined();
    expect(explicit.mcpServers.server?.allowedTools).toEqual(["read"]);
  });

  it("materializes a session-pinned CLI shim", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipes-mcp-shim-"));
    try {
      const result = await materializeSessionMcpCli({ cwd: root, env: {} });
      const script = readFileSync(result.shimPath, "utf8");
      expect(script).toContain("PI_RECIPES_MCP_SESSION_ROOT=");
      expect(script).toContain("MCPORTER_CONFIG:=");
      if (nativeMcpClientPath()) {
        expect(script).toContain(nativeMcpClientPath());
        expect(script).toContain("mcp-client.js' --start-daemon");
        expect(script).toContain("native_status");
        expect(script).not.toContain("PI_RECIPES_MCP_NATIVE_REQUIRED");
        expect(script).not.toContain('mcp-client.js\' "$@"');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves the native client from the installed package", () => {
    const packageEntrypoint = fileURLToPath(
      import.meta.resolve("@introspection-ai/recipes")
    );
    const executable = process.platform === "win32" ? "mcp-client.exe" : "mcp-client";

    expect(nativeMcpClientPath()).toBe(
      join(
        dirname(packageEntrypoint),
        "..",
        "vendor",
        "mcp-client",
        `${process.platform}-${process.arch}`,
        executable
      )
    );
  });
});

describe("lazy MCP CLI discovery", () => {
  it("uses the tool schema to preserve numeric-looking string arguments", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipes-mcp-string-args-"));
    const stub = await startStubMcpServer();
    const cwd = join(root, "workspace");
    const recipeDir = join(root, "recipe");
    mkdirSync(recipeDir, { recursive: true });
    const local = writeLocalConfig(cwd, [
      {
        id: "stub",
        transport: "streamable_http",
        url: stub.url,
        headers: { Authorization: "Bearer ${STUB_TOKEN}" },
      },
    ]);
    const env: NodeJS.ProcessEnv = {
      PI_RECIPES_MCP_LOCAL_CONFIG: local,
      STUB_TOKEN: "test-token",
    };
    try {
      const shim = await materializeSessionMcpCli({ cwd, env });
      await materializeMcpSession({
        cwd,
        env,
        manifest: recipeManifest(recipeDir, [
          {
            id: "stub",
            required: true,
            include: ["lookup_profile", "text_only", "requires_auth"],
          },
        ]),
        agentMcp: [
          {
            serverId: "stub",
            tools: {
              include: ["lookup_profile", "text_only", "requires_auth"],
            },
          },
        ],
      });
      await preloadMcpCatalogs({ env });
      const cliEnv = Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      );

      const plain = await runMcpShim(
        shim.shimPath,
        ["call", "stub.lookup_profile", "id=22688", "limit=5"],
        cliEnv
      );
      expect(plain).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(plain.stdout)).toMatchObject({
        arguments: { id: "22688", limit: 5 },
      });
      const listCallsAfterFirstCall = stub.stats.list;

      const quoted = await runMcpShim(
        shim.shimPath,
        ["call", "stub.lookup_profile", 'id="196921652"'],
        cliEnv
      );
      expect(quoted).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(quoted.stdout)).toMatchObject({
        arguments: { id: "196921652" },
      });

      const json = await runMcpShim(
        shim.shimPath,
        ["call", "stub.lookup_profile", "--json", '{"id":"22688","limit":5}'],
        cliEnv
      );
      expect(json).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(json.stdout)).toMatchObject({
        arguments: { id: "22688", limit: 5 },
      });
      expect(stub.stats.list).toBe(listCallsAfterFirstCall);

      const textAsJson = await runMcpShim(
        shim.shimPath,
        ["call", "stub.text_only", "--output", "json"],
        cliEnv
      );
      expect(textAsJson).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(textAsJson.stdout)).toEqual({
        content: [{ type: "text", text: "plain output" }],
      });

      const auth = await runMcpShim(
        shim.shimPath,
        ["call", "stub.requires_auth", "--timeout", "1000"],
        cliEnv
      );
      expect(auth).toMatchObject({ code: 1, stdout: "" });
      expect(auth.stderr).toContain(
        "Ask the user to authenticate this MCP connection outside the agent session"
      );
      expect(auth.stderr).not.toContain("mcporter auth");
    } finally {
      await clearMcpSession(env, cwd);
      stub.server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("reuses one daemon runtime across concurrent calls and later commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipes-mcp-daemon-"));
    const stub = await startStubMcpServer({ failListAttempts: 1 });
    const cwd = join(root, "workspace");
    const recipeDir = join(root, "recipe");
    mkdirSync(recipeDir, { recursive: true });
    const local = writeLocalConfig(cwd, [
      {
        id: "stub",
        transport: "streamable_http",
        url: stub.url,
        headers: { Authorization: "Bearer ${STUB_TOKEN}" },
      },
    ]);
    const env: NodeJS.ProcessEnv = {
      PI_RECIPES_MCP_LOCAL_CONFIG: local,
      PI_RECIPES_MCP_RUN_TIMEOUT_MS: "1000",
      PI_RECIPES_MCP_MAX_OUTPUT_BYTES: "1024",
      STUB_TOKEN: "test-token",
    };
    try {
      const shim = await materializeSessionMcpCli({ cwd, env });
      await materializeMcpSession({
        cwd,
        env,
        manifest: recipeManifest(recipeDir, [
          { id: "stub", required: true, include: ["search_profiles"] },
        ]),
        agentMcp: [
          { serverId: "stub", tools: { include: ["search_profiles"] } },
        ],
      });
      const cliEnv = Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      );
      const preload = preloadMcpCatalogs({ env });
      for (
        let attempt = 0;
        attempt < 100 && !existsSync(env.PI_RECIPES_MCP_DAEMON_SOCKET!);
        attempt += 1
      ) {
        await delay(20);
      }
      expect(existsSync(env.PI_RECIPES_MCP_DAEMON_SOCKET!)).toBe(true);
      for (let attempt = 0; attempt < 100 && stub.stats.list === 0; attempt += 1) {
        await delay(10);
      }
      expect(stub.stats.list).toBeGreaterThanOrEqual(1);
      const nativeClient = nativeMcpClientPath();
      if (nativeClient) {
        const interruptedDuringPreload = await interruptNativeMcp(
          nativeClient,
          ["run"],
          cliEnv,
          [
            "const result = await tools.stub.search_profiles({ query: 'must-not-run' });",
            "console.log(JSON.stringify(result));",
          ].join("\n"),
          50
        );
        expect(interruptedDuringPreload.code).toBe(130);
      }
      const racedList = await runMcpShim(
        shim.shimPath,
        ["list", "stub.search_profiles", "--schema"],
        cliEnv
      );
      await preload;
      expect(racedList).toMatchObject({ code: 0, stderr: "" });
      expect(racedList.stdout).toContain("stub.search_profiles");
      expect(stub.stats.initialize).toBe(2);
      expect(stub.stats.list).toBe(2);
      expect(stub.stats.call).toBe(0);

      const [left, right] = await Promise.all([
        runMcpShim(
          shim.shimPath,
          ["call", "stub.search_profiles", "--json", '{"query":"engineer"}'],
          cliEnv
        ),
        runMcpShim(
          shim.shimPath,
          ["call", "stub.search_profiles", "--json", '{"query":"architect"}'],
          cliEnv
        ),
      ]);
      expect(left).toMatchObject({ code: 0, stderr: "" });
      expect(right).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(left.stdout)).toMatchObject({ arguments: { query: "engineer" } });
      expect(JSON.parse(right.stdout)).toMatchObject({ arguments: { query: "architect" } });
      expect(stub.stats.initialize).toBe(2);
      expect(stub.stats.call).toBe(2);

      const later = await runMcpShim(
        shim.shimPath,
        ["call", "stub.search_profiles", "query=designer"],
        cliEnv
      );
      expect(later).toMatchObject({ code: 0, stderr: "" });
      expect(stub.stats.initialize).toBe(2);
      expect(stub.stats.call).toBe(3);

      if (nativeClient) {
        await stopMcpDaemon({ ...cliEnv });
        const warmed = await runMcpShim(
          shim.shimPath,
          ["--start-daemon"],
          cliEnv
        );
        expect(warmed).toMatchObject({ code: 0, stdout: "", stderr: "" });

        await stopMcpDaemon({ ...cliEnv });
        const recovered = await runMcpShim(
          shim.shimPath,
          ["run"],
          cliEnv,
          [
            "const result = await tools.stub.search_profiles({ query: 'recovered' });",
            "console.log(JSON.stringify(result));",
          ].join("\n")
        );
        expect(recovered).toMatchObject({ code: 0, stderr: "" });
        expect(JSON.parse(recovered.stdout)).toMatchObject({
          arguments: { query: "recovered" },
        });
        expect(stub.stats.call).toBe(4);
      }

      const oversized = await runMcpShim(
        shim.shimPath,
        ["call", "stub.search_profiles", `query=${"x".repeat(2_000)}`],
        cliEnv
      );
      expect(oversized.code).toBe(1);
      expect(oversized.stdout).toBe("");
      expect(oversized.stderr).toContain("exceeding PI_RECIPES_MCP_MAX_OUTPUT_BYTES=1024");
      expect(stub.stats.call).toBe(nativeClient ? 5 : 4);

      const search = await runMcpShim(
        shim.shimPath,
        ["search", "candidate"],
        cliEnv
      );
      expect(search).toMatchObject({ code: 0, stderr: "" });
      expect(search.stdout).toContain("stub.search_profiles");
      const list = await runMcpShim(
        shim.shimPath,
        ["list", "stub"],
        cliEnv
      );
      expect(list).toMatchObject({ code: 0, stderr: "" });
      expect(list.stdout).toContain("stub.search_profiles(query: string)");
      expect(stub.stats.initialize).toBe(nativeClient ? 3 : 2);
      expect(stub.stats.list).toBe(2);

      const run = await runMcpShim(
        shim.shimPath,
        ["run"],
        cliEnv,
        [
          "const result = await tools.stub.search_profiles({ query: 'principal' });",
          "console.log(JSON.stringify(result));",
        ].join("\n")
      );
      expect(run).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(run.stdout)).toMatchObject({ arguments: { query: "principal" } });
      expect(stub.stats.initialize).toBe(nativeClient ? 3 : 2);
      expect(stub.stats.call).toBe(nativeClient ? 6 : 5);

      if (nativeClient) {
        const interrupted = await interruptNativeMcp(
          nativeClient,
          ["run"],
          cliEnv,
          "while (true) {}"
        );
        expect(interrupted.code).toBe(130);
      }

      const busy = await runMcpShim(
        shim.shimPath,
        ["run"],
        cliEnv,
        "while (true) {}"
      );
      expect(busy.code).not.toBe(0);

      const afterBusyLoop = await runMcpShim(
        shim.shimPath,
        ["call", "stub.search_profiles", "query=survivor"],
        cliEnv
      );
      expect(afterBusyLoop).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(afterBusyLoop.stdout)).toMatchObject({
        arguments: { query: "survivor" },
      });
      expect(stub.stats.initialize).toBe(nativeClient ? 3 : 2);
      expect(stub.stats.call).toBe(nativeClient ? 7 : 6);
    } finally {
      await clearMcpSession(env, cwd);
      stub.server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("discovers once on first use, caches per server, and enforces policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipes-mcp-lazy-"));
    const stub = await startStubMcpServer();
    try {
      const cwd = join(root, "workspace");
      const recipeDir = join(root, "recipe");
      mkdirSync(recipeDir, { recursive: true });
      const local = writeLocalConfig(cwd, [
        {
          id: "stub",
          transport: "streamable_http",
          url: stub.url,
          headers: { Authorization: "Bearer ${STUB_TOKEN}" },
        },
      ]);
      const env: NodeJS.ProcessEnv = {
        PI_RECIPES_MCP_LOCAL_CONFIG: local,
        STUB_TOKEN: "test-token",
      };
      await materializeMcpSession({
        cwd,
        env,
        manifest: recipeManifest(recipeDir, [
          { id: "stub", required: true, include: ["search_profiles"] },
        ]),
        agentMcp: [
          { serverId: "stub", tools: { include: ["search_profiles"] } },
        ],
      });
      expect(stub.stats).toEqual({ initialize: 0, list: 0, call: 0 });
      const cliEnv = {
        PI_RECIPES_MCP_SESSION_ROOT: cwd,
        PI_RECIPES_MCP_SESSION: env.PI_RECIPES_MCP_SESSION!,
        MCPORTER_CONFIG: env.MCPORTER_CONFIG!,
        STUB_TOKEN: "test-token",
      };

      const blocked = await runMcpCli(["call", "stub.hidden_tool"], cliEnv);
      expect(blocked.code).toBe(2);
      expect(blocked.stderr).toContain("not available on server 'stub'");
      expect(stub.stats).toEqual({ initialize: 0, list: 0, call: 0 });

      const call = await runMcpCli(
        ["call", "stub.search_profiles", "query=engineer"],
        cliEnv
      );
      expect(call.code).toBe(0);
      expect(JSON.parse(call.stdout)).toEqual({
        tool: "search_profiles",
        arguments: { query: "engineer" },
      });
      expect(stub.stats.list).toBe(0);
      expect(stub.stats.call).toBe(1);

      const run = await runMcpCli(
        ["run"],
        cliEnv,
        [
          "const result = await tools.stub.search_profiles({ query: 'architect' });",
          "console.log(JSON.stringify(result));",
        ].join("\n")
      );
      expect(run).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(run.stdout)).toEqual({
        tool: "search_profiles",
        arguments: { query: "architect" },
      });
      expect(stub.stats.list).toBe(0);
      expect(stub.stats.call).toBe(2);

      const persistedSession = JSON.parse(
        readFileSync(defaultMcpSessionPath(cwd), "utf8")
      ) as McpSessionConfig;
      const lock = catalogLockPath(cwd, persistedSession.servers[0]!);
      mkdirSync(join(cwd, ".pi", "mcp-catalogs"), { recursive: true });
      writeFileSync(
        lock,
        `${JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() })}\n`
      );

      const first = await runMcpCli(["search", "candidate"], cliEnv);
      expect(first).toMatchObject({ code: 0, stderr: "" });
      expect(first.stdout).toContain("stub.search_profiles");
      expect(stub.stats.list).toBe(1);
      expect(() => readFileSync(lock)).toThrow();

      const second = await runMcpCli(["list", "stub"], cliEnv);
      expect(second).toMatchObject({ code: 0, stderr: "" });
      expect(second.stdout).toContain("stub.search_profiles(query: string)");
      expect(stub.stats.list).toBe(1);

      const cacheDir = join(cwd, ".pi", "mcp-catalogs");
      const cacheFiles = readdirSync(cacheDir).filter((name) =>
        name.endsWith(".json")
      );
      expect(cacheFiles).toHaveLength(1);
      expect(readFileSync(join(cacheDir, cacheFiles[0]!), "utf8")).not.toContain(
        "test-token"
      );
    } finally {
      stub.server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("deduplicates concurrent discovery across CLI processes", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipes-mcp-lock-"));
    const stub = await startStubMcpServer();
    try {
      const cwd = join(root, "workspace");
      const recipeDir = join(root, "recipe");
      mkdirSync(recipeDir, { recursive: true });
      const local = writeLocalConfig(cwd, [
        {
          id: "stub",
          transport: "streamable_http",
          url: stub.url,
          headers: { Authorization: "Bearer ${STUB_TOKEN}" },
        },
      ]);
      const env: NodeJS.ProcessEnv = {
        PI_RECIPES_MCP_LOCAL_CONFIG: local,
        STUB_TOKEN: "test-token",
      };
      await materializeMcpSession({
        cwd,
        env,
        manifest: recipeManifest(recipeDir, [
          { id: "stub", required: true, include: ["search_profiles"] },
        ]),
        agentMcp: [
          { serverId: "stub", tools: { include: ["search_profiles"] } },
        ],
      });
      const cliEnv = {
        PI_RECIPES_MCP_SESSION_ROOT: cwd,
        PI_RECIPES_MCP_SESSION: env.PI_RECIPES_MCP_SESSION!,
        MCPORTER_CONFIG: env.MCPORTER_CONFIG!,
        STUB_TOKEN: "test-token",
      };
      const persistedSession = JSON.parse(
        readFileSync(defaultMcpSessionPath(cwd), "utf8")
      ) as McpSessionConfig;
      const lock = catalogLockPath(cwd, persistedSession.servers[0]!);
      mkdirSync(join(cwd, ".pi", "mcp-catalogs"), { recursive: true });
      writeFileSync(
        lock,
        `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`
      );
      const waitStartedAt = Date.now();
      const timedOut = await runMcpCli(
        ["list", "stub", "--timeout", "100"],
        cliEnv
      );
      expect(timedOut.code).toBe(1);
      expect(Date.now() - waitStartedAt).toBeLessThan(1_000);
      expect(stub.stats.list).toBe(0);
      rmSync(lock, { force: true });

      const [left, right] = await Promise.all([
        runMcpCli(["search", "candidate"], cliEnv),
        runMcpCli(["list", "stub"], cliEnv),
      ]);
      expect(left.code).toBe(0);
      expect(right.code).toBe(0);
      expect(stub.stats.list).toBe(1);
    } finally {
      stub.server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("calls a healthy tool from a partial catalog without rediscovering failed optional servers", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipes-mcp-partial-call-"));
    const stub = await startStubMcpServer();
    const env: NodeJS.ProcessEnv = {};
    try {
      const cwd = join(root, "workspace");
      const recipeDir = join(root, "recipe");
      mkdirSync(recipeDir, { recursive: true });
      const local = writeLocalConfig(cwd, [
        {
          id: "stub",
          transport: "streamable_http",
          url: stub.url,
          headers: { Authorization: "Bearer ${STUB_TOKEN}" },
        },
        {
          id: "offline",
          transport: "streamable_http",
          url: "http://127.0.0.1:9/mcp",
        },
      ]);
      Object.assign(env, {
        PI_RECIPES_MCP_LOCAL_CONFIG: local,
        STUB_TOKEN: "test-token",
      });
      await materializeMcpSession({
        cwd,
        env,
        manifest: recipeManifest(recipeDir, [
          { id: "stub", required: true, include: ["search_profiles"] },
          { id: "offline", include: ["*"] },
        ]),
        agentMcp: [
          { serverId: "stub", tools: { include: ["search_profiles"] } },
          { serverId: "offline", tools: { include: ["*"] } },
        ],
      });

      const startedAt = Date.now();
      const catalogs = await preloadMcpCatalogs({
        env,
        allowPartial: true,
        timeoutMs: 250,
      });
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      expect(catalogs.find((server) => server.id === "stub")?.error).toBeFalsy();
      expect(catalogs.find((server) => server.id === "offline")?.error).toBeTruthy();
      const listAttempts = stub.stats.list;

      const result = await callMcpDaemonTool(
        "stub",
        "search_profiles",
        { query: "Ada" },
        { env, timeoutMs: 1_000 }
      );

      expect(result).toEqual(
        expect.objectContaining({
          structuredContent: {
            tool: "search_profiles",
            arguments: { query: "Ada" },
          },
        })
      );
      expect(stub.stats.list).toBe(listAttempts);
    } finally {
      await stopMcpDaemon(env).catch(() => {});
      stub.server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("MCP CLI helpers", () => {
  it("searches only the supplied catalog", () => {
    const session: McpSessionConfig = {
      version: 1,
      servers: [
        {
          id: "nextplay",
          name: "Nextplay",
          base_url: "https://mcp.example.test/mcp",
          package_tools: { include: ["*"] },
          agent_tools: [{ include: ["*"] }],
          catalog: [
            {
              name: "search_profiles",
              description: "Search candidate profiles",
              input_schema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          ],
        },
      ],
    };
    expect(searchMcpTools(session, "candidate")[0]?.ref).toBe(
      "nextplay.search_profiles"
    );
    expect(searchMcpTools(session, "query", { regex: true })[0]?.ref).toBe(
      "nextplay.search_profiles"
    );
  });

  it("applies package and agent policy and scrubs hidden tool references", () => {
    const policy = {
      package_tools: {
        include: ["*"],
        exclude: ["delete_profile"],
      },
      agent_tools: [{ include: ["get_profile", "delete_profile"] }],
    };
    expect(mcpSessionAllowsTool(policy, "get_profile")).toBe(true);
    expect(mcpSessionAllowsTool(policy, "delete_profile")).toBe(false);
    expect(
      filterMcpCatalog(policy, [
        {
          name: "get_profile",
          description: "Read a profile, then use delete_profile if needed.",
        },
        { name: "delete_profile", description: "Delete a profile." },
      ])
    ).toEqual([
      {
        name: "get_profile",
        description:
          "Read a profile, then use [unavailable MCP tool] if needed.",
      },
    ]);
  });

  it("keeps concise recovery diagnostics", () => {
    expect(describeUnknownRunServer("nxtplay", ["nextplay"])).toContain(
      "Did you mean 'tools.nextplay'?"
    );
    expect(
      describeUnavailableRunTool("nextplay", "search_profils", [
        "search_profiles",
      ])
    ).toContain("Did you mean 'search_profiles'?");
    expect(callJsonArgumentError(["nextplay.search_profiles", "--json"])).toContain(
      "expects a JSON object"
    );
  });
});
