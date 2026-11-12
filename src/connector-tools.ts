import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { stripApiBoundHeaders } from "./api-bindings.js";
import {
  CHANNEL_MODULE_API_VERSION,
  createChannelConnectorModule,
  type RecipeChannelModule,
} from "./channels/module.js";
import { loadRecipeDocuments } from "./documents/module.js";
import { loadSearchProviders } from "./search/module.js";
import { loadRecipeIssues } from "./issues/module.js";
import { loadRecipeSignatures } from "./signatures/module.js";
import { loadRecipeProductivity } from "./productivity/module.js";
import { loadRecipePackageModule } from "./recipe/companions.js";
import { deferTools } from "./tool-search.js";
import {
  recipeChannelPackageName,
  type RecipePackageChannel,
  type RecipePackageManifest,
} from "./recipe/package.js";
import type { RecipeToolExposure } from "./recipe/agent.js";
import type { RecipeClock } from "./clock.js";

interface RecipeConnectorToolDefinition {
  readonly id: string;
  readonly name: string;
  readonly defaultActive: boolean;
}

interface RecipeConnectorExtension {
  owner: string;
  factory: ExtensionFactory;
}

export interface RecipeConnectorExtensionOptions {
  recipeDir: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Prepared package Python environments by package name (see `prepareRecipePython`). */
  python?: Readonly<Record<string, { interpreter: string }>>;
  /** Where companion packages resolve from. Default: where `@introspection-ai/recipes` is installed. */
  hostDir?: string;
  /** How a first-party tool registers for the agent (`tools.mode`, `defer`). Default: declared. */
  exposure?: (tool: string) => RecipeToolExposure;
  /** What the agent's `include: ["*"]` added (`wildcardTools`). */
  wildcardTools?: readonly string[];
  /** The session's clock. Default: the host's. */
  clock?: RecipeClock;
}

interface RecipeConnectorToolLoadout {
  toolNames: string[];
  initialActiveToolNames: string[];
  deferredToolNames: string[];
  /** Registered for codemode scripts only (`tools.mode: codemode`). */
  scriptOnlyToolNames: string[];
}

function isScriptOnly(tool: object): boolean {
  return (tool as { scriptOnly?: boolean }).scriptOnly === true;
}

interface RecipeConnectorModuleOptions {
  tools: readonly string[];
  commands?: readonly string[];
  requireReply?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RecipeConnectorModule {
  readonly provider: string;
  readonly tools: readonly RecipeConnectorToolDefinition[];
  /** Every host the connector sends to (a channel's `capabilities.hosts`). */
  readonly hosts?: readonly string[];
  createExtension(options: RecipeConnectorModuleOptions): ExtensionFactory;
}

export interface LoadedRecipeConnectors {
  extensions: RecipeConnectorExtension[];
  loadout: RecipeConnectorToolLoadout;
  /** Skills the `documents`, productivity, `issues` and `signatures` tools offer: their core skills and the selected profiles. */
  skillPaths: string[];
  /**
   * Every host the loaded providers and adapters declare: channels,
   * productivity and issues, and search when the Recipe declares `pi.search`.
   * An API binding may rebind only these.
   */
  hosts: string[];
}

function connectorModuleError(
  channel: RecipePackageChannel,
  detail: string,
): Error {
  return new Error(
    `Recipe channel package ${recipeChannelPackageName(channel.provider)} ${detail}`,
  );
}

function isConnectorToolDefinition(
  value: unknown,
): value is RecipeConnectorToolDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const tool = value as Partial<RecipeConnectorToolDefinition>;
  return (
    typeof tool.id === "string" &&
    Boolean(tool.id.trim()) &&
    typeof tool.name === "string" &&
    Boolean(tool.name.trim()) &&
    typeof tool.defaultActive === "boolean"
  );
}

function parseRecipeConnectorModule(
  value: unknown,
  channel: RecipePackageChannel,
): RecipeConnectorModule {
  if (!value || typeof value !== "object") {
    throw connectorModuleError(channel, "does not export a module");
  }
  const module = value as Partial<RecipeConnectorModule>;
  if (
    module.provider !== channel.provider ||
    !Array.isArray(module.tools) ||
    module.tools.length === 0 ||
    module.tools.some((tool) => !isConnectorToolDefinition(tool)) ||
    typeof module.createExtension !== "function"
  ) {
    throw connectorModuleError(channel, "has an invalid module contract");
  }
  const tools = module.tools as readonly RecipeConnectorToolDefinition[];
  const ids = tools.map((tool) => tool.id);
  const names = tools.map((tool) => tool.name);
  if (
    new Set(ids).size !== ids.length ||
    new Set(names).size !== names.length
  ) {
    throw connectorModuleError(
      channel,
      "has duplicate or conflicting tool names",
    );
  }
  return module as RecipeConnectorModule;
}

/**
 * A channel package's plain descriptor (`kind: "channel"`) becomes a connector
 * here, in the host. A package built with `createChannelConnectorModule`
 * already is one.
 */
function fromChannelModule(
  value: unknown,
  channel: RecipePackageChannel,
): unknown {
  if (
    !value ||
    typeof value !== "object" ||
    (value as { kind?: unknown }).kind !== "channel"
  )
    return value;
  const module = value as Partial<RecipeChannelModule>;
  if (
    module.provider !== channel.provider ||
    !module.capabilities ||
    typeof module.capabilities !== "object" ||
    typeof module.createSession !== "function"
  ) {
    throw connectorModuleError(channel, "has an invalid module contract");
  }
  return createChannelConnectorModule(module as RecipeChannelModule);
}

