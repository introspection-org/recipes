import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  MCP_DAEMON_FINGERPRINT_ENV,
  MCP_DAEMON_GENERATION_ENV,
  MCP_DAEMON_PARENT_PID_ENV,
  MCP_DAEMON_SOCKET_ENV,
  MCP_DAEMON_TOKEN_ENV,
  MCP_SESSION_ROOT_ENV,
} from "./mcp-daemon-protocol.js";
import {
  resolvePiPackageMcpManifestPaths,
  type RecipePackageManifest,
  type RecipePackageMcpConfig,
  type RecipeMcpToolSelection,
} from "./recipe-package.js";
import { generatedBindingEnvVars } from "./recipe-mcp-config.js";
import {
  mcpSelectionAllowsTool,
  type ScopedMcpToolSelection,
} from "./mcp-policy.js";

export { preloadMcpCatalogs } from "./mcp-catalog.js";
export {
  executableRecipeToolNames,
  mcpSelectionAllowsTool,
  normalizeMcpServerId,
  resolveAgentMcpSelections,
  type ScopedMcpToolSelection,
} from "./mcp-policy.js";

export interface McpToolCatalogEntry {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpSessionServer {
  id: string;
  name: string;
  base_url: string;
  required?: boolean;
  package_tools: RecipeMcpToolSelection;
  agent_tools: RecipeMcpToolSelection[];
  /** Optional package-pinned catalog. Dynamic bindings leave this absent. */
  catalog?: McpToolCatalogEntry[];
}

export interface McpSessionConfig {
  version: 1;
  servers: McpSessionServer[];
}

export interface LocalMcpServer {
  id?: string;
  name?: string;
  transport?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: string;
  tokenCacheDir?: string;
  clientName?: string;
  oauthClientId?: string;
  oauthClientSecretEnv?: string;
  oauthTokenEndpointAuthMethod?: string;
  oauthRedirectUrl?: string;
  oauthScope?: string;
  httpFetch?: "default" | "node-http1";
}

/**
 * The `.pi/mcp.local.json` shape, usable inline by hosts that synthesize
 * endpoint bindings instead of reading them from disk.
 */
export interface McpLocalConfig {
  servers: LocalMcpServer[];
}

interface LocalMcpOAuthSettings {
  auth: "oauth";
  tokenCacheDir?: string;
  clientName?: string;
  oauthClientId?: string;
  oauthClientSecretEnv?: string;
  oauthTokenEndpointAuthMethod?: string;
  oauthRedirectUrl?: string;
  oauthScope?: string;
}

interface McpEndpointBinding {
  id: string;
  name: string;
  baseUrl: string;
  /**
   * Header values as written in the local config (`${VAR}` refs intact) so
   * they can be re-emitted into the mcporter config without persisting
   * resolved secrets to disk.
  */
  rawHeaders: Record<string, string>;
  /** mcporter request implementation; independent of endpoint authentication. */
  httpFetch?: "default" | "node-http1";
  localOAuth?: LocalMcpOAuthSettings;
}

export interface McpConfigurationDiagnostic {
  code: "mcp.tools_filtered";
  serverId: string;
  url: string;
  stage: "filter";
  message: string;
}

export interface MaterializeMcpSessionOptions {
  cwd: string;
  manifest: RecipePackageManifest;
  /** MCP selections for the one resolved agent owning this session. */
  agentMcp?: readonly ScopedMcpToolSelection[];
  env?: NodeJS.ProcessEnv;
  /**
   * Inline endpoint bindings. When provided, the local config file
   * (`.pi/mcp.local.json`) is not consulted.
   */
  localConfig?: McpLocalConfig;
  /** Explicit generated mcporter target for a private tools-mode runtime. */
  mcporterConfigPath?: string;
}

/**
 * A `required: true` package MCP server has no endpoint binding. Thrown by
 * `materializeMcpSession` before any server is materialized (fail-closed).
 */
export class McpBindingError extends Error {
  override readonly name = "McpBindingError";

