import { existsSync, realpathSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface RecipePackageResources {
  agents: string[];
  extensions: string[];
  skills: string[];
  prompts: string[];
}

export interface RecipePackageMcpServer {
  id: string;
  required: boolean;
  tools: RecipeMcpToolSelection;
}

export interface RecipeMcpToolSelection {
  /** Exact tool names or the reserved whole-toolset `*` sentinel. Omission allows no tools. */
  include?: string[];
  /** Exact tool names removed after inclusion. */
  exclude?: string[];
}

const INVALID_MCP_TOOL_SELECTION = Symbol("invalidMcpToolSelection");

type ParsedRecipeMcpToolSelection = RecipeMcpToolSelection & {
  [INVALID_MCP_TOOL_SELECTION]?: true;
};

/** Parse a selection while preserving whether its source shape was malformed. */
export function parseRecipeMcpToolSelection(value: unknown): RecipeMcpToolSelection {
  const validObject = Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const data = asRecord(value);
  const selection: ParsedRecipeMcpToolSelection = {
    ...(Object.hasOwn(data, "include") ? { include: stringArray(data.include) } : {}),
    ...(Object.hasOwn(data, "exclude") ? { exclude: stringArray(data.exclude) } : {}),
  };
  const malformedArray = ["include", "exclude"].some(
    (key) =>
      Object.hasOwn(data, key) &&
      (!Array.isArray(data[key]) || data[key].some((item) => typeof item !== "string"))
  );
  if (!validObject || malformedArray) {
    Object.defineProperty(selection, INVALID_MCP_TOOL_SELECTION, {
      value: true,
      enumerable: false,
    });
  }
  return selection;
}

/** Minimal session guard; the Recipe checker owns authoring diagnostics. */
export function isValidRecipeMcpToolSelection(selection: RecipeMcpToolSelection): boolean {
  if ((selection as ParsedRecipeMcpToolSelection)[INVALID_MCP_TOOL_SELECTION]) {
    return false;
  }
  return (
    (selection.include ?? []).every((selector) => {
      const value = selector.trim();
      return Boolean(value) && (value === "*" || !value.includes("*"));
    }) &&
    (selection.exclude ?? []).every((selector) => {
      const value = selector.trim();
      return Boolean(value) && !value.includes("*");
    })
  );
}

export interface RecipePackageMcpConfig {
  manifests: string[];
  servers: RecipePackageMcpServer[];
}

export interface RecipePackageChannel {
  provider: string;
  commands?: string[];
  requireReply?: boolean;
}

export function recipeChannelPackageName(provider: string): string {
  return `@introspection-ai/recipe-channel-${provider}`;
}

export interface RecipePythonRuntimeRequirement {
  project: string;
  lockfile: string;
  version?: string;
  imports: string[];
}

export interface RecipeSystemPackageRequirement {
  id: string;
  version: string;
}

export interface RecipeRuntimeRequirements {
  python?: RecipePythonRuntimeRequirement;
  system: {
    packages: RecipeSystemPackageRequirement[];
  };
}

export interface RecipePackageManifest {
  name: string;
  version: string;
  description?: string;
  path: string;
  resources: RecipePackageResources;
  /** Whether each resource key was explicitly authored in package.json#pi. */
  resourceDeclarations?: Record<keyof RecipePackageResources, boolean>;
  channels?: RecipePackageChannel[];
  mcp: RecipePackageMcpConfig;
  runtime?: RecipeRuntimeRequirements;
}

export type PiPackageResources = RecipePackageResources;
export type PiPackageManifest = RecipePackageManifest;

export interface RecipeValidationFinding {
  code: string;
  message: string;
  packageName?: string;
}

export interface RecipeValidationReport {
  valid: boolean;
  findings: RecipeValidationFinding[];
}

type PackageJson = {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  dependencies?: unknown;
  pi?: unknown;
};

const RESOURCE_KEYS: Array<keyof RecipePackageResources> = [
  "agents",
  "extensions",
  "skills",
  "prompts",
];

const PI_KEYS = new Set([
  ...RESOURCE_KEYS,
  "channels",
  "mcp",
  "runtime",
]);
const SOURCE_FINDINGS = Symbol("recipeSourceFindings");
type ParsedRecipePackageManifest = RecipePackageManifest & {
  [SOURCE_FINDINGS]?: RecipeValidationFinding[];
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function emptyResources(): RecipePackageResources {
  return {
    agents: [],
    extensions: [],
    skills: [],
    prompts: [],
  };
}

function resourceDeclarations(
  pi: Record<string, unknown>
): Record<keyof RecipePackageResources, boolean> {
  return Object.fromEntries(RESOURCE_KEYS.map((key) => [key, Object.hasOwn(pi, key)])) as Record<
    keyof RecipePackageResources,
    boolean
  >;
}

function sourceShapeFindings(
  pi: Record<string, unknown>,
  packageName: string,
  dependencies: unknown
): RecipeValidationFinding[] {
  const findings: RecipeValidationFinding[] = [];
  for (const key of Object.keys(pi)) {
    if (!PI_KEYS.has(key as keyof RecipePackageResources | "mcp")) {
      findings.push(
        finding("pi.unknown_key", `package.json#pi contains unknown key '${key}'`, packageName)
      );
    }
  }
  for (const key of RESOURCE_KEYS) {
    if (!Object.hasOwn(pi, key)) continue;
    const value = pi[key];
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== "string" || item.trim().length === 0)
    ) {
      findings.push(
        finding(
          `pi.${key}_invalid`,
          `package.json#pi.${key} must be an array of non-empty strings`,
          packageName
        )
      );
    } else if (new Set(value.map((item) => String(item).trim())).size !== value.length) {
      findings.push(
        finding(
          `pi.${key}_duplicate`,
          `package.json#pi.${key} must not contain duplicate entries`,
          packageName
        )
      );
    }
  }
  findings.push(
    ...channelSourceShapeFindings(pi.channels, packageName, dependencies)
  );
  findings.push(...mcpSourceShapeFindings(pi.mcp, packageName));
  findings.push(...runtimeSourceShapeFindings(pi.runtime, packageName));
  return findings;
}

