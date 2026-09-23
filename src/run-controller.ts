import { randomUUID } from "node:crypto";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type {
  AgentRunEventObserver,
  AgentRunController,
  AgentRunStatus,
  AgentRunSummary,
} from "./agents.js";
import { notifyAgentRunEvent } from "./agents.js";
import { autoResolveInteractions } from "./interactions.js";
import { promptResultError, promptResultText } from "./child/agent.js";
import { createIsolatedChildSession } from "./child/session.js";
import type {
  CreateAgentSessionInternalOptions,
  RecipeSessionOtelOptions,
  RecipeSessionHandle,
} from "./session.js";
import type {
  MemoryContextOverride,
  MemoryContextSource,
} from "./memory.js";
import type { ResolvedRecipe } from "./recipe/resolve.js";

/** Default in-process child concurrency. */
export const DEFAULT_SUBAGENT_CONCURRENCY = 4;

export interface InProcessRunControllerOptions {
  recipe: ResolvedRecipe;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  credentials?: CredentialStore;
  memory?: MemoryContextSource;
  memoryOverride?: MemoryContextOverride;
  /** Concurrent child runs; excess starts queue. Default 4. */
  concurrency?: number;
  /** Root session instrumentation inherited by in-process child sessions. */
  otel?: RecipeSessionOtelOptions;
  /** Observe canonical Pi events from every child run. */
  onAgentRunEvent?: AgentRunEventObserver;
  /** Child session factory; defaults to `createAgentSession`. Test/DI seam. */
  sessionFactory?: (
    options: CreateAgentSessionInternalOptions
  ) => Promise<RecipeSessionHandle>;
}

interface ChildRun {
  summary: AgentRunSummary;
  handle: RecipeSessionHandle | null;
  settled: Promise<void>;
  onUpdate?: ((summary: AgentRunSummary) => void | Promise<void>) | undefined;
  waiters: Array<() => void>;
}

class RunNotFoundError extends Error {
  constructor(id: string) {
    super(`Agent run not found: ${id}`);
    this.name = "RunNotFoundError";
  }
}

/**
 * The default in-process subagent controller. Children are Recipe sessions
 * created through `createAgentSession`, with bounded concurrency and
 * one-level delegation.
 *
 * Recovery rule every controller must honor: a child whose agent profile no
 * longer exists errors the parent's `agent` tool call — it never wedges it.
 * Here that falls out of Recipe selection: selecting an
 * unknown agent name, the run settles as `failed`, and `start`/`wait`
 * resolve with that failure.
 */
