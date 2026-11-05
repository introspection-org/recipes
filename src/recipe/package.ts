import {
  existsSync,
  realpathSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { minimatch } from "minimatch";

import {
  documentProfileShapeProblem,
  isDocumentProfilePath,
  recipeProfileSkill,
} from "../documents/profile.js";
import { isCompanionPackage, isHostPeerPackage } from "./companions.js";

export interface RecipePackageResources {
  agents: string[];
  extensions: string[];
  skills: string[];
  prompts: string[];
}

interface RecipePackageMcpServer {
  id: string;
  required: boolean;
  /**
   * `"defer"` lets a host that boots a session only to prepare it start
   * without this required server's catalog. Absent means `"require"`.
   */
  discovery?: "defer";
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
export function parseRecipeMcpToolSelection(
  value: unknown,
): RecipeMcpToolSelection {
  const validObject =
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const data = asRecord(value);
  const selection: ParsedRecipeMcpToolSelection = {
    ...(Object.hasOwn(data, "include")
      ? { include: stringArray(data.include) }
      : {}),
    ...(Object.hasOwn(data, "exclude")
      ? { exclude: stringArray(data.exclude) }
      : {}),
  };
  const malformedArray = ["include", "exclude"].some(
    (key) =>
      Object.hasOwn(data, key) &&
      (!Array.isArray(data[key]) ||
        data[key].some((item) => typeof item !== "string")),
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
export function isValidRecipeMcpToolSelection(
  selection: RecipeMcpToolSelection,
): boolean {
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

/** A document format the Recipe's `documents` tool opens, such as `docx` or `pdf`. */
export interface RecipePackageDocument {
  format: string;
  commands?: string[];
  /** A profile the format ships, by name, or a relative path to a profile folder in the Recipe. */
  profile?: string;
}

/**
 * Why a `pi.documents[].profile` value is invalid, or undefined when it is
 * valid. A name is checked against the format's profiles when the Recipe
 * loads; a path is checked here too when the Recipe folder is known.
 */
function documentProfileProblem(
  profile: unknown,
  packageDir?: string,
): string | undefined {
  const shape = documentProfileShapeProblem(profile);
  if (
    shape ||
    packageDir === undefined ||
    !isDocumentProfilePath(profile as string)
  )
    return shape;
  try {
    recipeProfileSkill(profile as string, packageDir);
    return undefined;
  } catch (error) {
    return (error as Error).message.replace(/^Document profile /, "");
  }
}

export function recipeDocumentPackageName(format: string): string {
  return `@introspection-ai/recipe-documents-${format}`;
}

export interface RecipePythonRuntimeRequirement {
  project: string;
  lockfile: string;
  version?: string;
  imports: string[];
}

interface RecipeRuntimeRequirements {
  python?: RecipePythonRuntimeRequirement;
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
  documents?: RecipePackageDocument[];
  mcp: RecipePackageMcpConfig;
  runtime?: RecipeRuntimeRequirements;
}

export type PiPackageManifest = RecipePackageManifest;

export interface RecipeValidationFinding {
  code: string;
  message: string;
  packageName?: string;
  /** Absent for an error. A warning never makes a report invalid. */
  severity?: "warning";
}

/** The findings that make a report invalid: every finding but warnings. */
export function recipeValidationErrors(
  findings: readonly RecipeValidationFinding[],
): RecipeValidationFinding[] {
  return findings.filter((item) => item.severity !== "warning");
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
  peerDependencies?: unknown;
  files?: unknown;
  pi?: unknown;
};

const RESOURCE_KEYS: Array<keyof RecipePackageResources> = [
  "agents",
  "extensions",
  "skills",
  "prompts",
];

// `evals` declares where a Recipe's eval suites live. The runtime never loads
// evals, so it accepts the key without reading it; recipe-check validates it.
const PI_KEYS = new Set([
  ...RESOURCE_KEYS,
  "channels",
  "documents",
  "evals",
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
  pi: Record<string, unknown>,
): Record<keyof RecipePackageResources, boolean> {
  return Object.fromEntries(
    RESOURCE_KEYS.map((key) => [key, Object.hasOwn(pi, key)]),
  ) as Record<keyof RecipePackageResources, boolean>;
}

/** The package's dependency blocks, as written. */
interface DeclaredDependencies {
  dependencies: unknown;
  peerDependencies: unknown;
}

function versioned(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Why a `pi.channels` or `pi.documents` declaration's package (`packageName`)
 * is declared wrongly, or undefined when it is fine. Listed in `dependencies`
 * with a version, the Recipe brings and pins it; listed in `peerDependencies`,
 * the platform provides it (see `peerFindings`). Omitted entirely, only a host
 * default is supplied; every other package must be declared.
 */
function declarationPackageProblem(
  declarationName: string,
  packageName: string,
  declared: DeclaredDependencies,
): string | undefined {
  const dependencies = asRecord(declared.dependencies);
  const required = `${declarationName} requires dependency '${packageName}'`;
  if (Object.hasOwn(dependencies, packageName)) {
    return versioned(dependencies[packageName]) ? undefined : required;
  }
  if (Object.hasOwn(asRecord(declared.peerDependencies), packageName))
    return undefined;
  return isCompanionPackage(packageName) ? undefined : required;
}

/**
 * A peer means the platform running the Recipe provides it: the managed
 * install never installs peers. Each needs a version range; one that is
 * neither a package the host imports (Recipes' own peers) nor a companion package
 * is a warning, since a standard platform does not provide it.
 */
function peerFindings(
  declared: DeclaredDependencies,
  packageName: string,
): RecipeValidationFinding[] {
  const findings: RecipeValidationFinding[] = [];
  for (const [name, version] of Object.entries(
    asRecord(declared.peerDependencies),
  )) {
    if (!versioned(version)) {
      findings.push(
        finding(
          "package.peer_version_missing",
          `package.json#peerDependencies '${name}' needs a version range`,
          packageName,
        ),
      );
    } else if (!isHostPeerPackage(name) && !isCompanionPackage(name)) {
      findings.push({
        ...finding(
          "package.peer_not_provided_by_default",
          `package.json#peerDependencies '${name}' is not provided by a standard platform: the platform running the Recipe must provide it, or the runtime image build fails. Add it to dependencies to bring it with the Recipe`,
          packageName,
        ),
        severity: "warning",
      });
    }
  }
  return findings;
}

function sourceShapeFindings(
  pi: Record<string, unknown>,
  packageName: string,
  dependencies: DeclaredDependencies,
  packageDir?: string,
): RecipeValidationFinding[] {
  const findings: RecipeValidationFinding[] = [];
  for (const key of Object.keys(pi)) {
    if (!PI_KEYS.has(key as keyof RecipePackageResources | "mcp")) {
      findings.push(
        finding(
          "pi.unknown_key",
          `package.json#pi contains unknown key '${key}'`,
          packageName,
        ),
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
          packageName,
        ),
      );
    } else if (
      new Set(value.map((item) => String(item).trim())).size !== value.length
    ) {
      findings.push(
        finding(
          `pi.${key}_duplicate`,
          `package.json#pi.${key} must not contain duplicate entries`,
          packageName,
        ),
      );
    }
  }
  findings.push(
    ...channelSourceShapeFindings(pi.channels, packageName, dependencies),
  );
  findings.push(
    ...documentSourceShapeFindings(
      pi.documents,
      packageName,
      dependencies,
      packageDir,
    ),
  );
  findings.push(...mcpSourceShapeFindings(pi.mcp, packageName));
  findings.push(...runtimeSourceShapeFindings(pi.runtime, packageName));
  findings.push(...peerFindings(dependencies, packageName));
  return findings;
}

function channelSourceShapeFindings(
  value: unknown,
  packageName: string,
  dependencies: DeclaredDependencies,
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
        invalid(`package.json#pi.channels[${index}] must be an object`),
      );
      continue;
    }
    const connector = raw as Record<string, unknown>;
    const unknown = Object.keys(connector).filter(
      (key) => !["provider", "commands", "requireReply"].includes(key),
    );
    if (
      connector.requireReply !== undefined &&
      typeof connector.requireReply !== "boolean"
    ) {
      findings.push(
        invalid(
          `package.json#pi.channels[${index}].requireReply must be a boolean`,
        ),
      );
    }
    if (
      connector.commands !== undefined &&
      (!Array.isArray(connector.commands) ||
        connector.commands.some(
          (command) => typeof command !== "string" || !command.trim(),
        ) ||
        new Set(connector.commands).size !== connector.commands.length)
    ) {
      findings.push(
        invalid(
          `package.json#pi.channels[${index}].commands must be an array of unique non-empty strings`,
        ),
      );
    }
    if (unknown.length > 0) {
      findings.push(
        invalid(
          `package.json#pi.channels[${index}] contains unknown field(s): ${unknown.join(", ")}`,
        ),
      );
    }

    const provider =
      typeof connector.provider === "string" && connector.provider.trim()
        ? connector.provider.trim()
        : undefined;
    if (!provider) {
      findings.push(
        invalid(
          `package.json#pi.channels[${index}].provider must be non-empty`,
        ),
      );
    } else if (providers.has(provider)) {
      findings.push(
        invalid(
          `package.json#pi.channels contains duplicate provider '${provider}'`,
        ),
      );
    } else {
      providers.add(provider);
    }

    if (provider) {
      const problem = declarationPackageProblem(
        `package.json#pi.channels provider '${provider}'`,
        recipeChannelPackageName(provider),
        dependencies,
      );
      if (problem) findings.push(invalid(problem));
    }
  }
  return findings;
}

function documentSourceShapeFindings(
  value: unknown,
  packageName: string,
  dependencies: DeclaredDependencies,
  packageDir?: string,
): RecipeValidationFinding[] {
  if (value === undefined) return [];
  const invalid = (message: string) =>
    finding("pi.documents_invalid", message, packageName);
  if (!Array.isArray(value)) {
    return [invalid("package.json#pi.documents must be an array")];
  }
  const findings: RecipeValidationFinding[] = [];
  const formats = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      findings.push(
        invalid(`package.json#pi.documents[${index}] must be an object`),
      );
      continue;
    }
    const declaration = raw as Record<string, unknown>;
    const unknown = Object.keys(declaration).filter(
      (key) => !["format", "commands", "profile"].includes(key),
    );
    if (unknown.length > 0) {
      findings.push(
        invalid(
          `package.json#pi.documents[${index}] contains unknown field(s): ${unknown.join(", ")}`,
        ),
      );
    }
    if (
      declaration.commands !== undefined &&
      (!Array.isArray(declaration.commands) ||
        declaration.commands.some(
          (command) => typeof command !== "string" || !command.trim(),
        ) ||
        new Set(declaration.commands).size !== declaration.commands.length)
    ) {
      findings.push(
        invalid(
          `package.json#pi.documents[${index}].commands must be an array of unique non-empty strings`,
        ),
      );
    }
    const profileProblem =
      declaration.profile === undefined
        ? undefined
        : documentProfileProblem(declaration.profile, packageDir);
    if (profileProblem)
      findings.push(
        invalid(
          `package.json#pi.documents[${index}].profile ${profileProblem}`,
        ),
      );
    const format =
      typeof declaration.format === "string" && declaration.format.trim()
        ? declaration.format.trim()
        : undefined;
    if (!format) {
      findings.push(
        invalid(`package.json#pi.documents[${index}].format must be non-empty`),
      );
      continue;
    }
    if (formats.has(format)) {
      findings.push(
        invalid(
          `package.json#pi.documents contains duplicate format '${format}'`,
        ),
      );
      continue;
    }
    formats.add(format);
    const problem = declarationPackageProblem(
      `package.json#pi.documents format '${format}'`,
      recipeDocumentPackageName(format),
      dependencies,
    );
    if (problem) findings.push(invalid(problem));
  }
  return findings;
}

const PYTHON_MODULE_NAME =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Whether `value` is a dotted Python module name such as `docx` or `paper_docx.api`. */
export function isPythonModuleName(value: string): boolean {
  return PYTHON_MODULE_NAME.test(value);
}

function runtimeSourceShapeFindings(
  value: unknown,
  packageName: string,
): RecipeValidationFinding[] {
  if (value === undefined) return [];
  const invalid = (message: string) =>
    finding("pi.runtime_invalid", message, packageName);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [invalid("package.json#pi.runtime must be an object")];
  }
  const runtime = value as Record<string, unknown>;
  const findings: RecipeValidationFinding[] = [];
  for (const key of Object.keys(runtime)) {
    if (key !== "python") {
      findings.push(
        invalid(`package.json#pi.runtime contains unknown field '${key}'`),
      );
    }
  }
  if (runtime.python !== undefined) {
    if (
      !runtime.python ||
      typeof runtime.python !== "object" ||
      Array.isArray(runtime.python)
    ) {
      findings.push(
        invalid("package.json#pi.runtime.python must be an object"),
      );
    } else {
      const python = runtime.python as Record<string, unknown>;
      for (const key of Object.keys(python)) {
        if (!["project", "lockfile", "version", "imports"].includes(key)) {
          findings.push(
            invalid(
              `package.json#pi.runtime.python contains unknown field '${key}'`,
            ),
          );
        }
      }
      for (const key of ["project", "lockfile"]) {
        if (typeof python[key] !== "string" || !python[key].trim()) {
          findings.push(
            invalid(
              `package.json#pi.runtime.python.${key} must be a non-empty relative path`,
            ),
          );
        }
      }
      if (
        python.version !== undefined &&
        (typeof python.version !== "string" || !python.version.trim())
      ) {
        findings.push(
          invalid(
            "package.json#pi.runtime.python.version must be a non-empty string",
          ),
        );
      }
      if (
        python.imports !== undefined &&
        (!Array.isArray(python.imports) ||
          python.imports.some(
            (item) => typeof item !== "string" || !item.trim(),
          ))
      ) {
        findings.push(
          invalid(
            "package.json#pi.runtime.python.imports must be an array of non-empty module names",
          ),
        );
      } else if (Array.isArray(python.imports)) {
        for (const item of python.imports as string[]) {
          if (!isPythonModuleName(item.trim())) {
            findings.push(
              invalid(
                `package.json#pi.runtime.python.imports entry '${item}' must be a dotted Python module name`,
              ),
            );
          }
        }
      }
    }
  }
  return findings;
}

