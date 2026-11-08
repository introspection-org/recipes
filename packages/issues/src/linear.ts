import type {
  IssueComment,
  IssuePerson,
  IssuePriority,
  IssueStatusCategory,
  IssuesCallContext,
  IssuesMcpToolMapping,
  IssuesSession,
  ProviderIssue,
  RecipeIssuesProviderModule,
} from "@introspection-ai/recipes/issues";

import {
  callJson,
  categoryFromName,
  firstText,
  IssuesError,
  isStatusCategory,
  listOf,
  record,
  text,
  toolsFor,
} from "./common.js";

/**
 * Linear's remote MCP server tools the adapter calls, per use, as its captured
 * tool list names them (`test/fixtures/issues/linear-tools.json`).
 */
export const LINEAR_MCP_TOOLS: readonly IssuesMcpToolMapping[] = [
  { tool: "list_issues", serves: ["search"], verified: true },
  { tool: "get_issue", serves: ["get", "transition"], verified: true },
  { tool: "list_comments", serves: ["get"], verified: true },
  {
    tool: "save_issue",
    serves: ["create", "update", "transition"],
    verified: true,
  },
  { tool: "save_comment", serves: ["comment"], verified: true },
  { tool: "list_issue_statuses", serves: ["transition"], verified: true },
];

/** Linear's priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
const PRIORITY_FROM_LINEAR: Record<number, IssuePriority> = {
  0: "none",
  1: "urgent",
  2: "high",
  3: "medium",
  4: "low",
};
const PRIORITY_TO_LINEAR: Record<IssuePriority, number> = {
  none: 0,
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

/** A workflow state type as Linear names it, to the shape's category. */
const STATE_TYPES: Record<string, IssueStatusCategory> = {
  triage: "open",
  backlog: "open",
  unstarted: "open",
  started: "in_progress",
  completed: "done",
  canceled: "cancelled",
  cancelled: "cancelled",
};
/** The state types that serve a category, most likely first. */
const CATEGORY_STATE_TYPES: Record<IssueStatusCategory, readonly string[]> = {
  open: ["unstarted", "backlog", "triage"],
  in_progress: ["started"],
  done: ["completed"],
  cancelled: ["canceled", "cancelled"],
};

function priorityOf(value: unknown): IssuePriority | undefined {
  if (typeof value === "number") return PRIORITY_FROM_LINEAR[value];
  const object = record(value);
  if (typeof object.value === "number")
    return PRIORITY_FROM_LINEAR[object.value];
  const name = firstText(value, object.name)?.toLowerCase();
  if (!name) return undefined;
  if (name.startsWith("no")) return "none";
  return (["urgent", "high", "medium", "low"] as const).find((p) => name === p);
}

function personOf(value: unknown): IssuePerson | null | undefined {
  if (value === null) return null;
  if (typeof value === "string")
    return value.trim() ? { name: value } : undefined;
  const object = record(value);
  const name = firstText(object.displayName, object.name);
  const email = text(object.email);
  const id = text(object.id);
  if (!name && !email && !id) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(id ? { id } : {}),
  };
}

function statusOf(issue: Record<string, unknown>): ProviderIssue["status"] {
  const state = record(issue.state);
  const name =
    firstText(state.name, issue.status, issue.state, issue.stateName) ??
    "Unknown";
  const type = firstText(
    state.type,
    issue.statusType,
    issue.stateType,
  )?.toLowerCase();
  return {
    name,
    category: (type && STATE_TYPES[type]) || categoryFromName(name),
  };
}

function labelsOf(value: unknown): string[] {
  return listOf(value, ["nodes"])
    .map((label) => firstText(label, record(label).name))
    .filter((label): label is string => label !== undefined);
}