  constructor(
    /** Missing required server ids, in manifest order. */
    readonly servers: readonly string[],
    /** The `${VAR}` names a generated binding for those servers would use. */
    readonly expectedEnvVars: readonly string[]
  ) {
    super(
      `Required MCP server binding(s) missing: ${servers.join(", ")}` +
        (expectedEnvVars.length > 0
          ? ` (bind via .pi/mcp.local.json or env: ${expectedEnvVars.join(", ")})`
          : "")
    );
  }
}

export interface MaterializedMcpSession extends McpSessionConfig {
  diagnostics?: McpConfigurationDiagnostic[];
}

const RECIPE_ENV_PREFIX = "PI_RECIPES_";
const MCP_SESSION_ENV = `${RECIPE_ENV_PREFIX}MCP_SESSION`;
// mcporter's own config env var — the sandbox `mcp` CLI is mcporter, and the
// generated config referenced here is the only server catalog it may read.
const MCPORTER_CONFIG_ENV = "MCPORTER_CONFIG";
const MCP_LOCAL_CONFIG_ENV = `${RECIPE_ENV_PREFIX}MCP_LOCAL_CONFIG`;
const MCP_BIN_DIR_ENV = `${RECIPE_ENV_PREFIX}MCP_BIN_DIR`;

const MCP_RUNTIME_ENV_KEYS = [
  MCP_SESSION_ENV,
  MCPORTER_CONFIG_ENV,
  MCP_LOCAL_CONFIG_ENV,
  MCP_BIN_DIR_ENV,
  MCP_DAEMON_FINGERPRINT_ENV,
  MCP_DAEMON_GENERATION_ENV,
  MCP_DAEMON_PARENT_PID_ENV,
  MCP_DAEMON_SOCKET_ENV,
  MCP_DAEMON_TOKEN_ENV,
  MCP_SESSION_ROOT_ENV,
] as const;

export interface McpEnvironmentSnapshot {
  pathKey: string;
  values: Record<string, string | undefined>;
}

/** Capture every environment entry Recipes may mutate while materializing MCP. */
export function snapshotMcpEnvironment(
  env: NodeJS.ProcessEnv
): McpEnvironmentSnapshot {
  const currentPathKey = pathKey(env);
  return {
    pathKey: currentPathKey,
    values: Object.fromEntries(
      [...MCP_RUNTIME_ENV_KEYS, currentPathKey].map((key) => [key, env[key]])
    ),
  };
}

/** Restore a previously captured MCP environment exactly. */
export function restoreMcpEnvironment(
  env: NodeJS.ProcessEnv,
  snapshot: McpEnvironmentSnapshot
): void {
  for (const [key, value] of Object.entries(snapshot.values)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
}

/**
 * Hide host-owned runtime state before materializing a leased session. The
 * local binding selector remains visible by design; session files, daemon
 * coordinates, and generated CLI state do not.
 */
export function isolateMcpEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of MCP_RUNTIME_ENV_KEYS) {
    if (key !== MCP_LOCAL_CONFIG_ENV) delete env[key];
  }
}

export function defaultMcpSessionPath(cwd: string): string {
  return join(cwd, ".pi", "mcp-session.json");
}

export function fallbackMcpSessionPath(): string {
  return join(tmpdir(), "recipes", "mcp-session.json");
}

export function defaultMcporterConfigPath(cwd: string): string {
  return join(cwd, ".pi", "mcporter.json");
}

export function fallbackMcporterConfigPath(): string {
  return join(tmpdir(), "recipes", "mcporter.json");
}

export function defaultMcpLocalConfigPath(cwd: string): string {
  return join(cwd, ".pi", "mcp.local.json");
}

