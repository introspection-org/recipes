import { randomUUID } from "node:crypto";
import type {
  ClassifierResult,
  CredentialStore,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  ModelRegistry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentRunSummary } from "../agents.js";
import type { BatchRunController } from "../batch/runner.js";
import { resolveRecipeAgentModels } from "../model-binding.js";
import { applyRecipeAgentModelConfigToModel } from "../recipe/model.js";
import {
  RecipeResolutionError,
  type ResolvedRecipe,
  type ResolvedRecipeAgent,
} from "../recipe/resolve.js";
import { createInProcessRunController } from "../run-controller.js";
import {
  createAgentSessionInternal,
  type CreateAgentSessionInternalOptions,
  type RecipeSessionHandle,
} from "../session.js";
import type {
  ClassifierJudgeDefinition,
  JudgeDefinition,
  JudgeQuestion,
  LlmJudgeDefinition,
} from "./definition.js";
import { VERDICT_INSTRUCTIONS } from "./verdict.js";

const DEFAULT_FALLBACK_AFTER_RETRIES = 2;

/**
 * Asks a decision model a judge's questions about a transcript. `model` is
 * `<provider>/<model>`. The default asks Pi (`piClassifier`); a host that
 * routes inference itself supplies its own.
 */
export type JudgeClassifier = (request: {
  model: string;
  state: Record<string, unknown>;
  questions: Record<
    string,
    Omit<JudgeQuestion, "threshold"> & { type: "bool" }
  >;
  signal?: AbortSignal;
}) => Promise<
  Pick<ClassifierResult, "answers" | "stopReason" | "errorMessage"> &
    Partial<Pick<ClassifierResult, "usage">>
>;

/** The tokens a judgement took, when the model reported them. */
export interface JudgeUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/** Who answered a judge's run, and what it cost, as far as Pi reported it. */
export interface JudgeRunDetails {
  /** The `<provider>/<model>` that answered, after any `ai.fallbacks`. */
  model?: string;
  usage?: JudgeUsage;
}

function addUsage(
  total: JudgeUsage | undefined,
  usage: Usage | undefined,
): JudgeUsage | undefined {
  if (!usage) return total;
  // Cached prompt tokens are input too.
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  const output = usage.output;
  if (input + output === 0) return total;
  return {
    input_tokens: (total?.input_tokens ?? 0) + input,
    output_tokens: (total?.output_tokens ?? 0) + output,
    total_tokens: (total?.total_tokens ?? 0) + input + output,
  };
}

export interface JudgeRunControllerOptions {
  /** The Recipe the judges belong to. */
  recipe: ResolvedRecipe;
  judges: readonly JudgeDefinition[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Concurrent LLM judge sessions; give it at least the batch's concurrency. */
  concurrency?: number;
  credentials?: CredentialStore;
  settingsManager?: SettingsManager;
  /**
   * Pi's model registry. With it and no `credentials`, a judge starts on the
   * first of its `ai.model` and `ai.fallbacks` that has a credential and moves
   * to the next when a request is retried, exactly as a subagent does.
   */
  modelRegistry?: ModelRegistry;
  /**
   * Retries a judge's model gets before the judge moves to its next
   * `ai.fallbacks` entry. Default 2: a batch expects rate limits, so a model
   * that is only throttled is waited for, and one that keeps failing is left.
   * The host's `retry.maxRetries` must exceed it for a fallback to be reached.
   */
  fallbackAfterRetries?: number;
  /** Answers classifier judges. Required when any judge declares `questions`. */
  classify?: JudgeClassifier;
  /** Session factory for LLM judges; defaults to Recipes' own. Test/DI seam. */
  sessionFactory?: (
    options: CreateAgentSessionInternalOptions,
  ) => Promise<RecipeSessionHandle>;
}

/** What a batch drives to run judges, plus the release of its sessions. */
export type JudgeRunController = BatchRunController & {
  shutdown(): Promise<void>;
  /** The model that answered a run and its token usage, once it has finished. */
  runDetails(runId: string): JudgeRunDetails;
};

function judgeAgent(
  recipe: ResolvedRecipe,
  judge: LlmJudgeDefinition,
): ResolvedRecipeAgent {
  const definition = {
    name: judge.name,
    ...(judge.description ? { description: judge.description } : {}),
    model: {
      name: judge.ai.name,
      ...(judge.ai.thinkingLevel
        ? { thinkingLevel: judge.ai.thinkingLevel }
        : {}),
    },
    modelConfig: judge.ai,
    tools: [],
    skills: [],
    subagents: [],
  };
  return {
    recipeDir: recipe.recipeDir,
    manifest: recipe.manifest,
    name: judge.name,
    definition,
    subagents: new Map(),
    modelSpec: judge.ai.name,
    modelConfig: judge.ai,
    ...(judge.ai.thinkingLevel
      ? { thinkingLevel: judge.ai.thinkingLevel }
      : {}),
    tools: [],
    skillPaths: [],
    promptPaths: [],
    extensionPaths: [],
    // The judge's whole prompt: nothing of the Recipe's own agents reaches it.
    systemPromptOverride: () =>
      `${judge.instructions.trim()}\n\n${VERDICT_INSTRUCTIONS}`,
  };
}

/**
 * The Recipe's LLM judges as agents of their own: each has the judge's `ai:`
 * block, no tools, skills or extensions, and the judge's instructions as its
 * whole system prompt. A batch then runs a judge exactly as it runs an agent.
 */
export function judgeRecipe(
  recipe: ResolvedRecipe,
  judges: readonly JudgeDefinition[],
): ResolvedRecipe {
  const agents = new Map(
    judges
      .filter((judge) => judge.kind === "llm")
      .map((judge) => [judge.name, judgeAgent(recipe, judge)]),
  );
  return {
    recipeDir: recipe.recipeDir,
    manifest: recipe.manifest,
    resources: {
      skills: [],
      prompts: [],
      extensions: [],
      hasSystemPrompt: false,
    },
    agents,
    selectAgent(name) {
      const agent = name === undefined ? undefined : agents.get(name);
      if (!agent) {
        throw new RecipeResolutionError(
          `Recipe has no LLM judge named "${name}"`,
        );
      }
      return agent;
    },
  };
}

/**
 * Runs a Recipe's judges for a batch. An LLM judge's line is a fresh session
 * of that judge's agent; a classifier judge's line is one decision-model call
 * whose answers are the line's output, as JSON. Both honour `ai.fallbacks`.
 */
export function createJudgeRunController(
  options: JudgeRunControllerOptions,
): JudgeRunController {
  const byName = new Map(options.judges.map((judge) => [judge.name, judge]));
  const base = options.sessionFactory ?? createAgentSessionInternal;
  const registry = options.modelRegistry;
  const details = new Map<string, JudgeRunDetails>();
  const sessions = createInProcessRunController({
    recipe: judgeRecipe(options.recipe, options.judges),
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.settingsManager
      ? { settingsManager: options.settingsManager }
      : {}),
    // An LLM judge's answer is its last assistant message: the model that
    // wrote it answered, and every message of the run used tokens.
    onAgentRunEvent: ({ agent_run_id, event }) => {
      if (event.type !== "message_end" || event.message.role !== "assistant") {
        return;
      }
      const message = event.message;
      const earlier = details.get(agent_run_id);
      const usage = addUsage(earlier?.usage, message.usage);
      details.set(agent_run_id, {
        model: `${message.provider}/${message.model}`,
        ...(usage ? { usage } : {}),
      });
    },
    sessionFactory:
      registry && !options.credentials
        ? async (session) => {
            const agent = session.recipe.selectAgent(session.agentName);
            const {
              models: [model, ...fallbacks],
              credentials,
            } = await resolveRecipeAgentModels({
              modelSpec: agent.modelSpec,
              ...(agent.modelConfig?.fallbacks
                ? { fallbacks: agent.modelConfig.fallbacks }
                : {}),
              env: session.env ?? process.env,
              modelRegistry: registry,
            });
            return base({
              ...session,
              modelOverride: applyRecipeAgentModelConfigToModel(
                model!,
                agent.modelConfig,
              ),
              ...(fallbacks.length > 0
                ? {
                    modelFallbacks: fallbacks,
                    modelFallbackAfterRetries:
                      options.fallbackAfterRetries ??
                      DEFAULT_FALLBACK_AFTER_RETRIES,
                  }
                : {}),
              credentials,
              credentialsResolved: true,
            });
          }
        : base,
  });

