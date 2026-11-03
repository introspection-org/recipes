import { execFile } from "node:child_process";
import { posix, win32 } from "node:path";

/**
 * The interpreter the helpers run with, first match wins:
 *
 * 1. `RECIPE_DOCUMENTS_PYTHON`: an explicit override (tests, custom hosts).
 * 2. `python`: the interpreter of this package's own environment, which the
 *    host prepares from the package's `pi.runtime.python` and passes to
 *    `createAdapter`. A Recipe declares no Python for its documents.
 * 3. `VIRTUAL_ENV`: an activated environment, for hosts that pass none.
 *    `bin/python`, or `Scripts\\python.exe` on Windows.
 * 4. `python3` from `PATH`.
 */
export function pythonExecutable(
  env: NodeJS.ProcessEnv = process.env,
  python?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.RECIPE_DOCUMENTS_PYTHON) return env.RECIPE_DOCUMENTS_PYTHON;
  if (python) return python;
  if (env.VIRTUAL_ENV) {
    return platform === "win32"
      ? win32.join(env.VIRTUAL_ENV, "Scripts", "python.exe")
      : posix.join(env.VIRTUAL_ENV, "bin", "python");
  }
  return "python3";
}

export interface HelperResult {
  text: string;
  details?: Record<string, unknown>;
  images?: Array<{ label: string; data: string; mimeType: string }>;
}

/** Run one helper request: JSON on stdin, JSON on stdout. A helper error becomes the tool call's error. */
export function runHelper(
  script: string,
  request: Record<string, unknown>,
  options: { env: NodeJS.ProcessEnv; cwd: string; python?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<HelperResult> {
  const started = performance.now();
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      pythonExecutable(options.env, options.python),
      ["-I", script],
      {
        cwd: options.cwd,
        env: { ...options.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
        timeout: options.timeoutMs ?? 300_000,
        maxBuffer: 64 << 20,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        let output: (HelperResult & { error?: string }) | undefined;
        try {
          output = JSON.parse(String(stdout || "null"));
        } catch {
          output = undefined;
        }
        if (output && typeof output.error === "string") return reject(new Error(output.error));
        if (!output || typeof output.text !== "string") {
          const detail = String(stderr || error?.message || "no output").slice(-600);
          return reject(new Error(`document helper failed: ${detail}`));
        }
        const timing = (output.details?.timing ?? {}) as Record<string, number>;
        output.details = {
          ...output.details,
          timing: { ...timing, call_ms: Math.round(performance.now() - started) },
        };
        resolvePromise(output);
      },
    );
    child.stdin?.end(JSON.stringify(request));
  });
}
