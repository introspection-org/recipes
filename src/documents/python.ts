import { PythonJsonError, pythonExecutable, runPythonJson } from "../python.js";
import type { DocumentResult } from "./types.js";

/** Names an interpreter for every document helper, winning over the prepared one (tests, custom hosts). */
export const RECIPE_DOCUMENTS_PYTHON_ENV = "RECIPE_DOCUMENTS_PYTHON";

/**
 * The interpreter a document helper runs with, first match wins:
 *
 * 1. `RECIPE_DOCUMENTS_PYTHON`: an explicit override (tests, custom hosts).
 * 2. `python`: the interpreter of the format package's own environment, which
 *    the host prepares from the package's `pi.runtime.python` and passes to
 *    `createAdapter`. A Recipe declares no Python for its documents.
 * 3. `VIRTUAL_ENV`: an activated environment, for hosts that pass none.
 * 4. `python3` from `PATH`.
 */
export function documentPythonExecutable(
  env: NodeJS.ProcessEnv = process.env,
  python?: string,
  platform: NodeJS.Platform = process.platform
): string {
  return pythonExecutable({ env, ...(python ? { python } : {}), override: RECIPE_DOCUMENTS_PYTHON_ENV, platform });
}

export interface DocumentHelperOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The format package's prepared interpreter; see `documentPythonExecutable`. */
  python?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Run one document helper request with `runPythonJson`: JSON on stdin, a
 * `DocumentResult` on stdout. A helper that answers `{ "error": ... }` fails
 * the tool call with that message; `details.timing.call_ms` records the
 * round trip.
 */
export async function runDocumentHelper(
  script: string,
  request: Record<string, unknown>,
  options: DocumentHelperOptions
): Promise<DocumentResult> {
  const started = performance.now();
  let output: unknown;
  try {
    output = await runPythonJson(script, request, {
      python: documentPythonExecutable(options.env, options.python),
      env: options.env,
      cwd: options.cwd,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  } catch (error) {
    if (!(error instanceof PythonJsonError)) throw error;
    const reported = helperError(error.output);
    if (reported !== undefined) throw new Error(reported);
    const cause = error.cause instanceof Error ? error.cause.message : "no output";
    throw new Error(`document helper failed: ${(error.stderr || cause).slice(-600)}`);
  }
  const reported = helperError(output);
  if (reported !== undefined) throw new Error(reported);
  const result = output as (DocumentResult & { details?: Record<string, unknown> }) | null;
  if (!result || typeof result.text !== "string") {
    throw new Error("document helper failed: no output");
  }
  const timing = (result.details?.timing ?? {}) as Record<string, number>;
  result.details = {
    ...result.details,
    timing: { ...timing, call_ms: Math.round(performance.now() - started) },
  };
  return result;
}

function helperError(output: unknown): string | undefined {
  if (output && typeof output === "object" && typeof (output as { error?: unknown }).error === "string") {
    return (output as { error: string }).error;
  }
  return undefined;
}
