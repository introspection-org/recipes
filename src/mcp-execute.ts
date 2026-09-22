import { execFile, spawn } from "node:child_process";
import { createContext, runInContext } from "node:vm";
import { existsSync, readFileSync } from "node:fs";
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
// The program's own output is clamped before it reaches the model, but that
// clamp runs after the host has buffered and parsed the frame. A program that
// returns something enormous would otherwise exhaust the host's memory from
// inside the sandbox, so the stream is bounded as it is read.
const MAX_CHILD_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
// One provider result, bounded before it is queued for the child. The child's
// own RSS watchdog cannot see frames still sitting in the parent's stream.
const MAX_RESULT_FRAME_BYTES = 4 * 1024 * 1024;
const SURFACE_DESCRIPTION_MAX_CHARS = 200;
const SURFACE_MAX_CHARS = 4_000;
const DEFAULT_MAX_MEMORY_MB = 512;
const PROC_POLL_MS = 250;
// `ps` costs a spawn per sample, so it is read far less often than /proc.
const PS_POLL_MS = 1_000;

/** A timeout that never outlives the race it was created for. */
function timeoutIn<T>(ms: number, value: T): { promise: Promise<T>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout>;
  const promise = new Promise<T>((resolve) => {
    handle = setTimeout(() => resolve(value), ms);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

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
 *
 * ⚠️ It has to run in the grammar the program runs in, not at top level. `await`
 * is a valid identifier in a script and a syntax error inside an async
 * function; `arguments` binds to the wrapper's own arguments object and shadows
 * the injected namespace. The wrapper is therefore host-owned and sent to the
 * child, so the probe and the program cannot disagree about it.
 */
const PROBE_RESULT = "__recipeBareGlobalProbe";

function bareGlobalServers(serverIds: Iterable<string>): Set<string> {
  return new Set(
    [...serverIds].filter((id) => {
      if (!IDENTIFIER.test(id) || RUNNER_GLOBALS.has(id)) return false;
      // The wrapper is async, so it returns a promise — but its body runs
      // synchronously up to the first await, and there is none. Assign and
      // read back rather than awaiting a probe.
      const sandbox: Record<string, unknown> = { [id]: PROBE };
      try {
        runInContext(
          wrapProgram(
            `globalThis.${PROBE_RESULT} = typeof ${id} === "object" && ${id} !== null && ${id}.bareGlobal === true;`
          ),
          createContext(sandbox),
          { filename: "probe.js" }
        );
      } catch {
        return false;
      }
      return sandbox[PROBE_RESULT] === true;
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

/**
 * How the runner is launched.
 *
 * Exported so the permission flags are assertable: the program cannot check
 * them from inside once `process` is removed from its realm, and a silently
 * dropped `--permission` would take the filesystem, subprocess and worker
 * denials with it.
 */
/**
 * The grammar a program runs in. Host-owned, so the bare-global probe and the
 * child evaluate candidates under exactly the same wrapper.
 */
export function wrapProgram(code: string): string {
  return `(async function recipeExecuteProgram() {\n${code}\n})()`;
}

export function executeChildArgs(
  childPath: string,
  manifest: string | undefined,
  maxMemoryMb: number
): string[] {
  return [
    "--permission",
    `--max-old-space-size=${maxMemoryMb}`,
    `--allow-fs-read=${dirname(childPath)}`,
    ...(manifest ? [`--allow-fs-read=${manifest}`] : []),
    childPath,
  ];
}

/**
 * How to sample a running child's resident memory, chosen once per host.
 *
 * `--max-old-space-size` bounds V8's heap but not external memory, so a
 * program filling typed arrays grows unchecked under it — measured at 3 GiB
 * RSS against a 64 MiB cap. Sampling RSS from the parent is what bounds that,
 * and it cannot be done portably: `/proc` is Linux, `ps` covers the other
 * POSIX hosts, and Windows has neither (its `tasklist` memory column is
 * locale-formatted, and a parser that silently misreads would be worse than
 * the documented gap). Where no reader exists the heap cap is all that is
 * left, which `memoryBoundIsEnforced` reports rather than hides.
 */
function residentMemoryReader():
  | { read: (pid: number) => Promise<number | undefined>; pollMs: number }
  | undefined {
  if (existsSync("/proc/self/status")) {
    return {
      pollMs: PROC_POLL_MS,
      // A /proc read is a memory copy, not I/O, so this one stays synchronous.
      read: async (pid) => {
        try {
          const kb = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
          return kb ? Number(kb[1]) / 1024 : undefined;
        } catch {
          return undefined;
        }
      },
    };
  }
  if (process.platform === "win32") {
    return {
      pollMs: PS_POLL_MS,
      // `WorkingSet64` is a raw int64. `tasklist`'s memory column is
      // locale-formatted and would fail open on a misparse, which is worse
      // than no reader; this one cannot.
      read: async (pid) => {
        const bytes = await sampleNumber("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
        ]);
        return bytes === undefined ? undefined : bytes / 1_048_576;
      },
    };
  }
  return {
    pollMs: PS_POLL_MS,
    // `ps` reports KiB.
    read: async (pid) => {
      const kb = await sampleNumber("ps", ["-o", "rss=", "-p", String(pid)]);
      return kb === undefined ? undefined : kb / 1024;
    },
  };
}

/**
 * One numeric sample from a process-inspection command, or nothing.
 *
 * Asynchronous because this runs on the host's main loop once per second for
 * the life of every program: a synchronous spawn — PowerShell, most of all —
 * would stall the session, and a slow one would stall it for the full timeout.
 */
function sampleNumber(
  command: string,
  args: readonly string[]
): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { encoding: "utf8", timeout: 5_000 },
      (error, stdout) => {
        if (error) return resolve(undefined);
        const value = Number(stdout.trim());
        resolve(Number.isFinite(value) && value > 0 ? value : undefined);
      }
    );
  });
}

/** Whether this host can enforce the memory bound, or only the heap cap. */
export function memoryBoundIsEnforced(): boolean {
  return residentMemoryReader() !== undefined;
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
  const maxMemoryMb = positiveInteger(
    options.env.PI_RECIPES_MCP_EXECUTE_MAX_MEMORY_MB,
    DEFAULT_MAX_MEMORY_MB
  );
  const child = spawn(
    process.execPath,
    executeChildArgs(childPath, manifest, maxMemoryMb),
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
      const deadline = timeoutIn(drainMs, false);
      const settledInTime = await Promise.race([
        Promise.allSettled([...inFlight]).then(() => true),
        deadline.promise,
      ]);
      deadline.cancel();
      if (settledInTime) return;
      abandoned.abort();
      const grace = timeoutIn(ABORT_GRACE_MS, undefined);
      await Promise.race([Promise.allSettled([...inFlight]), grace.promise]);
      grace.cancel();
    };

    const finish = (outcome: () => void, abortInFlight: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
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
    const memory = residentMemoryReader();
    let sampling = false;
    const watchdog = setInterval(
      () => {
        // One sample at a time: a slow reader must not queue spawns behind it.
        if (!memory || sampling || settled) return;
        sampling = true;
        void memory.read(child.pid ?? -1).then((resident) => {
          sampling = false;
          if (settled) return;
          if (resident !== undefined && resident > maxMemoryMb) {
            fail(
              `Program exceeded ${maxMemoryMb}MB of memory and was terminated. Process the results in batches rather than holding them all at once.`
            );
          }
        });
      },
      memory?.pollMs ?? PROC_POLL_MS
    );
    const onAbort = () => fail("Program was cancelled.");
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    /**
     * Write one frame to the child, respecting backpressure.
     *
     * A provider result is serialized whole. Ignoring `write()`'s return value
     * let every frame a slow child had not read yet accumulate in the parent —
     * memory the RSS watchdog cannot see, because it measures the child.
     *
     * ⚠️ Writes are chained, not merely awaited by their own caller. A fan-out
     * completes concurrently, so per-caller backpressure still lets every other
     * caller push a full frame in after the stream is already saturated: the
     * call budget times the frame bound, not one frame. Chaining keeps at most
     * one frame in flight. The drain wait races the child's exit so a killed
     * child cannot strand it.
     */
    let writes: Promise<void> = Promise.resolve();
    const write = (message: unknown): Promise<void> => {
      const send = async (): Promise<void> => {
        if (child.stdin.destroyed || settled) return;
        if (child.stdin.write(`${JSON.stringify(message)}\n`)) return;
        await new Promise<void>((resolve) => {
          const done = () => {
            child.stdin.off("drain", done);
            child.off("close", done);
            resolve();
          };
          child.stdin.once("drain", done);
          child.once("close", done);
        });
      };
      writes = writes.then(send, send);
      return writes;
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
        // Encoded bytes, not UTF-16 code units: CJK text is roughly 2.5x
        // longer once encoded, so `.length` would let a "4 MiB" frame past at
        // about 10 MiB.
        const frame = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
        if (frame > MAX_RESULT_FRAME_BYTES) {
          throw new Error(
            `Result of ${server}.${tool} is ${frame} bytes, over the ${MAX_RESULT_FRAME_BYTES}-byte limit for one call. Narrow the query or request fewer fields.`
          );
        }
        record.ok = true;
        record.ms = Date.now() - started;
        calls.push(record);
        await write({ type: "result", id, ok: true, value });
      } catch (error) {
        record.ms = Date.now() - started;
        record.error = error instanceof Error ? error.message : String(error);
        calls.push(record);
        await write({ type: "result", id, ok: false, error: record.error });
      }
    };

    let buffer = "";
    let received = 0;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      // The child is killed at settlement, but data already queued still
      // arrives. Servicing a `call` frame now would start a provider write
      // after cancellation, against a drain that has already been taken.
      if (settled) return;
      received += Buffer.byteLength(chunk, "utf8");
      // `received` is the byte-accurate bound. The buffer check stays on
      // `.length` because it runs per chunk against a string up to the limit
      // itself, and it can only under-count — which `received` already caught.
      if (received > MAX_CHILD_OUTPUT_BYTES || buffer.length > MAX_CHILD_OUTPUT_BYTES) {
        fail(
          `Program produced more than ${MAX_CHILD_OUTPUT_BYTES} bytes of output and was terminated. Return a summary rather than the raw results.`
        );
        return;
      }
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        // Re-checked per frame, not once per chunk: `done` and a later `call`
        // can coalesce into one read, and `finish()` settles mid-loop.
        if (settled) return;
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
      // Only the tail is ever reported, so only the tail is ever held.
      stderr = (stderr + chunk).slice(-MAX_STDERR_BYTES);
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
      // Wrapped here, not in the child: the bare-global probe must evaluate
      // candidates under exactly the grammar the program runs in, so the
      // wrapper has one definition and the two cannot disagree.
      code: wrapProgram(options.code),
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

/**
 * A call whose remote outcome the daemon could not resolve.
 *
 * Cancellation reaches the daemon but not the provider — mcporter exposes no
 * AbortSignal — so a write abandoned at the drain deadline may still be
 * running. The record carried that, but only in `details`, where the model
 * never sees it and reads the program's value as an unqualified success.
 */
function unresolvedCalls(calls: readonly McpExecuteCallRecord[]): McpExecuteCallRecord[] {
  return calls.filter((call) => !call.ok && call.error?.includes("remote outcome is unknown"));
}

function programResultText(outcome: {
  value: unknown;
  logs: Array<{ level: string; text: string }>;
  calls: readonly McpExecuteCallRecord[];
}): string {
  const parts: string[] = [];
  const unresolved = unresolvedCalls(outcome.calls);
  if (unresolved.length > 0) {
    parts.push(
      `⚠️ ${unresolved.length} call(s) were cancelled with the remote outcome unknown and may still be running: ${unresolved
        .map((call) => `${call.server}.${call.tool}`)
        .join(", ")}. Do not retry them automatically; check the provider's state.`
    );
  }
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
  // This goes out with every model request, before `execute` is ever called,
  // so a catalog with long descriptions would inflate the prompt past the
  // guards that only apply to a program's own output.
  const lines = eager.map(
    (tool) =>
      `- ${tool.callable}(args) — ${clipLine(tool.description, SURFACE_DESCRIPTION_MAX_CHARS)}`
  );
  if (disclosed.length > eager.length) {
    lines.push(
      `- …and ${disclosed.length - eager.length} more; find them with ${RECIPE_TOOL_SEARCH_NAME}.`
    );
  }
  const surface = lines.join("\n");
  // Clipped whole, not per line: twelve bounded descriptions can still add up.
  return surface.length <= SURFACE_MAX_CHARS
    ? surface
    : `${surface.slice(0, SURFACE_MAX_CHARS)}\n…`;
}

/** A description's first line, clipped — this ships in a tool definition. */
function clipLine(value: string, max: number): string {
  const line = value.split("\n")[0] ?? "";
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
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
          const unresolved = unresolvedCalls(error.calls);
          // A failed execution is the one most likely to be retried, so the
          // calls whose remote outcome is unknown matter more here than on the
          // success path, not less.
          const unknown =
            unresolved.length > 0
              ? `\n\n⚠️ ${unresolved.length} call(s) were cancelled with the remote outcome unknown and may still be running: ${unresolved
                  .map((call) => `${call.server}.${call.tool}`)
                  .join(", ")}. Do not retry them automatically; check the provider's state.`
              : "";
          throw new Error(
            guardText(
              `${error.message}${logs}\n\n${error.calls.length} tool call(s) ran before the failure; provider writes are not rolled back.${unknown}`,
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
