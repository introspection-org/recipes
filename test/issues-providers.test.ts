import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  adfToMarkdown,
  createIntrospectionIssuesProvider,
  JIRA_MCP_TOOLS,
  jiraIssuesProvider,
  LINEAR_MCP_TOOLS,
  linearIssuesProvider,
  type IntrospectionIssue,
  type IntrospectionIssueComment,
  type IntrospectionIssuesClient,
} from "../packages/issues/src/index.js";
import {
  ISSUES_FIRST_PARTY_OPTIONS,
  type IssuesMcpCaller,
  type IssuesSession,
  type RecipeIssuesProviderModule,
} from "../src/issues/index.js";

interface CapturedToolList {
  server: string;
  captured: boolean;
  tools: Array<{
    name: string;
    inputSchema: {
      properties: Record<
        string,
        { type?: string | string[]; anyOf?: Array<{ type: string }> }
      >;
      required?: string[];
    };
  }>;
}

function toolList(name: string): CapturedToolList {
  return JSON.parse(
    readFileSync(
      join(import.meta.dirname, "fixtures", "issues", `${name}-tools.json`),
      "utf8",
    ),
  ) as CapturedToolList;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * A fake server answering from `handlers`, which offers exactly the tools of
 * a captured tool list and refuses a call whose arguments its schema does not
 * accept: a missing required one, an unknown one, or one of another type.
 */
function fakeServer(
  list: CapturedToolList,
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const caller: IssuesMcpCaller = {
    hasTool: (tool) => list.tools.some((entry) => entry.name === tool),
    async callTool(tool, args) {
      const entry = list.tools.find((candidate) => candidate.name === tool);
      if (!entry) throw new Error(`the server offers no ${tool}`);
      const { properties, required = [] } = entry.inputSchema;
      for (const name of required)
        if (args[name] === undefined)
          throw new Error(`${tool}: missing required ${name}`);
      for (const [name, value] of Object.entries(args)) {
        const property = properties[name];
        if (!property) throw new Error(`${tool}: unknown argument ${name}`);
        const types = property.anyOf
          ? property.anyOf.map((option) => option.type)
          : [property.type].flat();
        const actual = typeOf(value);
        if (!types.includes(actual))
          throw new Error(
            `${tool}: ${name} is ${actual}, not ${types.join("|")}`,
          );
      }
      calls.push({ tool, args });
      const handler = handlers[tool];
      if (!handler) throw new Error(`no fake answer for ${tool}`);
      const answer = handler(args);
      return { content: [{ type: "text", text: JSON.stringify(answer) }] };
    },
  };
  return { caller, calls };
}

async function session(
  module: RecipeIssuesProviderModule,
  options: Record<string, string> = {},
): Promise<IssuesSession> {
  return module.createSession({
    config: { provider: module.id, options },
    env: {},
  });
}

describe("first-party options", () => {
  it("are the options each provider declares", () => {
    expect({
      linear: linearIssuesProvider.capabilities.options ?? {},
      jira: jiraIssuesProvider.capabilities.options ?? {},
      introspection:
        createIntrospectionIssuesProvider().capabilities.options ?? {},
    }).toEqual(ISSUES_FIRST_PARTY_OPTIONS);
  });
});

describe("adapter tool maps", () => {
  it("name only tools the tool lists offer, verified once a list is captured", () => {
    for (const [map, list] of [
      [LINEAR_MCP_TOOLS, toolList("linear")],
      [JIRA_MCP_TOOLS, toolList("jira")],
    ] as const) {
      expect(map.every((entry) => entry.verified === list.captured)).toBe(true);
      const offered = (entry: (typeof map)[number]) =>
        list.tools.some((tool) => tool.name === entry.tool);
      if (list.captured) {
        // A captured list is the server's: every mapped tool is on it.
        expect(map.filter((entry) => !offered(entry))).toEqual([]);
        continue;
      }
      // Each use has at least one tool the list offers; older names may be absent.
      const uses = new Set(map.flatMap((entry) => entry.serves));
      for (const use of uses)
        expect(
          map.some((entry) => entry.serves.includes(use) && offered(entry)),
        ).toBe(true);
    }
  });
});

const LINEAR_ISSUE = {
  id: "9c1e",
  identifier: "ENG-123",
  title: "Checkout fails",
  description: "Steps:\n1. pay",
  priority: { value: 2, name: "High" },
  url: "https://linear.app/acme/issue/ENG-123",
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-02T10:00:00.000Z",
  state: { name: "In Review", type: "started" },
  assignee: { name: "Ada", email: "ada@acme.test", id: "u1" },
  labels: { nodes: [{ name: "bug" }, { name: "payments" }] },
  team: { key: "ENG", id: "t1" },
};

describe("linear", () => {
  const list = toolList("linear");

  it("searches with the server's filters and normalizes state and priority", async () => {
    const { caller, calls } = fakeServer(list, {
      list_issues: () => ({
        issues: [
          LINEAR_ISSUE,
          {
            identifier: "ENG-7",
            title: "Old",
            status: "Canceled",
            priority: 0,
            labels: ["chore"],
            team: "Engineering",
          },
        ],
      }),
    });
    const result = await (
      await session(linearIssuesProvider)
    ).search!(
      {
        query: "checkout",
        status: "In Review",
        assignee: "me",
        container: "ENG",
        label: "bug",
        limit: 5,
      },
      { mcp: caller },
    );
    expect(calls).toEqual([
      {
        tool: "list_issues",
        args: {
          limit: 5,
          query: "checkout",
          state: "In Review",
          assignee: "me",
          team: "ENG",
          label: "bug",
        },
      },
    ]);
    expect(result.issues).toEqual([
      {
        ref: "ENG-123",
        title: "Checkout fails",
        description: "Steps:\n1. pay",
        status: { name: "In Review", category: "in_progress" },
        priority: "high",
        assignee: { name: "Ada", email: "ada@acme.test", id: "u1" },
        labels: ["bug", "payments"],
        container: { name: "ENG", id: "t1" },
        url: "https://linear.app/acme/issue/ENG-123",
        created_at: "2026-11-01T10:00:00.000Z",
        updated_at: "2026-11-02T10:00:00.000Z",
      },
      {
        ref: "ENG-7",
        title: "Old",
        status: { name: "Canceled", category: "cancelled" },
        priority: "none",
        labels: ["chore"],
        container: { name: "Engineering" },
      },
    ]);
  });

  it("maps every state type and priority", async () => {
    const issueWith = (type: string, priority: number) => ({
      ...LINEAR_ISSUE,
      state: { name: type, type },
      priority,
    });
    const { caller } = fakeServer(list, {
      list_issues: () =>
        [
          "triage",
          "backlog",
          "unstarted",
          "started",
          "completed",
          "canceled",
        ].map((type, index) => issueWith(type, index % 5)),
    });
    const { issues } = await (
      await session(linearIssuesProvider)
    ).search!({}, { mcp: caller });
    expect(
      issues.map((issue) => [issue.status.category, issue.priority]),
    ).toEqual([
      ["open", "none"],
      ["open", "urgent"],
      ["open", "high"],
      ["in_progress", "medium"],
      ["done", "low"],
      ["cancelled", "none"],
    ]);
  });

  it("gets an issue with its comments", async () => {
    const { caller, calls } = fakeServer(list, {
      get_issue: () => LINEAR_ISSUE,
      list_comments: () => ({
        comments: [
          {
            id: "c1",
            body: "Seen in prod",
            user: { name: "Bo" },
            createdAt: "2026-11-02T11:00:00Z",
          },
        ],
      }),
    });
    const issue = await (
      await session(linearIssuesProvider)
    ).get!({ ref: "ENG-123" }, { mcp: caller });
    expect(calls.map((call) => call.tool)).toEqual([
      "get_issue",
      "list_comments",
    ]);
    expect(issue.comments).toEqual([
      {
        id: "c1",
        body: "Seen in prod",
        author: { name: "Bo" },
        created_at: "2026-11-02T11:00:00Z",
      },
    ]);
  });

  it("creates in the declared team, updates and comments through save_issue and save_comment", async () => {
    const { caller, calls } = fakeServer(list, {
      save_issue: (args) => ({
        ...LINEAR_ISSUE,
        title: args.title ?? LINEAR_ISSUE.title,
      }),
      save_comment: (args) => ({ comment: { id: "c2", body: args.body } }),
    });
    const opened = await session(linearIssuesProvider, { team: "ENG" });
    await opened.create!(
      {
        title: "New",
        description: "Body",
        priority: "urgent",
        labels: ["bug"],
        assignee: "me",
      },
      { mcp: caller },
    );
    await opened.update!(
      { ref: "ENG-123", priority: "low", assignee: "none" },
      { mcp: caller },
    );
    const comment = await opened.comment!(
      { ref: "ENG-123", body: "On it" },
      { mcp: caller },
    );
    expect(calls).toEqual([
      {
        tool: "save_issue",
        args: {
          team: "ENG",
          title: "New",
          description: "Body",
          priority: 1,
          labels: ["bug"],
          assignee: "me",
        },
      },
      {
        tool: "save_issue",
        args: { id: "ENG-123", priority: 4, assignee: null },
      },
      { tool: "save_comment", args: { issueId: "ENG-123", body: "On it" } },
    ]);
    expect(comment).toEqual({ id: "c2", body: "On it" });
  });

  it("needs a team to create", async () => {
    const { caller } = fakeServer(list, {});
    await expect(
      (await session(linearIssuesProvider)).create!(
        { title: "New" },
        { mcp: caller },
      ),
    ).rejects.toMatchObject({ issues: { code: "invalid_request" } });
  });

  it("transitions by state name, or by category through the team's states", async () => {
    const { caller, calls } = fakeServer(list, {
      get_issue: () => LINEAR_ISSUE,
      list_issue_statuses: () => [
        { name: "Todo", type: "unstarted" },
        { name: "Shipped", type: "completed" },
      ],
      save_issue: (args) => ({
        ...LINEAR_ISSUE,
        state: { name: args.state, type: "completed" },
      }),
    });
    const opened = await session(linearIssuesProvider);
    const moved = await opened.transition!(
      { ref: "ENG-123", status: "done" },
      { mcp: caller },
    );
    await opened.transition!(
      { ref: "ENG-123", status: "Todo" },
      { mcp: caller },
    );
    expect(calls).toEqual([
      { tool: "get_issue", args: { id: "ENG-123" } },
      { tool: "list_issue_statuses", args: { team: "ENG" } },
      { tool: "save_issue", args: { id: "ENG-123", state: "Shipped" } },
      { tool: "save_issue", args: { id: "ENG-123", state: "Todo" } },
    ]);
    expect(moved.status).toEqual({ name: "Shipped", category: "done" });
  });
});

const JIRA_ISSUE = {
  id: "10045",
  key: "PROJ-45",
  fields: {
    summary: "Refund stuck",
    description: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Context" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Customer " },
            { type: "text", text: "Acme", marks: [{ type: "strong" }] },
            { type: "text", text: " sees " },
            {
              type: "text",
              text: "docs",
              marks: [{ type: "link", attrs: { href: "https://x.test" } }],
            },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "one" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "two", marks: [{ type: "code" }] },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: "sh" },
          content: [{ type: "text", text: "retry" }],
        },
      ],
    },
    status: {
      name: "In Progress",
      statusCategory: { key: "indeterminate", name: "In Progress" },
    },
    priority: { name: "Highest" },
    assignee: {
      displayName: "Ada",
      emailAddress: "ada@acme.test",
      accountId: "a1",
    },
    labels: ["refunds"],
    project: { key: "PROJ", id: "100" },
    issuetype: { name: "Task" },
    created: "2026-11-01T10:00:00.000+0000",
    updated: "2026-11-02T10:00:00.000+0000",
  },
};

