// #region docs:improve/evals/score-cases
import { expect } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createRecipeHarness, recipeCases, recipeJudge } from "@introspection-ai/vitest-evals";

const CodesRecall = createJudge<unknown, string, { expected: { codes: string[] } }>(
  "codes-recall",
  ({ output, expected }) => {
    const found = expected.codes.filter((code) => output.includes(code));
    return { score: found.length / expected.codes.length };
  },
);

describeEval("Billing codes", {
  harness: createRecipeHarness(),
  judges: [recipeJudge("cites-policy")],   // runs on every case
}, (it) => {
  it.for(recipeCases("billing-codes"))("$name", async ({ input, expected }, { run }) => {
    const result = await run(input);
    await expect(result).toSatisfyJudge(CodesRecall, { expected: expected as { codes: string[] }, threshold: 1 });
  });
});
// #endregion docs:improve/evals/score-cases
