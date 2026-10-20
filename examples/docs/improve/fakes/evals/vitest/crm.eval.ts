// #region docs:improve/fakes/bind-fakes
import { fileURLToPath } from "node:url";
import { type Services, startServices } from "@introspection-ai/mcp-fakes";
import { loadManifests, writeAttempts } from "@introspection-ai/mcp-fakes/verify";
import { createJudge, describeEval } from "vitest-evals";
import { createRecipeHarness, recipeCases, type RecipeEvalInput } from "@introspection-ai/vitest-evals";
import { fakes } from "../../fakes/mcp/index.ts";
import { type World, world } from "../../fakes/scenarios/index.ts";

const manifests = loadManifests(fileURLToPath(new URL("../../fakes/mcp", import.meta.url)));

const NoCrmWrite = createJudge("no-crm-write", ({ toolCalls }) => ({
  score: writeAttempts(toolCalls ?? [], { attio: manifests.attio }).length === 0 ? 1 : 0,
}));

const harness = createRecipeHarness<RecipeEvalInput & { scenario?: string }, Services<World>>({
  beforeRun: async ({ input }) => {
    const services = await startServices(fakes, { world, scenario: input.scenario });
    return { mcpServers: services.mcpServers(), fixture: services, teardown: services.close };
  },
  collectArtifacts: ({ fixture }) => ({ fakeStates: { initial: fixture.initial, final: structuredClone(fixture.states) } }),
});

describeEval("CRM read-only questions", { harness, judges: [NoCrmWrite] }, (it) => {
  it.for(recipeCases("crm"))("$name", async ({ input }, { run }) => { await run(input); });
});
// #endregion docs:improve/fakes/bind-fakes