/** A Linear issue, as `get_issue` or `list_issues` returns it, in the shared shape. */
export function linearIssue(value: unknown): ProviderIssue {
  const issue = record(value);
  const ref = firstText(issue.identifier, issue.id);
  if (!ref)
    throw new IssuesError(
      "provider_error",
      "Linear returned an issue without an identifier",
    );
  const team = record(issue.team);
  const teamName = firstText(team.key, team.name, issue.team);
  const priority = priorityOf(issue.priority);
  const assignee = personOf(issue.assignee);
  const url = text(issue.url);
  const description = text(issue.description);
  const created = firstText(issue.createdAt, issue.created_at);
  const updated = firstText(issue.updatedAt, issue.updated_at);
  return {
    ref,
    title: firstText(issue.title) ?? "",
    status: statusOf(issue),
    labels: labelsOf(issue.labels),
    ...(description ? { description } : {}),
    ...(priority ? { priority } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(teamName
      ? {
          container: {
            name: teamName,
            ...(text(team.id) ? { id: text(team.id)! } : {}),
          },
        }
      : {}),
    ...(url ? { url } : {}),
    ...(created ? { created_at: created } : {}),
    ...(updated ? { updated_at: updated } : {}),
  };
}

function linearComment(value: unknown): IssueComment | undefined {
  const comment = record(value);
  const body = firstText(comment.body);
  if (!body) return undefined;
  const author = personOf(comment.user ?? comment.author);
  const id = text(comment.id);
  const created = firstText(comment.createdAt, comment.created_at);
  return {
    body,
    ...(id ? { id } : {}),
    ...(author ? { author } : {}),
    ...(created ? { created_at: created } : {}),
  };
}

/** The issue a write tool answered with: the issue itself, or under `issue`. */
function writtenIssue(value: unknown): unknown {
  const object = record(value);
  return object.issue !== undefined ? object.issue : value;
}

export const linearIssuesProvider: RecipeIssuesProviderModule = {
  kind: "issues",
  apiVersion: 1,
  id: "linear",
  capabilities: {
    commands: {
      search: {},
      get: {},
      create: { note: "Needs a team: the declaration's, or container." },
      update: {},
      comment: {},
      transition: {},
    },
    fields: [
      "description",
      "priority",
      "assignee",
      "labels",
      "container",
      "comments",
      "url",
    ],
    hosts: ["mcp.linear.app"],
    options: { team: "string", server: "string" },
  },
  mcp: {
    url: "https://mcp.linear.app/mcp",
    server: "linear",
    tools: LINEAR_MCP_TOOLS,
  },
  createSession({ config }): IssuesSession {
    const call = (
      use: IssuesMcpToolMapping["serves"][number],
      args: Record<string, unknown>,
      ctx: IssuesCallContext,
      only?: readonly string[],
    ) =>
      callJson(
        ctx.mcp,
        "linear",
        toolsFor(LINEAR_MCP_TOOLS, use).filter(
          (tool) => !only || only.includes(tool),
        ),
        args,
        ctx.signal,
      );
    const getIssue = async (ref: string, ctx: IssuesCallContext) =>
      linearIssue(
        writtenIssue(await call("get", { id: ref }, ctx, ["get_issue"])),
      );
    const save = async (
      use: "create" | "update" | "transition",
      args: Record<string, unknown>,
      ctx: IssuesCallContext,
    ) => linearIssue(writtenIssue(await call(use, args, ctx, ["save_issue"])));
    const fields = (args: {
      title?: string;
      description?: string;
      priority?: IssuePriority;
      labels?: readonly string[];
      assignee?: string;
    }) => ({
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.description !== undefined
        ? { description: args.description }
        : {}),
      ...(args.priority !== undefined
        ? { priority: PRIORITY_TO_LINEAR[args.priority] }
        : {}),
      ...(args.labels !== undefined ? { labels: [...args.labels] } : {}),
      ...(args.assignee !== undefined
        ? { assignee: args.assignee === "none" ? null : args.assignee }
        : {}),
    });
    return {
      async search(args, ctx) {
        const found = await call(
          "search",
          {
            limit: args.limit ?? 20,
            ...(args.query !== undefined ? { query: args.query } : {}),
            ...(args.status !== undefined ? { state: args.status } : {}),
            ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
            ...(args.container !== undefined ? { team: args.container } : {}),
            ...(args.label !== undefined ? { label: args.label } : {}),
          },
          ctx,
        );
        return {
          issues: listOf(found, ["issues", "nodes", "results"]).map(
            linearIssue,
          ),
        };
      },
      async get({ ref }, ctx) {
        const issue = await getIssue(ref, ctx);
        const comments = listOf(
          await call("get", { issueId: ref }, ctx, ["list_comments"]),
          ["comments", "nodes"],
        )
          .map(linearComment)
          .filter((comment): comment is IssueComment => comment !== undefined);
        return { ...issue, comments };
      },
      async create(args, ctx) {
        const team = args.container ?? text(config.options.team);
        if (!team)
          throw new IssuesError(
            "invalid_request",
            "A Linear issue needs a team: name one as container, or set team on the Recipe's pi.issues declaration",
          );
        return save("create", { team, ...fields(args) }, ctx);
      },
      async update({ ref, ...changes }, ctx) {
        return save("update", { id: ref, ...fields(changes) }, ctx);
      },
      async comment({ ref, body }, ctx) {
        const answer = record(
          await call("comment", { issueId: ref, body }, ctx),
        );
        return linearComment(answer.comment ?? answer) ?? { body };
      },
      async transition({ ref, status }, ctx) {
        let state = status;
        const category = status
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, "_");
        if (isStatusCategory(category)) {
          const current = await getIssue(ref, ctx);
          const statuses = listOf(
            await call(
              "transition",
              { team: current.container?.name ?? text(config.options.team) },
              ctx,
              ["list_issue_statuses"],
            ),
            ["statuses", "states", "nodes"],
          ).map(record);
          const match = CATEGORY_STATE_TYPES[category]
            .map((type) =>
              statuses.find(
                (candidate) => text(candidate.type)?.toLowerCase() === type,
              ),
            )
            .find((candidate) => candidate !== undefined);
          const name = match && text(match.name);
          if (!name)
            throw new IssuesError(
              "invalid_request",
              `Linear has no ${category} state for this issue's team; name the state`,
            );
          state = name;
        }
        return save("transition", { id: ref, state }, ctx);
      },
    };
  },
};
