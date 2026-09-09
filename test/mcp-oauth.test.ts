import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultMcporterConfigPath,
  materializeMcpSession,
} from "../src/mcp.js";
import type { RecipePackageManifest } from "../src/recipe-package.js";

describe("MCP OAuth session configuration", () => {
  it("projects OAuth references without contacting the server", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipes-mcp-oauth-"));
    try {
      const cwd = join(root, "workspace");
      const recipeDir = join(root, "recipe");
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      mkdirSync(recipeDir, { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "mcp.local.json"),
        JSON.stringify({
          servers: [
            {
              id: "crm",
              transport: "streamable_http",
              url: "https://mcp.example.test/mcp",
              auth: "oauth",
              oauthClientId: "client-id",
              oauthClientSecretEnv: "CRM_CLIENT_SECRET",
            },
          ],
        })
      );
      const manifest: RecipePackageManifest = {
        name: "oauth-recipe",
        version: "1.0.0",
        path: recipeDir,
        resources: { agents: [], extensions: [], skills: [], prompts: [] },
        mcp: {
          manifests: [],
          servers: [
            {
              id: "crm",
              required: true,
              tools: { include: ["*"] },
            },
          ],
        },
      };

      const session = await materializeMcpSession({
        cwd,
        manifest,
        agentMcp: [{ serverId: "crm", tools: { include: ["*"] } }],
        env: {},
      });

      expect(session.servers).toHaveLength(1);
      expect(session.servers[0]?.catalog).toBeUndefined();
      const config = JSON.parse(
        readFileSync(defaultMcporterConfigPath(cwd), "utf8")
      ) as { mcpServers: Record<string, Record<string, unknown>> };
      expect(config.mcpServers.crm).toMatchObject({
        baseUrl: "https://mcp.example.test/mcp",
        auth: "oauth",
        oauthClientId: "client-id",
        oauthClientSecretEnv: "CRM_CLIENT_SECRET",
      });
      expect(JSON.stringify(config)).not.toContain("CRM_CLIENT_SECRET=");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
