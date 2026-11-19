import { describe, expect, it } from "vitest";
import {
  fitBudget,
  modelBudgetUnits,
  OUTPUT_RESERVE_TOKENS,
  UNITS_PER_TOKEN,
} from "../src/prompts/index.js";

describe("a prompt's budget", () => {
  it("is a model's window less its reply's reserve, in UTF-16 units", () => {
    expect(modelBudgetUnits({ contextWindow: 200_000, maxTokens: 8_000 })).toBe(
      (200_000 - 8_000) * UNITS_PER_TOKEN,
    );
    expect(
      modelBudgetUnits({ contextWindow: 1_000_000, maxTokens: 128_000 }),
    ).toBe((1_000_000 - OUTPUT_RESERVE_TOKENS) * UNITS_PER_TOKEN);
  });

  it("fits the smallest window among the models that may answer", () => {
    const budget = fitBudget(
      [
        { contextWindow: 1_000_000, maxTokens: 32_000 },
        { contextWindow: 272_000, maxTokens: 16_000 },
      ],
      800_000,
    );
    expect(budget.maxUnits).toBe((272_000 - 16_000) * UNITS_PER_TOKEN);
  });

  it("keeps the fixed budget for a model the catalog does not know", () => {
    expect(fitBudget([undefined], 800_000).maxUnits).toBe(800_000);
    expect(
      fitBudget(
        [{ contextWindow: 1_000_000, maxTokens: 32_000 }, undefined],
        800_000,
      ).maxUnits,
    ).toBe(800_000);
  });
});
