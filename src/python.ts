/**
 * Run Python from an extension or a format package: pick the interpreter of
 * a prepared `pi.runtime.python` environment and exchange one JSON request
 * and one JSON response with a script.
 *
 * ```ts
 * import { pythonExecutable, runPythonJson } from "@introspection-ai/recipes/python";
 * ```
 */
import { execFile } from "node:child_process";
import { posix, win32 } from "node:path";

export interface PythonExecutableOptions {
  /** A prepared interpreter, such as `packagePython(name)` returns. */
  python?: string;
  /** Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** An environment variable that, when set, names the interpreter and wins over everything else. */
  override?: string;
  /** Default: `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * The interpreter to run, first match wins:
 *
 * 1. `env[override]`, when `override` names a variable that is set.
 * 2. `python`: a prepared interpreter.
 * 3. `VIRTUAL_ENV`: an activated environment. `bin/python`, or
 *    `Scripts\\python.exe` on Windows.
 * 4. `python3` from `PATH`.
 */
export function pythonExecutable(options: PythonExecutableOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const overridden = options.override ? env[options.override] : undefined;
  if (overridden) return overridden;
  if (options.python) return options.python;
  if (env.VIRTUAL_ENV) {
    return platform === "win32"
      ? win32.join(env.VIRTUAL_ENV, "Scripts", "python.exe")
      : posix.join(env.VIRTUAL_ENV, "bin", "python");
  }
  return "python3";
}

export interface RunPythonJsonOptions {
  /** The interpreter to run. Default: `pythonExecutable({ env })`. */
  python?: string;
  /** The child's environment. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  /** Default: 300 000 (five minutes). */
  timeoutMs?: number;
}

/**
 * The script did not answer with JSON, or exited with an error. `output` is
 * its stdout parsed as JSON when that succeeded: a script may report its own
 * failure as JSON and exit non-zero.
 */
export class PythonJsonError extends Error {
  constructor(
    message: string,
    readonly output: unknown,
    readonly stderr: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "PythonJsonError";
  }
}

/** The most stdout or stderr kept: 64 MB. */
export const PYTHON_JSON_MAX_BUFFER = 64 << 20;
/** The default timeout: 300 s. */
export const PYTHON_JSON_TIMEOUT_MS = 300_000;

/**
 * Run `python -I <script>` with `request` as JSON on stdin and resolve its
 * stdout parsed as JSON. Isolated mode keeps the working directory and user
 * site-packages off `sys.path`; `PYTHONDONTWRITEBYTECODE=1` keeps the package
 * directory clean and `PYTHONIOENCODING=utf-8` fixes the stream encoding.
 * Rejects with a `PythonJsonError` when the script exits non-zero, times out,
 * is aborted, or prints something that is not JSON.
 */
export function runPythonJson<T = unknown>(
  script: string,
  request: unknown,
  options: RunPythonJsonOptions = {}
): Promise<T> {
  const env = options.env ?? process.env;
  const python = options.python ?? pythonExecutable({ env });
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      python,
      ["-I", script],
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: { ...env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
        timeout: options.timeoutMs ?? PYTHON_JSON_TIMEOUT_MS,
        maxBuffer: PYTHON_JSON_MAX_BUFFER,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        const errorText = String(stderr ?? "");
        let output: unknown;
        let parsed = false;
        try {
          output = JSON.parse(String(stdout ?? ""));
          parsed = true;
        } catch {
          output = undefined;
        }
        if (error) {
          const detail = (errorText || error.message).slice(-600);
          return reject(new PythonJsonError(`${script} failed: ${detail}`, output, errorText, { cause: error }));
        }
        if (!parsed) {
          const detail = (errorText || "no JSON on stdout").slice(-600);
          return reject(new PythonJsonError(`${script} did not answer with JSON: ${detail}`, undefined, errorText));
        }
        resolvePromise(output as T);
      }
    );
    child.stdin?.on("error", () => {
      // The child exited before reading its request; the exit callback reports it.
    });
    child.stdin?.end(JSON.stringify(request));
  });
}
