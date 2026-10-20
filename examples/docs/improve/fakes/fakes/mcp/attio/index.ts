import type { McpServer } from "@introspection-ai/mcp-fakes";
import type { State } from "./entities.ts";
import { register as registerWrites, registerReads } from "./handlers.ts";
import manifest from "./manifest.json" with { type: "json" };

export { manifest };

export function register(server: McpServer, state: State) {
  registerReads(server, state);
  registerWrites(server, state);
}
