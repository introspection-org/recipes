import { fileURLToPath } from "node:url";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { loadRecipePackageModule } from "../recipe/companions.js";
import {
  recipeDocumentPackageName,
  type RecipePackageDocument,
} from "../recipe/package.js";
import {
  DOCUMENT_COMMANDS,
  documentCommandsFor,
  registerDocumentTools,
  type DocumentCommand,
} from "./tools.js";
import { resolveDocumentProfile } from "./profile.js";
import { runDocumentHelper } from "./python.js";
import type { DocumentAdapter, DocumentCapabilities } from "./types.js";

/** The core `documents` skill, offered to every agent that selects the tool. It ships beside `dist/`. */
export const DOCUMENTS_SKILL = fileURLToPath(
  new URL("../../skills/documents/SKILL.md", import.meta.url),
);

/**
 * The document format contract this host implements. A format module
 * declares the version it was written against, and the host refuses one that
 * differs; bump it on any breaking change to `RecipeDocumentFormatModule` or
 * `DocumentAdapterOptions`.
 */
export const DOCUMENT_FORMAT_API_VERSION = 1 as const;

/**
 * What a format package exports as its default: transport plus a capability
 * descriptor, no schemas. A plain object: everything the format needs from
 * the host at run time (`runHelper`) arrives through `createAdapter`, so a
 * format package needs no run-time import of `@introspection-ai/recipes`,
 * only its types.
 */
export interface RecipeDocumentFormatModule {
  readonly kind: "documents";
  /** The contract version, `DOCUMENT_FORMAT_API_VERSION` when written. */
  readonly apiVersion: typeof DOCUMENT_FORMAT_API_VERSION;
  readonly format: string;
  readonly extensions: readonly string[];
  /** Static, so the loader can build the tool before any session exists. */
  readonly capabilities: DocumentCapabilities;
  /** Profiles this format ships: name to the absolute path of its SKILL.md (see profile.ts). */
  readonly profiles?: Readonly<Record<string, string>>;
  createAdapter(options: DocumentAdapterOptions): DocumentAdapter;
}

/** Runs one Python helper request for a format: the host's `runDocumentHelper`. */
export type DocumentHelperRunner = typeof runDocumentHelper;

/**
 * What the host passes a format's `createAdapter`. `python` is the
 * interpreter of the environment the format package's own
 * `pi.runtime.python` declares, prepared by the host; absent when the package
 * declares none. An adapter that ignores it keeps working. `runHelper` is the
 * host's `runDocumentHelper`, for formats whose work runs in a Python helper.
 */
export interface DocumentAdapterOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  python?: string;
  runHelper: DocumentHelperRunner;
}

export interface DocumentFormatModuleOptions {
  format: string;
  extensions: readonly string[];
  capabilities: DocumentCapabilities;
  /** Profiles shipped with the format: name to the absolute path of its SKILL.md. */
  profiles?: Readonly<Record<string, string>>;
  createAdapter(options: DocumentAdapterOptions): DocumentAdapter;
}

function sameCapabilities(
  left: DocumentCapabilities,
  right: DocumentCapabilities,
): boolean {
  const a = documentCommandsFor(left);
  const b = documentCommandsFor(right);
  return (
    a.length === b.length && a.every((command, index) => command === b[index])
  );
}

/**
 * Build a format module from an adapter factory, checking its shape. A
 * convenience for formats that already depend on Recipes; a format may
 * instead export the plain object itself. The host checks every module the
 * same way when it loads it.
 */
export function createDocumentFormatModule(
  options: DocumentFormatModuleOptions,
): RecipeDocumentFormatModule {
  if (!options.capabilities.read)
    throw new Error(`Document format '${options.format}' must support read`);
  if (options.extensions.length === 0)
    throw new Error(`Document format '${options.format}' opens no extensions`);
  return {
    kind: "documents",
    apiVersion: DOCUMENT_FORMAT_API_VERSION,
    format: options.format,
    extensions: options.extensions.map((extension) => extension.toLowerCase()),
    capabilities: options.capabilities,
    profiles: { ...options.profiles },
    createAdapter: (createOptions) => options.createAdapter(createOptions),
  };
}

/** Create a module's adapter, checking it returns the format and capabilities it declared. */
function createCheckedAdapter(
  module: RecipeDocumentFormatModule,
  options: DocumentAdapterOptions,
): DocumentAdapter {
  const adapter = module.createAdapter(options);
  if (adapter.format !== module.format) {
    throw new Error(
      `Document adapter for '${module.format}' returned format '${adapter.format}'`,
    );
  }
  if (!sameCapabilities(adapter.capabilities, module.capabilities)) {
    throw new Error(
      `Document adapter '${module.format}' returned capabilities that differ from its declared catalog`,
    );
  }
  return adapter;
}