function channelSourceShapeFindings(
  value: unknown,
  packageName: string,
  dependencies: unknown
): RecipeValidationFinding[] {
  if (value === undefined) return [];
  const invalid = (message: string) =>
    finding("pi.channels_invalid", message, packageName);
  if (!Array.isArray(value)) {
    return [invalid("package.json#pi.channels must be an array")];
  }

  const findings: RecipeValidationFinding[] = [];
  const providers = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      findings.push(
        invalid(`package.json#pi.channels[${index}] must be an object`)
      );
      continue;
    }
    const connector = raw as Record<string, unknown>;
    const unknown = Object.keys(connector).filter((key) => !["provider", "commands", "requireReply"].includes(key));
    if (connector.requireReply !== undefined && typeof connector.requireReply !== "boolean") {
      findings.push(invalid(`package.json#pi.channels[${index}].requireReply must be a boolean`));
    }
    if (connector.commands !== undefined && (!Array.isArray(connector.commands) ||
      connector.commands.some((command) => typeof command !== "string" || !command.trim()) ||
      new Set(connector.commands).size !== connector.commands.length)) {
      findings.push(invalid(`package.json#pi.channels[${index}].commands must be an array of unique non-empty strings`));
    }
    if (unknown.length > 0) {
      findings.push(
        invalid(
          `package.json#pi.channels[${index}] contains unknown field(s): ${unknown.join(", ")}`
        )
      );
    }

    const provider =
      typeof connector.provider === "string" && connector.provider.trim()
        ? connector.provider.trim()
        : undefined;
    if (!provider) {
      findings.push(
        invalid(
          `package.json#pi.channels[${index}].provider must be non-empty`
        )
      );
    } else if (providers.has(provider)) {
      findings.push(
        invalid(
          `package.json#pi.channels contains duplicate provider '${provider}'`
        )
      );
    } else {
      providers.add(provider);
    }

    if (provider) {
      const channelPackage = recipeChannelPackageName(provider);
      const declaredDependencies =
        dependencies &&
        typeof dependencies === "object" &&
        !Array.isArray(dependencies)
          ? (dependencies as Record<string, unknown>)
          : {};
      const dependencyVersion = declaredDependencies[channelPackage];
      if (
        typeof dependencyVersion !== "string" ||
        !dependencyVersion.trim()
      ) {
        findings.push(
          invalid(
            `package.json#pi.channels provider '${provider ?? "unknown"}' requires dependency '${channelPackage}'`
          )
        );
      }
    }
  }
  return findings;
}

