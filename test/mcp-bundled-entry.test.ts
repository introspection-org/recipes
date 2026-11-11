import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

it("starts MCP from a relocated host bundle and its generated session shim", async () => {
  const host = mkdtempSync(join(tmpdir(), "mcp-host-"));
  try {
    const modules = join(host, "node_modules", "@introspection-ai");
    mkdirSync(modules, { recursive: true });
    symlinkSync(root, join(modules, "recipes"), "dir");
    const outfile = join(host, "usr", "local", "lib", "runtime", "probe.mjs");
    await build({
      stdin: {
        resolveDir: root,
        contents: `
          import assert from "node:assert/strict";
          import { execFile } from "node:child_process";
          import { existsSync, mkdirSync, writeFileSync } from "node:fs";
          import { dirname, join } from "node:path";
          import { fileURLToPath } from "node:url";
          import { materializeSessionMcpCli, mcpClientEntrypointPath,
            mcpCliEntrypointPath, stopMcpDaemon } from "./src/mcp/index.ts";
          import { daemonPath, ensureMcpDaemon } from "./src/mcp/daemon/client.ts";
          import { hostedMcpDaemon } from "./src/mcp/daemon/hosted.ts";
          const dist = dirname(fileURLToPath(import.meta.resolve("@introspection-ai/recipes")));
          assert.equal(mcpClientEntrypointPath(), join(dist, "mcp/client-entry.js"));
          assert.equal(mcpCliEntrypointPath(), join(dist, "mcp/cli/index.js"));
          assert.equal(daemonPath(), join(dist, "mcp-daemon.js"));
          const cwd = process.cwd();
          mkdirSync(join(cwd, ".pi"), { recursive: true });
          const env = { ...process.env,
            MCPORTER_CONFIG: join(cwd, ".pi/mcporter.json"),
            PI_RECIPES_MCP_SESSION: join(cwd, ".pi/mcp-session.json"),
            PI_RECIPES_MCP_DAEMON_SOCKET: join(cwd, "daemon.sock"),
            PI_RECIPES_MCP_DAEMON_TOKEN: "test-token",
            PI_RECIPES_MCP_DAEMON_FINGERPRINT: "test-fingerprint",
            PI_RECIPES_MCP_DAEMON_PARENT_PID: String(process.pid),
          };
          writeFileSync(env.MCPORTER_CONFIG, JSON.stringify({ imports: [], mcpServers: {} }));
          writeFileSync(env.PI_RECIPES_MCP_SESSION, JSON.stringify({ version: 1, servers: [] }));
          const { shimPath } = await materializeSessionMcpCli({ cwd, env });
          const session = () => ({ socketPath: env.PI_RECIPES_MCP_DAEMON_SOCKET,
            token: env.PI_RECIPES_MCP_DAEMON_TOKEN, fingerprint: env.PI_RECIPES_MCP_DAEMON_FINGERPRINT });
          // Asynchronous, so a server this process hosts can answer the shim.
          function run(args, runEnv = env) {
            return new Promise((resolve) => {
              execFile(shimPath, args, { cwd, env: runEnv, encoding: "utf8", timeout: 25000 },
                (error, stdout, stderr) => {
                  assert.equal(error?.code ?? 0, 0, stderr + stdout);
                  resolve(stdout + stderr);
                });
            });
          }
          try {
            // No socket exists: native client must invoke the JS supervisor.
            assert.match(await run(["--help"]), /mcp search/);
            assert.ok(existsSync(env.PI_RECIPES_MCP_DAEMON_SOCKET));
            // The shim's fallback starts the standalone daemon, never one in this process.
            assert.equal(hostedMcpDaemon(session()), undefined);
          } finally { await stopMcpDaemon({ ...env }); }
          // On pi-mcp the relocated bundle serves the socket from its own
          // process, and finds the run worker from the package rather than
          // from itself; mcporter keeps the standalone daemon.
          env.PI_RECIPES_MCP_DAEMON_SOCKET = join(cwd, "bundled.sock");
          try {
            await ensureMcpDaemon(env);
            assert.equal(Boolean(hostedMcpDaemon(session())),
              process.env.PI_RECIPES_MCP_CLIENT !== "mcporter");
            assert.match(await run(["--help"]), /mcp search/);
            writeFileSync(join(cwd, "probe.js"), "console.log(42)");
            assert.match(await run(["run", "probe.js"]), /42/);
          } finally { await stopMcpDaemon({ ...env }); }
          assert.ok(!existsSync(join(cwd, "bundled.sock")));
          // Shells without the daemon environment take the direct CLI path.
          assert.match(await run(["--help"], { ...env, PI_RECIPES_MCP_DAEMON_SOCKET: "" }), /mcp search/);
        `,
      },
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["@introspection-ai/recipes"],
      // jsonc-parser's UMD `main` hides its requires from esbuild.
      mainFields: ["module", "main"],
      banner: {
        js: 'import { createRequire as __testCreateRequire } from "node:module"; const require = __testCreateRequire(import.meta.url);',
      },
    });
    const child = spawnSync(process.execPath, [outfile], {
      cwd: host,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(child.stderr).toBe("");
    expect(child.status, child.stdout).toBe(0);
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
}, 90_000);
