import type { State as Attio } from "../mcp/attio/entities.ts";
import base from "./base.ts";
import blocked from "./blocked.ts";

export type World = { attio: Attio };

export const SCENARIOS = { blocked } satisfies Record<string, (world: World) => void>;

export function world(name: string | undefined, clock: Date): World {
  const built = base(clock);
  if (name === undefined) return built;
  if (!Object.hasOwn(SCENARIOS, name)) throw new Error(`Unknown scenario: ${name}`);
  SCENARIOS[name as keyof typeof SCENARIOS](built);
  return built;
}
