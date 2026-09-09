import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { loadRecipeModule } from "./recipe-extensions.js";
import {
  recipeChannelPackageName,
  type RecipePackageChannel,
  type RecipePackageManifest,
} from "./recipe-package.js";

export interface RecipeConnectorToolDefinition {
  readonly id: string;
  readonly name: string;
  readonly defaultActive: boolean;
}

export interface RecipeConnectorExtension {
  owner: string;
  factory: ExtensionFactory;
}

export interface RecipeConnectorExtensionOptions {
  recipeDir: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RecipeConnectorToolLoadout {
  toolNames: string[];
  initialActiveToolNames: string[];
  deferredToolNames: string[];
}

export interface RecipeConnectorModuleOptions {
  tools: readonly string[];
  commands?: readonly string[];
  requireReply?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RecipeConnectorModule {
  readonly provider: string;
  readonly tools: readonly RecipeConnectorToolDefinition[];
  createExtension(options: RecipeConnectorModuleOptions): ExtensionFactory;
}

export interface LoadedRecipeConnectors {
  extensions: RecipeConnectorExtension[];
  loadout: RecipeConnectorToolLoadout;
}

function connectorModuleError(
  channel: RecipePackageChannel,
  detail: string
): Error {
  return new Error(
    `Recipe channel package ${recipeChannelPackageName(channel.provider)} ${detail}`
  );
}

function isConnectorToolDefinition(
  value: unknown
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
  channel: RecipePackageChannel
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
      "has duplicate or conflicting tool names"
    );
  }
  return module as RecipeConnectorModule;
}

async function loadRecipeConnectorModule(
  recipeDir: string,
  channel: RecipePackageChannel
): Promise<RecipeConnectorModule> {
  const packageName = recipeChannelPackageName(channel.provider);
  let imported: unknown;
  try {
    imported = await loadRecipeModule(recipeDir, packageName);
  } catch (error) {
    throw new Error(
      `Recipe channel '${channel.provider}' requires ${packageName} in the Recipe dependencies`,
      { cause: error }
    );
  }
  const connectorModule =
    imported &&
    typeof imported === "object" &&
    "default" in imported
      ? imported.default
      : imported;
  return parseRecipeConnectorModule(connectorModule, channel);
}

export async function loadRecipeConnectors(
  manifest: RecipePackageManifest,
  agentTools: readonly string[],
  options: RecipeConnectorExtensionOptions
): Promise<LoadedRecipeConnectors> {
  const loaded = await Promise.all(
    (manifest.channels ?? []).map(async (channel) => {
      const module = await loadRecipeConnectorModule(options.recipeDir, channel);
      const selected = module.tools.filter((tool) =>
        agentTools.includes(tool.name) && channel.commands?.length !== 0
      );
      return {
        extension: {
          owner: `<channel:${channel.provider}>`,
          factory: module.createExtension({
            tools: selected.map((tool) => tool.id),
            ...(channel.commands !== undefined ? { commands: channel.commands } : {}),
            ...(channel.requireReply !== undefined ? { requireReply: channel.requireReply } : {}),
            env: options.env,
            cwd: options.cwd,
          }),
        },
        selected,
      };
    })
  );
  const selected = loaded.flatMap((connector) => connector.selected);
  const registeredNames = selected.map((tool) => tool.name);
  if (new Set(registeredNames).size !== registeredNames.length) {
    throw new Error("Recipe connector packages register duplicate tool names");
  }
  return {
    extensions: loaded.map((connector) => connector.extension),
    loadout: {
      toolNames: selected.map((tool) => tool.name),
      initialActiveToolNames: selected
        .filter((tool) => tool.defaultActive)
        .map((tool) => tool.name),
      deferredToolNames: selected
        .filter((tool) => !tool.defaultActive)
        .map((tool) => tool.name),
    },
  };
}
