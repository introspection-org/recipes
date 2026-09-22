import { spawn } from "node:child_process";
import { createContext, runInContext } from "node:vm";
import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { callMcpDaemonTool } from "./mcp-daemon-client.js";
import type { McpCatalogServer } from "./mcp-daemon-protocol.js";
import {
  guardText,
  mcpCallTimeoutMs,
  mcpResultValue,
  resolveAuthorizedMcpTools,
  validateMcpToolInput,
  type McpToolSet,
  type UsableMcpTool,
} from "./mcp-tools.js";
import { compiledEntrypoint } from "./mcp.js";
import type { McpSessionConfig } from "./mcp.js";
import type { RecipeAgentMcp } from "./recipe-agent.js";
import {
  LEGACY_MCP_TOOL_SEARCH_NAME,
  RECIPE_EXECUTE_TOOL_NAME,
  RECIPE_TOOL_SEARCH_NAME,
  type RecipeDisclosedTool,
} from "./tool-search.js";

const DEFAULT_PROGRAM_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_CALLS = 100;
const DRAIN_TIMEOUT_MS = 5_000;
const ABORT_GRACE_MS = 1_000;

export interface McpExecuteCallRecord {
  server: string;
  tool: string;
  ms: number;
  ok: boolean;
  error?: string;
}

export interface McpExecuteDetails {
  calls: McpExecuteCallRecord[];
  truncated?: { originalBytes: number; originalLines: number };
}

export interface McpExecuteToolSet extends McpToolSet {
  /** Callable inside `execute` but never registered with Pi; `tool_search` discloses these. */
  disclosed: RecipeDisclosedTool[];
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function mcpExecuteChildPath(): string {
  return compiledEntrypoint("mcp-execute-child.js");
}

/**
 * The manifest Node reads to decide the child's module type.
 *
 * Granted explicitly so the child's own directory is the only other readable
 * path — a grant wide enough to cover the session directory would hand an
 * escaped program the session locator in `.pi/mcp-session.json`.
 */
function nearestPackageManifest(from: string): string | undefined {
  let directory = dirname(from);
  const { root } = parse(directory);
  for (;;) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) return candidate;
    if (directory === root) return undefined;
    directory = dirname(directory);
  }
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** What the runner installs itself, so a server id cannot take the binding. */
const RUNNER_GLOBALS = new Set(["tools", "console", "sleep"]);

const PROBE = Object.freeze({ bareGlobal: true });

/**
 * Which server ids can be reached as a bare global, established by trying it.
 *
 * A denylist of reserved words is the obvious implementation and the wrong one:
 * it has to enumerate every name that cannot hold a binding, and the ones that
 * get missed fail silently — `delete` is a syntax error, `undefined` and `NaN`
 * are non-writable so the assignment does not take, and each is only found once
 * a model is sent to a call that throws. Running the candidate in a throwaway
 * context answers all of them at once, and answers anything not thought of.
 */
function bareGlobalServers(serverIds: Iterable<string>): Set<string> {
  return new Set(
    [...serverIds].filter((id) => {
      if (!IDENTIFIER.test(id) || RUNNER_GLOBALS.has(id)) return false;
      try {
        return (
          runInContext(
            `typeof ${id} === "object" && ${id} !== null && ${id}.bareGlobal === true`,
            createContext({ [id]: PROBE })
          ) === true
        );
      } catch {
        return false;
      }
    })
  );
}

function callableExpression(
  serverId: string,
  toolName: string,
  bareGlobals: ReadonlySet<string>
): string {
  const namespace = bareGlobals.has(serverId)
    ? serverId
    : `tools[${JSON.stringify(serverId)}]`;
  return IDENTIFIER.test(toolName)
    ? `${namespace}.${toolName}`
    : `${namespace}[${JSON.stringify(toolName)}]`;
}

interface ProgramOutcome {
  value: unknown;
  logs: Array<{ level: string; text: string }>;
  calls: McpExecuteCallRecord[];
}

class ProgramFailure extends Error {
  constructor(
    message: string,
    readonly calls: McpExecuteCallRecord[],
    readonly logs: Array<{ level: string; text: string }>
  ) {
    super(message);
    this.name = "ProgramFailure";
  }
}