function parseFormatModule(
  value: unknown,
  declaration: RecipePackageDocument,
): RecipeDocumentFormatModule {
  const packageName = recipeDocumentPackageName(declaration.format);
  const module = value as Partial<RecipeDocumentFormatModule> | undefined;
  if (
    !module ||
    module.kind !== "documents" ||
    module.format !== declaration.format ||
    !Array.isArray(module.extensions) ||
    module.extensions.length === 0 ||
    !module.capabilities?.read ||
    typeof module.createAdapter !== "function"
  ) {
    throw new Error(
      `Recipe document package ${packageName} has an invalid module contract`,
    );
  }
  return {
    ...module,
    extensions: module.extensions.map((extension) =>
      String(extension).toLowerCase(),
    ),
  } as RecipeDocumentFormatModule;
}

export interface LoadedRecipeDocuments {
  extension?: { owner: string; factory: ExtensionFactory };
  toolNames: string[];
  /** The core `documents` skill, then each declared profile's skill, offered beside the tool. */
  skillPaths?: string[];
}

const knownCommands = new Set<string>(DOCUMENT_COMMANDS);

/**
 * Load every `pi.documents` format package and the profile each declaration
 * names (only those) and, when the agent selects `documents`, one extension
 * registering the shared tool and offering the core `documents` skill with
 * each profile's hints beside it.
 *
 * Each declaration's `commands` allowlist narrows what that format may do;
 * the tool exposes the union of what the formats allow.
 */
export async function loadRecipeDocuments(
  declarations: readonly RecipePackageDocument[],
  agentTools: readonly string[],
  options: {
    recipeDir: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    /** Prepared package environments by package name (see `prepareRecipePython`). */
    python?: Readonly<Record<string, { interpreter: string }>>;
    /** Where companion packages resolve from. Default: where `@introspection-ai/recipes` is installed. */
    hostDir?: string;
  },
): Promise<LoadedRecipeDocuments> {
  if (declarations.length === 0) return { toolNames: [] };
  const modules = await Promise.all(
    declarations.map(async (declaration) => {
      const packageName = recipeDocumentPackageName(declaration.format);
      const imported = await loadRecipePackageModule(
        options.recipeDir,
        packageName,
        {
          what: `Recipe document format '${declaration.format}'`,
          api: {
            name: "document format",
            version: DOCUMENT_FORMAT_API_VERSION,
          },
          ...(options.hostDir !== undefined
            ? { hostDir: options.hostDir }
            : {}),
        },
      );
      const module = parseFormatModule(imported, declaration);
      const supported = documentCommandsFor(module.capabilities);
      for (const command of declaration.commands ?? []) {
        if (!knownCommands.has(command))
          throw new Error(
            `Unknown documents command in pi.documents allowlist: ${command}`,
          );
        if (!supported.includes(command as DocumentCommand)) {
          throw new Error(
            `Document format '${declaration.format}' does not support command: ${command}`,
          );
        }
      }
      const profile =
        declaration.profile === undefined
          ? undefined
          : resolveDocumentProfile(declaration.profile, {
              format: declaration.format,
              shipped: module.profiles,
              recipeDir: options.recipeDir,
            });
      return { declaration, module, profile };
    }),
  );
  const enabled = modules.filter(
    ({ declaration }) => declaration.commands?.length !== 0,
  );
  if (!agentTools.includes("documents") || enabled.length === 0)
    return { toolNames: [] };
  const skillPaths = [DOCUMENTS_SKILL];
  for (const { profile } of enabled) {
    if (profile && !skillPaths.includes(profile)) skillPaths.push(profile);
  }
  return {
    toolNames: ["documents"],
    skillPaths,
    extension: {
      owner: `<documents:${enabled.map(({ declaration }) => declaration.format).join(",")}>`,
      factory: (pi) => {
        const env = options.env ?? process.env;
        const cwd = options.cwd ?? process.cwd();
        const adapters = enabled.map(({ declaration, module }) => {
          const python =
            options.python?.[recipeDocumentPackageName(declaration.format)]
              ?.interpreter;
          const adapter = createCheckedAdapter(module, {
            env,
            cwd,
            runHelper: runDocumentHelper,
            ...(python ? { python } : {}),
          });
          const allowed = declaration.commands;
          if (allowed === undefined) return adapter;
          // Narrow the descriptor to the allowlist so the shared tool filters on it.
          const has = (command: DocumentCommand) => allowed.includes(command);
          return Object.assign(Object.create(adapter) as DocumentAdapter, {
            capabilities: {
              read: true as const,
              revise: Boolean(adapter.capabilities.revise && has("revise")),
              proposeEdits: Boolean(
                adapter.capabilities.proposeEdits && has("propose_edits"),
              ),
              comment: Boolean(adapter.capabilities.comment && has("comment")),
              respond: Boolean(adapter.capabilities.respond && has("respond")),
              removeSection: Boolean(
                adapter.capabilities.removeSection && has("remove_section"),
              ),
              render: Boolean(adapter.capabilities.render && has("render")),
            },
          });
        });
        registerDocumentTools(pi, adapters, { cwd });
        pi.on("resources_discover", () => ({ skillPaths }));
      },
    },
  };
}
