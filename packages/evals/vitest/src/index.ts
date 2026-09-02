import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  createJudge,
  createHarness,
  type JsonValue,
  type NormalizedSession,
  type TranscriptEvent,
} from "vitest-evals";

const RUN_SPEC_ENV = "INTROSPECTION_EVAL_RUN_SPEC";

export type RecipeCase<TExpected = unknown, TInput extends RecipeEvalInput = RecipeEvalInput> = {
  input: TInput;
  expected?: TExpected;
  [key: string]: unknown;
};

export type RecipeEvalInput = {
  prompt: string;
  history?: RecipeHistoryEvent[];
  [key: string]: unknown;
};

export type RecipeHistoryEvent =
  | {
      type: "message";
      role: "user" | "assistant";
      content: string;
      timestamp?: string;
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments?: JsonValue;
      timestamp?: string;
    }
  | {
      type: "tool_result";
      tool_call_id: string;
      name?: string;
      content?: JsonValue;
      error?: { type: string; message: string };
      timestamp?: string;
    };

type RunSpec = {
  schema_version: 2;
  runner: "evalite" | "vitest" | "harbor";
  candidate: {
    runtime: string;
    agent?: string;
    model?: string;
  };
  input: {
    prompt?: string;
    history?: RecipeHistoryEvent[];
    replay_context_path?: string;
    metadata?: unknown;
  };
};

export type RecipeRunScope = {
  id: string;
  parentId: string | null;
  agentName: string;
  invocationName: string;
  depth: number;
};

export type RecipeEvalEvent = Record<string, unknown> & {
  run: RecipeRunScope;
};

export type RecipeToolCall = {
  id: string;
  name: string;
  arguments: unknown;
  result?: unknown;
  run: RecipeRunScope;
};

export type RecipeEvalResult = {
  output: string;
  toolCalls: RecipeToolCall[];
  events: RecipeEvalEvent[];
  completion: {
    reason?: string;
    error?: string;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsd: number;
  };
  observedModel?: string;
};

export type RecipeHarnessContext<TInput extends RecipeEvalInput> = {
  input: TInput;
  prompt: string;
  signal?: AbortSignal;
};

export type RecipeHarnessResultContext<TInput extends RecipeEvalInput> =
  RecipeHarnessContext<TInput> & {
    result: RecipeEvalResult;
  };

export type CreateRecipeHarnessOptions<TInput extends RecipeEvalInput = RecipeEvalInput> = {
  name?: string;
  /**
   * Render the application-visible user message from a typed eval input.
   *
   * Recipe-owned system instructions are still resolved by `introspection
   * local`. Use this only for context that the application normally adds to
   * the user message before starting a turn.
   */
  renderPrompt?: (input: TInput) => string;
  /** @deprecated Use `renderPrompt` for new evals. */
  prompt?: (input: TInput) => string;
  beforeRun?: (context: RecipeHarnessContext<TInput>) => void | Promise<void>;
  collectArtifacts?: (
    context: RecipeHarnessResultContext<TInput>,
  ) => Record<string, JsonValue> | Promise<Record<string, JsonValue>>;
};

type RecipeJudgeVerdict = {
  schema_version: number;
  judge: string;
  provider: string;
  model: string;
  verdict: "pass" | "fail" | "not_applicable";
  reasoning?: string | null;
  usage?: JsonValue;
  engine?: JsonValue;
};

type JudgeInput = {
  schema_version: 2;
  trajectory: JsonValue[];
  system_instructions?: string;
};

/**
 * Use a Recipe-owned YAML judge in a Vitest eval.
 *
 * `reference` may be the judge's YAML `name` or an explicit YAML path. Names
 * are resolved from the current Recipe's `judges/` directory by the CLI, so
 * eval files can move without breaking their judge references.
 */
export function recipeJudge<
  TInput extends RecipeEvalInput = RecipeEvalInput,