async function runProgram(options: {
  code: string;
  registry: ReadonlyMap<string, UsableMcpTool>;
  bareGlobals: ReadonlySet<string>;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<ProgramOutcome> {
  const childPath = mcpExecuteChildPath();
  if (!existsSync(childPath)) {
    throw new Error(
      `The execute program runner is missing at ${childPath}. It is a build artifact, so a source checkout needs \`pnpm build\` before execute mode can run.`
    );
  }
  const manifest = nearestPackageManifest(childPath);
  const child = spawn(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${dirname(childPath)}`,
      ...(manifest ? [`--allow-fs-read=${manifest}`] : []),
      childPath,
    ],
    {
      // No credentials, no daemon token, no egress URL. This is the boundary,
      // not a convenience: an escaped program has nothing to authenticate with.
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  const calls: McpExecuteCallRecord[] = [];
  const maxCalls = positiveInteger(
    options.env.PI_RECIPES_MCP_EXECUTE_MAX_CALLS,
    DEFAULT_MAX_CALLS
  );
  const timeoutMs = positiveInteger(
    options.env.PI_RECIPES_MCP_EXECUTE_TIMEOUT_MS,
    DEFAULT_PROGRAM_TIMEOUT_MS
  );
  let stderr = "";
  let settled = false;
  let admitted = 0;
  // A program can start a call without awaiting it. The call is still a real
  // provider call, so it has to be accounted for before the tool reports an
  // outcome — otherwise `void attio["update-record"](...)` returns success with
  // an empty call list while the write is still in flight.
  const inFlight = new Set<Promise<void>>();
  const abandoned = new AbortController();

  return await new Promise<ProgramOutcome>((resolve, reject) => {
    /**
     * Settle only once every started call has completed or been cancelled.
     *
     * Giving up on the wait is not the same as giving up on the call: a drain
     * that simply stopped waiting would resolve the tool while a provider write
     * was still running, which is the under-reporting this tracking exists to
     * prevent. So the deadline cancels rather than abandons, and the cancelled
     * call still records its own outcome.
     */
    const drain = async (abortFirst: boolean): Promise<void> => {
      if (abortFirst) abandoned.abort();
      if (inFlight.size === 0) return;
      const drainMs = positiveInteger(
        options.env.PI_RECIPES_MCP_EXECUTE_DRAIN_MS,
        DRAIN_TIMEOUT_MS
      );
      const settledInTime = await Promise.race([
        Promise.allSettled([...inFlight]).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), drainMs)),
      ]);
      if (settledInTime) return;
      abandoned.abort();
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((resolve) => setTimeout(resolve, ABORT_GRACE_MS)),
      ]);
    };

    const finish = (outcome: () => void, abortInFlight: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      // The child is killed first so it cannot start anything else, then what
      // is already in flight is drained. A drain that outlives its own bound
      // stops being waited on rather than holding the turn open.
      child.kill("SIGKILL");
      void drain(abortInFlight).then(outcome);
    };
    const fail = (
      message: string,
      logs: Array<{ level: string; text: string }> = []
    ) =>
      finish(
        () => reject(new ProgramFailure(message, calls, logs)),
        true
      );

    const timer = setTimeout(
      () => fail(`Program exceeded ${timeoutMs}ms and was terminated.`),
      timeoutMs
    );
    const onAbort = () => fail("Program was cancelled.");
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const write = (message: unknown) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const serviceCall = async (id: number, server: string, tool: string, args: unknown) => {
      const started = Date.now();
      const record: McpExecuteCallRecord = { server, tool, ms: 0, ok: false };
      try {
        // Check and admit together, before the first await: a program that
        // fans out with Promise.all has every call in flight at once.
        if (admitted >= maxCalls) {
          throw new Error(
            `Program exceeded its ${maxCalls}-call budget. Narrow the work or raise PI_RECIPES_MCP_EXECUTE_MAX_CALLS.`
          );
        }
        admitted += 1;
        // ⚠️ The gate. The child names a tool; only this lookup decides whether
        // one exists, so a program can never reach past the resolved policy.
        const authorized = options.registry.get(`${server}.${tool}`);
        if (!authorized) {
          throw new Error(
            `Tool '${server}.${tool}' is not authorized for this agent.`
          );
        }
        const input =
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};
        validateMcpToolInput(authorized, input);
        const raw = await callMcpDaemonTool(
          authorized.serverId,
          authorized.catalog.name,
          input,
          {
            env: options.env,
            timeoutMs: mcpCallTimeoutMs(options.env),
            signal: abandoned.signal,
          }
        );
        const value = mcpResultValue(authorized, raw, options.env);
        record.ok = true;
        record.ms = Date.now() - started;
        calls.push(record);
        write({ type: "result", id, ok: true, value });
      } catch (error) {
        record.ms = Date.now() - started;
        record.error = error instanceof Error ? error.message : String(error);
        calls.push(record);
        write({ type: "result", id, ok: false, error: record.error });
      }
    };

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.type === "call") {
          const call = serviceCall(
            Number(message.id),
            String(message.server),
            String(message.tool),
            message.args
          ).finally(() => inFlight.delete(call));
          inFlight.add(call);
          continue;
        }
        const logs = Array.isArray(message.logs)
          ? (message.logs as Array<{ level: string; text: string }>)
          : [];
        if (message.type === "done") {
          // Not aborted: a fire-and-forget call is allowed to complete so the
          // record describes what actually reached the provider.
          finish(() => resolve({ value: message.value, logs, calls }), false);
          continue;
        }
        if (message.type === "error") {
          fail(String(message.message ?? "Program failed."), logs);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {
      // The child is gone; the failure is reported by `close` or the timeout.
    });
    child.on("error", (error) => fail(`Program runner failed to start: ${error.message}`));
    child.on("close", (code) => {
      fail(
        `Program runner exited (${code}) without a result.${
          stderr.trim() ? `\n${runnerStderr(stderr)}` : ""
        }`
      );
    });

    write({
      type: "start",
      code: options.code,
      tools: [...options.registry.values()].map((tool) => ({
        server: tool.serverId,
        tool: tool.catalog.name,
      })),
      globals: [...options.bareGlobals],
    });
  });
}

/** Enough of a dead runner's own output to diagnose it, and no more. */
function runnerStderr(stderr: string): string {
  const lines = stderr.trim().split("\n").slice(-20).join("\n");
  return lines.length > 2_000 ? `${lines.slice(0, 2_000)}…` : lines;
}

function programResultText(outcome: {
  value: unknown;
  logs: Array<{ level: string; text: string }>;
}): string {
  const parts: string[] = [];
  if (outcome.logs.length > 0) {
    parts.push(
      outcome.logs.map((entry) => `[${entry.level}] ${entry.text}`).join("\n")
    );
  }
  let rendered: string;
  try {
    rendered = JSON.stringify(outcome.value, null, 2) ?? "null";
  } catch {
    rendered = String(outcome.value);
  }
  parts.push(rendered);
  return parts.join("\n\n");
}

function describeSurface(disclosed: readonly RecipeDisclosedTool[]): string {
  const eager = disclosed.slice(0, 12);
  const lines = eager.map(
    (tool) => `- ${tool.callable}(args) — ${tool.description.split("\n")[0]}`
  );
  if (disclosed.length > eager.length) {
    lines.push(
      `- …and ${disclosed.length - eager.length} more; find them with ${RECIPE_TOOL_SEARCH_NAME}.`
    );
  }
  return lines.join("\n");
}

/**
 * `mcp.mode: execute` — the whole authorized catalog behind one tool.
 *
 * The callable surface is the same `package ∩ agent` intersection `tools` mode
 * registers with Pi, resolved through the same function, so the two modes
 * cannot disagree about what an agent may call. What differs is where the
 * calls happen: in a program, so a fan-out costs one turn and one result
 * rather than one turn per provider call.
 */
export function createMcpExecuteToolSet(options: {
  session: McpSessionConfig;
  catalogs: readonly McpCatalogServer[];
  mcp: RecipeAgentMcp;
  env: NodeJS.ProcessEnv;
}): McpExecuteToolSet {
  const { usable, unusable } = resolveAuthorizedMcpTools(options);
  const registry = new Map(usable.map((tool) => [tool.canonicalName, tool]));
  const bareGlobals = bareGlobalServers(usable.map((tool) => tool.serverId));
  const disclosed: RecipeDisclosedTool[] = usable.map((tool) => ({
    name: tool.canonicalName,
    label: tool.catalog.name,
    description: tool.catalog.description ?? `MCP tool ${tool.canonicalName}`,
    parameters: tool.inputSchema,
    callable: callableExpression(tool.serverId, tool.catalog.name, bareGlobals),
  }));

  const execute: ToolDefinition = {
    name: RECIPE_EXECUTE_TOOL_NAME,
    label: "Execute",
    description: [
      "Run a short async JavaScript program against this Recipe's authorized tools and return its value.",
      "",
      "Every authorized tool is an async function. `tools[\"<server>\"][\"<tool>\"](args)` always works; dot access needs the name to be a valid identifier, which many are not — MCP servers commonly publish hyphenated names, so prefer the bracket form unless the listing below shows otherwise. The listing gives each tool's exact callable form.",
      "",
      "A call returns the server's structured result when it declares one, otherwise its text content — parsed as JSON when it parses, and left as a string when it does not. A server with no output schema usually means strings: parse out what you need rather than assuming fields. A failed call throws, so ordinary `try`/`catch` works.",
      "",
      "Write the body only — no wrapper, no imports. `return` the value you want; it is the only thing that enters the conversation, so filter and aggregate here rather than returning raw pages. `console.log` is captured. `sleep(ms)` is available. There is no filesystem, no shell and no network client: the authorized tools are the only way out.",
      "",
      "Prefer this over one tool call per record: a loop that reads thirty deals and writes three times each is one call here.",
      "",
      "Available now:",
      describeSurface(disclosed),
    ].join("\n"),
    parameters: Type.Object({
      code: Type.String({
        description:
          "The program body. Async; `return` the result. Example: `const page = await tools[\"attio\"][\"list-records\"]({ object: \"deals\" }); return page.length;`",
      }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const input = params as { code?: unknown };
      const code = typeof input.code === "string" ? input.code : "";
      if (!code.trim()) throw new Error("execute requires a non-empty program.");
      let outcome: ProgramOutcome;
      try {
        outcome = await runProgram({
          code,
          registry,
          bareGlobals,
          env: options.env,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (error instanceof ProgramFailure) {
          const logs =
            error.logs.length > 0
              ? `\n\n${error.logs
                  .map((entry) => `[${entry.level}] ${entry.text}`)
                  .join("\n")}`
              : "";
          // A program that logged a raw page and then threw would otherwise
          // reach the model unclamped, past the bound its own success path has.
          throw new Error(
            guardText(
              `${error.message}${logs}\n\n${error.calls.length} tool call(s) ran before the failure; provider writes are not rolled back.`,
              options.env
            ).text
          );
        }
        throw error;
      }
      const guarded = guardText(programResultText(outcome), options.env);
      return {
        content: [{ type: "text" as const, text: guarded.text }],
        details: {
          calls: outcome.calls,
          ...(guarded.truncated ? { truncated: guarded.truncated } : {}),
        } satisfies McpExecuteDetails,
      };
    },
  };

  if (
    execute.name === RECIPE_TOOL_SEARCH_NAME ||
    execute.name === LEGACY_MCP_TOOL_SEARCH_NAME
  ) {
    throw new Error("Recipe execute tool name collides with tool search.");
  }

  return {
    tools: [execute],
    toolNames: [execute.name],
    initialActiveToolNames: [execute.name],
    deferredToolNames: [],
    disclosed,
    diagnostics: [
      ...options.catalogs
        .filter((catalog) => catalog.error)
        .map((catalog) => `${catalog.id}: ${catalog.error}`),
      ...[...unusable.entries()].map(([name, error]) => `${name}: ${error}`),
    ],
    canonicalToPiName: new Map(),
  };
}
