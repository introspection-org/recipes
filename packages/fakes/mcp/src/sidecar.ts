import fs from "node:fs";
import path from "node:path";
import { type Fakes, type Services, startServices } from "./server.js";

/** The port the Harbor sidecar serves on unless `MCP_FAKES_PORT` says otherwise. */
export const SIDECAR_PORT = 7353;

/**
 * The Harbor sidecar: every fake on `0.0.0.0:7353`, configured from the environment. The
 * bundler's built-in entrypoint calls it with the Recipe's fakes and world.
 *
 * | Variable | Meaning |
 * | --- | --- |
 * | `MCP_FAKES_SCENARIO` | The scenario `world` builds |
 * | `MCP_FAKES_PORT`, `MCP_FAKES_HOST` | Where to listen; `7353` on `0.0.0.0` |
 * | `MCP_FAKES_STATE_FILE` | A file every fake's state is written to after each request |
 * | `MCP_FAKES_RECORD` | A file each tool call is appended to |
 * | `MCP_FAKES_MANIFEST_DIR` | A directory each fake's manifest is written to, as `mcp/<id>/manifest.json`, for the verifier |
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
    }
  // Node runs as PID 1 in the sidecar, which ignores SIGTERM without a handler.
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => process.exit(0));
  console.log(`Fake MCP services ready on port ${services.port}`);
  return services;
}
