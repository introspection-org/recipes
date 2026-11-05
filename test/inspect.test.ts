import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectRecipe } from "../src/inspect.js";
import { resolveRecipe } from "../src/recipe/resolve.js";
import { writeFixtureRecipe } from "../src/test-utils.js";

describe("inspectRecipe", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("reports every accepted provider credential variable", () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);

    const inspection = inspectRecipe(
      resolveRecipe({ recipeDir: fixture.recipeDir }),
    );
    expect(inspection.credentialEnv).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_OAUTH_TOKEN",
    ]);
    expect(inspection.resolvedAgents[0]).toMatchObject({
      name: "agent",
      prompt: { base: "SYSTEM.md" },
      tools: {
        authored: ["read"],
        root: ["read"],
        subagent: ["read"],
      },
    });
  });

  it("reports deterministic binding variables without reading host-local bindings", () => {
    const fixture = writeFixtureRecipe({
      manifestPi: {
        mcp: {
          servers: [{ id: "crm", required: false, tools: { include: ["*"] } }],
        },
      },
      agentExtras: [
        "mcp:",
        "  mode: cli",
        "  servers:",
        "    crm:",
        '      include: ["*"]',
      ],
    });
    cleanups.push(fixture.cleanup);
    const configDir = join(fixture.recipeDir, ".pi");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "mcp.local.json"),
      JSON.stringify({
        servers: [
          {
            id: "crm",
            url: "${CRM_MCP_URL}",
            auth: "oauth",
            oauthClientSecretEnv: "CRM_CLIENT_SECRET",
          },
        ],
      }),
    );

    expect(
      inspectRecipe(resolveRecipe({ recipeDir: fixture.recipeDir })).mcpEnv,
    ).toEqual(["CRM_MCP_TOKEN", "CRM_MCP_URL"]);
  });
});
