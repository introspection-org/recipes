import { describe, expect, it } from "vitest";
import type { JudgeInput } from "../src/judges/trajectory.js";
import {
  CLASSIFIER_BUDGET_UNITS,
  renderTrajectoryInput,
} from "../src/prompts/index.js";

// Today's judge prompts, pinned before they move onto the prompt builders, so
// the move shows here as a diff if it changes a byte.

const LONG = "x".repeat(5_000);
const EMOJI = "🙂".repeat(1_500);

const base: JudgeInput = {
  schema_version: 2,
  trajectory: [
    { type: "message", role: "user", content: "How many seats?" },
    { type: "tool_call", id: "c1", name: "crm_lookup", arguments: { q: LONG } },
    {
      type: "tool_result",
      tool_call_id: "c1",
      name: "crm_lookup",
      content: { rows: [LONG] },
    },
    { type: "message", role: "assistant", content: `42 ${EMOJI}` },
  ],
};

const CASES: Record<
  string,
  { input: JudgeInput; options?: Parameters<typeof renderTrajectoryInput>[1] }
> = {
  whole: { input: base },
  with_system: { input: { ...base, system_instructions: "Be brief." } },
  blank_system: { input: { ...base, system_instructions: "   " } },
  only_system: {
    input: { schema_version: 2, trajectory: [], system_instructions: "S" },
  },
  classifier: {
    input: { ...base, system_instructions: "S" },
    options: { maxUnits: CLASSIFIER_BUDGET_UNITS, slim: true },
  },
  cut: {
    input: { ...base, system_instructions: "S" },
    options: { maxUnits: 900 },
  },
  cut_on_surrogate: { input: base, options: { maxUnits: 6_001 } },
  slim_and_cut: { input: base, options: { maxUnits: 700, slim: true } },
};

describe("a judge's prompt", () => {
  it.each(Object.entries(CASES))("renders %s", (_, { input, options }) => {
    expect(renderTrajectoryInput(input, options)).toMatchSnapshot();
  });
});
