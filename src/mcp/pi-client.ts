import { createHash } from "node:crypto";

import {
  createMcpExtension,
  type ExtensionAPI,
  type ExtensionFactory,
  type McpExposure,
  type McpExtensionOptions,
  type McpServerConfig,
  type ToolDefinition,
  type ToolNamespace,
  VERSION,
} from "@earendil-works/pi-coding-agent";

import type { RecipeAgentMcp } from "../recipe/agent.js";
import { mcpSelectionAllowsTool } from "./policy.js";
import {
  explicitAllowedTools,
  interpolateEnv,
  mcpSessionAllowsTool,
  type McpEndpointBinding,
  type McpSessionConfig,
  type McpSessionServer,
} from "./index.js";

const MCP_CONNECT_TIMEOUT_ENV = "PI_RECIPES_MCP_CONNECT_TIMEOUT_MS";
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const CONNECT_POLL_MS = 50;
// Pi's limit for a tool name, which its MCP tool names are shortened to by
// keeping the start and adding `_` and this many hex digits of a hash.
const MAX_TOOL_NAME_LENGTH = 64;
const HASH_LENGTH = 8;

/** Pi's MCP resource tools, which no Recipe declares. */
export const PI_MCP_RESOURCE_TOOL_NAMES = [
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
] as const;

/**
 * The Pi tool name of an MCP tool under `mcp.mode: codemode`, the name a
 * codemode script calls (`tools.<name>`) and `ctx.executeTool()` takes. It is
 * Pi's own rule (`createMcpToolName`, which Pi does not export):
 * `mcp__<server>__<tool>`, every character outside `[A-Za-z0-9_]` replaced by
 * `_`, and a hash suffix past 64 characters. Pi also adds the suffix when two
 * of a server's tools sanitize to one name, which this cannot know; match a
 * registered tool to its server with {@link isPiMcpServerTool}, never by name.
 */