export function resolveMcpLocalConfigPath(opts: {
  cwd: string;
  recipeDir: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = opts.env ?? process.env;
  const configured = env[MCP_LOCAL_CONFIG_ENV];
  if (configured) return configured;

  const workspaceConfig = defaultMcpLocalConfigPath(opts.cwd);
  if (existsSync(workspaceConfig)) return workspaceConfig;

  const recipeConfig = defaultMcpLocalConfigPath(opts.recipeDir);
  return existsSync(recipeConfig) ? recipeConfig : undefined;
}

export function configureMcpLocalConfigPath(opts: {
  cwd: string;
  recipeDir: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = opts.env ?? process.env;
  const path = resolveMcpLocalConfigPath({ ...opts, env });
  if (!path) return undefined;
  env[MCP_LOCAL_CONFIG_ENV] = path;
  return path;
}

export function defaultMcpBinDir(cwd: string): string {
  return join(cwd, ".pi", "bin");
}

export function mcporterCliEntrypointPath(): string {
  return fileURLToPath(import.meta.resolve("mcporter/cli"));
}

function compiledEntrypoint(name: string): string {
  const adjacent = fileURLToPath(new URL(`./${name}`, import.meta.url));
  if (existsSync(adjacent)) return adjacent;
  return fileURLToPath(new URL(`../dist/${name}`, import.meta.url));
}

export function mcpCliEntrypointPath(): string {
  return compiledEntrypoint("mcp-cli.js");
}

export function mcpClientEntrypointPath(): string {
  return compiledEntrypoint("mcp-client.js");
}

export function nativeMcpClientPath(
  platform = process.platform,
  arch = process.arch
): string | undefined {
  const executable = platform === "win32" ? "mcp-client.exe" : "mcp-client";
  // Anchor every lookup at the recipes package rather than at this module.
  // The runtime agent bundles this code into its own tree, where `import.meta`
  // points at the bundle and the platform packages - linked only beneath
  // recipes, never hoisted - are invisible. The package itself stays
  // resolvable there because it is a direct dependency of the host.
  const packageEntrypoint = fileURLToPath(
    import.meta.resolve("@introspection-ai/recipes")
  );
  // A published install carries exactly one binary: the platform packages are
  // gated by npm `os`/`cpu`, so only the one this host can execute is ever
  // downloaded. Resolution is wrapped because a package manager that skipped
  // optional dependencies - or a lookup for a platform other than the host's -
  // simply has nothing to resolve, which is a fallthrough rather than an error.
  // package.json is the resolution target because a package `exports` map may
  // not expose the binary path, while the manifest always resolves.
  try {
    const manifest = createRequire(packageEntrypoint).resolve(
      `@introspection-ai/mcp-client-${platform}-${arch}/package.json`
    );
    const packaged = resolve(dirname(manifest), "bin", executable);
    if (existsSync(packaged)) return packaged;
  } catch {
    // No platform package for this host; fall through to the working tree.
  }
  // Working-tree fallback: `pnpm build:native` writes here, so a checkout runs
  // against a locally compiled client without publishing anything.
  const candidate = resolve(
    dirname(packageEntrypoint),
    "..",
    "vendor",
    "mcp-client",
    `${platform}-${arch}`,
    executable
  );
  return existsSync(candidate) ? candidate : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function doubleQuoteEscape(value: string): string {
  return value.replace(/[\\"$`]/g, "\\$&");
}

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function prependPath(env: NodeJS.ProcessEnv, dir: string): void {
  const key = pathKey(env);
  const current = env[key] ?? "";
  const entries = current.split(delimiter).filter(Boolean);
  if (entries.includes(dir)) return;
  env[key] = [dir, current].filter(Boolean).join(delimiter);
}

function removePathEntry(env: NodeJS.ProcessEnv, dir: string): void {
  const key = pathKey(env);
  const entries = (env[key] ?? "").split(delimiter).filter(Boolean);
  env[key] = entries.filter((entry) => entry !== dir).join(delimiter);
}

export async function materializeSessionMcpCli(opts: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ binDir: string; shimPath: string }> {
  const env = opts.env ?? process.env;
  env[MCP_SESSION_ROOT_ENV] = opts.cwd;
  const binDir = defaultMcpBinDir(opts.cwd);
  const shimPath = join(binDir, "mcp");
  const nativeClient = nativeMcpClientPath();
  if (process.platform !== "win32" && !nativeClient) {
    throw new Error(
      `Native MCP client is unavailable for ${process.platform}-${process.arch}.`
    );
  }
  if (nativeClient && process.platform !== "win32") {
    await access(nativeClient, constants.X_OK).catch(async () => {
      await chmod(nativeClient, 0o755);
      await access(nativeClient, constants.X_OK);
    });
  }
  // The shim pins MCPORTER_CONFIG to the session-generated config (the
  // session env normally sets it; the default covers shells that lost the
  // env). mcporter must never fall through to its own config resolution —
  // that would import the developer's personal MCP servers (~/.mcporter,
  // Cursor/Claude/VS Code configs) into a recipe session.
  const script = [
    "#!/bin/sh",
    `PI_RECIPES_MCP_SESSION_ROOT=${shellQuote(opts.cwd)}`,
    "export PI_RECIPES_MCP_SESSION_ROOT",
    `: "\${${MCPORTER_CONFIG_ENV}:=${doubleQuoteEscape(defaultMcporterConfigPath(opts.cwd))}}"`,
    `export ${MCPORTER_CONFIG_ENV}`,
    `if [ -n "\${${MCP_DAEMON_SOCKET_ENV}:-}" ]; then`,
    ...(nativeClient
      ? [
          `  ${shellQuote(nativeClient)} "$@"`,
          "  native_status=$?",
          "  if [ \"$native_status\" -ne 75 ]; then exit \"$native_status\"; fi",
          `  ${shellQuote(process.execPath)} ${shellQuote(mcpClientEntrypointPath())} --start-daemon`,
          "  supervisor_status=$?",
          "  if [ \"$supervisor_status\" -ne 0 ]; then exit \"$supervisor_status\"; fi",
          `  exec ${shellQuote(nativeClient)} "$@"`,
        ]
      : [
          `  exec ${shellQuote(process.execPath)} ${shellQuote(mcpClientEntrypointPath())} "$@"`,
        ]),
    "fi",
    `exec ${shellQuote(process.execPath)} ${shellQuote(mcpCliEntrypointPath())} "$@"`,
    "",
  ].join("\n");
  await mkdir(binDir, { recursive: true });
  await writeFile(shimPath, script);
  await chmod(shimPath, 0o755);
  env[MCP_BIN_DIR_ENV] = binDir;
  prependPath(env, binDir);
  return { binDir, shimPath };
}

function sessionPath(env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  return env[MCP_SESSION_ENV] || defaultMcpSessionPath(cwd);
}

export function readMcpSessionConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): McpSessionConfig {
  const path = sessionPath(env, cwd);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as McpSessionConfig;
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.servers)
  ) {
    throw new Error(`Unsupported Recipe MCP session at ${path}`);
  }
  return parsed;
}

function localMcpConfigPath(env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  return env[MCP_LOCAL_CONFIG_ENV] || defaultMcpLocalConfigPath(cwd);
}

function safeServerId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || "mcp";
}

function hostForUrl(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function interpolateEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => env[name] ?? "");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function readLocalMcpServers(
  env: NodeJS.ProcessEnv,
  cwd: string,
  localConfig?: McpLocalConfig
): LocalMcpServer[] {
  if (localConfig) {
    return Array.isArray(localConfig.servers) ? localConfig.servers : [];
  }
  const path = localMcpConfigPath(env, cwd);
  if (!existsSync(path)) return [];
  try {
    const parsed = readJson(path) as { servers?: unknown };
    return Array.isArray(parsed.servers) ? (parsed.servers as LocalMcpServer[]) : [];
  } catch {
    return [];
  }
}

function localBindings(
  env: NodeJS.ProcessEnv,
  cwd: string,
  localConfig?: McpLocalConfig
): McpEndpointBinding[] {
  return readLocalMcpServers(env, cwd, localConfig).flatMap((server) => {
    if (server.transport && server.transport !== "streamable_http") return [];
    const baseUrl = server.url ? interpolateEnv(server.url, env) : "";
    if (!baseUrl) return [];
    const label = (server.name ?? server.id ?? hostForUrl(baseUrl)) || "mcp";
    const rawHeaders = server.headers ?? {};
    const localOAuth: LocalMcpOAuthSettings | undefined =
      server.auth === "oauth"
        ? {
            auth: "oauth",
            ...(server.tokenCacheDir ? { tokenCacheDir: server.tokenCacheDir } : {}),
            ...(server.clientName ? { clientName: server.clientName } : {}),
            ...(server.oauthClientId ? { oauthClientId: server.oauthClientId } : {}),
            ...(server.oauthClientSecretEnv
              ? { oauthClientSecretEnv: server.oauthClientSecretEnv }
              : {}),
            ...(server.oauthTokenEndpointAuthMethod
              ? { oauthTokenEndpointAuthMethod: server.oauthTokenEndpointAuthMethod }
              : {}),
            ...(server.oauthRedirectUrl
              ? { oauthRedirectUrl: server.oauthRedirectUrl }
              : {}),
            ...(server.oauthScope ? { oauthScope: server.oauthScope } : {}),
          }
        : undefined;
    return [{
      id: safeServerId(server.id ?? label),
      name: label,
      baseUrl,
      rawHeaders,
      ...(server.httpFetch ? { httpFetch: server.httpFetch } : {}),
      ...(localOAuth ? { localOAuth } : {}),
    }];
  });
}

function endpointBindings(
  env: NodeJS.ProcessEnv,
  cwd: string,
  localConfig?: McpLocalConfig
): McpEndpointBinding[] {
  const candidates = localBindings(env, cwd, localConfig);
  const seen = new Set<string>();
  const bindings: McpEndpointBinding[] = [];
  for (const binding of candidates) {
    const key = `${binding.id}:${binding.baseUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push(binding);
  }
  return bindings;
}

export function formatMcpConfigurationDiagnostics(
  diagnostics: readonly McpConfigurationDiagnostic[],
  limit = 3
): string {
  const selected = diagnostics.slice(0, limit);
  const lines = selected.map((diagnostic) => {
    return `${diagnostic.serverId} ${diagnostic.stage} [${diagnostic.code}]: ${diagnostic.message}`;
  });
  const remaining = diagnostics.length - selected.length;
  if (remaining > 0) lines.push(`${remaining} more MCP configuration issue(s).`);
  return lines.join("\n");
}

function recipeMcpPolicy(mcp: RecipePackageMcpConfig): {
  required: Set<string>;
  tools: Map<string, RecipeMcpToolSelection>;
} {
  return {
    required: new Set(
      mcp.servers
        .filter((server) => server.required)
        .map((server) => safeServerId(server.id))
    ),
    tools: new Map(
      mcp.servers.map((server) => [safeServerId(server.id), server.tools])
    ),
  };
}

export function mcpSessionAllowsTool(
  server: Pick<McpSessionServer, "package_tools" | "agent_tools">,
  toolName: string
): boolean {
  return (
    mcpSelectionAllowsTool(server.package_tools, toolName) &&
    server.agent_tools.some((selection) =>
      mcpSelectionAllowsTool(selection, toolName)
    )
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function filterMcpCatalog(
  server: Pick<McpSessionServer, "package_tools" | "agent_tools">,
  catalog: readonly McpToolCatalogEntry[]
): McpToolCatalogEntry[] {
  const allowed = catalog.filter((tool) =>
    mcpSessionAllowsTool(server, tool.name)
  );
  const hiddenNames = catalog
    .filter((tool) => !mcpSessionAllowsTool(server, tool.name))
    .map((tool) => tool.name)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (hiddenNames.length === 0) return allowed;
  return allowed.map((tool) => ({
    ...tool,
    ...(tool.description
      ? {
          description: hiddenNames.reduce(
            (description, name) =>
              description.replace(
                new RegExp(
                  `(^|[^A-Za-z0-9_-])${escapeRegExp(name)}(?=$|[^A-Za-z0-9_-])`,
                  "g"
                ),
                "$1[unavailable MCP tool]"
              ),
            tool.description
          ),
        }
      : {}),
  }));
}

interface ConfiguredMcpServer {
  id: string;
  name?: string;
  base_url: string;
  tools?: McpToolCatalogEntry[];
}

interface ConfiguredMcpManifest {
  servers?: ConfiguredMcpServer[];
}

function readConfiguredManifests(
  manifest: RecipePackageManifest
): ConfiguredMcpServer[] {
  const servers: ConfiguredMcpServer[] = [];
  for (const path of resolvePiPackageMcpManifestPaths(manifest)) {
    const parsed = readJson(path) as ConfiguredMcpManifest;
    servers.push(...(parsed.servers ?? []));
  }
  return servers;
}

function explicitAllowedTools(server: McpSessionServer): string[] | undefined {
  const packageIncludes = server.package_tools.include ?? [];
  const agentIncludes = server.agent_tools.flatMap(
    (selection) => selection.include ?? []
  );
  const candidates = !packageIncludes.includes("*")
    ? packageIncludes
    : !agentIncludes.includes("*")
      ? agentIncludes
      : undefined;
  if (!candidates) return undefined;
  return [...new Set(candidates)].filter((name) =>
    mcpSessionAllowsTool(server, name)
  );
}

async function writeWithFallback(
  path: string,
  serialized: string,
  defaultPath: string,
  fallbackPath: string
): Promise<string> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serialized);
    return path;
  } catch (err) {
    if (path !== defaultPath) throw err;
    await mkdir(dirname(fallbackPath), { recursive: true });
    await writeFile(fallbackPath, serialized);
    return fallbackPath;
  }
}

export interface McporterServerConfig {
  baseUrl: string;
  headers: Record<string, string>;
  allowedTools?: string[];
  auth?: "oauth";
  tokenCacheDir?: string;
  clientName?: string;
  oauthClientId?: string;
  oauthClientSecretEnv?: string;
  oauthTokenEndpointAuthMethod?: string;
  oauthRedirectUrl?: string;
  oauthScope?: string;
  httpFetch?: "default" | "node-http1";
}

export interface McporterConfig {
  imports: string[];
  mcpServers: Record<string, McporterServerConfig>;
}

/**
 * Project the static session policy into the config the `mcp` CLI (mcporter)
 * reads. Header values stay `${VAR}` references — mcporter interpolates them
 * at config load — so neither session tokens nor local dev secrets are
 * persisted. `allowedTools` re-applies the recipe/agent tool filter inside
 * mcporter, and `imports: []` keeps mcporter from discovering host-level
 * configs (Cursor/Claude/VS Code) in a recipe session.
 */
export function buildMcporterConfig(
  session: McpSessionConfig,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}
): McporterConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  return projectMcporterConfig(session, localBindings(env, cwd));
}

function projectMcporterConfig(
  session: McpSessionConfig,
  bindings: readonly McpEndpointBinding[]
): McporterConfig {
  const mcpServers: Record<string, McporterServerConfig> = {};
  for (const server of session.servers) {
    const binding = bindings.find(
      (candidate) =>
        candidate.id === server.id && candidate.baseUrl === server.base_url
    );
    const allowedTools = explicitAllowedTools(server);
    mcpServers[server.id] = {
      baseUrl: server.base_url,
      headers: binding?.rawHeaders ?? {},
      ...(allowedTools ? { allowedTools } : {}),
      ...(binding?.httpFetch ? { httpFetch: binding.httpFetch } : {}),
      ...(binding?.localOAuth ?? {}),
    };
  }
  return { imports: [], mcpServers };
}

async function writeMcporterConfig(
  env: NodeJS.ProcessEnv,
  cwd: string,
  session: McpSessionConfig,
  bindings?: readonly McpEndpointBinding[],
  targetPath?: string
): Promise<string> {
  const config = bindings
    ? projectMcporterConfig(session, bindings)
    : buildMcporterConfig(session, { env, cwd });
  const writtenPath = await writeWithFallback(
    targetPath || defaultMcporterConfigPath(cwd),
    `${JSON.stringify(config, null, 2)}\n`,
    defaultMcporterConfigPath(cwd),
    fallbackMcporterConfigPath()
  );
  env[MCPORTER_CONFIG_ENV] = writtenPath;
  return writtenPath;
}

export async function clearMcpSession(
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<void> {
  await stopMcpDaemon(env);
  const configuredPath = sessionPath(env, cwd);
  delete env[MCP_SESSION_ENV];
  await rm(configuredPath, { force: true });
  if (configuredPath !== defaultMcpSessionPath(cwd)) {
    await rm(defaultMcpSessionPath(cwd), { force: true });
  }
  // Keep an empty mcporter config (rather than none): a stale `.pi/bin/mcp`
  // shim from an earlier session must resolve to "no servers", never to
  // mcporter's host-level config discovery.
  await writeMcporterConfig(env, cwd, { version: 1, servers: [] });
}

/**
 * Remove the CLI-facing MCP surface entirely. Tools mode calls this before it
 * creates its private daemon environment so shell tools cannot inherit the
 * session, mcporter config, or `mcp` shim.
 */
export async function clearSessionMcpCli(
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<{ previousMcporterConfig?: string }> {
  const previousMcporterConfig = env[MCPORTER_CONFIG_ENV];
  await stopMcpDaemon(env);
  const configuredSession = sessionPath(env, cwd);
  const configuredMcporter =
    env[MCPORTER_CONFIG_ENV] === fallbackMcporterConfigPath()
      ? fallbackMcporterConfigPath()
      : defaultMcporterConfigPath(cwd);
  const binDir = env[MCP_BIN_DIR_ENV] || defaultMcpBinDir(cwd);
  removePathEntry(env, binDir);
  delete env[MCP_BIN_DIR_ENV];
  delete env[MCP_SESSION_ENV];
  delete env[MCPORTER_CONFIG_ENV];
  await Promise.all([
    rm(configuredSession, { force: true }),
    configuredSession === defaultMcpSessionPath(cwd)
      ? Promise.resolve()
      : rm(defaultMcpSessionPath(cwd), { force: true }),
    rm(configuredMcporter, { force: true }),
    configuredMcporter === defaultMcporterConfigPath(cwd)
      ? Promise.resolve()
      : rm(defaultMcporterConfigPath(cwd), { force: true }),
    rm(join(binDir, "mcp"), { force: true }),
  ]);
  return {
    ...(previousMcporterConfig ? { previousMcporterConfig } : {}),
  };
}

export async function createIsolatedMcpEnvironment(
  baseEnv: NodeJS.ProcessEnv
): Promise<{
  env: NodeJS.ProcessEnv;
  directory: string;
  mcporterConfigPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "recipes-mcp-tools-"));
  const env = { ...baseEnv };
  for (const key of [
    MCP_DAEMON_SOCKET_ENV,
    MCP_DAEMON_TOKEN_ENV,
    MCP_DAEMON_FINGERPRINT_ENV,
    MCP_DAEMON_PARENT_PID_ENV,
    MCP_SESSION_ROOT_ENV,
    MCP_DAEMON_GENERATION_ENV,
  ]) {
    delete env[key];
  }
  delete env[MCP_BIN_DIR_ENV];
  delete env[MCPORTER_CONFIG_ENV];
  env[MCP_SESSION_ENV] = join(directory, "session.json");
  return {
    env,
    directory,
    mcporterConfigPath: join(directory, "mcporter.json"),
  };
}

export async function materializeMcpSession(
  opts: MaterializeMcpSessionOptions
): Promise<MaterializedMcpSession> {
  const env = opts.env ?? process.env;
  const agentSelections = opts.agentMcp ?? [];
  const endpointBindingList = endpointBindings(env, opts.cwd, opts.localConfig);
  const bindings = new Map(
    endpointBindingList.map((binding) => [binding.id, binding])
  );
  const configured = new Map(
    readConfiguredManifests(opts.manifest).map((server) => [
      safeServerId(server.id),
      server,
    ])
  );
  const policy = recipeMcpPolicy(opts.manifest.mcp);
  const available = new Set([...bindings.keys(), ...configured.keys()]);
  const missingRequired = [...policy.required].filter(
    (serverId) => !available.has(serverId)
  );
  if (missingRequired.length > 0) {
    throw new McpBindingError(
      missingRequired,
      missingRequired.flatMap((serverId) => generatedBindingEnvVars(serverId))
    );
  }

  const diagnostics: McpConfigurationDiagnostic[] = [];
  const servers: McpSessionServer[] = [];
  for (const packageServer of opts.manifest.mcp.servers) {
    const id = safeServerId(packageServer.id);
    const selected = agentSelections
      .filter((selection) => selection.serverId === id)
      .map((selection) => selection.tools);
    if (selected.length === 0 || selected.every((entry) => entry.include?.length === 0)) {
      continue;
    }
    const binding = bindings.get(id);
    const declared = configured.get(id);
    if (!binding && !declared) continue;
    const baseUrl = binding?.baseUrl ?? declared!.base_url;
    const catalogPolicy = {
      package_tools: packageServer.tools,
      agent_tools: selected,
    };
    const catalog = filterMcpCatalog(
      catalogPolicy,
      declared?.tools ?? []
    );
    if (declared?.tools && catalog.length === 0) {
      diagnostics.push({
        code: "mcp.tools_filtered",
        serverId: id,
        url: baseUrl,
        stage: "filter",
        message: "The configured catalog contains no tools allowed by both package and agent policy.",
      });
      continue;
    }
    servers.push({
      id,
      name: binding?.name ?? declared?.name ?? id,
      base_url: baseUrl,
      ...(packageServer.required ? { required: true } : {}),
      package_tools: packageServer.tools,
      agent_tools: selected,
      ...(declared?.tools ? { catalog } : {}),
    });
  }

  const session: McpSessionConfig = {
    version: 1,
    servers,
  };
  const defaultPath = defaultMcpSessionPath(opts.cwd);
  const target = sessionPath(env, opts.cwd);
  const serialized = `${JSON.stringify(session, null, 2)}\n`;
  const fingerprint = createHash("sha256").update(serialized).digest("hex").slice(0, 20);
  const previousFingerprint = env[MCP_DAEMON_FINGERPRINT_ENV];
  const previousToken = env[MCP_DAEMON_TOKEN_ENV];
  if (
    previousFingerprint &&
    previousFingerprint !== fingerprint
  ) {
    await stopMcpDaemon(env);
  }
  const writtenPath = await writeWithFallback(
    target,
    serialized,
    defaultPath,
    fallbackMcpSessionPath()
  );
  env[MCP_SESSION_ENV] = writtenPath;
  env[MCP_SESSION_ROOT_ENV] = opts.cwd;
  env[MCP_DAEMON_FINGERPRINT_ENV] = fingerprint;
  env[MCP_DAEMON_PARENT_PID_ENV] = String(process.pid);
  if (
    !env[MCP_DAEMON_GENERATION_ENV] ||
    (previousFingerprint && previousFingerprint !== fingerprint)
  ) {
    env[MCP_DAEMON_GENERATION_ENV] = randomBytes(12).toString("hex");
  }
  const socketKey = createHash("sha256")
    .update(
      `${opts.cwd}\0${fingerprint}\0${env[MCP_DAEMON_GENERATION_ENV]}`
    )
    .digest("hex")
    .slice(0, 20);
  env[MCP_DAEMON_SOCKET_ENV] =
    process.platform === "win32"
      ? `\\\\.\\pipe\\recipes-mcp-${socketKey}`
      : join(tmpdir(), `recipes-mcp-${socketKey}.sock`);
  // Re-materialization with identical policy must not strand a running daemon
  // behind a newly rotated client token. Rotate only when the session changes.
  env[MCP_DAEMON_TOKEN_ENV] =
    previousFingerprint === fingerprint && previousToken
      ? previousToken
      : randomBytes(32).toString("hex");
  await writeMcporterConfig(
    env,
    opts.cwd,
    session,
    endpointBindingList,
    opts.mcporterConfigPath
  );
  return { ...session, diagnostics };
}

export async function stopMcpDaemon(env: NodeJS.ProcessEnv): Promise<void> {
  const socketPath = env[MCP_DAEMON_SOCKET_ENV];
  const token = env[MCP_DAEMON_TOKEN_ENV];
  if (socketPath && token) {
    await new Promise<void>((resolve) => {
      const socket = createConnection(socketPath);
      let settled = false;
      let hardTimeout: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (hardTimeout) clearTimeout(hardTimeout);
        socket.destroy();
        resolve();
      };
      // net.Socket's idle timeout starts after connection establishment. Keep
      // a real deadline as well so a stale or disappearing Unix socket cannot
      // leave session shutdown pending with no ref'ed event-loop handles.
      hardTimeout = setTimeout(finish, 500);
      socket.setTimeout(500, finish);
      socket.once("connect", () => {
        socket.end(
          `${JSON.stringify({ type: "stop", id: randomUUID(), token })}\n`
        );
      });
      socket.once("end", finish);
      socket.once("close", finish);
      socket.once("error", finish);
    });
  }
  delete env[MCP_DAEMON_SOCKET_ENV];
  delete env[MCP_DAEMON_TOKEN_ENV];
  delete env[MCP_DAEMON_FINGERPRINT_ENV];
  delete env[MCP_DAEMON_PARENT_PID_ENV];
  delete env[MCP_SESSION_ROOT_ENV];
  delete env[MCP_DAEMON_GENERATION_ENV];
}
