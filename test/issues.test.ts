import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRecipeConnectors } from "../src/connector-tools.js";
import {
  createIssuesTool,
  formatIssuesResult,
  issuesParameters,
  issuesProviderDeclarations,
  ISSUES_SKILL,
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
          {
            provider: "linear",
            options: { team: "ENG", server: "linear-mcp" },
          },
          {
            provider: "jira",
            options: { project: "OPS", issueType: "Task" },
          },
          { provider: "introspection", enabled: false },
        ],
      }),
    ).toEqual([]);
  });

  it("reports options a provider does not take, a bad enabled, and unknown ids and fields", () => {
    expect(
      messages({
        issues: [
          { provider: "linear", options: { project: "OPS" } },
          { provider: "jira", options: { team: "ENG", issueType: "" } },
          { provider: "introspection", enabled: "no" },
          { provider: "acme" },
          { provider: "linear" },
          { provider: "github", enabled: false, package: "@acme/gh" },
          {
            provider: "jira2",
            package: "@acme/jira",
            color: "red",
            options: { queue: "ops", nested: {} },
          },
          { provider: "linear2", package: "@acme/l", team: "ENG", options: [] },
          "linear",
        ],
      }),
    ).toEqual([
      "package.json#pi.issues[0].options: provider 'linear' takes no option 'project'; it takes team, server",
      "package.json#pi.issues[1].options: provider 'jira' takes no option 'team'; it takes project, issueType, server",
      "package.json#pi.issues[1].options.issueType must be a non-empty string",
      "package.json#pi.issues[2].enabled must be true or false",
      "package.json#pi.issues provider 'acme' is not a first-party provider (linear, jira, introspection); give it a package",
      "package.json#pi.issues contains duplicate provider 'linear'",
      "package.json#pi.issues[5].package '@acme/gh' must be listed in package.json#dependencies",
      "package.json#pi.issues[5].enabled applies only to 'introspection'; remove the declaration to leave 'github' out",
      "package.json#pi.issues[6] contains unknown field(s): color; it takes provider, package, options, enabled",
      "package.json#pi.issues[6].package '@acme/jira' must be listed in package.json#dependencies",
      "package.json#pi.issues[6].options.nested must be a non-empty string",
      "package.json#pi.issues[7] contains unknown field(s): team; it takes provider, package, options, enabled",
      "package.json#pi.issues[7].package '@acme/l' must be listed in package.json#dependencies",
      "package.json#pi.issues[7].options must be an object",
      "package.json#pi.issues[8] must be an object",
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
            {
              provider: "jira",
              options: { project: "OPS", issueType: "Task" },
            },
            { provider: "introspection", enabled: false },
          ],
        }),
      ).issues,
    ).toEqual([
      { provider: "jira", options: { project: "OPS", issueType: "Task" } },
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
    ).toEqual({ toolNames: [], hosts: [] });
    const disabled = recipe({
      issues: [{ provider: "introspection", enabled: false }],
    });
    expect(
      await loadRecipeIssues(
        readPiPackageManifest(disabled).issues,
        ["issues"],
        { recipeDir: disabled },
      ),
    ).toEqual({ toolNames: [], hosts: [] });
  });

  it("registers one issues tool over the first-party bundle when declared and selected", async () => {
    const recipeDir = recipe({ issues: [{ provider: "linear" }] });
    const loaded = await loadRecipeConnectors(
      readPiPackageManifest(recipeDir),
      ["issues"],
      { recipeDir, env: {} },
    );
    expect(loaded.loadout.toolNames).toEqual(["issues"]);
    expect(loaded.skillPaths).toEqual([ISSUES_SKILL]);
    expect(readFileSync(ISSUES_SKILL, "utf8")).toMatch(/^---\nname: issues\n/);
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
      "introspection: search: Text matches the title and description of the most recent issues; the assignee is me or a member id.",
    );
    expect(
      (tool as unknown as { reachesTools(): string[] }).reachesTools(),
    ).toContain(mcpToolName("linear", "list_issues"));
  });

  it("loads a Recipe's own provider, with only the options it declares", async () => {
    const installed = (options: Record<string, unknown>) =>
      recipe(
        { issues: [{ provider: "acme", package: "@acme/issues", options }] },
        {
          "node_modules/@acme/issues/package.json": JSON.stringify({
            name: "@acme/issues",
            version: "1.0.0",
            type: "module",
            main: "index.js",
          }),
          "node_modules/@acme/issues/index.js": `export default { kind: "issues", apiVersion: 2, id: "acme",
  capabilities: { commands: { search: {} }, fields: [], hosts: ["acme.test"], options: { queue: "string" } },
  createSession: () => ({ search: async () => ({ issues: [] }) }) };\n`,
        },
      );
    const load = (recipeDir: string) =>
      loadRecipeIssues(readPiPackageManifest(recipeDir).issues, ["issues"], {
        recipeDir,
      });
    expect((await load(installed({ queue: "support" }))).toolNames).toEqual([
      "issues",
    ]);
    await expect(load(installed({ project: "X" }))).rejects.toThrow(
      "Recipe issues provider 'acme' takes no option 'project'; it takes queue",
    );
    await expect(load(installed({ queue: true }))).rejects.toThrow(
      "Recipe issues provider 'acme' option 'queue' must be a string",
    );
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
    apiVersion: 2,
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
      config: { provider: id, options: {} },
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
      config: { provider: "introspection", options: {} },
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

  it("declares each command with only its own arguments", () => {
    const schema = issuesParameters(providers([])) as unknown as {
      anyOf: Array<{
        properties: Record<string, { const?: string }>;
        required: string[];
        description: string;
      }>;
    };
    const variant = (command: string) =>
      schema.anyOf.find(
        (entry) => entry.properties.command?.const === command,
      )!;
    expect(Object.keys(variant("get").properties)).toEqual([
      "command",
      "handle",
    ]);
    expect(variant("create").required).toEqual(["command", "title"]);
    expect(variant("create").properties).not.toHaveProperty("query");
    expect(variant("transition").required).toEqual([
      "command",
      "handle",
      "status",
    ]);
    expect(schema.anyOf.every((entry) => entry.description)).toBe(true);
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

  it("names a person known only by id, on the issue and on its comments", () => {
    const text = formatIssuesResult({
      command: "get",
      provider: "introspection",
      issue: {
        handle: "introspection:12",
        provider: "introspection",
        ref: "12",
        title: "T",
        status: { name: "open", category: "open" },
        assignee: { id: "member-1" },
        comments: [
          { body: "By a member", author: { id: "member-2" } },
          { body: "By no one" },
        ],
      },
    });
    expect(text).toContain("assignee member-1");
    expect(text).toContain("- member-2: By a member");
    expect(text).toContain("- unknown: By no one");
  });
});

describe("attachments", () => {
  const TRACE = "0af7651916cd43dd8448eb211c80319c";
  const SPAN = "b7ad6b7169203331";

  /** A provider taking `attachments`, recording what each write receives. */
  function attaching(
    id: string,
    attachments: RecipeIssuesProviderModule["capabilities"]["attachments"],
    received: unknown[],
  ): IssuesToolProvider {
    const base = fakeModule(id, { available: true });
    return {
      module: {
        ...base,
        capabilities: {
          ...base.capabilities,
          ...(attachments ? { attachments } : {}),
        },
        createSession: () => ({
          create: async (args) => {
            received.push(args);
            return issue("2", args.title);
          },
          update: async (args) => {
            received.push(args);
            return issue(args.ref);
          },
        }),
      },
      config: { provider: id, options: {} },
      fallback: false,
    };
  }

  it("passes checked attachments to create and update, reduced to each kind's fields", async () => {
    const received: unknown[] = [];
    const tool = createIssuesTool({
      providers: [
        attaching(
          "introspection",
          { kinds: ["link", "file", "event", "span"], remove: true },
          received,
        ),
      ],
    });
    await tool({
      command: "create",
      title: "T",
      attachments: [
        { kind: "link", url: " https://github.com/acme/app/pull/7 " },
        { kind: "span", trace_id: TRACE, span_id: SPAN },
      ],
    });
    await tool({
      command: "update",
      handle: "introspection:I-3",
      add_attachments: [
        { kind: "file", file_id: "f1", name: "report.pdf" },
        { kind: "event", event_id: "e1" },
      ],
      remove_attachments: ["a1"],
    });
    expect(received).toEqual([
      {
        title: "T",
        attachments: [
          { kind: "link", url: "https://github.com/acme/app/pull/7" },
          { kind: "span", trace_id: TRACE, span_id: SPAN },
        ],
      },
      {
        ref: "I-3",
        add_attachments: [
          { kind: "file", file_id: "f1", name: "report.pdf" },
          { kind: "event", event_id: "e1" },
        ],
        remove_attachments: ["a1"],
      },
    ]);
  });

  it("refuses an attachment that is not well formed", async () => {
    const tool = createIssuesTool({
      providers: [
        attaching(
          "introspection",
          { kinds: ["link", "file", "event", "span"], remove: true },
          [],
        ),
      ],
    });
    const refused = (attachments: unknown[], message: string): Promise<void> =>
      expect(
        tool({
          command: "update",
          handle: "introspection:1",
          add_attachments: attachments as never,
        }),
      ).rejects.toMatchObject({
        issues: { code: "invalid_request", message },
      });
    await refused(
      [{ kind: "pdf" }],
      "add_attachments[0] needs a kind: link, file, event, span.",
    );
    await refused(
      [{ kind: "link", title: "PR" }],
      "add_attachments[0]: a link attachment needs url.",
    );
    await refused(
      [{ kind: "link", url: "https://x.test", file_id: "f1" }],
      "add_attachments[0]: a link attachment takes url and title, not file_id.",
    );
    await refused(
      [{ kind: "link", url: "https://user:pw@x.test/" }],
      "add_attachments[0]: url is an http or https URL without credentials, at most 2048 characters.",
    );
    await refused(
      [{ kind: "link", url: "file:///etc/passwd" }],
      "add_attachments[0]: url is an http or https URL without credentials, at most 2048 characters.",
    );
    await refused(
      [
        { kind: "event", event_id: "e1" },
        { kind: "span", trace_id: "xyz", span_id: SPAN },
      ],
      "add_attachments[1]: trace_id is 32 hex characters and span_id 16.",
    );
    await expect(
      tool({
        command: "update",
        handle: "introspection:1",
        remove_attachments: [""],
      }),
    ).rejects.toMatchObject({ issues: { code: "invalid_request" } });
    // An empty list is no change, so an update with nothing else is refused.
    await expect(
      tool({
        command: "update",
        handle: "introspection:1",
        add_attachments: [],
      }),
    ).rejects.toMatchObject({ issues: { code: "invalid_request" } });
  });

  it("refuses a kind or a removal the provider does not declare, naming what it can do", async () => {
    const received: unknown[] = [];
    const tool = createIssuesTool({
      providers: [
        attaching("linear", { kinds: ["link"], remove: false }, received),
        attaching("acme", undefined, received),
      ],
    });
    await expect(
      tool({
        command: "create",
        provider: "linear",
        title: "T",
        attachments: [{ kind: "event", event_id: "e1" }],
      }),
    ).rejects.toMatchObject({
      issues: {
        code: "not_supported",
        message:
          "linear takes only link attachments, not event; leave that kind out.",
      },
    });
    await expect(
      tool({
        command: "update",
        handle: "linear:ENG-1",
        remove_attachments: ["a1"],
      }),
    ).rejects.toMatchObject({
      issues: {
        code: "not_supported",
        message:
          "linear cannot remove attachments; it only adds link attachments.",
      },
    });
    await expect(
      tool({
        command: "update",
        handle: "acme:A-1",
        add_attachments: [{ kind: "link", url: "https://x.test" }],
      }),
    ).rejects.toMatchObject({
      issues: {
        code: "not_supported",
        message: "acme issues take no attachments; leave them out.",
      },
    });
    expect(received).toEqual([]);
  });

  it("says in the description what each provider's attachments are", () => {
    const pi = createMockExtensionAPI();
    registerIssuesTool(pi, {
      providers: [
        attaching("linear", { kinds: ["link"], remove: false }, []),
        attaching(
          "introspection",
          { kinds: ["link", "file", "event", "span"], remove: true },
          [],
        ),
        attaching("acme", undefined, []),
      ],
    });
    const description = pi.tools.get("issues")!.description;
    expect(description).toContain(
      "linear: attachments: link only; attachments cannot be removed.",
    );
    expect(description).not.toMatch(/^introspection:/m);
    expect(description).toContain("acme: no attachments.");
  });

  it("lists an issue's attachments with their ids", () => {
    const text = formatIssuesResult({
      command: "get",
      provider: "introspection",
      issue: {
        handle: "introspection:12",
        provider: "introspection",
        ref: "12",
        title: "T",
        status: { name: "open", category: "open" },
        attachments: [
          {
            id: "a1",
            kind: "link",
            url: "https://x.test/pr/1",
            title: "Pull request",
          },
          { id: "a2", kind: "file", file_id: "f1", name: "report.pdf" },
          { id: "a3", kind: "event", event_id: "e1" },
          { kind: "span", trace_id: TRACE, span_id: SPAN },
        ],
      },
    });
    expect(text).toContain(
      [
        "Attachments:",
        "- link: Pull request https://x.test/pr/1 (id a1)",
        "- file: report.pdf f1 (id a2)",
        "- event: e1 (id a3)",
        `- span: ${TRACE}/${SPAN}`,
      ].join("\n"),
    );
  });

  it("refuses a provider whose attachments capability is malformed", async () => {
    const recipeDir = recipe(
      { issues: [{ provider: "acme", package: "@acme/issues" }] },
      {
        "node_modules/@acme/issues/package.json": JSON.stringify({
          name: "@acme/issues",
          version: "1.0.0",
          type: "module",
          main: "index.js",
        }),
        "node_modules/@acme/issues/index.js": `export default { kind: "issues", apiVersion: 2, id: "acme",
  capabilities: { commands: { search: {} }, fields: [], hosts: [], attachments: { kinds: ["pdf"], remove: false } },
  createSession: () => ({}) };\n`,
      },
    );
    await expect(
      loadRecipeIssues(readPiPackageManifest(recipeDir).issues, ["issues"], {
        recipeDir,
      }),
    ).rejects.toThrow(
      "Recipe issues provider 'acme' declares capabilities.attachments that are not { kinds: (link | file | event | span)[], remove: boolean }",
    );
  });
});
