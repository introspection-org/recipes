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
  "running" | "completed" | "failed" | "interrupted" | "closed";

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
  /** The run's latest tool call in short form, e.g. `bash npm test`. */
  latest_tool_call?: string;
  /** Tool calls the run has started so far. */
  tool_call_count?: number;
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
  event: AgentRunEvent,
) => void | Promise<void>;

/** Notify a host observer without allowing it to interrupt the child run. */
export function notifyAgentRunEvent(
  observer: AgentRunEventObserver | undefined,
  event: AgentRunEvent,
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
    ]),
  ),
  name: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  id: Type.Optional(
    Type.String({ description: "The run id `start` returned." }),
  ),
  ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "With wait: several run ids `start` returned; returns when all of them have settled.",
    }),
  ),
  message: Type.Optional(Type.String()),
  wait: Type.Optional(
    Type.Boolean({
      description: "With start: return the child's result in this call.",
    }),
  ),
});

type AgentToolInput = Static<typeof AgentToolParams>;

function terminal(run: AgentRunSummary): boolean {
  return run.status !== "running";
}

/** The run id leads; the agent and label only describe it. */
function runLine(run: AgentRunSummary): string {
  return `run ${run.agent_run_id} (${run.agent_name}: ${run.label}) [${run.status}]`;
}

/** Longest tool call shown in a progress line. */
const TOOL_CALL_CHARS = 80;

/** The argument that says what a tool call does, in order of preference. */
const TOOL_CALL_SUBJECT_KEYS = [
  "command",
  "path",
  "file_path",
  "pattern",
  "query",
  "url",
  "name",
] as const;

/**
 * A tool call in short form for progress output: the tool name and the
 * argument that says what it does, on one line, e.g. `bash npm test` or
 * `write tests/test.sh`.
 */
