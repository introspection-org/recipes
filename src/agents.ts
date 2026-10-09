import {
  defineTool,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  OUTPUT_PREVIEW_CHARS,
  renderCompletionNotice,
  type ChildCompletionEnvelope,
} from "./child/agent-completions.js";

/** Portable lifecycle contract for Recipe agent runs. */
export type AgentRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "closed";

export interface AgentNestedToolSummary {
  toolName: string;
  verb: string;
  detail: string;
  toolInput?: Record<string, unknown>;
}

export interface AgentRunSummary {
  agent_run_id: string;
  invocation_name: string;
  agent_name: string;
  label: string;
  prompt: string;
  status: AgentRunStatus;
  started_at: number;
  completed_at?: number;
  last_activity_at: number;
  current_tool?: string;
  nested_tools?: AgentNestedToolSummary[];
  output_preview?: string;
  output?: string;
  error?: string;
}

/**
 * Deepest delegated run. The root session is depth 0, its children depth 1,
 * their children depth 2. A session at this depth never receives the `agent`
 * tool, which also bounds recursive subagent references (a -> b -> a).
 */
export const MAX_AGENT_RUN_DEPTH = 2;

/** Pi custom-entry type carrying one child run event. */
export const AGENT_RUN_EVENT_ENTRY_TYPE = "agent_run_event";

/** One canonical Pi event attributed to the child run that emitted it. */
export interface AgentRunEvent {
  type: typeof AGENT_RUN_EVENT_ENTRY_TYPE;
  agent_run_id: string;
  parent_agent_run_id: string | null;
  agent_name: string;
  invocation_name: string;
  depth: number;
  event: AgentSessionEvent;
}

/** Host observer for child run events. Observers never own run lifecycle. */
export type AgentRunEventObserver = (
  event: AgentRunEvent
) => void | Promise<void>;

/** Notify a host observer without allowing it to interrupt the child run. */
export function notifyAgentRunEvent(
  observer: AgentRunEventObserver | undefined,
  event: AgentRunEvent
): void {
  if (!observer) return;
  try {
    void Promise.resolve(observer(event)).catch(() => {});
  } catch {
    // Observation is detached from execution. A host hook must not turn a
    // successful child event into a failed delegated run.
  }
}

export interface AgentRunController {
  list(): AgentRunSummary[];
  get(id: string): AgentRunSummary | null;
  start(input: {
    name: string;
    prompt: string;
    label?: string;
    onUpdate?: (summary: AgentRunSummary) => void | Promise<void>;
  }): Promise<AgentRunSummary>;
  wait(id: string, signal?: AbortSignal): Promise<AgentRunSummary>;
  message(id: string, message: string): Promise<AgentRunSummary>;
  interrupt(id: string): Promise<AgentRunSummary>;
  close(id: string): Promise<AgentRunSummary>;
  /** Release every run and resource owned by this session's controller. */
  shutdown(): Promise<void>;
}

const AgentToolParams = Type.Object({
  action: Type.Optional(
    Type.Union([
      Type.Literal("start"),
      Type.Literal("status"),
      Type.Literal("wait"),
      Type.Literal("message"),
      Type.Literal("interrupt"),
      Type.Literal("close"),
    ])
  ),
  name: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
});

type AgentToolInput = Static<typeof AgentToolParams>;

function terminal(run: AgentRunSummary): boolean {
  return run.status !== "running";
}

function runLine(run: AgentRunSummary): string {
  return `${run.invocation_name} (${run.agent_run_id}) — ${run.label} [${run.status}]`;
}

function statusBlock(run: AgentRunSummary): string {
  if (!terminal(run)) return runLine(run);
  const output =
    run.output?.trim() ||
    (run.error ? `Agent failed: ${run.error}` : `Agent ${run.status}.`);
  return `${runLine(run)}\n${output}`;
}

