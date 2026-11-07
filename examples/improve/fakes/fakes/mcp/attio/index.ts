import type { McpServer } from "@introspection-ai/eval-simulate/mcp";
import type { State } from "./entities.ts";
import { register as registerWrites, registerReads } from "./handlers.ts";
import manifest from "./manifest.json" with { type: "json" };

export { manifest };
export { contract } from "./contract.ts";

export function register(server: McpServer, state: State) {
  registerReads(server, state);
  registerWrites(server, state);
}
