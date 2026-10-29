import { createHash } from "node:crypto";

import {
  createMcpExtension,
  type ExtensionAPI,
  type ExtensionFactory,
  type McpExposure,
  type McpExtensionOptions,
  type McpServerConfig,
  VERSION,
} from "@earendil-works/pi-coding-agent";

import type { RecipeAgentMcp } from "../recipe/agent.js";
import {
  explicitAllowedTools,
  interpolateEnv,
  mcpSessionAllowsTool,
  type McpEndpointBinding,
  type McpSessionConfig,
  type McpSessionServer,
} from "./index.js";

export const MCP_CONNECT_TIMEOUT_ENV = "PI_RECIPES_MCP_CONNECT_TIMEOUT_MS";
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const CONNECT_POLL_MS = 50;
// Pi's limit for a tool name, which its MCP tool names are shortened to.
const MAX_TOOL_NAME_LENGTH = 64;

/** Pi's MCP resource tools, which no Recipe declares. */
export const PI_MCP_RESOURCE_TOOL_NAMES = [
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
] as const;

/**
 * The Pi tool name of an MCP tool under `mcp.mode: codemode`, the name a
 * codemode script calls (`tools.<name>`) and `ctx.executeTool()` takes. It is
 * Pi's own rule: `mcp__<server>__<tool>`, every character outside
 * `[A-Za-z0-9_]` replaced by `_`, and a hash suffix past 64 characters.
 */
