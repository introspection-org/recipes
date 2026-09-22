import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const distCli = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "mcp",
  "cli",
  "index.js"
);

describe("mcp CLI entry", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "recipes-mcp-entry-"));
    writeFileSync(join(dir, "mcporter.json"), JSON.stringify({ imports: [], mcpServers: {} }));
    writeFileSync(
      join(dir, "mcp-session.json"),
      JSON.stringify({ version: 1, servers: [] })
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runCli(
    entry: string,
    args: string[],
    opts: { input?: string; env?: Record<string, string> } = {}
  ): {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    output: string;
  } {
    const child = spawnSync(process.execPath, [entry, ...args], {
      env: {
        ...process.env,
        MCPORTER_CONFIG: join(dir, "mcporter.json"),
        PI_RECIPES_MCP_SESSION: join(dir, "mcp-session.json"),
        ...opts.env,
      },
      encoding: "utf8",
      timeout: 30_000,
      input: opts.input,
    });
    return {
      status: child.status,
      signal: child.signal,
      stdout: child.stdout,
      stderr: child.stderr,
      output: `${child.stdout}${child.stderr}`,
    };
  }

  it("runs the CLI when invoked directly", () => {
    const result = runCli(distCli, ["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stderr).toBe("");
  });

  it("presents one primary discovery-to-call flow and keeps run as composition", () => {
    const result = runCli(distCli, ["--help"]);
    const search = result.stdout.indexOf('mcp search "what you need"');
    const schema = result.stdout.indexOf("mcp list <server.tool> --schema");
    const call = result.stdout.indexOf("mcp call <server>.<tool> key=value");

    expect(search).toBeGreaterThanOrEqual(0);
    expect(schema).toBeGreaterThan(search);
    expect(call).toBeGreaterThan(schema);
    expect(result.stdout).toContain("Batch or compose multiple calls in JavaScript");
    expect(result.stdout).toContain("mcp run <<'JS'");
    expect(result.stdout).not.toContain("mcp run <<'EOF'");
    expect(result.stdout).not.toContain("--save-images");
  });

  it("exits cleanly when a downstream pipeline closes stdout", () => {
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        [
          'const { spawn } = require("node:child_process");',
          `const child = spawn(process.execPath, [${JSON.stringify(distCli)}, "--help"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });`,
          "let stderr = '';",
          "child.stderr.setEncoding('utf8');",
          "child.stderr.on('data', chunk => { stderr += chunk; });",
          "child.stdout.destroy();",
          "child.on('close', code => { process.stderr.write(stderr); process.exit(code ?? 1); });",
        ].join("\n"),
      ],
      {
        env: {
          ...process.env,
          MCPORTER_CONFIG: join(dir, "mcporter.json"),
          PI_RECIPES_MCP_SESSION: join(dir, "mcp-session.json"),
        },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    expect(probe.status).toBe(0);
    expect(probe.stderr).not.toContain("EPIPE");
    expect(probe.stderr).not.toContain("Unhandled 'error' event");
  });

  it("runs through a symlink (pnpm/npm bin shims)", () => {
    // pnpm exposes package binaries through node_modules symlinks and npm bin
    // shims, so the dedicated entrypoint must work through either path.
    const linkDir = join(dir, "bin");
    mkdirSync(linkDir, { recursive: true });
    const link = join(linkDir, "mcp-cli.js");
    symlinkSync(distCli, link);

    const result = runCli(link, ["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stderr).toBe("");
  });

  it("provides wrapper help for every supported subcommand", () => {
    for (const command of ["search", "run", "list", "call"]) {
      const result = runCli(distCli, [command, "--help"]);
      expect(result.status).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      expect(result.stderr).toBe("");
    }
  });

  it("keeps quiet list output silent", () => {
    const quiet = runCli(distCli, ["list", "--quiet"]);
    expect(quiet.status).toBe(0);
    expect(quiet.output).toBe("");
  });

  it("rejects schema mode without an exact tool target", () => {
    const result = runCli(distCli, ["list", "--schema"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("requires one exact tool");
  });

  it("rejects unknown compact list options", () => {
    const result = runCli(distCli, ["list", "--scheam"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown mcp list option '--scheam'");
  });

  it("keeps list metadata failures compact", () => {
    writeFileSync(
      join(dir, "mcp-session.json"),
      JSON.stringify({
        version: 1,
        servers: [
          {
            id: "offline",
            base_url: "http://127.0.0.1:9/mcp",
            required: false,
            package_tools: { include: ["lookup"] },
            agent_tools: [{ include: ["lookup"] }],
          },
        ],
      })
    );
    writeFileSync(
      join(dir, "mcporter.json"),
      JSON.stringify({
        imports: [],
        mcpServers: {
          offline: {
            baseUrl: "http://127.0.0.1:9/mcp",
            allowedTools: ["lookup"],
          },
        },
      })
    );

    const result = runCli(distCli, [
      "list",
      "offline.lookup",
      "--json",
      "--timeout",
      "100",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("JSON is reserved for tool results");
    expect(result.stderr).not.toContain(" at ");

    const quiet = runCli(distCli, ["list", "offline", "--quiet", "--timeout", "100"]);
    expect(quiet.status).not.toBe(0);
    expect(quiet.output).toBe("");
  });

  it("rejects in-session authentication", () => {
    const auth = runCli(distCli, ["auth", "contacts"]);
    expect(auth.status).toBe(2);
    expect(auth.output).toContain("Ask the user to authenticate");
    expect(auth.output).not.toContain("managed");
  });

  it("blocks mcporter administration and ad-hoc connection surfaces", () => {
    for (const args of [
      ["config", "list"],
      ["resource", "contacts"],
      ["generate-cli", "contacts"],
      ["list", "--http-url", "https://example.test/mcp"],
    ]) {
      const result = runCli(distCli, args);
      expect(result.status).toBe(2);
      expect(result.output).toContain("unavailable");
    }
  });

  it("rejects an empty run script as a usage error", () => {
    const result = runCli(distCli, ["run"], { input: "  \n" });
    expect(result.status).toBe(2);
    expect(result.output).toContain("mcp run: empty script");
  });

  it("reports unknown servers in run scripts with the available list", () => {
    const result = runCli(distCli, ["run"], { input: "await tools.ghost.lookup({})" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("Unknown MCP server 'ghost'");
    expect(result.output).toContain("No MCP servers are configured.");
  });

  it("force-kills run scripts that never yield", () => {
    const result = runCli(distCli, ["run"], {
      input: "while (true) {}",
      env: { PI_RECIPES_MCP_RUN_TIMEOUT_MS: "500" },
    });
    expect(result.signal).toBe("SIGKILL");
    expect(result.output).toContain("mcp run: killed after 2500ms");
    expect(result.output).toContain("synchronous busy-loop");
  });

  it("reports uncertain remote outcome on a yielding timeout", () => {
    const result = runCli(distCli, ["run"], {
      input: "await new Promise(() => {})",
      env: { PI_RECIPES_MCP_RUN_TIMEOUT_MS: "100" },
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("Remote side effects may already have occurred");
    expect(result.output).toContain("inspect state before retrying");
  });

  it("rejects function-call expressions before the delegated path", () => {
    const result = runCli(distCli, ["call", 'ghost.lookup(q: "x", limit:']);
    expect(result.status).toBe(2);
    expect(result.output).toContain("function-call expressions are unavailable");
    expect(result.output).toContain("key=value or --json");
  });

  it("rejects well-formed function-call expressions too", () => {
    const expr = runCli(distCli, ["call", 'ghost.lookup(q: "x")']);
    expect(expr.status).toBe(2);
    expect(expr.output).toContain("function-call expressions are unavailable");
  });

  it("rejects non-numeric search limits", () => {
    const result = runCli(distCli, ["search", "profile", "--limit", "abc"]);
    expect(result.status).toBe(2);
    expect(result.output).toContain("--limit expects a positive integer, got 'abc'");
  });

  it("rejects fractional search limits and unknown options", () => {
    const fractional = runCli(distCli, ["search", "profile", "--limit", "1.5"]);
    expect(fractional.status).toBe(2);
    expect(fractional.output).toContain("--limit expects a positive integer");

    const unknown = runCli(distCli, ["search", "profile", "--limt", "2"]);
    expect(unknown.status).toBe(2);
    expect(unknown.output).toContain("Unknown mcp search option '--limt'");
  });

  it("rejects duplicate call arguments across plain and named-flag syntax", () => {
    writeFileSync(
      join(dir, "mcp-session.json"),
      JSON.stringify({
        version: 1,
        servers: [
          {
            id: "contacts",
            base_url: "http://127.0.0.1:9/mcp",
            required: false,
            package_tools: { include: ["search_contacts"] },
            agent_tools: [{ include: ["search_contacts"] }],
            catalog: [
              {
                name: "search_contacts",
                input_schema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                },
              },
            ],
          },
        ],
      })
    );

    const result = runCli(distCli, [
      "call",
      "contacts.search_contacts",
      "query=Ada",
      "query=Grace",
    ]);
    expect(result.status).toBe(2);
    expect(result.output).toContain("argument 'query' was passed more than once");
  });

  it("rejects invalid run timeout configuration", () => {
    const result = runCli(distCli, ["run"], {
      input: "return 1",
      env: { PI_RECIPES_MCP_RUN_TIMEOUT_MS: "NaN" },
    });
    expect(result.status).toBe(2);
    expect(result.output).toContain("PI_RECIPES_MCP_RUN_TIMEOUT_MS expects a positive integer");
  });
});