function subtask(run: AgentRunSummary) {
  const nestedTools = [...(run.nested_tools ?? [])];
  if (run.current_tool && !nestedTools.some((tool) => tool.toolName === run.current_tool)) {
    nestedTools.push({ toolName: run.current_tool, verb: run.current_tool, detail: "" });
  }
  return {
    agentName: run.invocation_name,
    label: run.label,
    task: run.prompt,
    nestedTools,
    transcript: run.output_preview
      ? [{ type: "assistant" as const, text: run.output_preview }]
      : [],
    status: terminal(run) ? ("completed" as const) : ("running" as const),
    finishReason: run.status === "completed" ? "stop" : run.error ?? run.status,
    startedAt: run.started_at,
    completedAt: run.completed_at,
  };
}

function result(run: AgentRunSummary, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { agent: run, subtasks: [subtask(run)] },
  };
}

function errorResult(text: string, controller: AgentRunController) {
  return {
    content: [{ type: "text" as const, text }],
    details: { agents: controller.list() },
    isError: true,
  };
}

export function createAgentTool(
  controller: AgentRunController,
  agents: ReadonlyMap<string, unknown>,
  opts: { acknowledgeCompletions?(ids: readonly string[]): void } = {}
): ToolDefinition {
  const closedRunIds = new Set<string>();
  const acknowledge = (run: AgentRunSummary) => {
    if (terminal(run)) opts.acknowledgeCompletions?.([run.agent_run_id]);
  };
  return defineTool({
    name: "agent",
    label: "Agent",
    description: [
      "Start or manage background child agents.",
      "Omit action to start one child with name and prompt; it returns a run id immediately.",
      `Available agent roles: ${[...agents.keys()].join(", ")}. Pass a role as name; use label to distinguish concurrent runs.`,
      "Use status, wait, message, interrupt, or close with that id.",
      "Message steers a running child at the next message boundary; on a settled child it resumes the same session.",
    ].join(" "),
    parameters: AgentToolParams,
    async execute(_callId, rawParams, signal, onUpdate) {
      const params = rawParams as AgentToolInput;
      try {
        if (!params.action || params.action === "start") {
          if (!params.name || !params.prompt) {
            return errorResult("Starting an agent requires name and prompt.", controller);
          }
          if (!agents.has(params.name)) {
            return errorResult(
              `Unknown agent "${params.name}". Available: ${[...agents.keys()].join(", ")}`,
              controller
            );
          }
          const run = await controller.start({
            name: params.name,
            prompt: params.prompt,
            label: params.label,
            onUpdate(update) {
              return onUpdate?.({
                content: [{ type: "text" as const, text: "" }],
                details: { subtasks: [subtask(update)] },
              });
            },
          });
          return result(run, `Started ${runLine(run)}`);
        }

        if (params.action === "status" && !params.id) {
          const runs = controller.list();
          runs.forEach(acknowledge);
          return {
            content: [
              {
                type: "text" as const,
                text: runs.length
                  ? runs.map(statusBlock).join("\n\n")
                  : "No agent runs.",
              },
            ],
            details: { agents: runs, subtasks: runs.map(subtask) },
          };
        }
        if (!params.id) return errorResult(`${params.action} requires id`, controller);
        if (closedRunIds.has(params.id)) {
          return errorResult(`Agent run already closed: ${params.id}`, controller);
        }

        if (params.action === "status") {
          const run = controller.get(params.id);
          if (!run) return errorResult(`Unknown agent run: ${params.id}`, controller);
          acknowledge(run);
          return result(run, statusBlock(run));
        }
        if (params.action === "wait") {
          const run = await controller.wait(params.id, signal);
          acknowledge(run);
          return result(run, statusBlock(run));
        }
        if (params.action === "message") {
          if (!params.message) return errorResult("message requires message", controller);
          const run = await controller.message(params.id, params.message);
          return result(run, `Sent message to ${runLine(run)}`);
        }
        if (params.action === "interrupt") {
          const run = await controller.interrupt(params.id);
          if (run.status !== "interrupted") {
            return result(
              run,
              `No interrupt sent: ${runLine(run)} is already ${run.status}.`
            );
          }
          return result(run, `Interrupted ${runLine(run)}`);
        }
        const run = await controller.close(params.id);
        closedRunIds.add(params.id);
        opts.acknowledgeCompletions?.([params.id]);
        return result(run, `Closed ${runLine(run)}`);
      } catch (error) {
        return errorResult(
          `Agent ${params.action ?? "start"} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          controller
        );
      }
    },
  });
}

/**
 * The runs a delegated session starts, settled before its result is read.
 * A session's turn can end while runs it started in the background are still
 * working; `run` prompts it, waits for those runs, then prompts it again with
 * the results it has not read, until nothing is outstanding. Each prompt has
 * fully settled before the next, so nothing is queued during turn teardown.
 *
 * Pass `agentToolOptions` when creating the session, so results it reads
 * through the `agent` tool (wait, a terminal status) are not handed to it
 * again.
 */
export interface DelegatedRuns {
  readonly agentToolOptions: {
    acknowledgeCompletions(ids: readonly string[]): void;
  };
  /**
   * `send` prompts the session once; returning `false` ends the loop (a turn
   * that failed). A rejection ends it too, and interrupts the session's runs.
   */
  run(
    session: { agentRuns?: AgentRunController },
    prompt: string,
    send: (input: string) => Promise<boolean | void>
  ): Promise<void>;
  /** End the loop and interrupt every run the session started. */
  interrupt(session: { agentRuns?: AgentRunController }): Promise<void>;
}

export function createDelegatedRuns(): DelegatedRuns {
  // Keyed by run and completion time: a run resumed with `message` keeps its
  // id, and its next result is new.
  const completion = (run: AgentRunSummary) =>
    `${run.agent_run_id}@${run.completed_at ?? ""}`;
  const seen = new Set<string>();
  let runs: AgentRunController | undefined;
  let stopped = false;
  const own = () => runs?.list() ?? [];
  const interruptOwn = async () => {
    await Promise.all(
      own()
        .filter((run) => run.status === "running")
        .map((run) => runs!.interrupt(run.agent_run_id).catch(() => {}))
    );
  };
  return {
    agentToolOptions: {
      acknowledgeCompletions(ids) {
        for (const id of ids) {
          const run = runs?.get(id);
          if (run) seen.add(completion(run));
        }
      },
    },
    async run(session, prompt, send) {
      runs = session.agentRuns;
      stopped = false;
      let next: string | null = prompt;
      let settled = false;
      try {
        while (next !== null) {
          const input: string = next;
          next = null;
          if ((await send(input)) === false || stopped) return;
          let running = own().filter((run) => run.status === "running");
          while (running.length > 0) {
            await Promise.all(
              running.map((run) =>
                runs!.wait(run.agent_run_id).catch(() => undefined)
              )
            );
            if (stopped) return;
            running = own().filter((run) => run.status === "running");
          }
          const unseen = own().filter(
            (run) =>
              (run.status === "completed" || run.status === "failed") &&
              !seen.has(completion(run))
          );
          for (const run of unseen) seen.add(completion(run));
          if (unseen.length > 0)
            next = renderCompletionNotice(unseen.map(completionEnvelope));
        }
        settled = true;
      } finally {
        // A session that errors or stops early leaves no run working for it.
        if (!settled) await interruptOwn();
      }
    },
    async interrupt(session) {
      stopped = true;
      runs = session.agentRuns ?? runs;
      await interruptOwn();
    },
  };
}

function completionEnvelope(run: AgentRunSummary): ChildCompletionEnvelope {
  const completed = run.completed_at;
  return {
    id: run.agent_run_id,
    agent: run.invocation_name,
    label: run.label,
    status: run.status === "failed" ? "failed" : "completed",
    ...(run.output
      ? { output_preview: run.output.slice(0, OUTPUT_PREVIEW_CHARS) }
      : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(completed !== undefined && completed >= run.started_at
      ? { duration_ms: completed - run.started_at }
      : {}),
  };
}