export function mcpToolName(serverId: string, toolName: string): string {
  const name = `mcp__${serverId}__${toolName}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
  const hash = createHash("sha256")
    .update(`${serverId}\0${toolName}`)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/**
 * A prefix of every Pi tool name of the server's tools, hashed or not: a
 * hashed name keeps the first 55 characters of the sanitized full name, and
 * the sanitized `mcp__<server>__` cut at 55 is a prefix of those. It can also
 * prefix another server's tools (`a` and `a__b`, or two ids that agree on
 * their first 48 characters), so it only narrows a name allowlist; it never
 * says which server a tool is from.
 */
export function piMcpToolNamePrefix(serverId: string): string {
  return `mcp__${serverId}__`
    .replace(/[^A-Za-z0-9_]/g, "_")
    .slice(0, MAX_TOOL_NAME_LENGTH - HASH_LENGTH - 1);
}

/** Pi's namespace of a server's tools (`mcpNamespace`, which Pi does not export). */
function piMcpNamespace(serverId: string): string {
  return `mcp__${serverId.replace(/-/g, "_")}`;
}

/**
 * Whether Pi registered the tool for this MCP server. Pi gives every MCP tool
 * the server's namespace, aliased by the server's name, and refuses a second
 * server whose namespace would clash, so this is exact where a name prefix is
 * not.
 */
export function isPiMcpServerTool(
  tool: { namespace?: ToolNamespace },
  serverId: string,
): boolean {
  // `aliases` is typed from Pi 1.3.0; the peer floor is older.
  const namespace = tool.namespace as
    (ToolNamespace & { aliases?: readonly string[] }) | undefined;
  return (
    namespace?.name === piMcpNamespace(serverId) &&
    (namespace.aliases?.includes(serverId) ?? false)
  );
}

/** Pi added `reachesTools`, which codemode's readiness rests on, in 1.3.0. */
const PI_MCP_CODEMODE_MIN_VERSION = "1.3.0";

function versionParts(version: string): number[] {
  return version
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number(part) || 0);
}

/** Refuses `mcp.mode: codemode` on a Pi older than {@link PI_MCP_CODEMODE_MIN_VERSION}. */
export function assertPiSupportsMcpCodemode(version: string = VERSION): void {
  const have = versionParts(version);
  const need = versionParts(PI_MCP_CODEMODE_MIN_VERSION);
  const index = have.findIndex((part, i) => part !== need[i]);
  if (index !== -1 && have[index]! < need[index]!) {
    throw new Error(
      `mcp.mode codemode needs Pi ${PI_MCP_CODEMODE_MIN_VERSION} or newer, where a tool can wait for the MCP servers it reaches; this host runs Pi ${version}`,
    );
  }
}

export interface PiMcpServerRegistration {
  id: string;
  required: boolean;
  /** The package marks the server's discovery deferrable (a bake may start without it). */
  deferrableDiscovery: boolean;
  /** The tools whose calls alone may reach the server (`behind`). */
  behind?: readonly string[];
  config: McpServerConfig;
}

function selectorsInclude(
  selectors: readonly string[] | undefined,
  name: string,
): boolean {
  return (
    selectors?.some((selector) => selector === "*" || selector === name) ??
    false
  );
}

/**
 * The tools of a session server the current agent may call. A host-provisioned
 * session may have been written for a broader agent, so the agent's own
 * selection narrows it, as `mode: tools` does.
 */
function agentAllowedTools(
  server: McpSessionServer,
  mcp: RecipeAgentMcp,
): {
  allows: (name: string) => boolean;
  explicit: string[] | undefined;
  excludes: string[];
} {
  const selection = mcp.servers[server.id] ?? {};
  const allows = (name: string) =>
    mcpSessionAllowsTool(server, name) &&
    mcpSelectionAllowsTool(selection, name);
  const agentIncludes = selection.include ?? [];
  const candidates =
    explicitAllowedTools(server) ??
    (agentIncludes.includes("*") ? undefined : agentIncludes);
  return {
    allows,
    explicit: candidates && [...new Set(candidates)].filter(allows),
    excludes: [
      ...(server.package_tools.exclude ?? []),
      ...server.agent_tools.flatMap((entry) => entry.exclude ?? []),
      ...(selection.exclude ?? []),
    ],
  };
}

function exposureConfig(
  server: McpSessionServer,
  mcp: RecipeAgentMcp,
): Pick<McpServerConfig, "exposure" | "toolExposure"> {
  const policy = mcp.servers[server.id];
  // A server behind a tool is off the model's declarations and codemode's
  // listings; only `ctx.executeTool` reaches a `deferred` tool.
  const allowed: McpExposure = policy?.behind ? "deferred" : "codemode";
  const eager = policy?.behind ? undefined : policy?.eager;
  const exposureOf = (name: string): McpExposure =>
    selectorsInclude(eager, name) ? "direct" : allowed;
  const { allows, explicit, excludes } = agentAllowedTools(server, mcp);
  if (explicit) {
    return {
      exposure: allowed,
      toolExposure: {
        ...Object.fromEntries(explicit.map((name) => [name, exposureOf(name)])),
        "*": "hidden",
      },
    };
  }
  // Every tool is allowed but the excluded ones, which stay unreachable.
  const excluded = excludes.filter((name) => !allows(name));
  return {
    exposure: eager?.includes("*") ? "direct" : allowed,
    toolExposure: {
      ...Object.fromEntries(
        (eager ?? [])
          .filter((name) => name !== "*")
          .map((name) => [name, "direct"]),
      ),
      ...Object.fromEntries(excluded.map((name) => [name, "hidden"])),
    },
  };
}

function resolvedHeaders(
  binding: McpEndpointBinding | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  const entries = Object.entries(binding?.rawHeaders ?? {});
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([name, raw]) => {
      const value = interpolateEnv(raw, env);
      // Pi runs a header value that starts with `!` as a shell command.
      if (value.startsWith("!")) {
        throw new Error(
          `MCP server '${binding!.id}' header '${name}' starts with '!', which Pi would run as a command`,
        );
      }
      return [name, value];
    }),
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
          `MCP server '${server.id}' is bound with an OAuth flow, which Pi's MCP client (mcp.mode codemode, or a server behind a tool) does not support; bind it with a header`,
        );
      }
      const headers = resolvedHeaders(binding, options.env);
      const behind = options.mcp.servers[server.id]?.behind;
      return {
        id: server.id,
        required: server.required === true,
        deferrableDiscovery: server.discovery === "defer",
        ...(behind ? { behind } : {}),
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
export function createRecipeMcpClientExtension(
  logPath: string,
): ExtensionFactory {
  return createMcpExtension({
    loadConfig: () => ({ servers: [], errors: [] }),
    credentials: noStoredCredentials,
    logPath,
  });
}

/** Registers the servers with Pi's MCP support, keeping the API for `waitForPiMcpServers`. */
export function createPiMcpServersExtension(
  registrations: readonly PiMcpServerRegistration[],
  onRegistered: (pi: ExtensionAPI) => void = () => {},
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
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + connectTimeoutMs(env);
  for (;;) {
    const tools = pi.getAllTools();
    const waiting = serverIds.filter(
      (id) => !tools.some((tool) => isPiMcpServerTool(tool, id)),
    );
    if (waiting.length === 0) return;
    if (signal?.aborted) throw new Error("MCP server connection was aborted");
    if (Date.now() >= deadline) {
      throw new Error(
        `Required MCP server(s) did not connect within ${connectTimeoutMs(env)} ms: ${waiting.join(", ")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, CONNECT_POLL_MS));
  }
}

/**
 * The server and tool a Pi MCP tool stands for, for telemetry: the server from
 * the tool's namespace, the tool from Pi's `<server>/<tool>` label.
 */
export function piMcpToolOrigin(
  session: McpSessionConfig,
  tool: Pick<ToolDefinition, "label" | "namespace"> | undefined,
):
  | {
      serverId: string;
      toolName: string;
      binding?: McpSessionServer["binding"];
    }
  | undefined {
  if (!tool) return undefined;
  const server = session.servers.find((entry) =>
    isPiMcpServerTool(tool, entry.id),
  );
  const labelPrefix = `${server?.id}/`;
  if (!server || !tool.label.startsWith(labelPrefix)) return undefined;
  return {
    serverId: server.id,
    toolName: tool.label.slice(labelPrefix.length),
    ...(server.binding ? { binding: server.binding } : {}),
  };
}

type BehindServer = Pick<PiMcpServerRegistration, "id" | "behind">;

const MCP_SERVERS_SECTION = "mcp_servers";

/** The server kept behind tools that a Pi tool belongs to, if any. */
export function serverBehindTools(
  servers: readonly BehindServer[],
  tool: { namespace?: ToolNamespace } | undefined,
): BehindServer | undefined {
  return tool
    ? servers.find(
        (server) => server.behind && isPiMcpServerTool(tool, server.id),
      )
    : undefined;
}

/** Pi's `mcp_servers` prompt section without the servers kept behind tools. */
function sectionWithoutServersBehindTools(
  section: string,
  servers: readonly BehindServer[],
): string | undefined {
  // A listed server reads `- <namespace> (<how>)`.
  const hidden = servers.map((server) => `- ${piMcpNamespace(server.id)} (`);
  const [, ...lines] = section.split("\n");
  const kept = lines.filter(
    (line) => !hidden.some((prefix) => line.startsWith(prefix)),
  );
  if (!kept.some((line) => / \((codemode|tool_search)\)/.test(line))) {
    return undefined;
  }
  // Pi's intro names how the listed servers are reached; rebuild it for those kept.
  let intro = "MCP servers whose tools are not declared to you.";
  if (kept.some((line) => line.includes(" (codemode)")))
    intro += " Call the tools of `codemode` servers from codemode scripts.";
  if (kept.some((line) => line.includes(" (tool_search)")))
    intro += " Load the tools of `tool_search` servers with `tool_search`.";
  return [intro, ...kept].join("\n");
}

/**
 * Keeps each server registered with `behind` behind its tools: a call to one
 * of its tools is refused unless a tool named in `behind` issued it, directly
 * or through calls nested inside that tool's call. The model, codemode scripts
 * and every other tool are refused.
 */
export function createMcpBehindGuard(
  servers: () => readonly BehindServer[],
): ExtensionFactory {
  return (pi) => {
    const calls = new Map<
      string,
      { toolName: string; parentToolCallId: string | undefined }
    >();
    pi.on("tool_call", (event) => {
      calls.set(event.toolCallId, {
        toolName: event.toolName,
        parentToolCallId: event.parentToolCallId,
      });
      const server = serverBehindTools(
        servers(),
        pi.getAllTools().find((tool) => tool.name === event.toolName),
      );
      if (!server?.behind) return undefined;
      const front = new Set(server.behind);
      // An ancestor this guard never saw ends the walk: the call is refused.
      for (
        let call = calls.get(event.parentToolCallId ?? "");
        call;
        call = calls.get(call.parentToolCallId ?? "")
      ) {
        if (front.has(call.toolName)) return undefined;
      }
      const tools = server.behind.join(", ");
      return {
        block: true,
        reason: `MCP server '${server.id}' is reachable only through the ${tools} tool${server.behind.length === 1 ? "" : "s"}; call ${server.behind[0]} instead.`,
      };
    });
    pi.on("tool_result", (event) => {
      calls.delete(event.toolCallId);
    });
    pi.on("agent_end", () => {
      calls.clear();
    });
  };
}

/**
 * Drops the servers kept behind tools from Pi's `mcp_servers` prompt section,
 * from a `before_agent_start` handler that runs after Pi's MCP extension's.
 */
export function hideServersBehindTools(
  sections: Record<string, string>,
  servers: readonly BehindServer[],
): void {
  const behind = servers.filter((server) => server.behind);
  if (behind.length === 0) return;
  const section = sections[MCP_SERVERS_SECTION];
  if (!section) return;
  const kept = sectionWithoutServersBehindTools(section, behind);
  if (kept) sections[MCP_SERVERS_SECTION] = kept;
  else delete sections[MCP_SERVERS_SECTION];
}
