import {
  defineTool,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

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

/**
 * Retention rule every implementation honors: a run's `output` is eligible
 * to be reused as another dispatch's leading context (see `start`'s
 * `continue` input) only when that run's terminal `status` is
 * `"completed"`. A `"failed"`, `"interrupted"`, or `"closed"` run's output
 * must never be treated as reusable context — a controller that reuses it
 * anyway is violating this contract, not exercising an implementation
 * choice.
 */
export interface AgentRunController {
  list(): AgentRunSummary[];
  get(id: string): AgentRunSummary | null;
  start(input: {
    name: string;
    prompt: string;
    label?: string;
    /**
     * Resolve the most recent `status === "completed"` run for `name` (per
     * the retention rule above) and prepend its output as a leading
     * `<prior_episode>` block ahead of `prompt`, before the new run starts.
     * No prior completed run for `name` (first dispatch, or every prior
     * dispatch failed) behaves identically to omitting this flag. Default
     * `false`/omitted: every `start()` is independent, unchanged from
     * today's behavior.
     */
    continue?: boolean;
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
  continue: Type.Optional(Type.Boolean()),
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
      "Pass continue: true on start to build on that role's own most recent successful run, if one exists; omit it to start independent of any prior run.",
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
            continue: params.continue,
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