function runtimeSourceShapeFindings(
  value: unknown,
  packageName: string
): RecipeValidationFinding[] {
  if (value === undefined) return [];
  const invalid = (message: string) => finding("pi.runtime_invalid", message, packageName);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [invalid("package.json#pi.runtime must be an object")];
  }
  const runtime = value as Record<string, unknown>;
  const findings: RecipeValidationFinding[] = [];
  for (const key of Object.keys(runtime)) {
    if (!["python", "system"].includes(key)) {
      findings.push(invalid(`package.json#pi.runtime contains unknown field '${key}'`));
    }
  }
  if (runtime.python !== undefined) {
    if (!runtime.python || typeof runtime.python !== "object" || Array.isArray(runtime.python)) {
      findings.push(invalid("package.json#pi.runtime.python must be an object"));
    } else {
      const python = runtime.python as Record<string, unknown>;
      for (const key of Object.keys(python)) {
        if (!["project", "lockfile", "version", "imports"].includes(key)) {
          findings.push(invalid(`package.json#pi.runtime.python contains unknown field '${key}'`));
        }
      }
      for (const key of ["project", "lockfile"]) {
        if (typeof python[key] !== "string" || !python[key].trim()) {
          findings.push(
            invalid(`package.json#pi.runtime.python.${key} must be a non-empty relative path`)
          );
        }
      }
      if (
        python.version !== undefined &&
        (typeof python.version !== "string" || !python.version.trim())
      ) {
        findings.push(invalid("package.json#pi.runtime.python.version must be a non-empty string"));
      }
      if (
        python.imports !== undefined &&
        (!Array.isArray(python.imports) ||
          python.imports.some((item) => typeof item !== "string" || !item.trim()))
      ) {
        findings.push(
          invalid(
            "package.json#pi.runtime.python.imports must be an array of non-empty module names"
          )
        );
      }
    }
  }
  if (runtime.system !== undefined) {
    if (!runtime.system || typeof runtime.system !== "object" || Array.isArray(runtime.system)) {
      findings.push(invalid("package.json#pi.runtime.system must be an object"));
    } else {
      const system = runtime.system as Record<string, unknown>;
      for (const key of Object.keys(system)) {
        if (key !== "packages") {
          findings.push(invalid(`package.json#pi.runtime.system contains unknown field '${key}'`));
        }
      }
      if (!Array.isArray(system.packages)) {
        findings.push(invalid("package.json#pi.runtime.system.packages must be an array"));
      } else {
        for (const [index, entry] of system.packages.entries()) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            findings.push(
              invalid(`package.json#pi.runtime.system.packages[${index}] must be an object`)
            );
            continue;
          }
          const pkg = entry as Record<string, unknown>;
          if (
            typeof pkg.id !== "string" ||
            !pkg.id.trim() ||
            typeof pkg.version !== "string" ||
            !pkg.version.trim()
          ) {
            findings.push(
              invalid(
                `package.json#pi.runtime.system.packages[${index}] requires non-empty id and version`
              )
            );
          }
        }
      }
    }
  }
  return findings;
}