export function createInProcessRunController(
  opts: InProcessRunControllerOptions
): AgentRunController {
  const env = opts.env ?? process.env;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_SUBAGENT_CONCURRENCY);
  const runs = new Map<string, ChildRun>();

  let active = 0;
  const queue: Array<() => void> = [];

  async function acquireSlot(): Promise<void> {
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
  }

  function releaseSlot(): void {
    active -= 1;
    queue.shift()?.();
  }

  function touch(run: ChildRun, patch: Partial<AgentRunSummary>): void {
    run.summary = {
      ...run.summary,
      ...patch,
      last_activity_at: Date.now(),
    };
    if (run.summary.output && !patch.output_preview) {
      run.summary.output_preview = run.summary.output.slice(0, 400);
    }
    void Promise.resolve(run.onUpdate?.(run.summary)).catch(() => {});
    if (run.summary.status !== "running") {
      for (const wake of run.waiters.splice(0)) wake();
    }
  }

  function requireRun(id: string): ChildRun {
    const run = runs.get(id);
    if (!run) throw new RunNotFoundError(id);
    return run;
  }

  async function executePrompt(run: ChildRun, prompt: string): Promise<void> {
    await acquireSlot();
    try {
      if (run.summary.status !== "running") return;
      if (!run.handle) {
        run.handle = await createIsolatedChildSession({
          recipe: opts.recipe,
          agentName: run.summary.agent_name,
          cwd: opts.cwd,
          // Every in-process child owns a private MCP environment. Sharing the
          // root object would either collide with its lease or expose its CLI
          // runtime to the child.
          env,
          ...(opts.credentials ? { credentials: opts.credentials } : {}),
          ...(opts.memory ? { memory: opts.memory } : {}),
          ...(opts.memoryOverride
            ? { memoryOverride: opts.memoryOverride }
            : {}),
          ...(opts.otel
            ? {
                otel: {
                  ...opts.otel,
                  // Keep one conversation across the agent tree; let each
                  // child derive its own Recipe agent id and name.
                  meta: {
                    conversationId: opts.otel.meta?.conversationId,
                  },
                },
              }
            : {}),
          ...(opts.sessionFactory ? { sessionFactory: opts.sessionFactory } : {}),
          onEvent: (event) => {
            notifyAgentRunEvent(opts.onAgentRunEvent, {
              type: "agent_run_event",
              agent_run_id: run.summary.agent_run_id,
              parent_agent_run_id: "root",
              agent_name: run.summary.agent_name,
              invocation_name: run.summary.invocation_name,
              depth: 1,
              event,
            });
            const record = event as { type?: string; toolName?: unknown };
            if (record.type === "tool_execution_start") {
              touch(run, { current_tool: String(record.toolName ?? "") });
            }
            if (record.type === "tool_execution_end") {
              touch(run, { current_tool: undefined });
            }
          },
        });
        if (run.summary.status !== "running") {
          await run.handle.dispose().catch(() => {});
          run.handle = null;
          return;
        }
      }
      // Children never own the root interaction lifecycle: their asks resolve
      // internally so a child cannot strand the parent waiting on a user.
      await autoResolveInteractions(() => run.handle!.session.prompt(prompt));
      if (run.summary.status !== "running") return;
      const result = {
        messages: [...run.handle.session.messages],
      };
      const error = promptResultError(result);
      if (error) throw new Error(error);
      const output = promptResultText(result);
      touch(run, {
        status: "completed",
        output,
        completed_at: Date.now(),
      });
    } catch (err) {
      if (run.summary.status !== "running") return;
      touch(run, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        completed_at: Date.now(),
      });
    } finally {
      releaseSlot();
    }
  }

  return {
    list(): AgentRunSummary[] {
      return [...runs.values()].map((run) => run.summary);
    },

    get(id: string): AgentRunSummary | null {
      return runs.get(id)?.summary ?? null;
    },

    async start(input): Promise<AgentRunSummary> {
      const id = `agent-run-${randomUUID().slice(0, 8)}`;
      const run: ChildRun = {
        summary: {
          agent_run_id: id,
          invocation_name: input.name,
          agent_name: input.name,
          label: input.label ?? input.prompt.slice(0, 80),
          prompt: input.prompt,
          status: "running",
          started_at: Date.now(),
          last_activity_at: Date.now(),
        },
        handle: null,
        settled: Promise.resolve(),
        onUpdate: input.onUpdate,
        waiters: [],
      };
      runs.set(id, run);
      run.settled = executePrompt(run, input.prompt);
      return run.summary;
    },

    async wait(id: string, signal?: AbortSignal): Promise<AgentRunSummary> {
      const run = requireRun(id);
      if (run.summary.status !== "running") return run.summary;
      if (signal?.aborted) {
        throw signal.reason ?? new Error("wait aborted");
      }
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = run.waiters.indexOf(wake);
          if (index >= 0) run.waiters.splice(index, 1);
          reject(signal?.reason ?? new Error("wait aborted"));
        };
        run.waiters.push(wake);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      return run.summary;
    },

    async message(id: string, message: string): Promise<AgentRunSummary> {
      const run = requireRun(id);
      if (run.summary.status === "closed") {
        throw new Error(`Agent run is closed: ${id}`);
      }
      if (run.summary.status === "running" && !run.handle) {
        await run.settled;
      }
      if (run.summary.status === "running" && run.handle) {
        await run.handle.session.steer(message);
        touch(run, {});
        return run.summary;
      }
      // A terminal (completed/failed/interrupted) child accepts a follow-up
      // turn on its existing session.
      touch(run, {
        status: "running" satisfies AgentRunStatus,
        completed_at: undefined,
        error: undefined,
        output: undefined,
        output_preview: undefined,
        current_tool: undefined,
      });
      run.settled = executePrompt(run, message);
      return run.summary;
    },

    async interrupt(id: string): Promise<AgentRunSummary> {
      const run = requireRun(id);
      if (run.summary.status === "running") {
        touch(run, { status: "interrupted", completed_at: Date.now() });
        await run.handle?.session.abort().catch(() => {});
      }
      return run.summary;
    },

    async close(id: string): Promise<AgentRunSummary> {
      const run = requireRun(id);
      if (run.summary.status !== "closed") {
        touch(run, {
          status: "closed",
          completed_at: run.summary.completed_at ?? Date.now(),
        });
        await run.handle?.session.abort().catch(() => {});
      }
      await run.handle?.dispose().catch(() => {});
      run.handle = null;
      await run.settled.catch(() => {});
      return run.summary;
    },

    async shutdown(): Promise<void> {
      await Promise.all(
        [...runs.values()]
          .filter((run) => run.summary.status !== "closed")
          .map((run) => this.close(run.summary.agent_run_id).then(() => undefined))
      );
    },
  };
}

/** A controller for sessions whose recipe declares no subagents. */
export function inertRunController(): AgentRunController {
  return {
    list: () => [],
    get: () => null,
    async start() {
      throw new Error("This recipe declares no subagents");
    },
    async wait(id: string) {
      throw new RunNotFoundError(id);
    },
    async message(id: string) {
      throw new RunNotFoundError(id);
    },
    async interrupt(id: string) {
      throw new RunNotFoundError(id);
    },
    async close(id: string) {
      throw new RunNotFoundError(id);
    },
    async shutdown() {},
  };
}