async function loadRecipeConnectorModule(
  recipeDir: string,
  channel: RecipePackageChannel,
  hostDir: string | undefined,
): Promise<RecipeConnectorModule> {
  const connectorModule = await loadRecipePackageModule(
    recipeDir,
    recipeChannelPackageName(channel.provider),
    {
      what: `Recipe channel '${channel.provider}'`,
      api: { name: "channel module", version: CHANNEL_MODULE_API_VERSION },
      ...(hostDir !== undefined ? { hostDir } : {}),
    },
  );
  return parseRecipeConnectorModule(
    fromChannelModule(connectorModule, channel),
    channel,
  );
}

export async function loadRecipeConnectors(
  manifest: RecipePackageManifest,
  agentTools: readonly string[],
  options: RecipeConnectorExtensionOptions,
): Promise<LoadedRecipeConnectors> {
  const loaded = await Promise.all(
    (manifest.channels ?? []).map(async (channel) => {
      const module = await loadRecipeConnectorModule(
        options.recipeDir,
        channel,
        options.hostDir,
      );
      const selected = module.tools.filter(
        (tool) =>
          agentTools.includes(tool.name) && channel.commands?.length !== 0,
      );
      return {
        extension: {
          owner: `<channel:${channel.provider}>`,
          factory: deferTools(
            module.createExtension({
              tools: selected.map((tool) => tool.id),
              ...(channel.commands !== undefined
                ? { commands: channel.commands }
                : {}),
              ...(channel.requireReply !== undefined
                ? { requireReply: channel.requireReply }
                : {}),
              env: options.env,
              cwd: options.cwd,
            }),
            selected
              .filter((tool) => !tool.defaultActive)
              .map((tool) => tool.name),
          ),
        },
        selected,
        hosts: module.hosts ?? [],
      };
    }),
  );
  const documents = await loadRecipeDocuments(
    manifest.documents ?? [],
    agentTools,
    options,
  );
  const productivity = await loadRecipeProductivity(
    manifest.productivity ?? [],
    agentTools,
    options,
  );
  const issues = await loadRecipeIssues(manifest.issues, agentTools, options);
  const signatures = await loadRecipeSignatures(
    manifest.signatures,
    agentTools,
    {
      recipeDir: options.recipeDir,
      ...(options.env ? { env: options.env } : {}),
      ...(options.hostDir !== undefined ? { hostDir: options.hostDir } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    },
  );
  // Search providers load here only to learn their hosts; `web_search` is
  // registered by the host or the Recipe.
  const search =
    manifest.search === undefined
      ? {}
      : await loadSearchProviders({
          recipeDir: options.recipeDir,
          ...(options.hostDir !== undefined
            ? { hostDir: options.hostDir }
            : {}),
          declarations: manifest.search,
        });
  stripApiBoundHeaders(
    Object.values(search).map(
      (module) => module.capabilities.credential.header,
    ),
  );
  // A first-party tool in codemode is registered but neither declared nor
  // deferred to tool search: codemode lists it for scripts.
  const scriptOnly = (name: string) => options.exposure?.(name) === "codemode";
  const active = (name: string) => options.exposure?.(name) !== "deferred";
  const selected = [
    ...loaded.flatMap((connector) => connector.selected),
    ...issues.toolNames.map((name) => ({
      id: name,
      name,
      defaultActive: active(name),
      scriptOnly: scriptOnly(name),
    })),
    ...productivity.toolNames.map((name) => ({
      id: name,
      name,
      defaultActive: active(name),
      scriptOnly: scriptOnly(name),
    })),
    ...documents.toolNames.map((name) => ({
      id: name,
      name,
      defaultActive: true,
    })),
    ...signatures.toolNames.map((name) => ({
      id: name,
      name,
      defaultActive: true,
    })),
  ];
  const registeredNames = selected.map((tool) => tool.name);
  if (new Set(registeredNames).size !== registeredNames.length) {
    throw new Error("Recipe connector packages register duplicate tool names");
  }
  return {
    skillPaths: [
      ...(documents.skillPaths ?? []),
      ...(productivity.skillPaths ?? []),
      ...(issues.skillPaths ?? []),
      ...(signatures.skillPaths ?? []),
    ],
    hosts: [
      ...new Set(
        [
          ...loaded.flatMap((connector) => connector.hosts),
          ...(productivity.hosts ?? []),
          ...(issues.hosts ?? []),
          ...(signatures.hosts ?? []),
          ...Object.values(search).flatMap((module) => [
            module.capabilities.host,
            ...(module.capabilities.hosts ?? []),
          ]),
        ].map((host) => host.toLowerCase()),
      ),
    ],
    extensions: [
      ...loaded.map((connector) => connector.extension),
      ...(documents.extension ? [documents.extension] : []),
      ...(productivity.extension ? [productivity.extension] : []),
      ...(issues.extension ? [issues.extension] : []),
      ...(signatures.extension ? [signatures.extension] : []),
    ],
    loadout: {
      toolNames: selected.map((tool) => tool.name),
      initialActiveToolNames: selected
        .filter((tool) => tool.defaultActive && !isScriptOnly(tool))
        .map((tool) => tool.name),
      deferredToolNames: selected
        .filter((tool) => !tool.defaultActive)
        .map((tool) => tool.name),
      scriptOnlyToolNames: selected
        .filter((tool) => isScriptOnly(tool))
        .map((tool) => tool.name),
    },
  };
}
