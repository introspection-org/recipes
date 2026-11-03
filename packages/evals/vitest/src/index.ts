import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { onTestFinished } from "vitest";

import {
  createJudge,
  createHarness,
  type JsonValue,
  type NormalizedSession,
  type TranscriptEvent,
} from "vitest-evals";
import { attachHarnessRunToError, normalizeHarnessRun } from "vitest-evals/harness";

export { piToolCalls, type ServerCall, serverCalls, type ToolCall } from "./tools.js";

const RUN_SPEC_ENV = "INTROSPECTION_EVAL_RUN_SPEC";

export type RecipeCase<TExpected = unknown, TInput extends RecipeEvalInput = RecipeEvalInput> = {
  input: TInput;
  expected?: TExpected;
  [key: string]: unknown;
};

export type RecipeEvalInput = {
  prompt: string;
  history?: RecipeHistoryEvent[];
  /**
   * An earlier run of the same test. The prompt is sent as the next turn of
   * that run's Pi session, and this run reports the whole conversation.
   */
  continue?: RecipeContinuableRun;
  [key: string]: unknown;
};

/** The part of an earlier harness run that identifies its Pi session. */
export type RecipeContinuableRun = {
  artifacts?: Record<string, JsonValue>;
};

/** One MCP server binding, as written to Pi's `.pi/mcp.local.json`. */
export type RecipeMcpServer = {
  id: string;
  url: string;
  transport?: string;
  [key: string]: JsonValue | undefined;
};

