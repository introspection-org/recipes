import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fauxProvider,
  type FauxProviderHandle,
  type FauxResponseStep,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

import { createRecipesExtension } from "../../src/pi-extension.js";
import { resolveRecipe } from "../../src/recipe/resolve.js";
import {
  createAgentSession as createRecipeAgentSession,
  type RecipeSessionHandle,
} from "../../src/session.js";
import { cleanEnv } from "../../src/test-utils.js";

/** The text of the last tool result a scripted model step sees. */
export function lastToolResult(context: {
  messages: readonly unknown[];
}): string {
  const message = [...context.messages]
    .reverse()
    .find((entry) => (entry as { role?: string }).role === "toolResult") as
    { content: Array<{ text?: string }> } | undefined;
  return message
    ? message.content.map((part) => part.text ?? "").join("\n")
    : "";
}

/** Points the fixture's agent at the scripted faux model. */
function useFauxModel(recipeDir: string): void {
  const agentPath = join(recipeDir, "agents", "agent.yaml");
  writeFileSync(
    agentPath,
    readFileSync(agentPath, "utf8").replace(
      "anthropic/claude-sonnet-4-5",
      "faux/faux-1",
    ),
  );
}

/** A faux provider scripted with `responses`, and credentials for it. */
async function scriptedFaux(responses: FauxResponseStep[]): Promise<{
  faux: FauxProviderHandle;
  credentials: InMemoryCredentialStore;
}> {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(faux.getModel().provider, async () => ({
    type: "api_key",
    key: "test-key",
  }));
  return { faux, credentials };
}

/**
 * A Recipe extension registering `names`, each a tool that calls the MCP tool
 * `target` with its `message` and returns the text, prefixed `refused: ` when
 * the call failed.
 */
export function mcpCallingToolsExtension(
  target: string,
  names: readonly string[],
): string {
  return [
    "export default (pi) => {",
    `  for (const name of ${JSON.stringify(names)}) {`,
    "    pi.registerTool({",
    "      name,",
    "      label: name,",
    '      description: name + " through the hello MCP",',
    '      parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },',
    "      async execute(_id, params, signal, _update, ctx) {",
    `        const call = await ctx.executeTool("${target}", { message: params.message }, { signal });`,
    '        const text = call.result.content.map((part) => part.text ?? "").join("\\n");',
    '        return { content: [{ type: "text", text: (call.isError ? "refused: " : "") + text }], details: {} };',
    "      },",
    "    });",
    "  }",
    "};",
    "",
  ].join("\n");
}

/**
 * The Pi CLI host: the recipes extension beside the built-in codemode,
 * tool_search and MCP extensions the `pi` command loads, with the fixture's
 * servers bound to `bindings`.
 */
export async function openPiCliSession(options: {
  recipeDir: string;
  workspaceDir: string;
  bindings: Array<{ id: string; url: string }>;
  responses: FauxResponseStep[];
  cleanups: Array<() => void | Promise<void>>;
}): Promise<AgentSession> {
  useFauxModel(options.recipeDir);
  const bindingsPath = join(options.recipeDir, ".pi-bindings.json");
  writeFileSync(
    bindingsPath,
    JSON.stringify({
      servers: options.bindings.map((binding) => ({
        ...binding,
        transport: "streamable_http",
      })),
    }),
  );
  const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
  options.cleanups.push(() =>
    rmSync(agentDir, { recursive: true, force: true }),
  );
  const { faux, credentials } = await scriptedFaux(options.responses);
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const env = {
    ...cleanEnv(),
    PI_RECIPE_DIR: options.recipeDir,
    PI_RECIPES_MCP_LOCAL_CONFIG: bindingsPath,
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.workspaceDir,
    agentDir,
    noExtensions: true,
    extensionFactories: [
      createCodemodeExtension({ models: false }),
      createToolSearchExtension(),
      createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) }),
      createRecipesExtension({ env }),
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: options.workspaceDir,
    agentDir,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    settingsManager: SettingsManager.inMemory(),
    sessionManager: SessionManager.inMemory(),
  });
  options.cleanups.push(() => session.dispose());
  await session.bindExtensions({});
  return session;
}

/** A Recipe SDK session on the scripted faux model, its MCP servers bound to `bindings`. */
export async function openRecipeSession(options: {
  recipeDir: string;
  workspaceDir: string;
  bindings: Array<{
    id: string;
    url: string;
    headers?: Record<string, string>;
  }>;
  responses?: FauxResponseStep[];
  env?: NodeJS.ProcessEnv;
  /** The host already materialized the session's MCP, so no bindings go to it. */
  mcpProvisioning?: "host";
}): Promise<RecipeSessionHandle> {
  useFauxModel(options.recipeDir);
  const { faux, credentials } = await scriptedFaux(options.responses ?? []);
  return createRecipeAgentSession({
    recipe: resolveRecipe({ recipeDir: options.recipeDir }),
    cwd: options.workspaceDir,
    env: options.env ?? cleanEnv(),
    credentials,
    modelOverride: faux.getModel(),
    extensionFactories: [(pi) => pi.registerProvider(faux.provider)],
    ...(options.mcpProvisioning
      ? { mcpProvisioning: options.mcpProvisioning }
      : {
          mcpBindings: {
            servers: options.bindings.map((binding) => ({
              ...binding,
              transport: "streamable_http" as const,
            })),
          },
        }),
  });
}
