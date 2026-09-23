import { generatedBindingEnvVars } from "./recipe/mcp-config.js";
import { expectedProviderEnvVars } from "./provider-env.js";
import type { RecipeAgentConfigField } from "./recipe/agent.js";
import type { ResolvedRecipe, ResolvedRecipeAgent } from "./recipe/resolve.js";

export interface RecipeAgentInspection {
  name: string;
  from?: string;
  declaredFields: RecipeAgentConfigField[];
  provenance: Partial<Record<RecipeAgentConfigField, string[]>>;
  model: {
    name: string;
    thinkingLevel?: string;
    config?: ResolvedRecipeAgent["modelConfig"];
  };
  session?: ResolvedRecipeAgent["sessionConfig"];
  prompt: {
    base: "SYSTEM.md" | "pi";
    agentInstructions?: {
      mode: "append" | "replace";
      source: string;
    };
  };
  tools: {
    authored: string[];
    root: string[];
    subagent: string[];
  };
  skills: string[];
  subagents: string[];
  mcp?: ResolvedRecipeAgent["mcp"];
}

/**
 * What a recipe requires before it can run, derived entirely from the
 * package's existing declarations — no new manifest keys. Hosts can use this
 * for preflight checks and configuration UIs.
 */
export interface RecipeInspection {
  name: string;
  version: string;
  description?: string;
  agents: string[];
  providers: string[];
  credentialEnv: string[];
  mcp: { required: string[]; optional: string[] };
  mcpEnv: string[];
  resources: {
    agents: number;
    skills: number;
    extensions: number;
    prompts: number;
  };
  packageClosure: {
    extensions: string[];
    prompts: string[];
  };
  resolvedAgents: RecipeAgentInspection[];
}

function agentChain(
  recipe: ResolvedRecipe,
  agent: ResolvedRecipeAgent
): ResolvedRecipeAgent[] {
  const chain: ResolvedRecipeAgent[] = [];
  const seen = new Set<string>();
  let current: ResolvedRecipeAgent | undefined = agent;
  while (current && !seen.has(current.name)) {
    seen.add(current.name);
    chain.unshift(current);
    current = current.definition.from
      ? recipe.agents.get(current.definition.from)
      : undefined;
  }
  return chain;
}

function inspectAgent(
  recipe: ResolvedRecipe,
  agent: ResolvedRecipeAgent,
  hasSystemPrompt: boolean
): RecipeAgentInspection {
  const chain = agentChain(recipe, agent);
  const fields: RecipeAgentConfigField[] = [
    "description",
    "model",
    "ai",
    "session",
    "tools",
    "mcp",
    "skills",
    "subagents",
    "system_instructions",
  ];
  const provenance = Object.fromEntries(
    fields.flatMap((field) => {
      const sources = chain
        .filter((entry) =>
          entry.definition.declaredFields?.includes(field)
        )
        .map((entry) => entry.name);
      return sources.length > 0 ? [[field, sources]] : [];
    })
  ) as Partial<Record<RecipeAgentConfigField, string[]>>;
  const instructionSource = provenance.system_instructions?.at(-1);
  const rootTools = [
    ...agent.tools,
    ...(agent.subagents.size > 0 ? ["agent"] : []),
  ];
  return {
    name: agent.name,
    ...(agent.definition.from ? { from: agent.definition.from } : {}),
    declaredFields: [...(agent.definition.declaredFields ?? [])],
    provenance,
    model: {
      name: agent.modelSpec,
      ...(agent.thinkingLevel
        ? { thinkingLevel: agent.thinkingLevel }
        : {}),
      ...(agent.modelConfig ? { config: agent.modelConfig } : {}),
    },
    ...(agent.sessionConfig ? { session: agent.sessionConfig } : {}),
    prompt: {
      base: hasSystemPrompt ? "SYSTEM.md" : "pi",
      ...(agent.definition.systemInstructions && instructionSource
        ? {
            agentInstructions: {
              mode: agent.definition.systemInstructions.mode,
              source: instructionSource,
            },
          }
        : {}),
    },
    tools: {
      authored: [...agent.tools],
      root: rootTools,
      subagent: [...agent.tools],
    },
    skills: [...agent.skillPaths],
    subagents: [...agent.subagents.keys()],
    ...(agent.mcp ? { mcp: agent.mcp } : {}),
  };
}

export function inspectRecipe(resolvedRecipe: ResolvedRecipe): RecipeInspection {
  const manifest = resolvedRecipe.manifest;
  const definitions = [...resolvedRecipe.agents.values()].map(
    (agent) => agent.definition
  );
  const agents = [...new Set(definitions.map((agent) => agent.name))];
  const uniqueResolvedAgents = [
    ...new Map(
      [...resolvedRecipe.agents.values()].map((agent) => [agent.name, agent])
    ).values(),
  ];
  const extensionPaths = resolvedRecipe.resources.extensions;
  const promptPaths = resolvedRecipe.resources.prompts;

  const providers = [
    ...new Set(
      definitions.flatMap((agent) => {
        const spec = agent.model?.name;
        const slash = spec?.indexOf("/") ?? -1;
        return spec && slash > 0 ? [spec.slice(0, slash)] : [];
      })
    ),
  ];
  const credentialEnv = [
    ...new Set(
      providers.flatMap((provider) =>
        expectedProviderEnvVars(
          provider === "gemini" ? "google" : provider
        )
      )
    ),
  ].sort();

  const required = manifest.mcp.servers
    .filter((server) => server.required)
    .map((server) => server.id);
  const optional = manifest.mcp.servers
    .filter((server) => !server.required)
    .map((server) => server.id);

  const mcpEnv = [
    ...new Set(
      manifest.mcp.servers.flatMap((server) =>
        generatedBindingEnvVars(server.id)
      )
    ),
  ].sort();

  return {
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description ? { description: manifest.description } : {}),
    agents,
    providers,
    credentialEnv,
    mcp: { required, optional },
    mcpEnv,
    resources: {
      agents: agents.length,
      skills: resolvedRecipe.resources.skills.length,
      extensions: extensionPaths.length,
      prompts: promptPaths.length,
    },
    packageClosure: {
      extensions: [...extensionPaths],
      prompts: [...promptPaths],
    },
    resolvedAgents: uniqueResolvedAgents.map((agent) =>
      inspectAgent(
        resolvedRecipe,
        agent,
        resolvedRecipe.resources.hasSystemPrompt
      )
    ),
  };
}