>(reference: string) {
  const normalizedReference = reference.trim();
  if (!normalizedReference) {
    throw new Error("recipeJudge requires a judge name or YAML path");
  }
  return createJudge<TInput, string>(
    judgeLabel(normalizedReference),
    async ({ session, run: harnessRun }) => {
      const input = judgeInput(session, harnessRun.usage?.model);
      const { stdout, stderr, code } = await run(
        process.env.INTROSPECTION_CLI ?? "introspection",
        [
          "judges",
          "evaluate",
          "--judge",
          normalizedReference,
          "--input",
          "-",
          "--output",
          "json",
        ],
        undefined,
        JSON.stringify(input),
      );
      if (code !== 0) {
        throw new Error(
          `Recipe judge ${normalizedReference} could not be evaluated:\n${failureOutput(stdout, stderr)}`,
        );
      }
      const verdict = parseJudgeVerdict(stdout, normalizedReference);
      if (verdict.verdict === "not_applicable") {
        throw new Error(
          `Recipe judge ${verdict.judge} did not apply to this eval trajectory`,
        );
      }
      return {
        score: verdict.verdict === "pass" ? 1 : 0,
        metadata: {
          rationale: verdict.reasoning ?? `Judge returned ${verdict.verdict}`,
          output: jsonValue(verdict),
        },
      };
    },
  );
}

export function recipeCases(reference: string): RecipeCase[];
export function recipeCases<
  TInput extends RecipeEvalInput,
  TCase extends RecipeCase<unknown, TInput>,
>(cases: readonly TCase[]): TCase[];
export function recipeCases<
  TInput extends RecipeEvalInput,
  TCase extends RecipeCase<unknown, TInput>,
>(source: readonly TCase[] | string): TCase[] {
  const cases = typeof source === "string"
    ? loadRecipeCases(source) as TCase[]
    : [...source];
  const spec = readRunSpec();
  if (!spec || !("prompt" in spec.input)) return [...cases];
  const baseline = cases[0];
  if (!baseline) {
    throw new Error(
      "recipeCases requires one authored case whose expected value defines the assertion contract",
    );
  }
  return [
    {
      ...baseline,
      input: {
        ...baseline.input,
        prompt: spec.input.prompt,
        ...(spec.input.history ? { history: spec.input.history } : {}),
        introspectionMetadata: spec.input.metadata,
      },
    },
  ];
}