const RESOURCES = [
  {
    id: "cloud-1",
    url: "https://acme.atlassian.net",
    name: "acme",
    scopes: ["read:jira-work", "write:jira-work"],
  },
];

describe("jira", () => {
  const list = toolList("jira");

  it("searches with JQL on the connected site and normalizes the issue", async () => {
    const { caller, calls } = fakeServer(list, {
      getAccessibleAtlassianResources: () => RESOURCES,
      lookupJiraAccountId: () => ({ users: [{ accountId: "a1" }] }),
      searchJiraIssuesUsingJql: () => ({ issues: [JIRA_ISSUE] }),
    });
    const { issues } = await (
      await session(jiraIssuesProvider)
    ).search!(
      {
        query: 'say "hi"',
        status: "in_progress",
        assignee: "Ada",
        container: "PROJ",
        label: "refunds",
        limit: 3,
      },
      { mcp: caller },
    );
    expect(calls[0]).toEqual({
      tool: "getAccessibleAtlassianResources",
      args: {},
    });
    expect(calls[1]).toEqual({
      tool: "lookupJiraAccountId",
      args: { cloudId: "cloud-1", searchString: "Ada" },
    });
    expect(calls[2]!.tool).toBe("searchJiraIssuesUsingJql");
    expect(calls[2]!.args).toMatchObject({
      cloudId: "cloud-1",
      maxResults: 3,
      jql: 'text ~ "say \\"hi\\"" AND statusCategory = "In Progress" AND assignee = "a1" AND project = "PROJ" AND labels = "refunds" ORDER BY updated DESC',
    });
    expect(issues).toEqual([
      {
        ref: "PROJ-45",
        title: "Refund stuck",
        description:
          "## Context\n\nCustomer **Acme** sees [docs](https://x.test)\n\n- one\n- `two`\n\n```sh\nretry\n```",
        status: { name: "In Progress", category: "in_progress" },
        priority: "urgent",
        assignee: { name: "Ada", email: "ada@acme.test", id: "a1" },
        labels: ["refunds"],
        container: { name: "PROJ", id: "100", type: "Task" },
        url: "https://acme.atlassian.net/browse/PROJ-45",
        created_at: "2026-11-01T10:00:00.000+0000",
        updated_at: "2026-11-02T10:00:00.000+0000",
      },
    ]);
  });

  it("maps status categories, a cancelled done status, and priority names", () => {
    const withStatus = (name: string, key: string, priority: string) => ({
      ...JIRA_ISSUE,
      fields: {
        ...JIRA_ISSUE.fields,
        status: { name, statusCategory: { key } },
        priority: { name: priority },
      },
    });
    return (async () => {
      const { caller } = fakeServer(list, {
        getAccessibleAtlassianResources: () => RESOURCES,
        searchJiraIssuesUsingJql: () => ({
          issues: [
            withStatus("To Do", "new", "Lowest"),
            withStatus("Doing", "indeterminate", "Low"),
            withStatus("Done", "done", "Medium"),
            withStatus("Won't Do", "done", "High"),
          ],
        }),
      });
      const { issues } = await (
        await session(jiraIssuesProvider)
      ).search!({}, { mcp: caller });
      expect(
        issues.map((issue) => [issue.status.category, issue.priority]),
      ).toEqual([
        ["open", "low"],
        ["in_progress", "low"],
        ["done", "medium"],
        ["cancelled", "high"],
      ]);
    })();
  });

  it("finds the cancelled category by status name, not as a literal status", async () => {
    const withStatus = (name: string, key: string) => ({
      ...JIRA_ISSUE,
      fields: {
        ...JIRA_ISSUE.fields,
        status: { name, statusCategory: { key } },
      },
    });
    const { caller, calls } = fakeServer(list, {
      getAccessibleAtlassianResources: () => RESOURCES,
      searchJiraIssuesUsingJql: () => ({
        issues: [withStatus("Done", "done"), withStatus("Won't Do", "done")],
      }),
    });
    const opened = await session(jiraIssuesProvider);
    const cancelled = await opened.search!(
      { status: "cancelled" },
      { mcp: caller },
    );
    expect(cancelled.issues.map((issue) => issue.status.name)).toEqual([
      "Won't Do",
    ]);
    expect(String(calls.at(-1)!.args.jql)).toContain('statusCategory = "Done"');
    const done = await opened.search!({ status: "done" }, { mcp: caller });
    expect(done.issues.map((issue) => issue.status.name)).toEqual(["Done"]);
  });

  it("assigns to the signed-in Jira account for me", async () => {
    const { caller, calls } = fakeServer(list, {
      getAccessibleAtlassianResources: () => RESOURCES,
      atlassianUserInfo: () => ({ account_id: "self-1" }),
      editJiraIssue: () => ({}),
      getJiraIssue: () => JIRA_ISSUE,
    });
    await (
      await session(jiraIssuesProvider)
    ).update!({ ref: "PROJ-45", assignee: "me" }, { mcp: caller });
    expect(calls.some((call) => call.tool === "lookupJiraAccountId")).toBe(
      false,
    );
    expect(
      JSON.stringify(calls.find((call) => call.tool === "editJiraIssue")!.args),
    ).toContain("self-1");
  });

  it("gets an issue and its comments, rendering ADF", async () => {
    const { caller } = fakeServer(list, {
      getAccessibleAtlassianResources: () => RESOURCES,
      getJiraIssue: () => JIRA_ISSUE,
      listJiraIssueComments: () => ({
        comments: [
          {
            id: "c1",
            author: { displayName: "Bo" },
            created: "2026-11-02T11:00:00.000+0000",
            body: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Escalated" }],
                },
              ],
            },
          },
        ],
      }),
    });
    const issue = await (
      await session(jiraIssuesProvider)
    ).get!({ ref: "PROJ-45" }, { mcp: caller });
    expect(issue.comments).toEqual([
      {
        id: "c1",
        body: "Escalated",
        author: { name: "Bo" },
        created_at: "2026-11-02T11:00:00.000+0000",
      },
    ]);
  });

  it("creates in the declared project and type, edits, and comments", async () => {
    const { caller, calls } = fakeServer(list, {
      getAccessibleAtlassianResources: () => RESOURCES,
      lookupJiraAccountId: () => [{ accountId: "a1" }],
      createJiraIssue: () => ({ id: "10046", key: "PROJ-46" }),
      getJiraIssue: () => JIRA_ISSUE,
      editJiraIssue: () => ({}),
      addOrEditJiraIssueComment: (args) => ({
        id: "c9",
        body: args.commentBody,
      }),
    });
    const opened = await session(jiraIssuesProvider, {
      project: "PROJ",
      issueType: "Task",
    });
    await opened.create!(
      {
        title: "New",
        description: "Body",
        priority: "high",
        labels: ["x"],
        assignee: "Ada",
      },
      { mcp: caller },
    );
    await opened.update!(
      { ref: "PROJ-45", title: "T", assignee: "none", priority: "urgent" },
      { mcp: caller },
    );
    const comment = await opened.comment!(
      { ref: "PROJ-45", body: "On it" },
      { mcp: caller },
    );
    const writes = calls.filter((call) =>
      [
        "createJiraIssue",
        "editJiraIssue",
        "addOrEditJiraIssueComment",
      ].includes(call.tool),
    );
    expect(writes).toEqual([
      {
        tool: "createJiraIssue",
        args: {
          cloudId: "cloud-1",
          projectKey: "PROJ",
          issueTypeName: "Task",
          summary: "New",
          description: "Body",
          assignee_account_id: "a1",
          additional_fields: { priority: { name: "High" }, labels: ["x"] },
        },
      },
      {
        tool: "editJiraIssue",
        args: {
          cloudId: "cloud-1",
          issueIdOrKey: "PROJ-45",
          fields: {
            summary: "T",
            priority: { name: "Highest" },
            assignee: null,
          },
        },
      },
      {
        tool: "addOrEditJiraIssueComment",
        args: {
          cloudId: "cloud-1",
          issueIdOrKey: "PROJ-45",
          commentBody: "On it",
        },
      },
    ]);
    expect(comment).toEqual({ id: "c9", body: "On it" });
    // The connected site is looked up once per session.
    expect(
      calls.filter((call) => call.tool === "getAccessibleAtlassianResources"),
    ).toHaveLength(1);
  });

  it("needs a project and issue type to create", async () => {
    const { caller } = fakeServer(list, {});
    await expect(
      (await session(jiraIssuesProvider, { project: "PROJ" })).create!(
        { title: "New" },
        { mcp: caller },
      ),
    ).rejects.toMatchObject({ issues: { code: "invalid_request" } });
  });

  it("transitions through the workflow transition that reaches the status", async () => {
    const { caller, calls } = fakeServer(list, {
      getAccessibleAtlassianResources: () => RESOURCES,
      listJiraIssueTransitions: () => ({
        transitions: [
          {
            id: "11",
            name: "Start",
            to: {
              name: "In Progress",
              statusCategory: { key: "indeterminate" },
            },
          },
          {
            id: "31",
            name: "Finish",
            to: { name: "Done", statusCategory: { key: "done" } },
          },
        ],
      }),
      transitionJiraIssue: () => ({}),
      getJiraIssue: () => JIRA_ISSUE,
    });
    const opened = await session(jiraIssuesProvider);
    await opened.transition!(
      { ref: "PROJ-45", status: "done" },
      { mcp: caller },
    );
    await opened.transition!(
      { ref: "PROJ-45", status: "in progress" },
      { mcp: caller },
    );
    expect(
      calls
        .filter((call) => call.tool === "transitionJiraIssue")
        .map((call) => call.args.transition),
    ).toEqual([{ id: "31" }, { id: "11" }]);
    await expect(
      opened.transition!(
        { ref: "PROJ-45", status: "Blocked" },
        { mcp: caller },
      ),
    ).rejects.toThrow(
      "No transition takes PROJ-45 to 'Blocked'; reachable: In Progress, Done",
    );
  });

  it("renders ADF best-effort and passes a string through", () => {
    expect(adfToMarkdown("already **markdown**")).toBe("already **markdown**");
    expect(
      adfToMarkdown({
        type: "doc",
        content: [
          {
            type: "orderedList",
            content: [
              {
                type: "listItem",
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "a" }] },
                ],
              },
            ],
          },
          {
            type: "blockquote",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "q" }] },
            ],
          },
          { type: "rule" },
          {
            type: "paragraph",
            content: [
              { type: "mention", attrs: { text: "@Ada" } },
              { type: "hardBreak" },
              { type: "text", text: "x", marks: [{ type: "em" }] },
            ],
          },
        ],
      }),
    ).toBe("1. a\n\n> q\n\n***\n\n@Ada\n*x*");
  });
});

