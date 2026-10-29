import { readFileSync } from "node:fs";

import {
  McpClient,
  McpConnectionClosedError,
  McpHttpError,
  McpSessionExpiredError,
  StreamableHttpTransport,
  type Tool,
} from "@earendil-works/pi-mcp";

import { createRuntime } from "mcporter";

import type { McpRuntime } from "./cli/command-context.js";
import type { McporterConfig, McporterServerConfig } from "./index.js";

/** Selects the client the `mcp` command and its daemon connect with. */
export const MCP_CLIENT_ENV = "PI_RECIPES_MCP_CLIENT";

export function usesPiMcpClient(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MCP_CLIENT_ENV]?.trim() === "pi-mcp";
}

export interface PiMcpCallOptions {
  args?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

// Statuses after which a request that only reads can be sent again.
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const READ_RETRY_DELAYS_MS = [250, 1_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function interpolateEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => env[name] ?? "");
}

/**
 * The status a failed request carries, in the form mcporter's error classifier
 * reads, so the `mcp` command describes a failure as it did on mcporter.
 */
function describedError(error: unknown, server: string): unknown {
  if (error instanceof McpHttpError) {
    return Object.assign(new Error(`HTTP ${error.status}: ${error.message}`, { cause: error }), {
      code: error.status,
    });
  }
  if (error instanceof Error && !(error instanceof McpConnectionClosedError)) return error;
  return new Error(
    `MCP server '${server}' closed the connection: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error }
  );
}

/** A request the server did not run, so sending it again cannot repeat a side effect. */
function notRun(error: unknown): boolean {
  return error instanceof McpSessionExpiredError;
}

// `fetch` reports a network failure, including a connection dropped mid-body,
// as a `TypeError`.
function transient(error: unknown): boolean {
  return (
    (error instanceof McpHttpError && TRANSIENT_STATUSES.has(error.status)) ||
    error instanceof McpConnectionClosedError ||
    error instanceof TypeError
  );
}

class ServerConnection {
  private client: Promise<McpClient> | undefined;
  private connected: McpClient | undefined;

  constructor(
    readonly id: string,
    private readonly config: McporterServerConfig,
    private readonly env: NodeJS.ProcessEnv
  ) {}

  private connect(): Promise<McpClient> {
    this.client ??= (async () => {
      const client = new McpClient({ name: "introspection-recipes", version: "1" });
      client.onClose(() => this.drop(client));
      await client.connect(
        new StreamableHttpTransport({
          url: this.config.baseUrl,
          headers: Object.fromEntries(
            Object.entries(this.config.headers ?? {}).map(([name, value]) => [
              name,
              interpolateEnv(value, this.env),
            ])
          ),
        })
      );
      this.connected = client;
      return client;
    })().catch((error) => {
      this.client = undefined;
      throw error;
    });
    return this.client;
  }

  /** Forgets `client`, so the next request connects afresh. A failed connect clears itself. */
  private drop(client: McpClient): void {
    if (this.connected !== client) return;
    this.connected = undefined;
    this.client = undefined;
  }

  /**
   * Runs `request` on a live connection, connecting first if needed. What was
   * never sent is retried: a failed connect, and a request whose MCP session
   * had expired. A read is also retried after a transient failure. A
   * `tools/call` that may have run is never sent twice.
   */
  async request<T>(read: boolean, request: (client: McpClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      let client: McpClient;
      try {
        client = await this.connect();
      } catch (error) {
        // Only a server that answered with a transient status is tried again:
        // one that refuses connections fails at once, so an offline optional
        // server never holds up the others.
        const answeredTransient =
          error instanceof McpHttpError && TRANSIENT_STATUSES.has(error.status);
        if (!answeredTransient || attempt >= READ_RETRY_DELAYS_MS.length) {
          throw describedError(error, this.id);
        }
        await sleep(READ_RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      try {
        return await request(client);
      } catch (error) {
        // An HTTP error status leaves the session usable; a lost connection
        // or an expired session does not.
        if (notRun(error) || error instanceof McpConnectionClosedError || error instanceof TypeError) {
          this.drop(client);
          void client.close().catch(() => {});
        }
        if (notRun(error) && attempt === 0) continue;
        if (read && transient(error) && attempt < READ_RETRY_DELAYS_MS.length) {
          await sleep(READ_RETRY_DELAYS_MS[attempt]!);
          continue;
        }
        throw describedError(error, this.id);
      }
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connected = undefined;
    await client?.then((value) => value.close()).catch(() => {});
  }
}

/**
 * The part of mcporter's runtime the `mcp` command and its daemon use, on
 * `pi-mcp` clients: one connection per server, opened on first use and kept
 * for the life of the process. It reads the same generated config.
 */
export class PiMcpRuntime {
  private readonly servers = new Map<string, ServerConnection>();

  constructor(
    private readonly config: McporterConfig,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    for (const [id, server] of Object.entries(config.mcpServers)) {
      if (server.auth === "oauth") {
        throw new Error(
          `MCP server '${id}' is bound with an OAuth flow, which the pi-mcp client does not run; unset ${MCP_CLIENT_ENV} to use mcporter for it`
        );
      }
      this.servers.set(id, new ServerConnection(id, server, env));
    }
  }

  static fromConfigFile(
    path: string | undefined = process.env.MCPORTER_CONFIG,
    env: NodeJS.ProcessEnv = process.env
  ): PiMcpRuntime {
    if (!path) throw new Error("MCPORTER_CONFIG is not set; the MCP session has no server config");
    return new PiMcpRuntime(JSON.parse(readFileSync(path, "utf8")) as McporterConfig, env);
  }

  listServers(): string[] {
    return [...this.servers.keys()];
  }

  private server(id: string): ServerConnection {
    const server = this.servers.get(id);
    if (!server) throw new Error(`Unknown MCP server '${id}'`);
    return server;
  }

  async listTools(server: string, _options?: Record<string, unknown>): Promise<Tool[]> {
    const tools = await this.server(server).request(true, (client) => client.listTools());
    const allowed = this.config.mcpServers[server]?.allowedTools;
    return allowed ? tools.filter((tool) => allowed.includes(tool.name)) : tools;
  }

  async callTool(server: string, tool: string, options: PiMcpCallOptions = {}): Promise<unknown> {
    const allowed = this.config.mcpServers[server]?.allowedTools;
    if (allowed && !allowed.includes(tool)) {
      throw new Error(`MCP tool '${server}.${tool}' is not in this session's allowed tools.`);
    }
    return await this.server(server).request(false, (client) =>
      client.callTool(tool, options.args ?? {}, {
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    );
  }

  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map((server) => server.close()));
  }
}

/** The session's MCP runtime: mcporter's, or pi-mcp's when {@link MCP_CLIENT_ENV} selects it. */
export async function createMcpRuntime(
  configPath: string | undefined = process.env.MCPORTER_CONFIG
): Promise<McpRuntime> {
  return usesPiMcpClient()
    ? PiMcpRuntime.fromConfigFile(configPath)
    : await createRuntime(configPath ? { configPath } : {});
}
