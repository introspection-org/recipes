import { describe, expect, it } from "vitest";
import {
  promptBudget,
  modelBudgetTokens,
  OUTPUT_RESERVE_TOKENS,
  MAX_PROMPT_TOKENS,
} from "../src/prompts/index.js";

describe("a prompt's budget", () => {
  it("is a model's window less its reply's reserve, in tokens", () => {
    expect(
      modelBudgetTokens({ contextWindow: 200_000, maxTokens: 8_000 }),
    ).toBe(200_000 - 8_000);
    expect(
      modelBudgetTokens({ contextWindow: 280_000, maxTokens: 128_000 }),
    ).toBe(280_000 - OUTPUT_RESERVE_TOKENS);
  });

  it("never passes the 300k-token ceiling, which an unknown model takes too", () => {
    expect(
      modelBudgetTokens({ contextWindow: 1_000_000, maxTokens: 128_000 }),
    ).toBe(MAX_PROMPT_TOKENS);
    expect(promptBudget([undefined])).toBe(MAX_PROMPT_TOKENS);
  });

  it("fits the smallest window among the models that may answer", () => {
    const budget = promptBudget([
      { contextWindow: 1_000_000, maxTokens: 32_000 },
      { contextWindow: 272_000, maxTokens: 16_000 },
    ]);
    expect(budget).toBe(272_000 - 16_000);
  });

  it("stops at the ceiling it is given, which an unknown model takes", () => {
    expect(promptBudget([undefined], 266_000)).toBe(266_000);
    expect(
      promptBudget(
        [{ contextWindow: 1_000_000, maxTokens: 32_000 }, undefined],
        266_000,
      ),
    ).toBe(266_000);
  });
});