function mcpSourceShapeFindings(value: unknown, packageName: string): RecipeValidationFinding[] {
  if (value === undefined) return [];
  const invalid = (message: string) => finding("pi.mcp_invalid", message, packageName);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [invalid("package.json#pi.mcp must be an object")];
  }
  const data = value as Record<string, unknown>;
  const findings: RecipeValidationFinding[] = [];
  const unknown = Object.keys(data).filter((key) => !["manifests", "servers"].includes(key));
  if (unknown.length > 0) {
    findings.push(invalid(`package.json#pi.mcp contains unknown field(s): ${unknown.join(", ")}`));
  }
  const manifests = Array.isArray(data.manifests) ? data.manifests : [];
  if (
    Object.hasOwn(data, "manifests") &&
    (!Array.isArray(data.manifests) ||
      data.manifests.some((item) => typeof item !== "string" || !item.trim()))
  ) {
    findings.push(invalid("package.json#pi.mcp manifests must be non-empty strings"));
  }
  if (
    manifests.every((item): item is string => typeof item === "string") &&
    new Set(manifests.map((item) => item.trim())).size !== manifests.length
  ) {
    findings.push(invalid("package.json#pi.mcp manifests must not contain duplicates"));
  }
  if (Object.hasOwn(data, "servers") && !Array.isArray(data.servers)) {
    findings.push(invalid("package.json#pi.mcp.servers must be an array"));
    return findings;
  }
  const ids = new Set<string>();
  const normalizedIds = new Set<string>();
  for (const [index, raw] of (Array.isArray(data.servers) ? data.servers : []).entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      findings.push(invalid(`package.json#pi.mcp.servers[${index}] must be an object`));
      continue;
    }
    const server = raw as Record<string, unknown>;
    const serverUnknown = Object.keys(server).filter(
      (key) => !["id", "required", "tools"].includes(key)
    );
    if (serverUnknown.length > 0) {
      findings.push(
        invalid(
          `package.json#pi.mcp.servers[${index}] contains unknown field(s): ${serverUnknown.join(", ")}`
        )
      );
    }
    const id = typeof server.id === "string" && server.id.trim() ? server.id.trim() : undefined;
    if (!id) {
      findings.push(invalid(`package.json#pi.mcp.servers[${index}].id must be non-empty`));
    } else if (ids.has(id)) {
      findings.push(invalid(`package.json#pi.mcp contains duplicate server id '${id}'`));
    } else {
      ids.add(id);
      const normalized =
        id
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "mcp";
      if (normalizedIds.has(normalized)) {
        findings.push(
          invalid(`package.json#pi.mcp server id '${id}' collides after normalization`)
        );
      }
      normalizedIds.add(normalized);
    }
    if (Object.hasOwn(server, "required") && typeof server.required !== "boolean") {
      findings.push(invalid(`package.json#pi.mcp.servers[${index}].required must be boolean`));
    }
    if (Object.hasOwn(server, "tools")) {
      if (!server.tools || typeof server.tools !== "object" || Array.isArray(server.tools)) {
        findings.push(invalid(`package.json#pi.mcp.servers[${index}].tools must be an object`));
      } else {
        const tools = server.tools as Record<string, unknown>;
        const toolsUnknown = Object.keys(tools).filter(
          (key) => !["include", "exclude"].includes(key)
        );
        if (toolsUnknown.length > 0) {
          findings.push(
            invalid(
              `package.json#pi.mcp.servers[${index}].tools contains unknown field(s): ${toolsUnknown.join(", ")}`
            )
          );
        }
      }
    }
  }
  return findings;
}

function emptyMcpConfig(): RecipePackageMcpConfig {
  return {
    manifests: [],
    servers: [],
  };
}

function normalizeResourcePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function hasTraversalSegment(path: string): boolean {
  return normalizeResourcePath(path)
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function assertPackageResourcePath(
  pkg: RecipePackageManifest,
  key: keyof RecipePackageResources,
  resource: string,
  resolved: string
): void {
  if (isAbsolute(resource) || hasTraversalSegment(resource)) {
    throw new RecipePackageError(
      `Recipe ${pkg.name} declares ${key} resource outside the package: ${resource}`
    );
  }
  const relativePath = relative(resolve(pkg.path), resolved);
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    isAbsolute(relativePath)
  ) {
    throw new RecipePackageError(
      `Recipe ${pkg.name} declares ${key} resource outside the package: ${resource}`
    );
  }
}

export function assertRecipePathContained(packageDir: string, path: string, label: string): void {
  const root = realpathSync(packageDir);
  const target = realpathSync(path);
  const relativePath = relative(root, target);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new RecipePackageError(`Recipe ${label} resolves outside the package: ${path}`);
  }
}

function assertResourceTreeContained(
  packageDir: string,
  path: string,
  label: string,
  seen = new Set<string>()
): void {
  assertRecipePathContained(packageDir, path, label);
  const realPath = realpathSync(path);
  if (seen.has(realPath)) return;
  seen.add(realPath);
  if (!statSync(path).isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    assertRecipePathContained(packageDir, child, label);
    if (statSync(child).isDirectory()) {
      assertResourceTreeContained(packageDir, child, label, seen);
    }
  }
}

