// #region docs:improve/eval-cases/per-case-files
import { resolve } from "node:path";
import { createRecipeHarness } from "@introspection-ai/vitest-evals";

const harness = createRecipeHarness({
  renderPrompt: ({ prompt, doc }) =>
    doc ? `${prompt}\n\nThe lease is at ${resolve(String(doc))}` : prompt,
});
// #endregion docs:improve/eval-cases/per-case-files

import { describeEval } from "vitest-evals";
import { recipeCases, recipeJudge } from "@introspection-ai/vitest-evals";

describeEval("Refund policy", { harness, judges: [recipeJudge("refund-policy")] }, (it) => {
  // #region docs:improve/eval-cases/expected-values
  it.for(recipeCases("refund-policy"))("$name", async ({ input, expected }, { run }) => {
    const result = await run(input);
    // grade result against expected with a judge: see Run and compare evals
  });
  // #endregion docs:improve/eval-cases/expected-values
});