function loadRecipeCases(reference: string): RecipeCase[] {
  const normalized = reference.trim();
  if (!normalized) throw new Error("recipeCases requires a suite name or JSONL path");
  const path = resolveRecipeCasesPath(normalized);
  const rows = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${index + 1} is not valid JSON: ${String(error)}`);
      }
      const row = record(value);
      const input = record(row?.input);
      if (
        !row || row.schema_version !== 2 || typeof row.name !== "string" ||
        !row.name.trim() || !input || typeof input.prompt !== "string" ||
        !input.prompt.trim()
      ) {
        throw new Error(
          `${path}:${index + 1} must contain schema_version 2, name, and input.prompt`,
        );
      }
      if (
        input.history !== undefined &&
        (!Array.isArray(input.history) || !input.history.every(isRecipeHistoryEvent))
      ) {
        throw new Error(`${path}:${index + 1} input.history is not a valid trajectory`);
      }
      return row as RecipeCase;
    });
  if (!rows.length) throw new Error(`${path} has no eval cases`);
  return rows;
}

function resolveRecipeCasesPath(reference: string): string {
  if (reference.includes("/") || reference.endsWith(".jsonl")) return reference;
  const canonical = join("evals", "vitest", `${reference}.eval.jsonl`);
  if (existsSync(canonical)) return canonical;
  const besideSuite = `${reference}.eval.jsonl`;
  return existsSync(besideSuite) ? besideSuite : canonical;
}

function isRecipeHistoryEvent(value: unknown): value is RecipeHistoryEvent {
  const event = record(value);
  if (!event) return false;
  if (event.timestamp !== undefined && typeof event.timestamp !== "string") return false;
  if (event.type === "message") {
    return (event.role === "user" || event.role === "assistant") &&
      typeof event.content === "string";
  }
  if (event.type === "tool_call") {
    return typeof event.id === "string" && typeof event.name === "string";
  }
  if (event.type === "tool_result") {
    const error = event.error === undefined ? undefined : record(event.error);
    return typeof event.tool_call_id === "string" &&
      (event.name === undefined || typeof event.name === "string") &&
      (error === undefined ||
        (typeof error.type === "string" && typeof error.message === "string"));
  }
  return false;
}

export function createRecipeHarness<TInput extends RecipeEvalInput = RecipeEvalInput>(
  options: CreateRecipeHarnessOptions<TInput> = {},
) {
  if (options.renderPrompt && options.prompt) {
    throw new Error("createRecipeHarness accepts renderPrompt or prompt, not both");
  }
  const promptFor = options.renderPrompt ?? options.prompt ?? ((input: TInput) => input.prompt);
  return createHarness<TInput, string>({
    name: options.name ?? "introspection-recipe",
    run: async ({ input, signal }) => {
      const spec = readRunSpec();
      const prompt = spec?.input.prompt ?? promptFor(input);
      const history = spec?.input.history ?? input.history ?? [];
      if (!prompt?.trim()) throw new Error("Recipe case input.prompt must not be empty");
      const context = { input, prompt, signal };
      await options.beforeRun?.(context);
      const result = await runRecipe(
        { prompt, history },
        { signal },
      );
      const customArtifacts = await options.collectArtifacts?.({ ...context, result });
      const [provider, model] = splitModel(result.observedModel);
      return {
        output: result.output,
        events: recipeTranscript(history, prompt, result.events),
        usage: {
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.inputTokens + result.usage.outputTokens,
          toolCalls: result.toolCalls.length,
          metadata: {
            cachedTokens: result.usage.cachedTokens,
            costUsd: result.usage.costUsd,
          },
        },
        artifacts: {
          completion: jsonValue(result.completion),
          piEvents: jsonValue(result.events),
          ...(customArtifacts ?? {}),
        },
      };
    },
  });
}

export async function runRecipe(
  input: { prompt: string; history?: RecipeHistoryEvent[] },
  options: { signal?: AbortSignal } = {},
): Promise<RecipeEvalResult> {
  const spec = readRunSpec();
  if (!input.prompt?.trim()) throw new Error("Recipe case input.prompt must not be empty");

  const args = ["local"];
  if (spec) args.push("--runtime", spec.candidate.runtime);
  if (spec?.candidate.agent) args.push("--agent", spec.candidate.agent);
  args.push("--print", input.prompt, "--mode", "json");
  const temporaryReplay = !spec?.input.replay_context_path && input.history?.length
    ? writeReplayContext(input.history)
    : undefined;
  const replayContext = spec?.input.replay_context_path ?? temporaryReplay?.path;
  if (replayContext) args.push("--replay-context", replayContext);

  let stdout: string;
  let stderr: string;
  let code: number;
  try {
    ({ stdout, stderr, code } = await run(
      process.env.INTROSPECTION_CLI ?? "introspection",
      args,
      options.signal,
    ));
  } finally {
    temporaryReplay?.cleanup();
  }
  if (code !== 0) {
    throw new Error(`introspection local exited ${code}:\n${failureOutput(stdout, stderr)}`);
  }
  const result = normalizeEvents(stdout, spec?.candidate.agent);
  assertSuccessfulCompletion(result);
  return result;
}

function recipeTranscript(
  history: RecipeHistoryEvent[],
  prompt: string,
  events: RecipeEvalEvent[],
): TranscriptEvent[] {
  const transcript: TranscriptEvent[] = [
    ...history.map(historyTranscriptEvent),
    { type: "message", role: "user", content: prompt },
  ];
  const callNames = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "message_end") continue;
    const message = record(event.message);
    if (!message) continue;
    if (message.role === "assistant") {
      for (const rawBlock of Array.isArray(message.content) ? message.content : []) {
        const block = record(rawBlock);
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") {
          transcript.push({
            type: "message",
            role: "assistant",
            content: block.text,
            metadata: { run: jsonValue(event.run) },
          });
        }
        if (
          block.type === "toolCall" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          const id = scopedCallId(event.run.id, block.id);
          callNames.set(id, block.name);
          transcript.push({
            type: "tool_call",
            id,
            name: block.name,
            ...(jsonObject(block.arguments) ? { arguments: jsonObject(block.arguments) } : {}),
            metadata: { originalId: block.id, run: jsonValue(event.run) },
          });
        }
      }
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const id = scopedCallId(event.run.id, message.toolCallId);
      const content = jsonValue(message.content);
      transcript.push({
        type: "tool_result",
        toolCallId: id,
        ...(callNames.get(id) ? { name: callNames.get(id) } : {}),
        ...(message.isError === true
          ? { error: { type: "ToolError", message: toolResultText(message.content) } }
          : content !== undefined
            ? { content }
            : {}),
        metadata: { originalId: message.toolCallId, run: jsonValue(event.run) },
      });
    }
  }
  return transcript;
}

function historyTranscriptEvent(event: RecipeHistoryEvent): TranscriptEvent {
  if (event.type === "message") {
    return {
      type: "message",
      role: event.role,
      content: event.content,
    };
  }
  if (event.type === "tool_call") {
    return {
      type: "tool_call",
      id: event.id,
      name: event.name,
      arguments: jsonObject(event.arguments) ?? {},
      ...(event.timestamp ? { startedAt: event.timestamp } : {}),
    };
  }
  return {
    type: "tool_result",
    toolCallId: event.tool_call_id,
    ...(event.name ? { name: event.name } : {}),
    ...(event.error
      ? { error: event.error }
      : event.content !== undefined
        ? { content: event.content }
        : {}),
    ...(event.timestamp ? { finishedAt: event.timestamp } : {}),
  };
}

function writeReplayContext(history: RecipeHistoryEvent[]) {
  const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-history-"));
  const path = join(directory, "context.json");
  writeFileSync(path, JSON.stringify({
    schema_version: 2,
    cwd: process.cwd(),
    trajectory: history,
  }), { mode: 0o600 });
  return {
    path,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function normalizeEvents(stdout: string, rootAgent?: string): RecipeEvalResult {
  const wireEvents = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const rootScope: RecipeRunScope = {
    id: "root",
    parentId: null,
    agentName: rootAgent ?? "root",
    invocationName: rootAgent ?? "root",
    depth: 0,
  };
  const events = wireEvents.map((event) => scopedEvent(event, rootScope));
  const calls = new Map<string, RecipeToolCall>();
  const rootModels = new Set<string>();
  let output = "";
  let reason: string | undefined;
  let error: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  for (const event of events) {
    if (event.type !== "message_end") continue;
    const message = record(event.message);
    if (!message) continue;
    if (message.role === "assistant") {
      for (const rawBlock of Array.isArray(message.content) ? message.content : []) {
        const block = record(rawBlock);
        if (!block) continue;
        if (event.run.depth === 0 && block.type === "text" && typeof block.text === "string") {
          output += block.text;
        }
        if (
          block.type === "toolCall" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          calls.set(scopedCallId(event.run.id, block.id), {
            id: block.id,
            name: block.name,
            arguments: block.arguments,
            run: event.run,
          });
        }
      }
      if (event.run.depth === 0) {
        reason = typeof message.stopReason === "string" ? message.stopReason : reason;
        error = typeof message.errorMessage === "string" ? message.errorMessage : error;
        const observed = messageModelName(message);
        if (observed) rootModels.add(observed);
      }
      const usage = record(message.usage) ?? {};
      inputTokens += number(usage.input);
      outputTokens += number(usage.output);
      cachedTokens += number(usage.cacheRead);
      costUsd += number(record(usage.cost)?.total);
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const call = calls.get(scopedCallId(event.run.id, message.toolCallId));
      if (call) call.result = message.content;
    }
  }
  if (rootModels.size > 1) {
    throw new Error(
      `Recipe used multiple root models in one run: ${[...rootModels].join(", ")}`,
    );
  }
  return {
    output,
    toolCalls: [...calls.values()],
    events,
    completion: { reason, error },
    usage: { inputTokens, outputTokens, cachedTokens, costUsd },
    observedModel: [...rootModels][0],
  };
}

function assertSuccessfulCompletion(result: RecipeEvalResult): void {
  const { reason, error } = result.completion;
  if (reason !== "error" && reason !== "aborted" && !error) return;
  const outcome = reason ?? "error";
  const detail = error?.trim() || "no error detail";
  throw new Error(`introspection local ended with ${outcome}: ${detail}`);
}

function failureOutput(stdout: string, stderr: string): string {
  const limit = 16_384;
  const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  if (!details) return "no output";
  return details.length <= limit ? details : `...[truncated]\n${details.slice(-limit)}`;
}

function readRunSpec(): RunSpec | undefined {
  const path = process.env[RUN_SPEC_ENV];
  if (!path) return undefined;
  const spec = JSON.parse(readFileSync(path, "utf8")) as RunSpec;
  if (spec.schema_version !== 2) {
    throw new Error(
      `Introspection evaluation run spec ${spec.schema_version} is not supported. Update the Introspection CLI.`,
    );
  }
  return spec;
}

function run(command: string, args: string[], signal?: AbortSignal, stdin?: string) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(signal ? { signal } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.stdin.end(stdin);
  });
}

function judgeInput(session: NormalizedSession, _model?: string): JudgeInput {
  const trajectory: JsonValue[] = [];
  let systemInstructions: string | undefined;
  for (const [index, event] of session.events.entries()) {
    const timestamp = eventTimestamp(event, index);
    if (event.type === "message") {
      const content = contentText(event.content);
      if (event.role === "system") {
        if (content.trim()) systemInstructions = content;
      } else if (content) {
        trajectory.push({
          type: "message",
          role: event.role,
          content,
          ...(timestamp ? { timestamp } : {}),
        });
      }
      continue;
    }
    if (event.type === "tool_call") {
      trajectory.push({
        type: "tool_call",
        id: event.id,
        name: event.name,
        arguments: jsonValue(event.arguments ?? {}),
        ...(timestamp ? { timestamp } : {}),
      });
      continue;
    }
    const content = jsonValue(event.content);
    trajectory.push({
      type: "tool_result",
      tool_call_id: event.toolCallId,
      ...(event.name ? { name: event.name } : {}),
      ...(event.error
        ? {
            error: {
              type: event.error.type ?? "ToolError",
              message: event.error.message ?? "Tool execution failed",
            },
          }
        : content !== undefined
          ? { content }
          : {}),
      ...(timestamp ? { timestamp } : {}),
    });
  }
  return {
    schema_version: 2,
    trajectory,
    ...(systemInstructions ? { system_instructions: systemInstructions } : {}),
  };
}

function eventTimestamp(event: TranscriptEvent, _index: number): string | undefined {
  if (event.type !== "message") {
    const timestamp = event.finishedAt ?? event.startedAt;
    if (timestamp) return timestamp;
  }
  return undefined;
}

function contentText(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .map((part) => {
        if (
          part &&
          typeof part === "object" &&
          !Array.isArray(part) &&
          part.type === "text" &&
          typeof part.text === "string"
        ) {
          return part.text;
        }
        return undefined;
      })
      .filter((part): part is string => part !== undefined);
    if (text.length === value.length) return text.join("\n");
  }
  if (value === undefined) return "";
  return JSON.stringify(value);
}

function judgeLabel(reference: string): string {
  const name = basename(reference).replace(/\.ya?ml$/i, "");
  return name || reference;
}

function parseJudgeVerdict(stdout: string, reference: string): RecipeJudgeVerdict {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(
      `Recipe judge ${reference} returned invalid JSON:\n${failureOutput(stdout, "")}`,
    );
  }
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
  if (
    !record ||
    typeof record.judge !== "string" ||
    typeof record.provider !== "string" ||
    typeof record.model !== "string" ||
    !matchesVerdict(record.verdict)
  ) {
    throw new Error(
      `Recipe judge ${reference} returned an invalid verdict envelope: ${JSON.stringify(value)}`,
    );
  }
  return value as RecipeJudgeVerdict;
}

function matchesVerdict(value: unknown): value is RecipeJudgeVerdict["verdict"] {
  return value === "pass" || value === "fail" || value === "not_applicable";
}

function scopedEvent(
  wireEvent: Record<string, unknown>,
  rootScope: RecipeRunScope,
): RecipeEvalEvent {
  const envelope = agentRunEnvelope(wireEvent);
  if (!envelope) return { ...wireEvent, run: rootScope };
  const event = record(envelope.event);
  if (!event) return { ...wireEvent, run: rootScope };
  const id = string(envelope.agent_run_id) ?? "unknown-child";
  const agentName = string(envelope.agent_name) ?? "child";
  return {
    ...event,
    run: {
      id,
      parentId: string(envelope.parent_agent_run_id) ?? rootScope.id,
      agentName,
      invocationName: string(envelope.invocation_name) ?? agentName,
      depth: Math.max(1, number(envelope.depth)),
    },
  };
}

function agentRunEnvelope(
  wireEvent: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (wireEvent.type === "agent_run_event") return wireEvent;
  if (wireEvent.type !== "entry_appended") return undefined;
  const entry = record(wireEvent.entry);
  if (entry?.type !== "custom" || entry.customType !== "agent_run_event") return undefined;
  return record(entry.data);
}

function scopedCallId(runId: string, callId: string): string {
  return `${runId}:${callId}`;
}

function messageModelName(message: Record<string, unknown>): string | undefined {
  const provider = string(message.provider);
  const model = string(message.model);
  return provider && model ? `${provider}/${model}` : undefined;
}

function splitModel(value?: string): [string | undefined, string | undefined] {
  if (!value) return [undefined, undefined];
  const separator = value.indexOf("/");
  return separator > 0
    ? [value.slice(0, separator), value.slice(separator + 1)]
    : [undefined, value];
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  const normalized = jsonValue(value);
  return normalized === undefined ? "Tool execution failed" : JSON.stringify(normalized);
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  const object = record(value);
  if (object) {
    return Object.fromEntries(
      Object.entries(object)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, jsonValue(entry)]),
    );
  }
  return String(value);
}

function jsonObject(value: unknown): Record<string, JsonValue> | undefined {
  return record(value) ? (jsonValue(value) as Record<string, JsonValue>) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