export function mcpToolName(serverId: string, toolName: string): string {
  const name = `mcp__${serverId}__${toolName}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
  const hash = createHash("sha256")
    .update(`${serverId}\0${toolName}`)
    .digest("hex")
    .slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/** Pi added `reachesTools`, which codemode's readiness rests on, in 1.3.0. */
export const PI_MCP_CODEMODE_MIN_VERSION = "1.3.0";

function versionParts(version: string): number[] {
  return version.split(/[.+-]/).slice(0, 3).map((part) => Number(part) || 0);
}

/** Refuses `mcp.mode: codemode` on a Pi older than {@link PI_MCP_CODEMODE_MIN_VERSION}. */
export function assertPiSupportsMcpCodemode(version: string = VERSION): void {
  const have = versionParts(version);
  const need = versionParts(PI_MCP_CODEMODE_MIN_VERSION);
  const index = have.findIndex((part, i) => part !== need[i]);
  if (index !== -1 && have[index]! < need[index]!) {
    throw new Error(
      `mcp.mode codemode needs Pi ${PI_MCP_CODEMODE_MIN_VERSION} or newer, where a tool can wait for the MCP servers it reaches; this host runs Pi ${version}`
    );
  }
}

export interface PiMcpServerRegistration {
  id: string;
  required: boolean;
  /** The package marks the server's discovery deferrable (a bake may start without it). */
  deferrableDiscovery: boolean;
  config: McpServerConfig;
}

function selectorsInclude(selectors: readonly string[] | undefined, name: string): boolean {
  return selectors?.some((selector) => selector === "*" || selector === name) ?? false;
}

function exposureConfig(
  server: McpSessionServer,
  mcp: RecipeAgentMcp
): Pick<McpServerConfig, "exposure" | "toolExposure"> {
  const eager = mcp.servers[server.id]?.eager;
  const exposureOf = (name: string): McpExposure =>
    selectorsInclude(eager, name) ? "direct" : "codemode";
  const explicit = explicitAllowedTools(server);
  if (explicit) {
    return {
      exposure: "codemode",
      toolExposure: {
        ...Object.fromEntries(explicit.map((name) => [name, exposureOf(name)])),
        "*": "hidden",
      },
    };
  }
  // Every tool is allowed but the excluded ones, which stay unreachable.
  const excluded = [
    ...(server.package_tools.exclude ?? []),
    ...server.agent_tools.flatMap((selection) => selection.exclude ?? []),
  ].filter((name) => !mcpSessionAllowsTool(server, name));
  return {
    exposure: eager?.includes("*") ? "direct" : "codemode",
    toolExposure: {
      ...Object.fromEntries(
        (eager ?? []).filter((name) => name !== "*").map((name) => [name, "direct"])
      ),
      ...Object.fromEntries(excluded.map((name) => [name, "hidden"])),
    },
  };
}

function resolvedHeaders(
  binding: McpEndpointBinding | undefined,
  env: NodeJS.ProcessEnv
): Record<string, string> | undefined {
  const entries = Object.entries(binding?.rawHeaders ?? {});
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([name, raw]) => {
      const value = interpolateEnv(raw, env);
      // Pi runs a header value that starts with `!` as a shell command.
      if (value.startsWith("!")) {
        throw new Error(
          `MCP server '${binding!.id}' header '${name}' starts with '!', which Pi would run as a command`
        );
      }
      return [name, value];
    })
  );
}

function callTimeoutSeconds(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.PI_RECIPES_MCP_CALL_TIMEOUT_MS);
  const ms = Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_CALL_TIMEOUT_MS;
  return Math.ceil(ms / 1000);
}

/**
 * Pi server configs for the servers this agent may use: the session's bound
 * servers, their URLs and headers from the bindings, and the agent's policy as
 * Pi exposures. Allowed tools are reachable from codemode scripts, `eager`
 * ones are also declared to the model, and every other tool is hidden.
 */
export function piMcpServerRegistrations(options: {
  session: McpSessionConfig;
  bindings: readonly McpEndpointBinding[];
  mcp: RecipeAgentMcp;
  env: NodeJS.ProcessEnv;
}): PiMcpServerRegistration[] {
  assertPiSupportsMcpCodemode();
  const timeout = callTimeoutSeconds(options.env);
  return options.session.servers
    .filter((server) => Object.hasOwn(options.mcp.servers, server.id))
    .map((server) => {
      const binding = options.bindings.find((entry) => entry.id === server.id);
      if (binding?.localOAuth) {
        throw new Error(
          `MCP server '${server.id}' is bound with an OAuth flow, which mcp.mode codemode does not support; bind it with a header, or use mode cli or tools`
        );
      }
      const headers = resolvedHeaders(binding, options.env);
      return {
        id: server.id,
        required: server.required === true,
        deferrableDiscovery: server.discovery === "defer",
        config: {
          url: server.base_url,
          ...(headers ? { headers } : {}),
          timeout,
          ...exposureConfig(server, options.mcp),
        },
      };
    });
}

/**
 * OAuth state Pi's MCP extension would otherwise keep in `~/.pi/agent`. A
 * Recipe session never signs in (credentials ride headers or the MCP edge), so
 * nothing is stored and nothing is written.
 */
const noStoredCredentials = {
  forServer: () => ({
    load: () => undefined,
    save: () => {},
    withRefreshLock: <T>(fn: () => Promise<T>) => fn(),
  }),
  tokens: () => undefined,
  remove: () => false,
} as unknown as NonNullable<McpExtensionOptions["credentials"]>;

/**
 * Pi's MCP extension for a Recipe session: no `mcp.json` is read, no OAuth
 * state is kept, and server logs go to `logPath`.
 */
export function createRecipeMcpClientExtension(logPath: string): ExtensionFactory {
  return createMcpExtension({
    loadConfig: () => ({ servers: [], errors: [] }),
    credentials: noStoredCredentials,
    logPath,
  });
}

/** Registers the servers with Pi's MCP support, keeping the API for `waitForPiMcpServers`. */
export function createPiMcpServersExtension(
  registrations: readonly PiMcpServerRegistration[],
  onRegistered: (pi: ExtensionAPI) => void = () => {}
): ExtensionFactory {
  return (pi) => {
    for (const registration of registrations) {
      pi.registerMcpServer(registration.id, registration.config);
    }
    onRegistered(pi);
  };
}

function connectTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env[MCP_CONNECT_TIMEOUT_ENV]);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_CONNECT_TIMEOUT_MS;
}

/**
 * Waits until each server has registered a tool, which Pi does once it has
 * connected and listed them, and throws naming those that did not in time.
 * Pi connects every server in the background when the session starts.
 */
export async function waitForPiMcpServers(
  pi: Pick<ExtensionAPI, "getAllTools">,
  serverIds: readonly string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<void> {
  const prefixes = serverIds.map((id) => [id, mcpToolName(id, "")] as const);
  const deadline = Date.now() + connectTimeoutMs(env);
  for (;;) {
    const names = pi.getAllTools().map((tool) => tool.name);
    const waiting = prefixes.filter(
      ([, prefix]) => !names.some((name) => name.startsWith(prefix))
    );
    if (waiting.length === 0) return;
    if (signal?.aborted) throw new Error("MCP server connection was aborted");
    if (Date.now() >= deadline) {
      throw new Error(
        `Required MCP server(s) did not connect within ${connectTimeoutMs(env)} ms: ${waiting
          .map(([id]) => id)
          .join(", ")}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, CONNECT_POLL_MS));
  }
}

/** The server and tool an MCP tool name stands for, for telemetry. */
export function piMcpToolOrigin(
  session: McpSessionConfig,
  piName: string
): { serverId: string; toolName: string; binding?: McpSessionServer["binding"] } | undefined {
  for (const server of session.servers) {
    const prefix = mcpToolName(server.id, "");
    if (!piName.startsWith(prefix)) continue;
    return {
      serverId: server.id,
      toolName: piName.slice(prefix.length),
      ...(server.binding ? { binding: server.binding } : {}),
    };
  }
  return undefined;
}