function introspectionIssue(
  fields: Partial<IntrospectionIssue> = {},
): IntrospectionIssue {
  return {
    id: "0190c0de-0000-7000-8000-000000000001",
    project_id: "proj-1",
    title: "Flaky deploy",
    description: "It fails on Tuesdays",
    priority: "high",
    status: "waiting",
    display_index: 12,
    tags: ["deploy"],
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-02T10:00:00Z",
    ...fields,
  };
}

const MEMBER = "0190c0de-0000-7000-8000-0000000000aa";

/**
 * A fake of the SDK client. `plane: "old"` is a data plane without assignees
 * or comments: it ignores the list's member filter and the read's include,
 * refuses an assignee on a write (422), and has no comments route (404).
 */
function fakeIntrospection(
  options: {
    issues?: IntrospectionIssue[];
    comments?: IntrospectionIssueComment[];
    plane?: "old";
    /** An SDK release without `issues.comments`. */
    sdk?: "old";
  } = {},
) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const old = options.plane === "old";
  const row = (fields: Partial<IntrospectionIssue> = {}) =>
    introspectionIssue(old ? fields : { assignee_member_id: null, ...fields });
  const issues = options.issues ?? [row()];
  const refuseAssignee = (params: { assignee_member_id?: unknown }) => {
    if (old && "assignee_member_id" in params)
      throw Object.assign(new Error("extra field"), { status: 422 });
  };
  const client: IntrospectionIssuesClient = {
    issues: {
      list: (params) => {
        calls.push({ method: "issues.list", args: [params] });
        const records = issues.filter(
          (issue) =>
            (params.display_index === undefined ||
              issue.display_index === params.display_index) &&
            (params.status === undefined || issue.status === params.status) &&
            (params.tag === undefined || issue.tags.includes(params.tag)) &&
            (old ||
              !params.relation?.includes("assignee") ||
              issue.assignee_member_id === (params.member_id ?? MEMBER)),
        );
        return Promise.resolve({ records, next: null });
      },
      get: async (id, params) => {
        calls.push({
          method: "issues.get",
          args: params ? [id, params] : [id],
        });
        const found = issues.find((issue) => issue.id === id);
        if (!found)
          throw Object.assign(new Error("not found"), { status: 404 });
        return !old && params?.include?.includes("comments")
          ? { ...found, comments: options.comments ?? [] }
          : found;
      },
      create: async (params) => {
        calls.push({ method: "issues.create", args: [params] });
        refuseAssignee(params);
        return row({
          title: params.title,
          description: params.description,
          priority: params.priority ?? "medium",
          status: "open",
          tags: params.tags ?? [],
          display_index: 13,
          ...(params.assignee_member_id
            ? { assignee_member_id: params.assignee_member_id }
            : {}),
        });
      },
      update: async (id, patch) => {
        calls.push({ method: "issues.update", args: [id, patch] });
        refuseAssignee(patch);
        return { ...row(), ...patch };
      },
      ...(options.sdk === "old"
        ? {}
        : {
            comments: {
              create: async (id, params) => {
                calls.push({
                  method: "issues.comments.create",
                  args: [id, params],
                });
                if (old)
                  throw Object.assign(new Error("no route"), { status: 404 });
                return {
                  id: "0190c0de-0000-7000-8000-0000000000c1",
                  comment: params.comment,
                  member_id: MEMBER,
                  created_at: "2026-11-03T10:00:00Z",
                };
              },
            },
          }),
    },
  };
  return { client, calls };
}

