import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  documentPythonExecutable,
  runDocumentHelper,
} from "../src/documents/index.js";
import {
  PythonJsonError,
  pythonExecutable,
  runPythonJson,
} from "../src/python.js";

describe("pythonExecutable", () => {
  const prepared = "/envs/package/bin/python";

  it("prefers the named override variable over everything", () => {
    const env = { MY_PYTHON: "/override/python", VIRTUAL_ENV: "/venv" };
    expect(
      pythonExecutable({
        env,
        python: prepared,
        override: "MY_PYTHON",
        platform: "linux",
      }),
    ).toBe("/override/python");
  });

  it("ignores an override variable that is unset or empty", () => {
    expect(
      pythonExecutable({
        env: { MY_PYTHON: "" },
        python: prepared,
        override: "MY_PYTHON",
      }),
    ).toBe(prepared);
    expect(
      pythonExecutable({ env: {}, python: prepared, override: "MY_PYTHON" }),
    ).toBe(prepared);
  });

  it("then the prepared interpreter, over VIRTUAL_ENV", () => {
    expect(
      pythonExecutable({ env: { VIRTUAL_ENV: "/venv" }, python: prepared }),
    ).toBe(prepared);
  });

  it("then VIRTUAL_ENV, in the layout of the platform", () => {
    expect(
      pythonExecutable({ env: { VIRTUAL_ENV: "/venv" }, platform: "linux" }),
    ).toBe("/venv/bin/python");
    expect(
      pythonExecutable({ env: { VIRTUAL_ENV: "/venv" }, platform: "darwin" }),
    ).toBe("/venv/bin/python");
    expect(
      pythonExecutable({
        env: { VIRTUAL_ENV: "C:\\r\\.venv" },
        platform: "win32",
      }),
    ).toBe("C:\\r\\.venv\\Scripts\\python.exe");
  });

  it("then python3 from PATH", () => {
    expect(pythonExecutable({ env: {} })).toBe("python3");
  });

  it("applies RECIPE_DOCUMENTS_PYTHON for document helpers only", () => {
    const env = { RECIPE_DOCUMENTS_PYTHON: "/docs/python" };
    expect(documentPythonExecutable(env, prepared, "linux")).toBe(
      "/docs/python",
    );
    expect(pythonExecutable({ env, python: prepared })).toBe(prepared);
  });
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!hasPython)("runPythonJson", () => {
  const dir = mkdtempSync(join(tmpdir(), "python-json-"));
  const script = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };
  const echo = script(
    "echo.py",
    [
      "import json, os, sys",
      "request = json.load(sys.stdin)",
      "print(json.dumps({",
      "  'request': request,",
      "  'cwd': os.getcwd(),",
      "  'isolated': sys.flags.isolated,",
      "  'bytecode': os.environ.get('PYTHONDONTWRITEBYTECODE'),",
      "  'encoding': os.environ.get('PYTHONIOENCODING'),",
      "  'marker': os.environ.get('SYNTHETIC_MARKER'),",
      "}, ensure_ascii=False))",
    ].join("\n"),
  );

  it("exchanges JSON over stdin and stdout in isolated mode", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "python-json-cwd-"));
    const output = await runPythonJson<Record<string, unknown>>(
      echo,
      { greeting: "grüß dich" },
      {
        python: "python3",
        cwd,
        env: { ...process.env, SYNTHETIC_MARKER: "m-1" },
      },
    );
    expect(output).toMatchObject({
      request: { greeting: "grüß dich" },
      isolated: 1,
      bytecode: "1",
      encoding: "utf-8",
      marker: "m-1",
    });
    expect(
      spawnSync("python3", [
        "-c",
        "import os,sys; print(os.path.realpath(sys.argv[1]))",
        String(output.cwd),
      ])
        .stdout.toString()
        .trim(),
    ).toBe(
      spawnSync("python3", [
        "-c",
        "import os,sys; print(os.path.realpath(sys.argv[1]))",
        cwd,
      ])
        .stdout.toString()
        .trim(),
    );
  });

  it("rejects a non-zero exit, keeping the JSON the script printed", async () => {
    const failing = script(
      "fail.py",
      "import json, sys\nprint(json.dumps({'error': 'synthetic failure'}))\nsys.exit(1)\n",
    );
    const error = await runPythonJson(failing, {}, { python: "python3" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PythonJsonError);
    expect((error as PythonJsonError).output).toEqual({
      error: "synthetic failure",
    });
  });

  it("rejects stdout that is not JSON, with the stderr tail", async () => {
    const noisy = script(
      "noisy.py",
      "import sys\nprint('not json')\nprint('synthetic stderr', file=sys.stderr)\n",
    );
    await expect(
      runPythonJson(noisy, {}, { python: "python3" }),
    ).rejects.toThrow(/did not answer with JSON: synthetic stderr/);
  });

  it("stops a script at the timeout", async () => {
    const slow = script("slow.py", "import time\ntime.sleep(30)\n");
    await expect(
      runPythonJson(slow, {}, { python: "python3", timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(PythonJsonError);
  });

  describe("runDocumentHelper", () => {
    const env = { ...process.env, RECIPE_DOCUMENTS_PYTHON: "python3" };

    it("returns the document result with the call's timing", async () => {
      const helper = script(
        "helper.py",
        "import json, sys\nreq = json.load(sys.stdin)\nprint(json.dumps({'text': 'read ' + req['path'], 'details': {'timing': {'python_ms': 1.5}}, 'images': []}))\n",
      );
      const result = await runDocumentHelper(
        helper,
        { command: "read", path: "synthetic.docx" },
        { env, cwd: dir },
      );
      expect(result.text).toBe("read synthetic.docx");
      expect(result.images).toEqual([]);
      const timing = (result.details as { timing: Record<string, number> })
        .timing;
      expect(timing.python_ms).toBe(1.5);
      expect(typeof timing.call_ms).toBe("number");
    });

    it("turns the helper's error field into the call's error", async () => {
      const failing = script(
        "doc-fail.py",
        "import json, sys\nprint(json.dumps({'error': 'ValueError: synthetic'}))\nsys.exit(1)\n",
      );
      await expect(
        runDocumentHelper(failing, {}, { env, cwd: dir }),
      ).rejects.toThrow(/^ValueError: synthetic$/);
    });

    it("reports a helper that answers nothing usable", async () => {
      const silent = script(
        "doc-silent.py",
        "import sys\nprint('crashed', file=sys.stderr)\nsys.exit(2)\n",
      );
      await expect(
        runDocumentHelper(silent, {}, { env, cwd: dir }),
      ).rejects.toThrow(/^document helper failed: crashed/);
    });
  });
});
