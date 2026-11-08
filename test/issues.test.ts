import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRecipeConnectors } from "../src/connector-tools.js";
import {
  createIssuesTool,
  issuesParameters,
  issuesProviderDeclarations,
  loadRecipeIssues,
  registerIssuesTool,
  type IssuesMcpClient,
  type IssuesToolProvider,
  type ProviderIssue,
  type RecipeIssuesProviderModule,
} from "../src/issues/index.js";
import { mcpToolName } from "../src/mcp/pi-client.js";
import {
  readPiPackageManifest,
  validatePiPackageManifest,
} from "../src/recipe/package.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function recipe(
  pi: Record<string, unknown>,
  files: Record<string, string> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "issues-recipe-"));
  write(
    join(dir, "package.json"),
    JSON.stringify({
      name: "r",
      version: "0.1.0",
      type: "module",
      pi: { agents: [], ...pi },
    }),
  );
  for (const [path, body] of Object.entries(files))
    write(join(dir, path), body);
  return dir;
}

const messages = (pi: Record<string, unknown>) =>
  validatePiPackageManifest(readPiPackageManifest(recipe(pi))).findings.map(
    (finding) => finding.message,
  );

describe("pi.issues", () => {
  it("accepts first-party providers with their own options", () => {
    expect(
      messages({
        issues: [
          { provider: "linear", team: "ENG", server: "linear-mcp" },
          { provider: "jira", project: "OPS", issueType: "Task" },
          { provider: "introspection", enabled: false },
        ],
      }),
    ).toEqual([]);
  });

  it("reports options a provider does not take, a bad enabled, and unknown ids and fields", () => {
    expect(
      messages({
        issues: [
          { provider: "linear", project: "OPS" },
          { provider: "jira", team: "ENG", issueType: "" },
          { provider: "introspection", enabled: "no" },
          { provider: "acme" },
          { provider: "linear" },
          { provider: "github", enabled: false, module: "./gh.ts" },
          { provider: "jira2", package: "@acme/jira", color: "red" },
          "linear",
        ],
      }),
    ).toEqual([
      "package.json#pi.issues[0]: provider 'linear' takes no project",
      "package.json#pi.issues[1]: provider 'jira' takes no team",
      "package.json#pi.issues[1].issueType must be a non-empty string",
      "package.json#pi.issues[2].enabled must be true or false",
      "package.json#pi.issues provider 'acme' is not a first-party provider (linear, jira, introspection); give it a package or module",
      "package.json#pi.issues contains duplicate provider 'linear'",
      "package.json#pi.issues[5]: module './gh.ts' does not exist",
      "package.json#pi.issues[5].enabled applies only to 'introspection'; remove the declaration to leave 'github' out",
      "package.json#pi.issues[6] contains unknown field(s): color",
      "package.json#pi.issues[6].package '@acme/jira' must be listed in package.json#dependencies",
      "package.json#pi.issues[7] must be an object",
    ]);
    expect(messages({ issues: { provider: "linear" } })).toEqual([
      "package.json#pi.issues must be an array",
    ]);
  });

  it("parses the declarations, and is absent without pi.issues", () => {
    expect(readPiPackageManifest(recipe({})).issues).toBeUndefined();
    expect(
      readPiPackageManifest(
        recipe({
          issues: [
            { provider: "jira", project: "OPS", issueType: "Task" },
            { provider: "introspection", enabled: false },
          ],
        }),
      ).issues,
    ).toEqual([
      { provider: "jira", project: "OPS", issueType: "Task" },
      { provider: "introspection", enabled: false },
    ]);
  });
});

describe("the introspection fallback", () => {
  it("is included whenever pi.issues is declared, unless disabled", () => {
    const ids = (declared: Parameters<typeof issuesProviderDeclarations>[0]) =>
      issuesProviderDeclarations(declared).map((d) => d.provider);
    expect(ids([])).toEqual(["introspection"]);
    expect(ids([{ provider: "linear" }])).toEqual(["linear", "introspection"]);
    expect(ids([{ provider: "introspection" }, { provider: "jira" }])).toEqual([
      "introspection",
      "jira",
    ]);
    expect(
      ids([
        { provider: "linear" },
        { provider: "introspection", enabled: false },
      ]),
    ).toEqual(["linear"]);
    expect(ids([{ provider: "introspection", enabled: false }])).toEqual([]);
  });
});