/** What `beforeRun` may set up for one Pi session. */
export type RecipeRunEnvironment<TFixture = unknown> = {
  /**
   * The only MCP servers the Recipe is bound to for this session. They are
   * written to a temporary working directory, never to the Recipe checkout.
   */
  mcpServers?: RecipeMcpServer[];
  /** Passed to `collectArtifacts` for every turn of this session. */
  fixture?: TFixture;
  /** Runs once when the test finishes, whether it passed, failed or aborted. */
  teardown?: () => void | Promise<void>;
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

export type RecipeHarnessResultContext<
  TInput extends RecipeEvalInput,
  TFixture = unknown,
> = RecipeHarnessContext<TInput> & {
  /** Absent when the turn failed. */
  result?: RecipeEvalResult;
  /** The `fixture` returned by `beforeRun` for this session. */
  fixture: TFixture;
};

export type CreateRecipeHarnessOptions<
  TInput extends RecipeEvalInput = RecipeEvalInput,
  TFixture = unknown,
> = {
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
  /**
   * Runs before the first turn of a Pi session; not again for a continued
   * run. May return the session's MCP bindings, fixture and teardown.
   */
  beforeRun?: (
    context: RecipeHarnessContext<TInput>,
  ) => void | RecipeRunEnvironment<TFixture> | Promise<void | RecipeRunEnvironment<TFixture>>;
  /** Runs after every turn, including a failed one, before teardown. */
  collectArtifacts?: (
    context: RecipeHarnessResultContext<TInput, TFixture>,
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
>(
  reference: string,
  subject?: (run: RecipeContinuableRun) => {
    runtimeSlug: string;
    conversationId: string;
  } | undefined,
) {
  const normalizedReference = reference.trim();
  if (!normalizedReference) {
    throw new Error("recipeJudge requires a judge name or YAML path");
  }
  return createJudge<TInput, string>(
    judgeLabel(normalizedReference),
    async ({ session, run: harnessRun }) => {
      const input = judgeInput(session, harnessRun.usage?.model);
      const identity = subject?.(harnessRun);
      const { stdout, stderr, code } = await run(
        process.env.INTROSPECTION_CLI ?? "introspection",
        [
          "judges",
          "evaluate",
          "--judge",
          normalizedReference,
          ...(identity
            ? ["--runtime-slug", identity.runtimeSlug, "--conversation-id", identity.conversationId]
            : []),
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

const SESSION_ARTIFACT = "recipeSession";

type RecipeSession = {
  id: string;
  directory: string;
  /** Working directory holding the session's MCP bindings, when it has any. */
  boundDirectory?: string;
  fixture: unknown;
  events: TranscriptEvent[];
  piEvents: RecipeEvalEvent[];
  usage: RecipeEvalResult["usage"];
  toolCalls: number;
  /**
   * False once a turn has replayed history: `introspection local` runs such a
   * turn in a session of its own, which is gone when the turn ends.
   */
  resumable: boolean;
  closed: boolean;
};

const sessions = new Map<string, RecipeSession>();

function openSession(environment: RecipeRunEnvironment | undefined): RecipeSession {
  const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-session-"));
  const session: RecipeSession = {
    id: randomUUID(),
    directory,
    fixture: environment?.fixture,
    events: [],
    piEvents: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
    toolCalls: 0,
    resumable: true,
    closed: false,
  };
  const close = async () => {
    session.closed = true;
    sessions.delete(session.id);
    try {
      await environment?.teardown?.();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  try {
    if (environment?.mcpServers) {
      // Fail closed: a session with declared servers runs only against them.
      session.boundDirectory = join(directory, "workspace");
      mkdirSync(join(session.boundDirectory, ".pi"), { recursive: true });
      writeFileSync(
        join(session.boundDirectory, ".pi", "mcp.local.json"),
        JSON.stringify({ servers: environment.mcpServers }),
        { mode: 0o600 },
      );
    }
    sessions.set(session.id, session);
  } catch (error) {
    void close();
    throw error;
  }
  return Object.assign(session, { close });
}

function continuedSession(run: RecipeContinuableRun): RecipeSession {
  const id = run.artifacts?.[SESSION_ARTIFACT];
  const session = typeof id === "string" ? sessions.get(id) : undefined;
  if (!session || session.closed) {
    throw new Error(
      "input.continue must be an earlier run of the same test: its Pi session is no longer open",
    );
  }
  if (!session.resumable) {
    throw new Error(
      "A run that replays history cannot be continued: its Pi session ends with the turn",
    );
  }
  return session;
}

export function createRecipeHarness<
  TInput extends RecipeEvalInput = RecipeEvalInput,
  TFixture = unknown,
>(options: CreateRecipeHarnessOptions<TInput, TFixture> = {}) {
  if (options.renderPrompt && options.prompt) {
    throw new Error("createRecipeHarness accepts renderPrompt or prompt, not both");
  }
  const promptFor = options.renderPrompt ?? options.prompt ?? ((input: TInput) => input.prompt);
  return createHarness<TInput, string>({
    name: options.name ?? "introspection-recipe",
    run: async ({ input, signal, artifacts, setArtifact }) => {
      const spec = readRunSpec();
      const continued = input.continue ? continuedSession(input.continue) : undefined;
      if (continued && input.history?.length) {
        throw new Error("A continued run takes its history from the session, not input.history");
      }
      // A replayed production turn replaces the first turn only.
      const prompt = continued ? promptFor(input) : (spec?.input.prompt ?? promptFor(input));
      const history = continued ? [] : (spec?.input.history ?? input.history ?? []);
      if (!prompt?.trim()) throw new Error("Recipe case input.prompt must not be empty");
      const context = { input, prompt, signal };

      let session = continued;
      if (!session) {
        const environment = (await options.beforeRun?.(context)) ?? undefined;
        const opened = openSession(environment) as RecipeSession & { close: () => Promise<void> };
        session = opened;
        try {
          onTestFinished(opened.close);
        } catch {
          // Outside a Vitest test nothing can continue the session: close it after this turn.
          session = Object.assign(opened, { closeAfterTurn: true });
        }
      }
      const active = session as RecipeSession & {
        close?: () => Promise<void>;
        closeAfterTurn?: boolean;
      };
      const artifactsFor = async (result?: RecipeEvalResult) =>
        (await options.collectArtifacts?.({
          ...context,
          ...(result ? { result } : {}),
          fixture: active.fixture as TFixture,
        })) ?? {};

      const turnStart: TranscriptEvent[] = [
        ...history.map(historyTranscriptEvent),
        { type: "message", role: "user", content: prompt },
      ];
      try {
        let result: RecipeEvalResult;
        try {
          result = await runRecipe(
            { prompt, history },
            { signal, session: active, replay: !continued },
          );
        } catch (error) {
          // The report keeps the conversation up to the failure and the fixture state.
          const partial = normalizeHarnessRun(input, {
            events: [...active.events, ...turnStart],
            usage: sessionUsage(active, undefined),
            artifacts: { [SESSION_ARTIFACT]: active.id, ...(await artifactsFor()) },
            errors: [{ type: "RecipeRunError", message: String(error) }],
          }, { signal, artifacts, setArtifact });
          throw attachHarnessRunToError(error, partial);
        }
        active.events.push(...recipeTranscript(history, prompt, result.events));
        active.piEvents.push(...result.events);
        active.usage = {
          inputTokens: active.usage.inputTokens + result.usage.inputTokens,
          outputTokens: active.usage.outputTokens + result.usage.outputTokens,
          cachedTokens: active.usage.cachedTokens + result.usage.cachedTokens,
          costUsd: active.usage.costUsd + result.usage.costUsd,
        };
        active.toolCalls += result.toolCalls.length;
        const customArtifacts = await artifactsFor(result);
        return {
          output: result.output,
          // A continued run reports the whole conversation, because vitest-evals
          // records one run per test and the CLI totals usage from that run.
          events: [...active.events],
          usage: sessionUsage(active, result.observedModel),
          artifacts: {
            completion: jsonValue(result.completion),
            piEvents: jsonValue(active.piEvents),
            [SESSION_ARTIFACT]: active.id,
            ...customArtifacts,
          },
        };
      } finally {
        if (active.closeAfterTurn) await active.close?.();
      }
    },
  });
}

/** One fake as its `index.ts` exports it, the part `@introspection-ai/recipe-fakes-mcp` serves. */
export type RecipeFake = {
  manifest: { server: { name: string; version: string }; tools: Record<string, unknown> };
  register: (server: never, state: never) => void;
};

/** A Pi session's running fakes: `Services` of `@introspection-ai/recipe-fakes-mcp`. */
export type RecipeFakeServices<TWorld> = {
  mcpServers: () => RecipeMcpServer[];
  /** Every fake's current state, which its handlers change in place. */
  states: TWorld;
  /** Every fake's state when the services started. */
  initial: TWorld;
  close: () => Promise<void>;
};

/** The `fakeStates` artifact of a fakes harness run. */
export type RecipeFakeStates<TWorld> = { initial: TWorld; final: TWorld };

export type FakesHarnessOptions<
  TWorld extends object,
  TInput extends RecipeEvalInput = RecipeEvalInput,
> = Omit<CreateRecipeHarnessOptions<TInput, RecipeFakeServices<TWorld>>, "beforeRun"> & {
  /** Every fake of the Recipe, keyed by the server id the Recipe declares. */
  fakes: Record<string, RecipeFake>;
  /** The Recipe's `world(scenario, clock)`: every fake's starting state, keyed by fake id. */
  world: (scenario: string | undefined, clock: Date) => TWorld;
  /** The scenario `world` builds, or a function of the case input that picks it. */
  scenario?: string | ((input: TInput) => string | undefined);
  /** The clock `world` computes its dates from; now when omitted. */
  clock?: Date | string;
};

/**
 * A Recipe harness bound to fresh loopback fakes for every Pi session, served by
 * `@introspection-ai/recipe-fakes-mcp`. Each run records the fakes' state when the session started and
 * after the turn as its `fakeStates` artifact, beside what `collectArtifacts` adds.
 */
export function fakesHarness<TWorld extends object, TInput extends RecipeEvalInput = RecipeEvalInput>(
  options: FakesHarnessOptions<TWorld, TInput>,
) {
  const { fakes, world, scenario, clock, collectArtifacts, ...harness } = options;
  return createRecipeHarness<TInput, RecipeFakeServices<TWorld>>({
    ...harness,
    beforeRun: async ({ input }) => {
      const { startServices } = await import("@introspection-ai/recipe-fakes-mcp");
      const services = await startServices(fakes as Parameters<typeof startServices>[0], {
        world,
        scenario: typeof scenario === "function" ? scenario(input) : scenario,
        clock,
      });
      return { mcpServers: services.mcpServers(), fixture: services, teardown: services.close };
    },
    collectArtifacts: async (context) => ({
      fakeStates: jsonValue({ initial: context.fixture.initial, final: context.fixture.states }),
      ...(await collectArtifacts?.(context)),
    }),
  });
}

function sessionUsage(session: RecipeSession, observedModel: string | undefined) {
  const [provider, model] = splitModel(observedModel);
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    inputTokens: session.usage.inputTokens,
    outputTokens: session.usage.outputTokens,
    totalTokens: session.usage.inputTokens + session.usage.outputTokens,
    toolCalls: session.toolCalls,
    metadata: {
      cachedTokens: session.usage.cachedTokens,
      costUsd: session.usage.costUsd,
    },
  };
}

export async function runRecipe(
  input: { prompt: string; history?: RecipeHistoryEvent[] },
  options: {
    signal?: AbortSignal;
    /** Pi session to create or continue, and the bound working directory to run in. */
    session?: { id: string; directory: string; boundDirectory?: string; resumable?: boolean };
    /** False for a continued turn: its history is already in the session. */
    replay?: boolean;
  } = {},
): Promise<RecipeEvalResult> {
  const spec = readRunSpec();
  if (!input.prompt?.trim()) throw new Error("Recipe case input.prompt must not be empty");
  const replay = options.replay ?? true;
  const session = options.session;

  const args = ["local"];
  // The Recipe stays where it is; only Pi's working directory moves to the bindings.
  if (session?.boundDirectory) args.push("--work-dir", process.cwd());
  if (spec) args.push("--runtime", spec.candidate.runtime);
  if (spec?.candidate.agent) args.push("--agent", spec.candidate.agent);
  args.push("--print", input.prompt, "--mode", "json");
  const specReplay = spec?.input.replay_context_path;
  const temporaryReplay = !replay
    ? undefined
    : specReplay
      // A context written by the CLI names the Recipe checkout; a bound session gets a copy.
      ? (session?.boundDirectory ? reboundReplayContext(specReplay, session.boundDirectory) : undefined)
      : input.history?.length
        ? writeReplayContext(input.history, session?.boundDirectory)
        : undefined;
  const replayContext = replay
    ? (temporaryReplay?.path ?? specReplay)
    : undefined;
  if (replayContext) args.push("--replay-context", replayContext);
  // `introspection local` hydrates a replay into a Pi `--session` of its own,
  // and Pi rejects `--session-id` beside it: a replaying turn keeps that session.
  const ownSession = session && !replayContext ? session : undefined;
  if (session && replayContext) session.resumable = false;
  const piArgs = [
    // Project-local bindings are read only when the run trusts them.
    ...(session?.boundDirectory ? ["--approve"] : []),
    ...(ownSession
      ? ["--session-dir", join(ownSession.directory, "sessions"), "--session-id", ownSession.id]
      : []),
  ];
  if (piArgs.length) args.push("--", ...piArgs);

  let stdout: string;
  let stderr: string;
  let code: number;
  try {
    ({ stdout, stderr, code } = await run(
      process.env.INTROSPECTION_CLI ?? "introspection",
      args,
      options.signal,
      undefined,
      session?.boundDirectory,
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

// Pi resumes a hydrated session in the directory the context names, and reads
// project-local MCP bindings from there: a bound session must replay in its
// own working directory, or it would run against the checkout's bindings.
function writeReplayContext(history: RecipeHistoryEvent[], boundDirectory?: string) {
  const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-history-"));
  const path = join(directory, "context.json");
  writeFileSync(path, JSON.stringify({
    schema_version: 2,
    cwd: boundDirectory ?? process.cwd(),
    trajectory: history,
  }), { mode: 0o600 });
  return {
    path,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function reboundReplayContext(path: string, boundDirectory: string) {
  const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-history-"));
  const rebound = join(directory, "context.json");
  writeFileSync(
    rebound,
    JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), cwd: boundDirectory }),
    { mode: 0o600 },
  );
  return {
    path: rebound,
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

function run(
  command: string,
  args: string[],
  signal?: AbortSignal,
  stdin?: string,
  cwd?: string,
) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(signal ? { signal } : {}),
      ...(cwd ? { cwd } : {}),
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
