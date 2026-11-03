import { observedOf } from "@introspection-ai/mcp-fakes";
import manifest from "./manifest.json" with { type: "json" };
import recorded from "./observed.ts";

export { contract } from "./contract.ts";
export { register } from "./handlers.ts";
export { manifest };

// What the real server answered each observed tool with.
export const observed = observedOf(recorded);