  const classified = new Map<string, Promise<AgentRunSummary>>();

  async function classify(
    judge: ClassifierJudgeDefinition,
    summary: AgentRunSummary,
  ): Promise<AgentRunSummary> {
    const ask = options.classify;
    if (!ask) {
      return {
        ...summary,
        status: "failed",
        error: `judge "${judge.name}" asks a classifier, and this run was given none`,
      };
    }
    const questions = Object.fromEntries(
      Object.entries(judge.questions).map(([name, question]) => [
        name,
        {
          type: "bool" as const,
          instructions: question.instructions,
          criteria: question.criteria,
        },
      ]),
    );
    const failures: string[] = [];
    for (const model of [judge.ai.name, ...(judge.ai.fallbacks ?? [])]) {
      try {
        const reply = await ask({
          model,
          state: { conversation: summary.prompt },
          questions,
        });
        const usage = addUsage(undefined, reply.usage);
        details.set(summary.agent_run_id, {
          model,
          ...(usage ? { usage } : {}),
        });
        if (reply.stopReason === "stop") {
          return {
            ...summary,
            status: "completed",
            output: JSON.stringify({ model, answers: reply.answers }),
            completed_at: Date.now(),
          };
        }
        failures.push(`${model}: ${reply.errorMessage ?? reply.stopReason}`);
      } catch (error) {
        failures.push(
          `${model}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return {
      ...summary,
      status: "failed",
      error: failures.join("; "),
      completed_at: Date.now(),
    };
  }

  return {
    async start(input) {
      const judge = byName.get(input.name);
      if (judge?.kind !== "classifier") return sessions.start(input);
      const now = Date.now();
      const summary: AgentRunSummary = {
        agent_run_id: `judge-run-${randomUUID().slice(0, 8)}`,
        invocation_name: input.name,
        agent_name: input.name,
        label: input.label ?? judge.name,
        prompt: input.prompt,
        status: "running",
        started_at: now,
        last_activity_at: now,
      };
      classified.set(summary.agent_run_id, classify(judge, summary));
      return summary;
    },
    async wait(id, signal) {
      return classified.get(id) ?? sessions.wait(id, signal);
    },
    async message(id, text) {
      if (classified.has(id)) {
        throw new Error("a classifier judge's run takes no follow-up message");
      }
      return sessions.message(id, text);
    },
    async close(id) {
      const run = classified.get(id);
      if (!run) return sessions.close(id);
      classified.delete(id);
      return { ...(await run), status: "closed" };
    },
    runDetails(id) {
      return details.get(id) ?? {};
    },
    async shutdown() {
      classified.clear();
      details.clear();
      await sessions.shutdown();
    },
  };
}