function mcpSourceShapeFindings(
  value: unknown,
  packageName: string,
): RecipeValidationFinding[] {
  if (value === undefined) return [];
  const invalid = (message: string) =>
    finding("pi.mcp_invalid", message, packageName);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [invalid("package.json#pi.mcp must be an object")];
  }
  const data = value as Record<string, unknown>;
  const findings: RecipeValidationFinding[] = [];
  const unknown = Object.keys(data).filter(
    (key) => !["manifests", "servers"].includes(key),
  );
  if (unknown.length > 0) {
    findings.push(
      invalid(
        `package.json#pi.mcp contains unknown field(s): ${unknown.join(", ")}`,
      ),
    );
  }
  const manifests = Array.isArray(data.manifests) ? data.manifests : [];
  if (
    Object.hasOwn(data, "manifests") &&
    (!Array.isArray(data.manifests) ||
      data.manifests.some((item) => typeof item !== "string" || !item.trim()))
  ) {
    findings.push(
      invalid("package.json#pi.mcp manifests must be non-empty strings"),
    );
  }
  if (
    manifests.every((item): item is string => typeof item === "string") &&
    new Set(manifests.map((item) => item.trim())).size !== manifests.length
  ) {
    findings.push(
      invalid("package.json#pi.mcp manifests must not contain duplicates"),
    );
  }
  if (Object.hasOwn(data, "servers") && !Array.isArray(data.servers)) {
    findings.push(invalid("package.json#pi.mcp.servers must be an array"));
    return findings;
  }
  const ids = new Set<string>();
  const normalizedIds = new Set<string>();
  for (const [index, raw] of (Array.isArray(data.servers)
    ? data.servers
    : []
  ).entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      findings.push(
        invalid(`package.json#pi.mcp.servers[${index}] must be an object`),
      );
      continue;
    }
    const server = raw as Record<string, unknown>;
    const serverUnknown = Object.keys(server).filter(
      (key) => !["id", "required", "discovery", "tools"].includes(key),
    );
    if (serverUnknown.length > 0) {
      findings.push(
        invalid(
          `package.json#pi.mcp.servers[${index}] contains unknown field(s): ${serverUnknown.join(", ")}`,
        ),
      );
    }
    const id =
      typeof server.id === "string" && server.id.trim()
        ? server.id.trim()
        : undefined;
    if (!id) {
      findings.push(
        invalid(`package.json#pi.mcp.servers[${index}].id must be non-empty`),
      );
    } else if (ids.has(id)) {
      findings.push(
        invalid(`package.json#pi.mcp contains duplicate server id '${id}'`),
      );
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
          invalid(
            `package.json#pi.mcp server id '${id}' collides after normalization`,
          ),
        );
      }
      normalizedIds.add(normalized);
    }
    if (
      Object.hasOwn(server, "required") &&
      typeof server.required !== "boolean"
    ) {
      findings.push(
        invalid(
          `package.json#pi.mcp.servers[${index}].required must be boolean`,
        ),
      );
    }
    if (
      Object.hasOwn(server, "discovery") &&
      server.discovery !== "require" &&
      server.discovery !== "defer"
    ) {
      findings.push(
        invalid(
          `package.json#pi.mcp.servers[${index}].discovery must be "require" or "defer"`,
        ),
      );
    }
    if (Object.hasOwn(server, "tools")) {
      if (
        !server.tools ||
        typeof server.tools !== "object" ||
        Array.isArray(server.tools)
      ) {
        findings.push(
          invalid(
            `package.json#pi.mcp.servers[${index}].tools must be an object`,
          ),
        );
      } else {
        const tools = server.tools as Record<string, unknown>;
        const toolsUnknown = Object.keys(tools).filter(
          (key) => !["include", "exclude"].includes(key),
        );
        if (toolsUnknown.length > 0) {
          findings.push(
            invalid(
              `package.json#pi.mcp.servers[${index}].tools contains unknown field(s): ${toolsUnknown.join(", ")}`,
            ),
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
  resolved: string,
  owner = `Recipe ${pkg.name}`,
): void {
  if (isAbsolute(resource) || hasTraversalSegment(resource)) {
    throw new RecipePackageError(
      `${owner} declares ${key} resource outside the package: ${resource}`,
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
      `${owner} declares ${key} resource outside the package: ${resource}`,
    );
  }
}

/**
 * Throw unless `path`'s real path is inside `packageDir`'s real path. `owner`
 * starts the message; a dependency package passes `Dependency <name>`.
 */
export function assertRecipePathContained(
  packageDir: string,
  path: string,
  label: string,
  owner = "Recipe",
): void {
  const root = realpathSync(packageDir);
  const target = realpathSync(path);
  const relativePath = relative(root, target);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new RecipePackageError(
      `${owner} ${label} resolves outside the package: ${path}`,
    );
  }
}

function assertResourceTreeContained(
  packageDir: string,
  path: string,
  label: string,
  owner = "Recipe",
  seen = new Set<string>(),
): void {
  assertRecipePathContained(packageDir, path, label, owner);
  const realPath = realpathSync(path);
  if (seen.has(realPath)) return;
  seen.add(realPath);
  if (!statSync(path).isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    assertRecipePathContained(packageDir, child, label, owner);
    if (statSync(child).isDirectory()) {
      assertResourceTreeContained(packageDir, child, label, owner, seen);
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
      throw new RecipePackageError(
        `Recipe resource glob resolves outside the package: ${glob}`,
      );
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
      const relative = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
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

function finding(
  code: string,
  message: string,
  packageName?: string,
): RecipeValidationFinding {
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
      }`,
    );
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseMcpConfig(value: unknown): RecipePackageMcpConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return emptyMcpConfig();

  const data = value as Record<string, unknown>;
  const manifests = stringArray(data.manifests).map(normalizeResourcePath);

  const seen = new Set<string>();
  const servers: RecipePackageMcpServer[] = [];
  for (const raw of Array.isArray(data.servers) ? data.servers : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const server = raw as Record<string, unknown>;
    const id = stringValue(server.id);
    if (!id || seen.has(id)) continue;
    const tools = parseRecipeMcpToolSelection(
      Object.hasOwn(server, "tools") ? server.tools : {},
    );
    seen.add(id);
    servers.push({
      id,
      required: server.required === true,
      ...(server.discovery === "defer" ? { discovery: "defer" as const } : {}),
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
    channels.push({
      provider,
      ...(Array.isArray(channel.commands)
        ? { commands: channel.commands as string[] }
        : {}),
      ...(typeof channel.requireReply === "boolean"
        ? { requireReply: channel.requireReply }
        : {}),
    });
  }
  return channels;
}

function parseDocuments(value: unknown): RecipePackageDocument[] {
  const seen = new Set<string>();
  const documents: RecipePackageDocument[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const declaration = asRecord(raw);
    const format = stringValue(declaration.format);
    if (!format || seen.has(format)) continue;
    seen.add(format);
    documents.push({
      format,
      ...(Array.isArray(declaration.commands)
        ? { commands: declaration.commands as string[] }
        : {}),
      ...(typeof declaration.profile === "string"
        ? { profile: declaration.profile }
        : {}),
    });
  }
  return documents;
}

function parseRuntimeRequirements(value: unknown): RecipeRuntimeRequirements {
  const runtime = asRecord(value);
  const python = asRecord(runtime.python);
  return {
    ...(stringValue(python.project) && stringValue(python.lockfile)
      ? {
          python: {
            project: normalizeResourcePath(stringValue(python.project)!),
            lockfile: normalizeResourcePath(stringValue(python.lockfile)!),
            ...(stringValue(python.version)
              ? { version: stringValue(python.version) }
              : {}),
            imports: stringArray(python.imports).map((item) => item.trim()),
          },
        }
      : {}),
  };
}

function packageJsonPath(packageDir: string): string | undefined {
  const packagePath = join(packageDir, "package.json");
  return existsSync(packagePath) ? packagePath : undefined;
}

function piPackageManifestBlock(
  raw: PackageJson,
): Record<string, unknown> | undefined {
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

export function readPiPackageManifest(
  packageDir: string,
): RecipePackageManifest {
  const packagePath = packageJsonPath(packageDir);
  if (!packagePath) {
    throw new RecipePackageError(
      `Recipe package at ${packageDir} is missing package.json with a pi manifest`,
    );
  }

  const raw = readJsonFile(packagePath);
  const pi = piPackageManifestBlock(raw);
  if (!pi) {
    throw new RecipePackageError(
      `Recipe package at ${packageDir} is missing package.json pi manifest`,
    );
  }

  const resources = emptyResources();
  for (const key of RESOURCE_KEYS) {
    resources[key] = stringArray(pi[key]).map(normalizeResourcePath);
  }

  const manifest: ParsedRecipePackageManifest = {
    name: stringValue(raw.name) ?? "",
    version: stringValue(raw.version) ?? "0.0.0",
    ...(stringValue(raw.description)
      ? { description: stringValue(raw.description) }
      : {}),
    path: packageDir,
    resources,
    resourceDeclarations: resourceDeclarations(pi),
    channels: parseChannels(pi.channels),
    documents: parseDocuments(pi.documents),
    mcp: parseMcpConfig(pi.mcp),
    runtime: parseRuntimeRequirements(pi.runtime),
  };
  Object.defineProperty(manifest, SOURCE_FINDINGS, {
    value: sourceShapeFindings(
      pi,
      manifest.name,
      {
        dependencies: raw.dependencies,
        peerDependencies: raw.peerDependencies,
      },
      packageDir,
    ),
    enumerable: false,
  });
  return manifest;
}

export function resolvePiPackageMcpManifestPaths(
  pkg: RecipePackageManifest,
): string[] {
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
        `Recipe ${pkg.name} declares mcp manifest outside the package: ${glob}`,
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
        `Recipe ${pkg.name} declares mcp manifest outside the package: ${glob}`,
      );
    }
    if (!hasGlob(glob)) {
      if (!existsSync(target)) {
        throw new RecipePackageError(
          `Recipe ${pkg.name} declares missing mcp manifest: ${glob}`,
        );
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
        `Recipe ${pkg.name} declares mcp manifest glob with no matches: ${glob}`,
      );
    }
    for (const match of matches.sort()) {
      assertResourceTreeContained(pkg.path, match, "mcp manifest");
      add(match);
    }
  }

  return resolved;
}

/**
 * Resolve a package's declared resources of one kind. `owner` names the
 * package in errors: the Recipe by default, `Dependency <name>` for a
 * dependency package.
 */
function resolvePiPackageResourcePaths(
  pkg: RecipePackageManifest,
  key: keyof RecipePackageResources,
  owner?: string,
): string[] {
  const declarer = owner ?? `Recipe ${pkg.name}`;
  const container = owner ?? "Recipe";
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
    assertPackageResourcePath(
      pkg,
      key,
      glob,
      resolve(pkg.path, glob),
      declarer,
    );
    if (!hasGlob(glob)) {
      const direct = resolve(pkg.path, glob);
      if (!existsSync(direct)) {
        throw new RecipePackageError(
          `${declarer} declares missing ${key} resource: ${glob}`,
        );
      }
      assertResourceTreeContained(
        pkg.path,
        direct,
        `${key} resource`,
        container,
      );
      add(direct);
      continue;
    }

    const matcher = globToRegExp(glob);
    const matches = entries
      .filter((entry) => matcher.test(normalizeResourcePath(entry)))
      .map((entry) => resolve(pkg.path, entry));
    if (matches.length === 0) {
      throw new RecipePackageError(
        `${declarer} declares ${key} glob with no matches: ${glob}`,
      );
    }
    for (const match of matches.sort()) {
      assertResourceTreeContained(
        pkg.path,
        match,
        `${key} resource`,
        container,
      );
      add(match);
    }
  }

  return resolved;
}

function defaultPiPackageResourcePaths(
  pkg: RecipePackageManifest,
  key: keyof RecipePackageResources,
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
  key: keyof RecipePackageResources,
): string[] {
  if (pkg.resourceDeclarations?.[key] || pkg.resources[key].length > 0) {
    return resolvePiPackageResourcePaths(pkg, key);
  }
  return defaultPiPackageResourcePaths(pkg, key);
}

export function validatePiPackageManifest(
  pkg: RecipePackageManifest,
): RecipeValidationReport {
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
        pkg.name,
      ),
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
        pkg.name,
      ),
    );
  }
  const invalidMcpServer = pkg.mcp.servers.find(
    (server) => !isValidRecipeMcpToolSelection(server.tools),
  );
  if (invalidMcpServer) {
    findings.push(
      finding(
        "pi.mcp_invalid",
        `MCP server "${invalidMcpServer.id}" has an invalid tool policy`,
        pkg.name,
      ),
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
        (expected === "directory"
          ? statSync(target).isDirectory()
          : statSync(target).isFile());
      if (outside || !exists) {
        findings.push(
          finding(
            "pi.runtime_path_invalid",
            `package.json#pi.runtime.python.${key} must resolve to a ${expected} inside the Recipe`,
            pkg.name,
          ),
        );
      }
    }
  }
  return {
    valid: recipeValidationErrors(findings).length === 0,
    findings,
  };
}

