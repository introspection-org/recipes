/**
 * Host conformance suite for Recipe sessions.
 *
 * A host that adopts `createAgentSession` with its own injected pieces —
 * credential store, synthesized MCP bindings, run controller — runs these
 * cases in its own CI. Passing the suite is what "supported host" means: the
 * session contract cannot drift from its consumers silently.
 *
 * The cases are runner-agnostic: each is a `{ name, run }` pair that throws
 * on failure. In vitest:
 *
 * ```ts
 * import { hostConformanceCases } from "@introspection-ai/recipes/test-utils";
 * for (const c of hostConformanceCases(myHostAdapter)) it(c.name, c.run);
 * ```
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { resolveRecipe } from "./recipe/resolve.js";
import type {
  CreateAgentSessionOptions,
  RecipeSessionHandle,
} from "./session.js";

export interface RecipeHost {
  /**
   * Create a session with the host's default injections applied. The options
   * here layer the suite's fixture on top.
   */
  createSession(
    options: CreateAgentSessionOptions,
  ): Promise<RecipeSessionHandle>;
}

export interface HostConformanceCase {
  name: string;
  run(): Promise<void>;
}

interface FixtureOptions {
  agentExtras?: string[];
  dependencies?: Record<string, string>;
  manifestPi?: Record<string, unknown>;
  subagents?: string[];
  tools?: string[];
}