describe("introspection", () => {
  const env = {
    INTROSPECTION_BASE_API_URL: "http://dp.internal",
    INTROSPECTION_TOKEN: "locator",
    INTROSPECTION_TASK_ID: "task-1",
  };
  const open = async (
    fake: ReturnType<typeof fakeIntrospection>,
    sessionEnv = env,
  ) =>
    createIntrospectionIssuesProvider({
      client: () => fake.client,
    }).createSession({
      config: { provider: "introspection", options: {} },
      env: sessionEnv,
    });

  it("declares every command and the assignee, and needs the task's session", () => {
    const provider = createIntrospectionIssuesProvider();
    expect(Object.keys(provider.capabilities.commands)).toEqual([
      "search",
      "get",
      "create",
      "update",
      "comment",
      "transition",
    ]);
    expect(provider.capabilities.fields).toContain("assignee");
    expect(provider.available!(env)).toBe(true);
    expect(provider.available!({ INTROSPECTION_TOKEN: "locator" })).toBe(false);
    expect(
      provider.available!({
        INTROSPECTION_DP_URL: "http://dp",
        INTROSPECTION_TOKEN: "t",
      }),
    ).toBe(true);
  });

  it("maps the row: handle by display index, status, priority and tags", async () => {
    const fake = fakeIntrospection();
    const { issues } = await (
      await open(fake)
    ).search!({ status: "in_progress", label: "deploy" }, {});
    expect(fake.calls[0]).toEqual({
      method: "issues.list",
      args: [{ limit: 20, status: "waiting", tag: "deploy" }],
    });
    expect(issues).toEqual([
      {
        ref: "12",
        title: "Flaky deploy",
        description: "It fails on Tuesdays",
        status: { name: "waiting", category: "in_progress" },
        priority: "high",
        labels: ["deploy"],
        container: { name: "project", id: "proj-1" },
        created_at: "2026-11-01T10:00:00Z",
        updated_at: "2026-11-02T10:00:00Z",
      },
    ]);
  });

  it("matches text over the most recent issues", async () => {
    const fake = fakeIntrospection({
      issues: [
        introspectionIssue(),
        introspectionIssue({
          title: "Other",
          description: "",
          display_index: 3,
        }),
      ],
    });
    const opened = await open(fake);
    const { issues } = await opened.search!({ query: "TUESDAY", limit: 5 }, {});
    expect(issues.map((issue) => issue.ref)).toEqual(["12"]);
    expect(fake.calls[0]!.args[0]).toMatchObject({ limit: 200 });
  });

  it("searches by assignee: me is the caller, a member id that member", async () => {
    const other = "0190c0de-0000-7000-8000-0000000000bb";
    const fake = fakeIntrospection({
      issues: [
        introspectionIssue({ assignee_member_id: MEMBER }),
        introspectionIssue({ assignee_member_id: other, display_index: 3 }),
        introspectionIssue({ assignee_member_id: null, display_index: 4 }),
      ],
    });
    const opened = await open(fake);
    const mine = await opened.search!({ assignee: " Me " }, {});
    expect(mine.issues.map((issue) => [issue.ref, issue.assignee])).toEqual([
      ["12", { id: MEMBER }],
    ]);
    const theirs = await opened.search!({ assignee: other }, {});
    expect(theirs.issues.map((issue) => issue.ref)).toEqual(["3"]);
    expect(fake.calls.map((call) => call.args[0])).toEqual([
      { limit: 20, relation: ["assignee"] },
      { limit: 20, relation: ["assignee"], member_id: other },
    ]);
    for (const assignee of ["Ada Lovelace", "ada@acme.test", "none"])
      await expect(opened.search!({ assignee }, {})).rejects.toMatchObject({
        issues: {
          code: "invalid_request",
          message: `Introspection issues take me or a member id as the assignee to search by, not '${assignee}'`,
        },
      });
    expect(fake.calls).toHaveLength(2);
  });

  it("gets an issue with its comments in one read", async () => {
    const fake = fakeIntrospection({
      comments: [
        {
          id: "c1",
          comment: "First",
          member_id: MEMBER,
          created_at: "2026-11-02T11:00:00Z",
        },
        {
          id: "c2",
          comment: "Second",
          member_id: null,
          created_at: "2026-11-02T12:00:00Z",
        },
      ],
    });
    const opened = await open(fake);
    const id = "0190c0de-0000-7000-8000-000000000001";
    const issue = await opened.get!({ ref: id }, {});
    expect(fake.calls).toEqual([
      { method: "issues.get", args: [id, { include: ["comments"] }] },
    ]);
    expect(issue.comments).toEqual([
      {
        id: "c1",
        body: "First",
        created_at: "2026-11-02T11:00:00Z",
        author: { id: MEMBER },
      },
      { id: "c2", body: "Second", created_at: "2026-11-02T12:00:00Z" },
    ]);
    await opened.get!({ ref: "12" }, {});
    expect(fake.calls.slice(1)).toEqual([
      { method: "issues.list", args: [{ display_index: 12, limit: 1 }] },
      { method: "issues.get", args: [id, { include: ["comments"] }] },
    ]);
  });

  it("comments on an issue", async () => {
    const fake = fakeIntrospection();
    const comment = await (
      await open(fake)
    ).comment!({ ref: "12", body: "Looks **fixed**" }, {});
    expect(fake.calls.at(-1)).toEqual({
      method: "issues.comments.create",
      args: [
        "0190c0de-0000-7000-8000-000000000001",
        { comment: "Looks **fixed**" },
      ],
    });
    expect(comment).toEqual({
      id: "0190c0de-0000-7000-8000-0000000000c1",
      body: "Looks **fixed**",
      created_at: "2026-11-03T10:00:00Z",
      author: { id: MEMBER },
    });
  });

  it("assigns by member id on create and update, and unassigns with none", async () => {
    const fake = fakeIntrospection();
    const opened = await open(fake);
    const created = await opened.create!(
      { title: "New", assignee: MEMBER },
      {},
    );
    expect(created.assignee).toEqual({ id: MEMBER });
    const assigned = await opened.update!({ ref: "12", assignee: MEMBER }, {});
    expect(assigned.assignee).toEqual({ id: MEMBER });
    const cleared = await opened.update!({ ref: "12", assignee: "None" }, {});
    expect(cleared.assignee).toBeUndefined();
    expect(
      fake.calls
        .filter((call) => call.method !== "issues.list")
        .map((call) => call.args.at(-1)),
    ).toEqual([
      {
        task_id: "task-1",
        title: "New",
        description: "New",
        assignee_member_id: MEMBER,
      },
      { assignee_member_id: MEMBER },
      { assignee_member_id: null },
    ]);
  });

  it("refuses to assign me, a name or an email, and none on create", async () => {
    const fake = fakeIntrospection();
    const opened = await open(fake);
    const refused = (assignee: string) => ({
      issues: {
        code: "invalid_request",
        message: `An Introspection issue is assigned by member id; this provider cannot resolve '${assignee}' to one`,
      },
    });
    for (const assignee of ["me", "Ada Lovelace", "ada@acme.test"]) {
      await expect(
        opened.create!({ title: "New", assignee }, {}),
      ).rejects.toMatchObject(refused(assignee));
      await expect(
        opened.update!({ ref: "12", assignee }, {}),
      ).rejects.toMatchObject(refused(assignee));
    }
    await expect(
      opened.create!({ title: "New", assignee: "none" }, {}),
    ).rejects.toMatchObject(refused("none"));
    expect(fake.calls.filter((call) => call.method !== "issues.list")).toEqual(
      [],
    );
  });

  describe("on a data plane without assignees or comments", () => {
    it("still searches, gets, creates, updates and transitions", async () => {
      const fake = fakeIntrospection({ plane: "old" });
      const opened = await open(fake);
      const { issues } = await opened.search!({ status: "waiting" }, {});
      expect(issues.map((issue) => issue.ref)).toEqual(["12"]);
      expect(issues[0]).not.toHaveProperty("assignee");
      const issue = await opened.get!({ ref: "12" }, {});
      expect(issue.comments).toEqual([]);
      expect((await opened.create!({ title: "New" }, {})).ref).toBe("13");
      expect(
        (await opened.update!({ ref: "12", title: "Renamed" }, {})).title,
      ).toBe("Renamed");
      expect(
        (await opened.transition!({ ref: "12", status: "done" }, {})).status,
      ).toEqual({ name: "closed", category: "done" });
    });

    it("refuses an assignee search rather than list every issue", async () => {
      const opened = await open(fakeIntrospection({ plane: "old" }));
      for (const assignee of ["me", MEMBER])
        await expect(opened.search!({ assignee }, {})).rejects.toMatchObject({
          issues: {
            code: "not_supported",
            message:
              "This data plane's issues have no assignee to search by yet",
          },
        });
    });

    it("reports comment as not supported", async () => {
      const opened = await open(fakeIntrospection({ plane: "old" }));
      await expect(
        opened.comment!({ ref: "12", body: "hi" }, {}),
      ).rejects.toMatchObject({
        issues: {
          code: "not_supported",
          message: "This data plane does not take issue comments yet",
        },
      });
    });
  });

  it("reports comment as not supported by an SDK release without it", async () => {
    const fake = fakeIntrospection({ sdk: "old" });
    await expect(
      (await open(fake)).comment!({ ref: "12", body: "hi" }, {}),
    ).rejects.toMatchObject({
      issues: {
        code: "not_supported",
        message:
          "The installed Introspection SDK cannot comment on an issue yet",
      },
    });
  });

  it("never reads events: the client it needs has no events client", async () => {
    const fake = fakeIntrospection();
    expect(Object.keys(fake.client)).toEqual(["issues"]);
    const opened = await open(fake);
    await opened.get!({ ref: "12" }, {});
    await opened.comment!({ ref: "12", body: "hi" }, {});
    expect(fake.calls.map((call) => call.method)).toEqual([
      "issues.list",
      "issues.get",
      "issues.list",
      "issues.comments.create",
    ]);
  });

  it("creates on the calling task, updates the row and transitions by status", async () => {
    const fake = fakeIntrospection();
    const opened = await open(fake);
    const created = await opened.create!(
      { title: "New", priority: "urgent", labels: ["x"] },
      {},
    );
    expect(created.ref).toBe("13");
    await opened.update!({ ref: "12", title: "Renamed", labels: [] }, {});
    const moved = await opened.transition!({ ref: "12", status: "done" }, {});
    await opened.transition!({ ref: "12", status: "Cancelled" }, {});
    const writes = fake.calls.filter((call) => call.method !== "issues.list");
    expect(writes).toEqual([
      {
        method: "issues.create",
        args: [
          {
            task_id: "task-1",
            title: "New",
            description: "New",
            priority: "urgent",
            tags: ["x"],
          },
        ],
      },
      {
        method: "issues.update",
        args: [
          "0190c0de-0000-7000-8000-000000000001",
          { title: "Renamed", tags: [] },
        ],
      },
      {
        method: "issues.update",
        args: ["0190c0de-0000-7000-8000-000000000001", { status: "closed" }],
      },
      {
        method: "issues.update",
        args: ["0190c0de-0000-7000-8000-000000000001", { status: "cancelled" }],
      },
    ]);
    expect(moved.status).toEqual({ name: "closed", category: "done" });
    await expect(
      opened.transition!({ ref: "12", status: "blocked" }, {}),
    ).rejects.toMatchObject({
      issues: { code: "invalid_request" },
    });
    await expect(
      opened.update!({ ref: "12", priority: "none" }, {}),
    ).rejects.toMatchObject({
      issues: { code: "invalid_request" },
    });
  });

  it("needs the calling task to create, and reports a missing issue", async () => {
    const fake = fakeIntrospection();
    const opened = await open(fake, { ...env, INTROSPECTION_TASK_ID: "" });
    await expect(opened.create!({ title: "New" }, {})).rejects.toMatchObject({
      issues: { code: "not_connected" },
    });
    await expect(opened.get!({ ref: "99" }, {})).rejects.toMatchObject({
      issues: { code: "not_found" },
    });
  });
});

