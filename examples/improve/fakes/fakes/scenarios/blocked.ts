// #region docs:improve/fakes/scenarios
import { labelId } from "@introspection-ai/eval-simulate/mcp";
import type { World } from "./index.ts";

// Updating the Acme deal is rejected by the CRM.
export default function blocked(world: World) {
  world.attio.failUpdate = labelId("acme-growth");
}
// #endregion docs:improve/fakes/scenarios