function hasGlob(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizeResourcePath(glob);
  let pattern = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      const after = normalized[index + 2];
      if (after === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegExp(char);
    }
  }
  pattern += "$";
  return new RegExp(pattern);
}

const UNSCANNED_PACKAGE_DIRS = new Set(["node_modules", ".git"]);

function globScanRoot(glob: string): string {
  const segments = normalizeResourcePath(glob).split("/");
  const staticSegments: string[] = [];
  for (const segment of segments) {
    if (hasGlob(segment)) break;
    staticSegments.push(segment);
  }
  return staticSegments.join("/");
}

function listPackageEntries(root: string, globs: readonly string[]): string[] {
  const scanRoots = new Set<string>();
  for (const glob of globs) {
    if (!glob.trim() || !hasGlob(glob)) continue;
    if (isAbsolute(glob) || hasTraversalSegment(glob)) {
      throw new RecipePackageError(`Recipe resource glob resolves outside the package: ${glob}`);
    }
    scanRoots.add(globScanRoot(glob));
  }
  if (scanRoots.size === 0) return [];

  const entries: string[] = [];
  const seen = new Set<string>();
  function visit(dir: string, relativeDir: string): void {
    let directoryEntries;
    try {
      directoryEntries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of directoryEntries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && UNSCANNED_PACKAGE_DIRS.has(entry.name)) {
        continue;
      }
      if (!seen.has(relative)) {
        seen.add(relative);
        entries.push(relative);
      }
      if (entry.isDirectory()) visit(fullPath, relative);
    }
  }

  const roots = scanRoots.has("") ? [""] : [...scanRoots];
  for (const scanRoot of roots) {
    if (scanRoot && !seen.has(scanRoot)) {
      seen.add(scanRoot);
      entries.push(scanRoot);
    }
    visit(scanRoot ? join(root, scanRoot) : root, scanRoot);
  }
  return entries;
}

function finding(code: string, message: string, packageName?: string): RecipeValidationFinding {
  return {
    code,
    message,
    packageName,
  };
}