describe("pages and status categories", () => {
  const jiraIssueIn = (key: string, status: string, category: string) => ({
    ...JIRA_ISSUE,
    key,
    fields: {
      ...JIRA_ISSUE.fields,
      status: { name: status, statusCategory: { key: category, name: "Done" } },
    },
  });

  it("searches Linear by every state type a category spans, newest first", async () => {
    const { caller, calls } = fakeServer(toolList("linear"), {
      list_issues: (args) => ({
        issues: [
          {
            ...LINEAR_ISSUE,
            identifier: `ENG-${String(args.state)}`,
            updatedAt:
              args.state === "backlog"
                ? "2026-11-03T00:00:00.000Z"
                : "2026-11-01T00:00:00.000Z",
            state: { name: String(args.state), type: String(args.state) },
          },
        ],
      }),
    });
    const found = await (
      await session(linearIssuesProvider)
    ).search!({ status: "open", limit: 2 }, { mcp: caller });
    expect(calls.map((call) => call.args.state)).toEqual([
      "unstarted",
      "backlog",
      "triage",
    ]);
    expect(found.issues.map((issue) => issue.ref)).toEqual([
      "ENG-backlog",
      "ENG-unstarted",
    ]);
  });

  it("follows Linear's comment pages to the end", async () => {
    const { caller, calls } = fakeServer(toolList("linear"), {
      get_issue: () => LINEAR_ISSUE,
      list_comments: (args) =>
        args.cursor === "p2"
          ? { comments: [{ id: "c2", body: "Two" }], hasNextPage: false }
          : {
              comments: [{ id: "c1", body: "One" }],
              hasNextPage: true,
              cursor: "p2",
            },
    });
    const issue = await (
      await session(linearIssuesProvider)
    ).get!({ ref: "ENG-123" }, { mcp: caller });
    expect(issue.comments?.map((comment) => comment.body)).toEqual([
      "One",
      "Two",
    ]);
    expect(
      calls
        .filter((call) => call.tool === "list_comments")
        .map((call) => call.args.cursor),
    ).toEqual([undefined, "p2"]);
  });

  it("fills a Jira cancelled search from later pages after telling it from done", async () => {
    const { caller, calls } = fakeServer(toolList("jira"), {
      getAccessibleAtlassianResources: () => RESOURCES,
      searchJiraIssuesUsingJql: (args) =>
        args.nextPageToken === "t2"
          ? {
              issues: [jiraIssueIn("PROJ-3", "Cancelled", "done")],
              isLast: true,
            }
          : {
              issues: [
                jiraIssueIn("PROJ-1", "Done", "done"),
                jiraIssueIn("PROJ-2", "Won't do", "done"),
              ],
              nextPageToken: "t2",
            },
    });
    const found = await (
      await session(jiraIssuesProvider)
    ).search!({ status: "cancelled", limit: 2 }, { mcp: caller });
    expect(found.issues.map((issue) => issue.ref)).toEqual([
      "PROJ-2",
      "PROJ-3",
    ]);
    expect(
      calls
        .filter((call) => call.tool === "searchJiraIssuesUsingJql")
        .map((call) => call.args.nextPageToken),
    ).toEqual([undefined, "t2"]);
  });

  it("reads the Jira comments an issue embeds only the first page of", async () => {
    const comment = (id: string) => ({
      id,
      author: { displayName: "Bo" },
      created: "2026-11-02T11:00:00.000+0000",
      body: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: id }] }],
      },
    });
    const { caller } = fakeServer(toolList("jira"), {
      getAccessibleAtlassianResources: () => RESOURCES,
      getJiraIssue: () => ({
        ...JIRA_ISSUE,
        fields: {
          ...JIRA_ISSUE.fields,
          comment: { comments: [comment("c1")], total: 2 },
        },
      }),
      listJiraIssueComments: () => ({
        comments: [comment("c1"), comment("c2")],
        total: 2,
      }),
    });
    const issue = await (
      await session(jiraIssuesProvider)
    ).get!({ ref: "PROJ-45" }, { mcp: caller });
    expect(issue.comments?.map((c) => c.body)).toEqual(["c1", "c2"]);
  });

  it("keeps reading Jira comments when the server caps the page below what was asked", async () => {
    const comment = (id: string) => ({
      id,
      author: { displayName: "Bo" },
      created: "2026-11-02T11:00:00.000+0000",
      body: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: id }] }],
      },
    });
    const { caller, calls } = fakeServer(toolList("jira"), {
      getAccessibleAtlassianResources: () => RESOURCES,
      getJiraIssue: () => ({
        ...JIRA_ISSUE,
        fields: {
          ...JIRA_ISSUE.fields,
          comment: { comments: [comment("c1")], total: 2 },
        },
      }),
      listJiraIssueComments: (args) =>
        args.startAt === 0
          ? {
              comments: [comment("c1")],
              maxResults: 1,
              total: 2,
              isLast: false,
            }
          : {
              comments: [comment("c2")],
              maxResults: 1,
              total: 2,
              isLast: true,
            },
    });
    const issue = await (
      await session(jiraIssuesProvider)
    ).get!({ ref: "PROJ-45" }, { mcp: caller });
    expect(issue.comments?.map((c) => c.body)).toEqual(["c1", "c2"]);
    expect(
      calls
        .filter((call) => call.tool === "listJiraIssueComments")
        .map((call) => call.args.startAt),
    ).toEqual([0, 1]);
  });
});
