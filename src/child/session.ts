import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore, Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  MAX_AGENT_RUN_DEPTH,
  createDelegatedRuns,
  type AgentRunEventObserver,
} from "../agents.js";
import { autoResolveInteractions } from "../interactions.js";
import { promptResultError } from "./agent.js";
import type { ResolvedRecipe } from "../recipe/resolve.js";
import type {
  MemoryContextOverride,
  MemoryContextSource,
} from "../memory.js";
import {
  createAgentSessionInternal,
  type CreateAgentSessionInternalOptions,
  type RecipeSessionHandle,
  type RecipeSessionOtelOptions,
} from "../session.js";

export interface CreateIsolatedChildSessionOptions {
  recipe: ResolvedRecipe;
  agentName: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  credentials?: CredentialStore;
  memory?: MemoryContextSource;
  memoryOverride?: MemoryContextOverride;
  credentialsResolved?: boolean;
  modelOverride?: Model<any>;
  otel?: RecipeSessionOtelOptions;
  onEvent?: (event: AgentSessionEvent) => void;
  /** The run this child serves; its own runs are attributed to it. */
  agentRunId?: string;
  /** This child's run depth. Default 1 (a child of the root session). */
  depth?: number;
  /** Observe events from runs this child starts in turn. */
  onAgentRunEvent?: AgentRunEventObserver;
  /** Concurrency of the controller serving this child's own runs. */
  concurrency?: number;
  sessionFactory?: (
    options: CreateAgentSessionInternalOptions
  ) => Promise<RecipeSessionHandle>;
}

export interface IsolatedChildSessionHandle extends RecipeSessionHandle {
  /**
   * Prompt the child and return only once its work has settled: every agent
   * run it started has finished, and the child has had a turn to process the
   * results it had not already read through the `agent` tool. The child's
   * final answer is then the last assistant message in `session.messages`.
   */
  run(prompt: string): Promise<void>;
  /** Abort the child's turn and interrupt every run it started. */
  interrupt(): Promise<void>;
}

/**
 * Shared child-session primitive used by both the embedded and interactive Pi
 * controllers. It owns the child's private MCP state. A child below
 * `MAX_AGENT_RUN_DEPTH` whose agent declares subagents gets its own `agent`
 * tool backed by an in-process controller; deeper children never delegate.
 */
export async function createIsolatedChildSession(
  opts: CreateIsolatedChildSessionOptions
): Promise<IsolatedChildSessionHandle> {
  const depth = opts.depth ?? 1;
  const delegates =
    depth < MAX_AGENT_RUN_DEPTH &&
    opts.recipe.selectAgent(opts.agentName).subagents.size > 0;
  const delegated = createDelegatedRuns();
  const mcpRuntimeDir = await mkdtemp(join(tmpdir(), "recipes-child-mcp-"));
  try {
    const handle = await (opts.sessionFactory ?? createAgentSessionInternal)({
      recipe: opts.recipe,
      agentName: opts.agentName,
      cwd: opts.cwd,
      env: { ...opts.env },
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.memoryOverride
        ? { memoryOverride: opts.memoryOverride }
        : {}),
      ...(opts.credentialsResolved ? { credentialsResolved: true } : {}),
      ...(opts.modelOverride ? { modelOverride: opts.modelOverride } : {}),
      ...(opts.otel ? { otel: opts.otel } : {}),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      mcpRuntimeDir,
      sessionRole: "subagent",
      ...(delegates
        ? {
            agentRun: {
              id: opts.agentRunId ?? "child",
              depth,
            },
            agentToolOptions: delegated.agentToolOptions,
            ...(opts.onAgentRunEvent
              ? { onAgentRunEvent: opts.onAgentRunEvent }
              : {}),
            ...(opts.concurrency !== undefined
              ? { inProcessRunController: { concurrency: opts.concurrency } }
              : {}),
            ...(opts.sessionFactory
              ? { sessionFactory: opts.sessionFactory }
              : {}),
          }
        : { runController: null }),
    });
    let disposed = false;
    return {
      ...handle,
      async run(prompt: string): Promise<void> {
        await delegated.run(handle, prompt, async (input) => {
          // Children never own the root interaction lifecycle: their asks
          // resolve internally so a child cannot strand the parent on a user.
          await autoResolveInteractions(() => handle.session.prompt(input));
          return (
            !disposed &&
            !promptResultError({ messages: handle.session.messages })
          );
        });
      },
      async interrupt(): Promise<void> {
        await Promise.all([
          Promise.resolve()
            .then(() => handle.session.abort())
            .catch(() => {}),
          delegated.interrupt(handle),
        ]);
      },
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        try {
          await handle.dispose();
        } finally {
          await rm(mcpRuntimeDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(mcpRuntimeDir, { recursive: true, force: true });
    throw error;
  }
}