describe("registering the issues tool", () => {
  it("registers nothing without pi.issues, or when the agent does not select it", async () => {
    const plain = recipe({});
    expect(
      await loadRecipeIssues(readPiPackageManifest(plain).issues, ["issues"], {
        recipeDir: plain,
      }),
    ).toEqual({ toolNames: [] });
    const declared = recipe({ issues: [] });
    expect(
      await loadRecipeIssues(readPiPackageManifest(declared).issues, ["bash"], {
        recipeDir: declared,
      }),
    ).toEqual({ toolNames: [] });
    const disabled = recipe({
      issues: [{ provider: "introspection", enabled: false }],
    });
    expect(
      await loadRecipeIssues(
        readPiPackageManifest(disabled).issues,
        ["issues"],
        { recipeDir: disabled },
      ),
    ).toEqual({ toolNames: [] });
  });

  it("registers one issues tool over the first-party bundle when declared and selected", async () => {
    const recipeDir = recipe({ issues: [{ provider: "linear" }] });
    const loaded = await loadRecipeConnectors(
      readPiPackageManifest(recipeDir),
      ["issues"],
      { recipeDir, env: {} },
    );
    expect(loaded.loadout.toolNames).toEqual(["issues"]);
    const pi = createMockExtensionAPI();
    for (const extension of loaded.extensions) extension.factory(pi);
    const tool = pi.tools.get("issues")!;
    expect(tool).toBeDefined();
    const schema = tool.parameters as {
      properties: { provider: { enum: string[] } };
    };
    expect(schema.properties.provider.enum).toEqual([
      "linear",
      "introspection",
    ]);
    expect(tool.description).toContain(
      "introspection: no comment; no assignee",
    );
    expect(
      (tool as unknown as { reachesTools(): string[] }).reachesTools(),
    ).toContain(mcpToolName("linear", "list_issues"));
  });

  it("loads a Recipe's own provider from a module", async () => {
    const recipeDir = recipe(
      { issues: [{ provider: "acme", module: "./acme.ts", project: "X" }] },
      {
        "acme.ts": `export default { kind: "issues", apiVersion: 1, id: "acme",
  capabilities: { commands: { search: {} }, fields: [], hosts: ["acme.test"] },
  createSession: () => ({ search: async () => ({ issues: [] }) }) };\n`,
      },
    );
    const loaded = await loadRecipeIssues(
      readPiPackageManifest(recipeDir).issues,
      ["issues"],
      { recipeDir },
    );
    expect(loaded.toolNames).toEqual(["issues"]);
  });
});

function issue(ref: string, title = "T"): ProviderIssue {
  return { ref, title, status: { name: "Todo", category: "open" } };
}

/** A fake provider recording which provider served each call. */
function fakeModule(
  id: string,
  options: {
    mcp?: boolean;
    available?: boolean;
    commands?: string[];
    fields?: RecipeIssuesProviderModule["capabilities"]["fields"];
  } = {},
  served: string[] = [],
): RecipeIssuesProviderModule {
  const commands = options.commands ?? [
    "search",
    "get",
    "create",
    "update",
    "comment",
    "transition",
  ];
  return {
    kind: "issues",
    apiVersion: 1,
    id,
    capabilities: {
      commands: Object.fromEntries(commands.map((command) => [command, {}])),
      fields: options.fields ?? [
        "description",
        "assignee",
        "labels",
        "priority",
      ],
      hosts: [],
    },
    ...(options.mcp
      ? {
          mcp: {
            url: `https://mcp.${id}.test/mcp`,
            server: id,
            tools: [{ tool: "find", serves: ["search"], verified: false }],
          },
        }
      : {}),
    ...(options.available !== undefined
      ? { available: () => options.available! }
      : {}),
    createSession: () => ({
      search: async (_args, ctx) => {
        served.push(`${id}:search${ctx.mcp ? ":mcp" : ""}`);
        return { issues: [issue("1")] };
      },
      get: async ({ ref }) => {
        served.push(`${id}:get`);
        return issue(ref);
      },
      create: async ({ title }) => {
        served.push(`${id}:create`);
        return issue("2", title);
      },
      update: async ({ ref }) => {
        served.push(`${id}:update`);
        return issue(ref);
      },
      comment: async ({ body }) => {
        served.push(`${id}:comment`);
        return { body };
      },
      transition: async ({ ref, status }) => {
        served.push(`${id}:transition`);
        return { ...issue(ref), status: { name: status, category: "done" } };
      },
    }),
  };
}

function providers(
  served: string[],
  extra: Array<[string, Parameters<typeof fakeModule>[1]]> = [
    ["linear", { mcp: true }],
  ],
): IssuesToolProvider[] {
  return [
    ...extra.map(([id, options]) => ({
      module: fakeModule(id, options, served),
      config: { provider: id },
      ...(options?.mcp ? { server: id } : {}),
      fallback: false,
    })),
    {
      module: fakeModule(
        "introspection",
        {
          available: true,
          commands: ["search", "get", "create", "update", "transition"],
          fields: ["description", "labels", "priority"],
        },
        served,
      ),
      config: { provider: "introspection" },
      fallback: true,
    },
  ];
}

const connectedTo = (...servers: string[]): IssuesMcpClient => ({
  hasTool: (server) => servers.includes(server),
  callTool: async () => ({ content: [] }),
});

