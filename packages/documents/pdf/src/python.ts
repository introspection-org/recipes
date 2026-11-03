import { execFile } from "node:child_process";
import { resolve } from "node:path";

/**
 * How the helpers run: the Recipe's own Python environment.
 *
 * The runtime activates `pi.runtime.python` as VIRTUAL_ENV, and that
 * environment must provide paper-docx. A package-level Python environment
 * is a follow-up; until then the Recipe declares the dependency.
 * `RECIPE_DOCUMENTS_PYTHON` overrides the interpreter (tests, custom hosts).
 */
export function pythonExecutable(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RECIPE_DOCUMENTS_PYTHON) return env.RECIPE_DOCUMENTS_PYTHON;
  if (env.VIRTUAL_ENV) return resolve(env.VIRTUAL_ENV, "bin", "python");
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
  options: { env: NodeJS.ProcessEnv; cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<HelperResult> {
  const started = performance.now();
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      pythonExecutable(options.env),
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