/** Write a minimal recipe package into a fresh temp dir. */
export function writeFixtureRecipe(options: FixtureOptions = {}): {
  recipeDir: string;
  workspaceDir: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "recipe-conformance-"));
  const recipeDir = join(root, "recipe");
  const workspaceDir = join(root, "workspace");
  mkdirSync(join(recipeDir, "agents"), { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(recipeDir, "package.json"),
    JSON.stringify({
      name: "conformance-fixture",
      version: "0.1.0",
      type: "module",
      ...(options.dependencies ? { dependencies: options.dependencies } : {}),
      pi: { agents: ["agents/*.yaml"], ...(options.manifestPi ?? {}) },
    }),
  );
  writeFileSync(
    join(recipeDir, "SYSTEM.md"),
    "You are a conformance fixture.\n",
  );
  writeFileSync(
    join(recipeDir, "agents", "agent.yaml"),
    [
      "name: agent",
      "model:",
      "  name: anthropic/claude-sonnet-4-5",
      "  thinking_level: low",
      `tools: [${(options.tools ?? ["read"]).join(", ")}]`,
      ...(options.subagents?.length
        ? ["subagents:", ...options.subagents.map((name) => `  - ${name}`)]
        : []),
      "system_instructions:",
      "  mode: append",
      "  content: Conformance agent",
      ...(options.agentExtras ?? []),
      "",
    ].join("\n"),
  );
  for (const name of options.subagents ?? []) {
    writeFileSync(
      join(recipeDir, "agents", `${name}.yaml`),
      [
        `name: ${name}`,
        "model:",
        "  name: anthropic/claude-sonnet-4-5",
        "  thinking_level: low",
        "tools: [read]",
        "system_instructions:",
        "  mode: append",
        `  content: Subagent ${name}`,
        "",
      ].join("\n"),
    );
  }
  return {
    recipeDir,
    workspaceDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Conformance failure: ${message}`);
}

async function expectRejection(
  promise: Promise<unknown>,
  message: string,
): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error(`Conformance failure: expected rejection — ${message}`);
}

async function testCredentialStore(): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: "conformance-test-key",
  }));
  return store;
}

export function hostConformanceCases(host: RecipeHost): HostConformanceCase[] {
  return [
    {
      name: "constructs a session from a resolved recipe with an injected credential store",
      async run() {
        const fixture = writeFixtureRecipe();
        try {
          const handle = await host.createSession({
            recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
            cwd: fixture.workspaceDir,
            credentials: await testCredentialStore(),
            env: { ...cleanEnv() },
          });
          try {
            assert(handle.agent.name === "agent", "agentName resolves");
            assert(
              handle.session.systemPrompt.includes("conformance fixture"),
              "SYSTEM.md reaches the system prompt",
            );
            assert(handle.agentRuns, "handle exposes an agent run controller");
          } finally {
            await handle.dispose();
          }
        } finally {
          fixture.cleanup();
        }
      },
    },
    {
      name: "fails closed when the model provider has no credential",
      async run() {
        const fixture = writeFixtureRecipe();
        try {
          const err = await expectRejection(
            host.createSession({
              recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
              cwd: fixture.workspaceDir,
              env: { ...cleanEnv() },
            }),
            "session construction without credentials",
          );
          assert(
            /ANTHROPIC_API_KEY/.test(err.message),
            `error names the expected env var (got: ${err.message})`,
          );
        } finally {
          fixture.cleanup();
        }
      },
    },
    {
      name: "fails closed on an unbound required MCP server",
      async run() {
        const fixture = writeFixtureRecipe({
          manifestPi: {
            mcp: {
              servers: [
                { id: "linear", required: true, tools: { include: ["*"] } },
              ],
            },
          },
          agentExtras: [
            "mcp:",
            "  mode: cli",
            "  servers:",
            "    linear:",
            '      include: ["*"]',
          ],
        });
        try {
          const err = await expectRejection(
            host.createSession({
              recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
              cwd: fixture.workspaceDir,
              credentials: await testCredentialStore(),
              env: { ...cleanEnv() },
            }),
            "session construction with an unbound required MCP server",
          );
          assert(
            err.message.includes("linear"),
            `error names the unbound server (got: ${err.message})`,
          );
        } finally {
          fixture.cleanup();
        }
      },
    },
    {
      name: "materializes inline MCP bindings without a local config file",
      async run() {
        const fixture = writeFixtureRecipe({
          manifestPi: {
            mcp: {
              servers: [
                { id: "linear", required: true, tools: { include: ["*"] } },
              ],
            },
          },
          agentExtras: [
            "mcp:",
            "  mode: cli",
            "  servers:",
            "    linear:",
            '      include: ["*"]',
          ],
        });
        try {
          const env = { ...cleanEnv() };
          const originalPath = env.PATH;
          const handle = await host.createSession({
            recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
            cwd: fixture.workspaceDir,
            credentials: await testCredentialStore(),
            env,
            mcpBindings: {
              servers: [
                {
                  id: "linear",
                  transport: "streamable_http",
                  url: "http://127.0.0.1:9/mcp",
                },
              ],
            },
          });
          await handle.dispose();
          await handle.dispose();
          assert(
            env.MCPORTER_CONFIG === undefined,
            "dispose restores an absent MCPORTER_CONFIG",
          );
          assert(env.PATH === originalPath, "dispose restores PATH");
        } finally {
          fixture.cleanup();
        }
      },
    },
    {
      name: "errors, never wedges, when a subagent profile does not exist",
      async run() {
        const fixture = writeFixtureRecipe({ subagents: ["helper"] });
        try {
          const handle = await host.createSession({
            recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
            cwd: fixture.workspaceDir,
            credentials: await testCredentialStore(),
            env: { ...cleanEnv() },
          });
          try {
            const settled = await Promise.race([
              (async () => {
                try {
                  const run = await handle.agentRuns.start({
                    name: "ghost",
                    prompt: "hello",
                  });
                  if (run.status === "running") {
                    return await handle.agentRuns.wait(run.agent_run_id);
                  }
                  return run;
                } catch (err) {
                  // A controller may reject the start outright; that is a
                  // valid non-wedging behavior.
                  return {
                    status: "failed" as const,
                    error: err instanceof Error ? err.message : String(err),
                  };
                }
              })(),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () =>
                    reject(
                      new Error(
                        "Conformance failure: ghost subagent start wedged (no settlement in 15s)",
                      ),
                    ),
                  15_000,
                ),
              ),
            ]);
            assert(
              settled.status === "failed",
              `ghost run settles as failed (got: ${settled.status})`,
            );
          } finally {
            await handle.dispose();
          }
        } finally {
          fixture.cleanup();
        }
      },
    },
  ];
}

/**
 * A process env for fixtures: PATH and platform basics without provider
 * keys, so credential-resolution cases are deterministic.
 */
export function cleanEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "TMPDIR", "SHELL", "SystemRoot", "TEMP", "TMP"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}