describe("choosing a provider", () => {
  it("offers the fallback only while no other provider is connected", async () => {
    const served: string[] = [];
    const tool = createIssuesTool({ providers: providers(served) });
    await tool({ command: "search" });
    await tool({ command: "search" }, { mcp: connectedTo() });
    await tool({ command: "search" }, { mcp: connectedTo("linear") });
    expect(served).toEqual([
      "introspection:search",
      "introspection:search",
      "linear:search:mcp",
    ]);
    await expect(
      tool(
        { command: "create", provider: "introspection", title: "x" },
        { mcp: connectedTo("linear") },
      ),
    ).rejects.toThrow(
      "introspection is a fallback, offered only when no other provider is; on offer: linear.",
    );
  });

  it("reaches a handle's provider whenever it has a credential path", async () => {
    const served: string[] = [];
    const tool = createIssuesTool({ providers: providers(served) });
    const got = await tool(
      { command: "get", handle: "introspection:12" },
      { mcp: connectedTo("linear") },
    );
    expect(got).toMatchObject({
      command: "get",
      issue: {
        handle: "introspection:12",
        provider: "introspection",
        ref: "12",
      },
    });
    await expect(
      tool({ command: "get", handle: "linear:ENG-1" }),
    ).rejects.toMatchObject({
      issues: {
        code: "not_connected",
        message:
          "linear is not connected. Ask a member to connect it with introspection_open, then try again.",
      },
    });
    await expect(
      tool({ command: "get", handle: "ENG-1" }),
    ).rejects.toMatchObject({
      issues: { code: "invalid_request" },
    });
    await expect(
      tool({ command: "get", handle: "github:1" }),
    ).rejects.toMatchObject({
      issues: { code: "invalid_request" },
    });
  });

  it("makes a call name one provider when several are on offer", async () => {
    const served: string[] = [];
    const list = providers(served, [
      ["linear", { mcp: true }],
      ["jira", { mcp: true }],
    ]);
    const tool = createIssuesTool({ providers: list });
    const both = { mcp: connectedTo("linear", "jira") };
    await expect(tool({ command: "search" }, both)).rejects.toThrow(
      "Several issues providers are on offer; name one: linear, jira.",
    );
    const created = await tool(
      { command: "create", provider: "jira", title: "Hi" },
      both,
    );
    expect(created).toMatchObject({ issue: { handle: "jira:2", title: "Hi" } });
    await expect(
      tool(
        { command: "search", provider: "jira" },
        { mcp: connectedTo("linear") },
      ),
    ).rejects.toMatchObject({ issues: { code: "not_connected" } });
    const schema = issuesParameters(list) as {
      properties: { provider: { enum: string[] }; command: { enum: string[] } };
    };
    expect(schema.properties.provider.enum).toEqual([
      "linear",
      "jira",
      "introspection",
    ]);
    expect(schema.properties.command.enum).toEqual([
      "search",
      "get",
      "create",
      "update",
      "comment",
      "transition",
    ]);
  });

  it("asks for a connection when nothing is on offer", async () => {
    const list = providers([]).slice(0, 1);
    await expect(
      createIssuesTool({ providers: list })({ command: "search" }),
    ).rejects.toThrow(
      "No issues provider is connected. Ask a member to connect linear with introspection_open.",
    );
  });

  it("refuses what a provider does not support", async () => {
    const tool = createIssuesTool({ providers: providers([]) });
    await expect(
      tool({ command: "comment", handle: "introspection:12", body: "hi" }),
    ).rejects.toMatchObject({
      issues: {
        code: "not_supported",
        message: "introspection does not support comment.",
      },
    });
    await expect(
      tool({ command: "update", handle: "introspection:12", assignee: "me" }),
    ).rejects.toMatchObject({
      issues: {
        code: "not_supported",
        message: "introspection issues take no assignee; leave it out.",
      },
    });
    await expect(
      tool({ command: "update", handle: "introspection:12" }),
    ).rejects.toMatchObject({
      issues: { code: "invalid_request" },
    });
  });

  it("returns text to the model and a typed error as a failed result", async () => {
    const served: string[] = [];
    const pi = createMockExtensionAPI();
    registerIssuesTool(pi, { providers: providers(served) });
    const tool = pi.tools.get("issues")!;
    const ok = (await tool.execute(
      "t1",
      { command: "transition", handle: "introspection:12", status: "done" },
      undefined,
      undefined,
      {} as never,
    )) as { content: Array<{ text: string }>; isError?: boolean };
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0]!.text).toBe("introspection:12 · T\n  done (done)");
    const failed = (await tool.execute(
      "t2",
      { command: "comment", handle: "introspection:12", body: "x" },
      undefined,
      undefined,
      {} as never,
    )) as { content: Array<{ text: string }>; isError?: boolean };
    expect(failed.isError).toBe(true);
    expect(failed.content[0]!.text).toBe(
      "issues failed (not_supported): introspection does not support comment.",
    );
  });
});