export function describeToolCall(toolName: string, args: unknown): string {
  const record =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const subject = TOOL_CALL_SUBJECT_KEYS.map((key) => record[key]).find(
    (value): value is string =>
      typeof value === "string" && value.trim() !== "",
  );
  const text = (subject ? `${toolName} ${subject}` : toolName)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > TOOL_CALL_CHARS
    ? `${text.slice(0, TOOL_CALL_CHARS - 1)}…`
    : text;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** Longest label shown in a progress line. */
const PROGRESS_LABEL_CHARS = 40;

/** The run's agent, with its label when the label tells concurrent runs apart. */
function progressName(run: AgentRunSummary): string {
  const label = run.label?.replace(/\s+/g, " ").trim();
  if (!label || label === run.agent_name) return run.agent_name;
  const short =
    label.length > PROGRESS_LABEL_CHARS
      ? `${label.slice(0, PROGRESS_LABEL_CHARS - 1)}…`
      : label;
  return `${run.agent_name} (${short})`;
}

/**
 * One line of progress for a child: its latest tool call, the time since it
 * started, and how many tool calls it has made, e.g.
 * `eval-author: bash python3 checks.py · 1m 5s · 7 tool calls`. A settled
 * child shows its status in place of the tool call, and its run time.
 */
export function formatAgentProgress(
  run: AgentRunSummary,
  now: number = Date.now(),
): string {
  const count = run.tool_call_count ?? 0;
  const settled = terminal(run);
  const activity = settled ? run.status : (run.latest_tool_call ?? "starting");
  const end = settled ? (run.completed_at ?? run.last_activity_at) : now;
  return [
    `${progressName(run)}: ${activity}`,
    formatElapsed(end - run.started_at),
    `${count} tool call${count === 1 ? "" : "s"}`,
  ].join(" · ");
}

/** One progress line per run, in the order given. */
export function formatAgentsProgress(
  runs: readonly AgentRunSummary[],
  now: number = Date.now(),
): string {
  return runs.map((run) => formatAgentProgress(run, now)).join("\n");
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
  if (
    run.current_tool &&
    !nestedTools.some((tool) => tool.toolName === run.current_tool)
  ) {
    nestedTools.push({
      toolName: run.current_tool,
      verb: run.current_tool,
      detail: "",
    });
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
    finishReason:
      run.status === "completed" ? "stop" : (run.error ?? run.status),
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

function unknownRun(id: string, controller: AgentRunController) {
  return errorResult(
    `Unknown agent run ${id}: use the run id \`start\` returned.`,
    controller,
  );
}

const UNKNOWN_RUN = /unknown agent run|agent run not found/i;

/** How often a wait over run ids re-reads them for progress updates. */
const WAIT_PROGRESS_POLL_MS = 1000;

export interface AgentToolOptions {
  acknowledgeCompletions?(ids: readonly string[]): void;
  /** A run started without `wait`: it works in the background. */
  onBackgroundRun?(run: AgentRunSummary): void;
  /**
   * The tool starts (`true`) or stops (`false`) waiting on these runs, whose
   * progress its own partial results then show.
   */
  onWait?(ids: readonly string[], waiting: boolean): void;
}

export function createAgentTool(
  controller: AgentRunController,
  agents: ReadonlyMap<string, unknown>,
  opts: AgentToolOptions = {},
): ToolDefinition {
  const closedRunIds = new Set<string>();
  const acknowledge = (run: AgentRunSummary) => {
    if (terminal(run)) opts.acknowledgeCompletions?.([run.agent_run_id]);
  };
  return defineTool({
    name: "agent",
    label: "Agent",
    description: [
      "Start or manage child agents.",
      "Omit action to start one child with name and prompt; it returns a run id at once. Its result reaches you when it finishes: carry on or end your turn.",
      "For a short check whose answer you need now, pass wait: true to get the result in the same call, or use wait with the run id, or with ids to wait for several runs at once.",
      `Available agent roles: ${[...agents.keys()].join(", ")}. Pass a role as name; use label to distinguish concurrent runs.`,
      "Use status, message, interrupt, or close with the run id `start` returned.",
      "Message steers a running child at the next message boundary; on a settled child it resumes the same session.",
    ].join(" "),
    parameters: AgentToolParams,
    async execute(_callId, rawParams, signal, onUpdate) {
      const params = rawParams as AgentToolInput;
      try {
        if (!params.action || params.action === "start") {
          if (!params.name || !params.prompt) {
            return errorResult(
              "Starting an agent requires name and prompt.",
              controller,
            );
          }
          if (!agents.has(params.name)) {
            return errorResult(
              `Unknown agent "${params.name}". Available: ${[...agents.keys()].join(", ")}`,
              controller,
            );
          }
          const run = await controller.start({
            name: params.name,
            prompt: params.prompt,
            label: params.label,
            onUpdate(update) {
              return onUpdate?.({
                content: [
                  {
                    type: "text" as const,
                    // A background run's updates reach hosts as details only:
                    // its tool call has already returned.
                    text:
                      params.wait && !terminal(update)
                        ? formatAgentProgress(update)
                        : "",
                  },
                ],
                details: { agent: update, subtasks: [subtask(update)] },
              });
            },
          });
          if (params.wait) return await waitFor(run, signal);
          try {
            opts.onBackgroundRun?.(run);
          } catch {
            // Showing background progress is cosmetic.
          }
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
        if (params.action === "wait" && params.ids?.length) {
          return await waitForMany(
            [...new Set([...(params.id ? [params.id] : []), ...params.ids])],
            signal,
            onUpdate,
          );
        }
        if (!params.id)
          return errorResult(`${params.action} requires id`, controller);
        if (closedRunIds.has(params.id)) {
          return errorResult(
            `Agent run already closed: ${params.id}`,
            controller,
          );
        }

        if (params.action === "status") {
          const run = controller.get(params.id);
          if (!run) return unknownRun(params.id, controller);
          acknowledge(run);
          return result(run, statusBlock(run));
        }
        if (params.action === "wait") {
          return await waitForMany([params.id], signal, onUpdate);
        }
        if (params.action === "message") {
          if (!params.message)
            return errorResult("message requires message", controller);
          const run = await controller.message(params.id, params.message);
          return result(run, `Sent message to ${runLine(run)}`);
        }
        if (params.action === "interrupt") {
          const run = await controller.interrupt(params.id);
          if (run.status !== "interrupted") {
            return result(
              run,
              `No interrupt sent: ${runLine(run)} is already ${run.status}.`,
            );
          }
          return result(run, `Interrupted ${runLine(run)}`);
        }
        const run = await controller.close(params.id);
        closedRunIds.add(params.id);
        opts.acknowledgeCompletions?.([params.id]);
        return result(run, `Closed ${runLine(run)}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          params.id &&
          UNKNOWN_RUN.test(message) &&
          !controller.get(params.id)
        ) {
          return unknownRun(params.id, controller);
        }
        return errorResult(
          `Agent ${params.action ?? "start"} failed: ${message}`,
          controller,
        );
      }
    },
  });

  /**
   * Block until every run settles, sending a partial result with one progress
   * line per run whenever one of them moves: plain-text hosts read the lines,
   * RPC hosts the summaries in `details.agents`. One id keeps the single-run
   * result shape. An abort stops the wait, never the runs.
   */
  async function waitForMany(
    ids: string[],
    signal: AbortSignal | undefined,
    onUpdate:
      | ((update: {
          content: Array<{ type: "text"; text: string }>;
          details: unknown;
        }) => unknown)
      | undefined,
  ) {
    for (const id of ids) {
      if (closedRunIds.has(id)) {
        return errorResult(`Agent run already closed: ${id}`, controller);
      }
    }
    let lastProgress = "";
    const report = () => {
      const runs = ids
        .map((id) => controller.get(id))
        .filter((run): run is AgentRunSummary => run !== null);
      if (!runs.some((run) => !terminal(run))) return;
      // Elapsed time moves on its own; a host redraws it between changes.
      const progress = JSON.stringify(
        runs.map((run) => [
          run.status,
          run.latest_tool_call,
          run.tool_call_count,
        ]),
      );
      if (progress === lastProgress) return;
      lastProgress = progress;
      try {
        void Promise.resolve(
          onUpdate?.({
            content: [
              { type: "text" as const, text: formatAgentsProgress(runs) },
            ],
            details: {
              ...(ids.length === 1 ? { agent: runs[0] } : { agents: runs }),
              subtasks: runs.map(subtask),
            },
          }),
        ).catch(() => {});
      } catch {
        // A progress update must not fail the wait.
      }
    };
    report();
    const poll = onUpdate
      ? setInterval(report, WAIT_PROGRESS_POLL_MS)
      : undefined;
    poll?.unref?.();
    opts.onWait?.(ids, true);
    try {
      if (ids.length === 1) return await waitFor(ids[0]!, signal);
      const runs = await Promise.all(
        ids.map(async (id) => {
          try {
            return await controller.wait(id, signal);
          } catch (error) {
            const fallback = controller.get(id);
            if (!signal?.aborted || !fallback) throw error;
            return fallback;
          }
        }),
      );
      runs.forEach(acknowledge);
      const text = runs
        .map((run) =>
          terminal(run)
            ? statusBlock(run)
            : `Stopped waiting: ${runLine(run)} keeps working; its result reaches you when it finishes.`,
        )
        .join("\n\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { agents: runs, subtasks: runs.map(subtask) },
      };
    } finally {
      if (poll) clearInterval(poll);
      opts.onWait?.(ids, false);
    }
  }

  /**
   * Block until the run settles. An abort stops the wait, never the run: it
   * keeps working and its result is pushed when it finishes.
   */
  async function waitFor(
    target: string | AgentRunSummary,
    signal: AbortSignal | undefined,
  ) {
    const id = typeof target === "string" ? target : target.agent_run_id;
    let run: AgentRunSummary;
    try {
      run = await controller.wait(id, signal);
    } catch (error) {
      const fallback =
        controller.get(id) ?? (typeof target === "string" ? null : target);
      if (!signal?.aborted || !fallback) throw error;
      run = fallback;
    }
    if (!terminal(run)) {
      return result(
        run,
        `Stopped waiting: ${runLine(run)} keeps working; its result reaches you when it finishes.`,
      );
    }
    acknowledge(run);
    return result(run, statusBlock(run));
  }
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
    send: (input: string) => Promise<boolean | void>,
  ): Promise<void>;
  /** End the loop and interrupt every run the session started. */
  interrupt(session: { agentRuns?: AgentRunController }): Promise<void>;
}

export function createDelegatedRuns(): DelegatedRuns {
  // A run resumed with `message` keeps its id, and its next result is new: a
  // result is keyed by run and by when the run last did anything, which every
  // controller reports and new work always moves.
  const completion = (run: AgentRunSummary) =>
    `${run.agent_run_id}@${run.last_activity_at}@${run.completed_at ?? ""}`;
  const seen = new Set<string>();
  let runs: AgentRunController | undefined;
  let stopped = false;
  const own = () => runs?.list() ?? [];
  const interruptOwn = async () => {
    await Promise.all(
      own()
        .filter((run) => run.status === "running")
        .map((run) => runs!.interrupt(run.agent_run_id).catch(() => {})),
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
                runs!.wait(run.agent_run_id).catch(() => undefined),
              ),
            );
            if (stopped) return;
            running = own().filter((run) => run.status === "running");
          }
          const unseen = own().filter(
            (run) =>
              (run.status === "completed" || run.status === "failed") &&
              !seen.has(completion(run)),
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
    agent: run.agent_name,
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
