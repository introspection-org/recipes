import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { contractOf, decode, encode, SIDECAR_PORT } from "../src/index.js";
import { answersOf } from "../src/sidecar.js";
import { callTool } from "./client.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(ROOT, "dist", "cli.js");
const FAKES = path.join(ROOT, "test", "fixtures", "fakes");

// The command as the package ships it, run in the fixture Recipe's fakes/.
async function cli(...args: string[]) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: FAKES });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

// Starts `mcp-fakes serve` in the fixture Recipe's fakes/, and resolves with its port.
function serve(env: Record<string, string>, ...args: string[]) {
  let stderr = "";
  const child = spawn(process.execPath, [CLI, "serve", ...args], {
    cwd: FAKES,
    env: { PATH: process.env.PATH, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk;
  });
  const port = new Promise<number>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      const match = String(chunk).match(/ready on port (\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.once("exit", (code) => reject(new Error(`serve exited with ${code}: ${stderr}`)));
  });
  return { child, port };
}

test("serve runs the Recipe's TypeScript fakes as they are", { timeout: 60_000 }, async () => {
  const manifests = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fakes-verifier-")), "v");
  const { child, port } = serve({
    MCP_FAKES_PORT: "0",
    MCP_FAKES_SCENARIO: "broken",
    MCP_FAKES_MANIFEST_DIR: manifests,
  });
  try {
    const url = `http://127.0.0.1:${await port}`;
    const sent = await callTool(`${url}/mail/mcp`, "send-email", {
      to: ["a@example.test"],
      subject: "Hi",
    });
    expect(sent).toEqual({ text: "Sent email-1", isError: false, structuredContent: undefined });
    expect((await (await fetch(`${url}/mail/admin/state`)).json()).emails).toHaveLength(1);
    expect((await (await fetch(`${url}/notes/admin/initial-state`)).json()).brokenId).toBe(
      "note-1",
    );
    const written = JSON.parse(
      fs.readFileSync(path.join(manifests, "mcp", "notes", "manifest.json"), "utf8"),
    );
    expect(written.server).toEqual({ name: "notes", version: "1.2.3" });
    const answers = JSON.parse(
      fs.readFileSync(path.join(manifests, "mcp", "notes", "answers.json"), "utf8"),
    );
    expect(answers["list-notes"]).toEqual({ format: "text" });
    expect(answers["get-note"]).toMatchObject({
      format: "json",
      structured: true,
      schema: { type: "object", properties: { id: { type: "string" } } },
    });
  } finally {
    child.kill("SIGTERM");
  }
});

test("serve writes a prefixed_json answer's prefix and suffix, so a verifier reads it back", () => {
  const tools = { tools: [{ name: "find", inputSchema: { type: "object" } }] } as const;
  const answer = { format: "prefixed_json", prefix: "Found: ", suffix: " Done." };
  const written = JSON.parse(JSON.stringify(answersOf(contractOf(tools, { find: answer }))));
  expect(written.find).toEqual(answer);
  expect(decode(written.find, encode(answer, { n: 2 }))).toEqual({ n: 2 });
  expect(() => decode(written.find, 'Found: {"n":2}')).toThrow('does not end with " Done."');
});

test("serve listens on the sidecar port unless told otherwise", { timeout: 60_000 }, async () => {
  expect(SIDECAR_PORT).toBe(7353);
  const { child, port } = serve({});
  try {
    expect(await port).toBe(SIDECAR_PORT);
    const health = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/health`);
    expect(await health.json()).toEqual({ ok: true });
  } finally {
    child.kill("SIGTERM");
  }
});

test("serve prints a refused scenario as Node prints an error", { timeout: 60_000 }, async () => {
  const failed: { code?: number; stderr: string } = await run(process.execPath, [CLI, "serve"], {
    cwd: FAKES,
    env: { PATH: process.env.PATH, MCP_FAKES_PORT: "0", MCP_FAKES_SCENARIO: "nope" },
  }).catch((error) => error);
  expect(failed.code).toBe(1);
  expect(failed.stderr).toMatch(/^Error: .*nope/m);
});

test("serve names a module without the export it needs", async () => {
  const missing = await cli("serve", "--fakes", "scenarios/index.ts");
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("scenarios/index.ts exports no `fakes`");
});

test("an unknown command prints the usage", async () => {
  const usage = await cli("bundle");
  expect(usage.code).toBe(2);
  expect(usage.stderr).toContain("Usage: mcp-fakes serve [--fakes <file>]");
});