/** Whether npm's `files` list ships `path` (a package-relative POSIX path). */
function packageFilesInclude(files: readonly unknown[], path: string): boolean {
  let included = false;
  for (const raw of files) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const negated = raw.startsWith("!");
    const entry = normalizeResourcePath(negated ? raw.slice(1) : raw).replace(
      /\/+$/,
      "",
    );
    // npm reads `files` with minimatch, so braces and classes expand here too.
    const matches = (candidate: string) =>
      minimatch(candidate, entry, { dot: true });
    const segments = path.split("/");
    // An entry naming a directory ships everything beneath it.
    const hit = segments.some((_, index) =>
      matches(segments.slice(0, index + 1).join("/")),
    );
    if (hit) included = !negated;
  }
  return included;
}

/**
 * Validate the `pi.runtime.python` a dependency package (not the Recipe)
 * declares: the same shape a Recipe's takes, a project directory holding
 * `pyproject.toml` and its `uv.lock` inside the package, and, when the package
 * lists `files`, both files shipped in it. Returns no requirement when the
 * package declares none.
 */
export function validateRecipePythonPackage(
  packageDir: string,
): RecipeValidationReport & {
  name: string;
  python?: RecipePythonRuntimeRequirement;
} {
  const packagePath = packageJsonPath(packageDir);
  if (!packagePath) {
    throw new RecipePackageError(
      `Package at ${packageDir} is missing package.json`,
    );
  }
  const raw = readJsonFile(packagePath);
  const name = stringValue(raw.name) ?? packageDir;
  const pi = piPackageManifestBlock(raw);
  const runtime = pi ? asRecord(pi.runtime) : {};
  if (runtime.python === undefined) return { valid: true, findings: [], name };
  const findings = runtimeSourceShapeFindings({ python: runtime.python }, name);
  const python = parseRuntimeRequirements({ python: runtime.python }).python;
  if (findings.length === 0 && python) {
    const invalidPath = (message: string) =>
      findings.push(finding("pi.runtime_path_invalid", message, name));
    const contained = (authored: string) => {
      const rel = relative(resolve(packageDir), resolve(packageDir, authored));
      return !(
        isAbsolute(authored) ||
        hasTraversalSegment(authored) ||
        rel === ".." ||
        rel.startsWith(`..${sep}`) ||
        isAbsolute(rel)
      );
    };
    const projectDir = resolve(packageDir, python.project);
    const pyproject = `${python.project}/pyproject.toml`.replace(/^\.\//, "");
    if (
      !contained(python.project) ||
      !existsSync(projectDir) ||
      !statSync(projectDir).isDirectory()
    ) {
      invalidPath(
        `package.json#pi.runtime.python.project must resolve to a directory inside the package`,
      );
    } else if (!existsSync(join(projectDir, "pyproject.toml"))) {
      invalidPath(
        `package.json#pi.runtime.python.project has no pyproject.toml: ${python.project}`,
      );
    }
    const lockfile = resolve(packageDir, python.lockfile);
    if (
      !contained(python.lockfile) ||
      !existsSync(lockfile) ||
      !statSync(lockfile).isFile()
    ) {
      invalidPath(
        `package.json#pi.runtime.python.lockfile must resolve to a file inside the package`,
      );
    } else if (lockfile !== join(projectDir, "uv.lock")) {
      invalidPath(
        `package.json#pi.runtime.python.lockfile must be the project's uv.lock: ${python.lockfile}`,
      );
    }
    if (Array.isArray(raw.files)) {
      for (const shipped of [
        pyproject,
        normalizeResourcePath(python.lockfile),
      ]) {
        if (!packageFilesInclude(raw.files, shipped)) {
          findings.push(
            finding(
              "pi.runtime_files_missing",
              `package.json#files must ship ${shipped}, which pi.runtime.python needs`,
              name,
            ),
          );
        }
      }
    }
  }
  return {
    valid: findings.length === 0,
    findings,
    name,
    ...(python ? { python } : {}),
  };
}

/** A direct dependency of the Recipe, as Node resolves it from the Recipe directory. */
export interface InstalledRecipeDependency {
  /** The name the Recipe's `package.json` declares it under. */
  name: string;
  /** The real path of the installed package (pnpm links into `.pnpm`). */
  packageDir: string;
}

/**
 * The directory of `name` as Node resolves it from `recipeDir`: the first
 * `node_modules/<name>/package.json` walking up from the Recipe's real path,
 * so a dependency hoisted beside the Recipe (npm, npx, `npm install --prefix`)
 * is found as well as one nested inside it or linked by pnpm. A package with
 * no entry point (a skills-only package) still resolves, because this reads
 * Node's lookup folders rather than resolving an entry. Falls back to
 * `findPackageJSON` for anything only Node's resolver can see.
 */
export function resolveDependencyDir(
  recipeDir: string,
  name: string,
): string | undefined {
  const realDir = realpathSync(recipeDir);
  const base = join(realDir, "package.json");
  // Only the `node_modules` folders of the directory and its ancestors: not
  // NODE_PATH or the global folders, which hold nothing the Recipe installed.
  const lookupFolders = (createRequire(base).resolve.paths(name) ?? []).filter(
    (folder) => {
      if (basename(folder) !== "node_modules") return false;
      const owner = relative(dirname(folder), realDir);
      return (
        owner !== ".." && !owner.startsWith(`..${sep}`) && !isAbsolute(owner)
      );
    },
  );
  for (const folder of lookupFolders) {
    const candidate = join(folder, ...name.split("/"));
    if (existsSync(join(candidate, "package.json")))
      return realpathSync(candidate);
  }
  try {
    const found = findPackageJSON(name, base);
    return found ? realpathSync(dirname(found)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Recipe's direct dependencies that are installed, in declaration order,
 * from the `package.json` blocks named by `keys`, each found with Node's
 * resolution from the Recipe directory. Transitive dependencies are never
 * read, and a declared dependency that does not resolve is skipped.
 */
export function installedRecipeDependencies(
  recipeDir: string,
  keys: readonly ("dependencies" | "peerDependencies")[],
): InstalledRecipeDependency[] {
  const root = resolve(recipeDir);
  const packagePath = packageJsonPath(root);
  if (!packagePath) return [];
  const raw = readJsonFile(packagePath);
  const names = new Set<string>();
  for (const key of keys) {
    for (const name of Object.keys(asRecord(raw[key]))) names.add(name);
  }
  const installed: InstalledRecipeDependency[] = [];
  for (const name of names) {
    const packageDir = resolveDependencyDir(root, name);
    if (packageDir) installed.push({ name, packageDir });
  }
  return installed;
}

/** One package's skill resources: the Recipe's own, or a dependency's `pi.skills`. */
export interface RecipeSkillResource {
  /** A skill file or a directory searched for `SKILL.md`. */
  path: string;
  /** The package the resource must stay inside (a real path for a dependency). */
  packageDir: string;
  /** The dependency's name; absent for the Recipe's own skills. */
  dependency?: string;
}

/**
 * The skill resources each direct `dependencies` or `peerDependencies` entry
 * declares with an explicit `pi.skills`, resolved inside that package (a peer
 * is provided by the platform, often from an ancestor `node_modules`). One
 * that is not installed is skipped. Dev and transitive dependencies are not
 * read, a dependency without `pi.skills`
 * contributes nothing (its `skills/` folder is not discovered by convention),
 * and an installed dependency whose `pi.skills` is malformed, unmatched or
 * escapes the package throws an error naming it.
 */
export function recipeDependencySkillResources(
  recipeDir: string,
): RecipeSkillResource[] {
  const resources: RecipeSkillResource[] = [];
  for (const { name, packageDir } of installedRecipeDependencies(recipeDir, [
    "dependencies",
    "peerDependencies",
  ])) {
    const raw = readJsonFile(join(packageDir, "package.json"));
    const pi = piPackageManifestBlock(raw);
    if (!pi || pi.skills === undefined) continue;
    const owner = `Dependency ${name}`;
    if (
      !Array.isArray(pi.skills) ||
      pi.skills.some((item) => typeof item !== "string" || !item.trim())
    ) {
      throw new RecipePackageError(
        `${owner} package.json#pi.skills must be an array of non-empty strings`,
      );
    }
    const pkg: RecipePackageManifest = {
      name,
      version: stringValue(raw.version) ?? "0.0.0",
      path: packageDir,
      resources: {
        ...emptyResources(),
        skills: stringArray(pi.skills).map(normalizeResourcePath),
      },
      channels: [],
      documents: [],
      mcp: { manifests: [], servers: [] },
    };
    for (const path of resolvePiPackageResourcePaths(pkg, "skills", owner)) {
      resources.push({ path, packageDir, dependency: name });
    }
  }
  return resources;
}
