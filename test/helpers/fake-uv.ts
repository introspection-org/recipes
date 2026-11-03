import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function write(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

/**
 * A stand-in uv on PATH. `sync --check` exits 0 once a sync has written its
 * marker into the environment, else FAKE_UV_CHECK_EXIT (default 1). `sync`
 * writes a venv with a fake interpreter whose import check fails when
 * FAKE_IMPORT_FAIL is set. Every call is appended to FAKE_UV_LOG.
 */
export function fakeUv(): { bin: string; log: string; calls(): Array<{ args: string[]; project?: string }> } {
  const bin = scratch("fake-uv-");
  const log = join(bin, "calls.jsonl");
  const python = [
    "#!/bin/sh",
    'printf "%s\\n" "{\\"python\\":true,\\"pythonhome\\":\\"${PYTHONHOME-unset}\\"}" >> "$FAKE_UV_LOG"',
    'if [ -n "$FAKE_IMPORT_FAIL" ]; then echo "docx: ModuleNotFoundError: No module named docx" >&2; exit 1; fi',
    "exit 0",
  ].join("\n");
  write(
    join(bin, "uv"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const env = process.env.UV_PROJECT_ENVIRONMENT;
fs.appendFileSync(process.env.FAKE_UV_LOG, JSON.stringify({ args, project: env }) + "\\n");
if (args[0] === "--version") { console.log("uv 0.0.0-fake"); process.exit(0); }
const marker = env && path.join(env, ".fake-current");
if (args.includes("--check")) {
  if (marker && fs.existsSync(marker)) process.exit(0);
  const code = Number(process.env.FAKE_UV_CHECK_EXIT ?? 1);
  if (code === 2) console.error("error: No interpreter found for Python >=3.99 in managed installations or search path");
  else console.error("error: The environment is outdated; run \`uv sync\` to update the environment");
  process.exit(code);
}
const delay = Number(process.env.FAKE_UV_SYNC_DELAY_MS ?? 0);
setTimeout(() => {
  if (process.env.FAKE_UV_SYNC_EXIT) {
    console.error(process.env.FAKE_UV_SYNC_STDERR ?? "error: sync failed");
    process.exit(Number(process.env.FAKE_UV_SYNC_EXIT));
  }
  fs.mkdirSync(path.join(env, "bin"), { recursive: true });
  fs.writeFileSync(path.join(env, "pyvenv.cfg"), "home = /fake\\n");
  fs.writeFileSync(path.join(env, "bin", "python"), ${JSON.stringify(python)});
  fs.chmodSync(path.join(env, "bin", "python"), 0o755);
  fs.writeFileSync(marker, "");
  process.exit(0);
}, delay);
`
  );
  chmodSync(join(bin, "uv"), 0o755);
  return {
    bin,
    log,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { args: string[]; project?: string; python?: boolean })
            .filter((call) => !call.python)
        : [],
  };
}

export function pythonProject(dir: string, lock = "version = 1\n"): void {
  write(join(dir, "python", "pyproject.toml"), "[project]\nname = 'synthetic'\nversion = '0.1.0'\n");
  write(join(dir, "python", "uv.lock"), lock);
}

