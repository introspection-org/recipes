import { labelId } from "@introspection-ai/mcp-fakes";
import type { World } from "./index.ts";

// Every record is fictional, and every date would be computed from the clock.
export default function base(_clock: Date): World {
  return {
    attio: {
      companies: [{ id: labelId("acme"), name: "Acme Robotics" }],
      deals: [{ id: labelId("acme-growth"), name: "Acme growth plan", stage: "Proposal", company_id: labelId("acme") }],
    },
  };
}
