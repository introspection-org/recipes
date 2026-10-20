import { fileURLToPath } from "node:url";

import { labelId, startServices } from "@introspection-ai/mcp-fakes";
import { checkRecipeFakes } from "@introspection-ai/mcp-fakes/checks";
import { loadManifests, piToolNames, writeAttempts } from "@introspection-ai/mcp-fakes/verify";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { decode } from "@toon-format/toon";
import { expect, test } from "vitest";

import { fakes } from "../improve/fakes/fakes/mcp/index.ts";
import { SCENARIOS, world } from "../improve/fakes/fakes/scenarios/index.ts";

const ACME_DEAL = labelId("acme-growth");

checkRecipeFakes({
  test,
  recipe: new URL("../improve/fakes/recipe.json", import.meta.url),
  fakes,
  world,
  scenarios: SCENARIOS,
  bundle: false,
});

test("the update-record handler writes the deal and answers in TOON", async () => {
  const services = await startServices(fakes, { world });
  const client = new Client({ name: "docs-examples", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(services.url("attio"))));
  try {
    const updated = await client.callTool({
      name: "update-record",
      arguments: { object: "deals", record_id: ACME_DEAL, values: { stage: "Won" } },
    });
    expect(updated.isError).toBeFalsy();
    expect(updated.content).toEqual([{ type: "text", text: expect.any(String) }]);
    expect(decode((updated.content as { text: string }[])[0]!.text)).toEqual({ record_id: ACME_DEAL });
    expect(services.states.attio.deals[0]?.stage).toBe("Won");
    expect(services.initial.attio.deals[0]?.stage).toBe("Proposal");

    const missing = await client.callTool({
      name: "update-record",
      arguments: { object: "deals", record_id: "nope", values: { stage: "Won" } },
    });
    expect(missing.isError).toBe(true);

    const company = await client.callTool({
      name: "update-record",
      arguments: { object: "companies", record_id: labelId("acme"), values: {} },
    });
    expect(company.isError).toBe(true);
    expect(company.content).toEqual([{ type: "text", text: "This fake does not implement updating companies." }]);
  } finally {
    await client.close();
    await services.close();
  }
});

test("the blocked scenario makes the Acme deal's update fail", async () => {
  const services = await startServices(fakes, { world, scenario: "blocked" });
  const client = new Client({ name: "docs-examples", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(services.url("attio"))));
  try {
    const rejected = await client.callTool({
      name: "update-record",
      arguments: { object: "deals", record_id: ACME_DEAL, values: { stage: "Won" } },
    });
    expect(rejected.isError).toBe(true);
    expect(services.states.attio.deals[0]?.stage).toBe("Proposal");
  } finally {
    await client.close();
    await services.close();
  }
});

test("the blocked scenario marks the Acme deal's update as failing", () => {
  expect(world(undefined, new Date()).attio.failUpdate).toBeUndefined();
  expect(world("blocked", new Date()).attio.failUpdate).toBe(ACME_DEAL);
  expect(() => world("blockd", new Date())).toThrow(/Unknown scenario/);
});

test("the no-crm-write judge counts only calls to write tools", () => {
  const manifests = loadManifests(fileURLToPath(new URL("../improve/fakes/fakes/mcp", import.meta.url)));
  const call = (tool: string) => ({ name: piToolNames("attio", tool)[0]! });
  expect(writeAttempts([call("list-records"), call("get-records-by-ids")], { attio: manifests.attio! })).toEqual([]);
  expect(writeAttempts([call("update-record")], { attio: manifests.attio! })).toHaveLength(1);
});