export class RecipePackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipePackageError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readJsonFile(path: string): PackageJson {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as PackageJson)
      : {};
  } catch (err) {
    throw new RecipePackageError(
      `Recipe package at ${path} has invalid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseMcpConfig(value: unknown): RecipePackageMcpConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyMcpConfig();

  const data = value as Record<string, unknown>;
  const manifests = stringArray(data.manifests).map(normalizeResourcePath);

  const seen = new Set<string>();
  const servers: RecipePackageMcpServer[] = [];
  for (const raw of Array.isArray(data.servers) ? data.servers : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const server = raw as Record<string, unknown>;
    const id = stringValue(server.id);
    if (!id || seen.has(id)) continue;
    const tools = parseRecipeMcpToolSelection(Object.hasOwn(server, "tools") ? server.tools : {});
    seen.add(id);
    servers.push({
      id,
      required: server.required === true,
      tools,
    });
  }

  return { manifests, servers };
}

function parseChannels(value: unknown): RecipePackageChannel[] {
  const seen = new Set<string>();
  const channels: RecipePackageChannel[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const channel = asRecord(raw);
    const provider = stringValue(channel.provider);
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    channels.push({ provider, ...(Array.isArray(channel.commands) ? { commands: channel.commands as string[] } : {}), ...(typeof channel.requireReply === "boolean" ? { requireReply: channel.requireReply } : {}) });
  }
  return channels;
}

function parseRuntimeRequirements(value: unknown): RecipeRuntimeRequirements {
  const runtime = asRecord(value);
  const python = asRecord(runtime.python);
  const system = asRecord(runtime.system);
  return {
    ...(stringValue(python.project) && stringValue(python.lockfile)
      ? {
          python: {
            project: normalizeResourcePath(stringValue(python.project)!),
            lockfile: normalizeResourcePath(stringValue(python.lockfile)!),
            ...(stringValue(python.version) ? { version: stringValue(python.version) } : {}),
            imports: stringArray(python.imports).map((item) => item.trim()),
          },
        }
      : {}),
    system: {
      packages: (Array.isArray(system.packages) ? system.packages : [])
        .map(asRecord)
        .filter((item) => stringValue(item.id) && stringValue(item.version))
        .map((item) => ({
          id: stringValue(item.id)!,
          version: stringValue(item.version)!,
        })),
    },
  };
}

function packageJsonPath(packageDir: string): string | undefined {
  const packagePath = join(packageDir, "package.json");
  return existsSync(packagePath) ? packagePath : undefined;
}

function piPackageManifestBlock(raw: PackageJson): Record<string, unknown> | undefined {
  return raw.pi && typeof raw.pi === "object" && !Array.isArray(raw.pi)
    ? (raw.pi as Record<string, unknown>)
    : undefined;
}

function piPackageManifestPath(packageDir: string): string | undefined {
  const manifestPath = packageJsonPath(packageDir);
  if (!manifestPath) return undefined;
  const raw = readJsonFile(manifestPath);
  return piPackageManifestBlock(raw) ? manifestPath : undefined;
}

export function readPiPackageManifest(packageDir: string): RecipePackageManifest {
  const packagePath = packageJsonPath(packageDir);
  if (!packagePath) {
    throw new RecipePackageError(
      `Recipe package at ${packageDir} is missing package.json with a pi manifest`
    );
  }

  const raw = readJsonFile(packagePath);
  const pi = piPackageManifestBlock(raw);
  if (!pi) {
    throw new RecipePackageError(
      `Recipe package at ${packageDir} is missing package.json pi manifest`
    );
  }

  const resources = emptyResources();
  for (const key of RESOURCE_KEYS) {
    resources[key] = stringArray(pi[key]).map(normalizeResourcePath);
  }

  const manifest: ParsedRecipePackageManifest = {
    name: stringValue(raw.name) ?? "",
    version: stringValue(raw.version) ?? "0.0.0",
    ...(stringValue(raw.description) ? { description: stringValue(raw.description) } : {}),
    path: packageDir,
    resources,
    resourceDeclarations: resourceDeclarations(pi),
    channels: parseChannels(pi.channels),
    mcp: parseMcpConfig(pi.mcp),
    runtime: parseRuntimeRequirements(pi.runtime),
  };
  Object.defineProperty(manifest, SOURCE_FINDINGS, {
    value: sourceShapeFindings(pi, manifest.name, raw.dependencies),
    enumerable: false,
  });
  return manifest;
}

export function resolvePiPackageMcpManifestPaths(pkg: RecipePackageManifest): string[] {
  const globs = pkg.mcp.manifests;
  const resolved: string[] = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    resolved.push(path);
  };
  const entries = listPackageEntries(pkg.path, globs);

  for (const glob of globs) {
    if (!glob.trim()) continue;
    if (isAbsolute(glob) || hasTraversalSegment(glob)) {
      throw new RecipePackageError(
        `Recipe ${pkg.name} declares mcp manifest outside the package: ${glob}`
      );
    }
    const target = resolve(pkg.path, glob);
    const relativePath = relative(resolve(pkg.path), target);
    if (
      relativePath === ".." ||
      relativePath.startsWith("../") ||
      relativePath.startsWith("..\\") ||
      isAbsolute(relativePath)
    ) {
      throw new RecipePackageError(
        `Recipe ${pkg.name} declares mcp manifest outside the package: ${glob}`
      );
    }
    if (!hasGlob(glob)) {
      if (!existsSync(target)) {
        throw new RecipePackageError(`Recipe ${pkg.name} declares missing mcp manifest: ${glob}`);
      }
      assertResourceTreeContained(pkg.path, target, "mcp manifest");
      add(target);
      continue;
    }

    const matcher = globToRegExp(glob);
    const matches = entries
      .filter((entry) => matcher.test(normalizeResourcePath(entry)))
      .map((entry) => resolve(pkg.path, entry));
    if (matches.length === 0) {
      throw new RecipePackageError(
        `Recipe ${pkg.name} declares mcp manifest glob with no matches: ${glob}`
      );
    }
    for (const match of matches.sort()) {
      assertResourceTreeContained(pkg.path, match, "mcp manifest");
      add(match);
    }
  }

  return resolved;
}

export function resolvePiPackageResourcePaths(
  pkg: RecipePackageManifest,
  key: keyof RecipePackageResources
): string[] {
  const globs = pkg.resources[key];
  const resolved: string[] = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    resolved.push(path);
  };
  const entries = listPackageEntries(pkg.path, globs);

  for (const glob of globs) {
    if (!glob.trim()) continue;
    assertPackageResourcePath(pkg, key, glob, resolve(pkg.path, glob));
    if (!hasGlob(glob)) {
      const direct = resolve(pkg.path, glob);
      if (!existsSync(direct)) {
        throw new RecipePackageError(
          `Recipe ${pkg.name} declares missing ${key} resource: ${glob}`
        );
      }
      assertResourceTreeContained(pkg.path, direct, `${key} resource`);
      add(direct);
      continue;
    }

    const matcher = globToRegExp(glob);
    const matches = entries
      .filter((entry) => matcher.test(normalizeResourcePath(entry)))
      .map((entry) => resolve(pkg.path, entry));
    if (matches.length === 0) {
      throw new RecipePackageError(
        `Recipe ${pkg.name} declares ${key} glob with no matches: ${glob}`
      );
    }
    for (const match of matches.sort()) {
      assertResourceTreeContained(pkg.path, match, `${key} resource`);
      add(match);
    }
  }

  return resolved;
}

export function defaultPiPackageResourcePaths(
  pkg: RecipePackageManifest,
  key: keyof RecipePackageResources
): string[] {
  const defaults: Partial<Record<keyof RecipePackageResources, string[]>> = {
    agents: [join(pkg.path, "agents")],
    skills: [join(pkg.path, "skills")],
    prompts: [join(pkg.path, "prompts")],
  };
  return (defaults[key] ?? []).filter((path) => existsSync(path));
}

export function packageResourcePaths(
  pkg: RecipePackageManifest,
  key: keyof RecipePackageResources
): string[] {
  if (pkg.resourceDeclarations?.[key] || pkg.resources[key].length > 0) {
    return resolvePiPackageResourcePaths(pkg, key);
  }
  return defaultPiPackageResourcePaths(pkg, key);
}

export function validatePiPackageManifest(pkg: RecipePackageManifest): RecipeValidationReport {
  const findings: RecipeValidationFinding[] = [
    ...((pkg as ParsedRecipePackageManifest)[SOURCE_FINDINGS] ?? []),
  ];
  if (!pkg.name.trim()) {
    findings.push(finding("package.name_missing", "Package is missing name"));
  }
  if (!piPackageManifestPath(pkg.path)) {
    findings.push(
      finding(
        "package.manifest_missing",
        "Package is missing package.json with a pi manifest",
        pkg.name
      )
    );
  }
  if (
    !pkg.resourceDeclarations?.agents &&
    pkg.resources.agents.length === 0 &&
    !existsSync(join(pkg.path, "agents"))
  ) {
    findings.push(
      finding(
        "package.no_agents",
        "Package declares no agents and has no agents directory",
        pkg.name
      )
    );
  }
  const invalidMcpServer = pkg.mcp.servers.find(
    (server) => !isValidRecipeMcpToolSelection(server.tools)
  );
  if (invalidMcpServer) {
    findings.push(
      finding(
        "pi.mcp_invalid",
        `MCP server "${invalidMcpServer.id}" has an invalid tool policy`,
        pkg.name
      )
    );
  }
  if (pkg.runtime?.python) {
    for (const [key, authored, expected] of [
      ["project", pkg.runtime.python.project, "directory"],
      ["lockfile", pkg.runtime.python.lockfile, "file"],
    ] as const) {
      const target = resolve(pkg.path, authored);
      const rel = relative(resolve(pkg.path), target);
      const outside =
        isAbsolute(authored) ||
        hasTraversalSegment(authored) ||
        rel === ".." ||
        rel.startsWith(`..${sep}`) ||
        isAbsolute(rel);
      const exists =
        existsSync(target) &&
        (expected === "directory" ? statSync(target).isDirectory() : statSync(target).isFile());
      if (outside || !exists) {
        findings.push(
          finding(
            "pi.runtime_path_invalid",
            `package.json#pi.runtime.python.${key} must resolve to a ${expected} inside the Recipe`,
            pkg.name
          )
        );
      }
    }
  }
  return {
    valid: findings.length === 0,
    findings,
  };
}
