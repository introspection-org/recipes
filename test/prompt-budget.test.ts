import { describe, expect, it } from "vitest";
import {
  promptBudget,
  modelBudgetUnits,
  OUTPUT_RESERVE_TOKENS,
  MAX_PROMPT_UNITS,
  UNITS_PER_TOKEN,
} from "../src/prompts/index.js";

describe("a prompt's budget", () => {
  it("is a model's window less its reply's reserve, in UTF-16 units", () => {
    expect(modelBudgetUnits({ contextWindow: 200_000, maxTokens: 8_000 })).toBe(
      (200_000 - 8_000) * UNITS_PER_TOKEN,
    );
    expect(
      modelBudgetUnits({ contextWindow: 280_000, maxTokens: 128_000 }),
    ).toBe((280_000 - OUTPUT_RESERVE_TOKENS) * UNITS_PER_TOKEN);
  });

  it("never passes the 300k-token ceiling, which an unknown model takes too", () => {
    expect(
      modelBudgetUnits({ contextWindow: 1_000_000, maxTokens: 128_000 }),
    ).toBe(MAX_PROMPT_UNITS);
    expect(promptBudget([undefined])).toBe(MAX_PROMPT_UNITS);
  });

  it("fits the smallest window among the models that may answer", () => {
    const budget = promptBudget([
      { contextWindow: 1_000_000, maxTokens: 32_000 },
      { contextWindow: 272_000, maxTokens: 16_000 },
    ]);
    expect(budget).toBe((272_000 - 16_000) * UNITS_PER_TOKEN);
  });

  it("stops at the ceiling it is given, which an unknown model takes", () => {
    expect(promptBudget([undefined], 800_000)).toBe(800_000);
    expect(
      promptBudget(
        [{ contextWindow: 1_000_000, maxTokens: 32_000 }, undefined],
        800_000,
      ),
    ).toBe(800_000);
  });
});
