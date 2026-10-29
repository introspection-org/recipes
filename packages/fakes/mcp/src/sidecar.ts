import fs from "node:fs";
import path from "node:path";
import type { Contract } from "./contract.js";
import { type Fakes, type Services, startServices } from "./server.js";

/** The port the Harbor sidecar serves on unless `MCP_FAKES_PORT` says otherwise. */
export const SIDECAR_PORT = 7353;

/**
 * The Harbor sidecar: every fake on `0.0.0.0:7353`, configured from the environment. `mcp-fakes
 * serve` calls it with the Recipe's fakes and world.
 *
 * | Variable | Meaning |
 * | --- | --- |
 * | `MCP_FAKES_SCENARIO` | The scenario `world` builds |
 * | `MCP_FAKES_PORT`, `MCP_FAKES_HOST` | Where to listen; `7353` on `0.0.0.0` |
 * | `MCP_FAKES_STATE_FILE` | A file every fake's state is written to after each request |
 * | `MCP_FAKES_INITIAL_STATE_FILE` | A file the state `/<id>/admin/initial-state` reports is written to at start |
 * | `MCP_FAKES_RESUME_STATE_FILE` | A state file of an earlier run to start every fake from instead of the world; `/<id>/admin/initial-state` then reports `MCP_FAKES_INITIAL_STATE_FILE` as that run left it, or this state when it is unset |
 * | `MCP_FAKES_RECORD` | A file each tool call is appended to |
 * | `MCP_FAKES_MANIFEST_DIR` | A directory each fake's manifest and answers are written to, as `mcp/<id>/manifest.json` and `mcp/<id>/answers.json`, for the verifier |
 */
export async function serveSidecar<W extends object>(
  fakes: Fakes,
  world: (scenario: string | undefined, clock: Date) => W,
  env: Record<string, string | undefined> = process.env,
): Promise<Services<W>> {
  const services = await startServices(fakes, {
    world,
    scenario: env.MCP_FAKES_SCENARIO || undefined,
    port: env.MCP_FAKES_PORT ? Number(env.MCP_FAKES_PORT) : SIDECAR_PORT,
    host: env.MCP_FAKES_HOST || "0.0.0.0",
    stateFile: env.MCP_FAKES_STATE_FILE || undefined,
    initialStateFile: env.MCP_FAKES_INITIAL_STATE_FILE || undefined,
    resume: resumed<W>(env.MCP_FAKES_RESUME_STATE_FILE, env.MCP_FAKES_INITIAL_STATE_FILE),
    record: env.MCP_FAKES_RECORD || undefined,
  });
  if (env.MCP_FAKES_MANIFEST_DIR)
    for (const [id, fake] of Object.entries(fakes)) {
      const dir = path.join(env.MCP_FAKES_MANIFEST_DIR, "mcp", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        `${JSON.stringify(fake.manifest, null, 2)}\n`,
      );
      fs.writeFileSync(
        path.join(dir, "answers.json"),
        `${JSON.stringify(answersOf(fake.contract), null, 2)}\n`,
      );
    }
  // Node runs as PID 1 in the sidecar, which ignores SIGTERM without a handler.
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => process.exit(0));
  console.log(`Fake MCP services ready on port ${services.port}`);
  return services;
}

// The earlier run `MCP_FAKES_RESUME_STATE_FILE` names, read before anything is written over it.
function resumed<W extends object>(stateFile?: string, initialFile?: string) {
  if (!stateFile) return undefined;
  const states = readStates<W>(stateFile);
  return { states, initial: initialFile ? readStates<W>(initialFile) : states };
}

function readStates<W extends object>(file: string): W {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read the saved state ${file}: ${(error as Error).message}`);
  }
  const states = JSON.parse(text);
  if (!states || typeof states !== "object" || Array.isArray(states))
    throw new Error(`The saved state ${file} is not every fake's state keyed by fake id`);
  return states as W;
}

/**
 * Each tool's answer by name, as JSON for a verifier in another language: its format, prefix,
 * suffix and schema (a TypeBox schema is JSON Schema), and `structured: true` for a tool that states an
 * outputSchema, whose answer is its structuredContent rather than its text.
 */
export function answersOf(contract: Contract) {
  return Object.fromEntries(
    Object.entries(contract).map(([name, { tool, answer }]) => [
      name,
      { ...answer, ...(tool.outputSchema && { structured: true }) },
    ]),
  );
}
