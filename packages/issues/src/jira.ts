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

import { adfToMarkdown } from "./adf.js";
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
 * Atlassian's Rovo MCP server tools the adapter calls, in order of preference
 * per use: the names Atlassian's supported-tools page lists, then the older
 * names a v1 server offered. Atlassian documents no arguments, so none is
 * checked against a captured tool list yet.
 */
export const JIRA_MCP_TOOLS: readonly IssuesMcpToolMapping[] = [
  {
    tool: "getAccessibleAtlassianResources",
    serves: ["setup"],
    verified: false,
  },
  { tool: "lookupJiraAccountId", serves: ["setup"], verified: false },
  { tool: "atlassianUserInfo", serves: ["setup"], verified: false },
  { tool: "searchJiraIssuesUsingJql", serves: ["search"], verified: false },
  {
    tool: "getJiraIssue",
    serves: ["get", "update", "transition"],
    verified: false,
  },
  { tool: "listJiraIssueComments", serves: ["get"], verified: false },
  { tool: "createJiraIssue", serves: ["create"], verified: false },
  { tool: "editJiraIssue", serves: ["update"], verified: false },
  { tool: "addOrEditJiraIssueComment", serves: ["comment"], verified: false },
  { tool: "addCommentToJiraIssue", serves: ["comment"], verified: false },
  { tool: "listJiraIssueTransitions", serves: ["transition"], verified: false },
  {
    tool: "getTransitionsForJiraIssue",
    serves: ["transition"],
    verified: false,
  },
  { tool: "transitionJiraIssue", serves: ["transition"], verified: false },
];

const JIRA_FIELDS = [
  "summary",
  "description",
  "status",
  "priority",
  "assignee",
  "labels",
  "project",
  "issuetype",
  "created",
  "updated",
  "comment",
];

/** Jira's status category keys to the shape's category. */
const CATEGORY_KEYS: Record<string, IssueStatusCategory> = {
  new: "open",
  indeterminate: "in_progress",
  done: "done",
};
const CATEGORY_NAMES: Record<IssueStatusCategory, string> = {
  open: "To Do",
  in_progress: "In Progress",
  done: "Done",
  cancelled: "Done",
};
const PRIORITY_FROM_JIRA: Record<string, IssuePriority> = {
  highest: "urgent",
  blocker: "urgent",
  critical: "urgent",
  high: "high",
  major: "high",
  medium: "medium",
  low: "low",
  minor: "low",
  lowest: "low",
  trivial: "low",
};
const PRIORITY_TO_JIRA: Record<Exclude<IssuePriority, "none">, string> = {
  urgent: "Highest",
  high: "High",
  medium: "Medium",
  low: "Low",
};
const CANCELLED = /cancel|won'?t|reject|declin|duplicate|invalid/i;

function categoryOf(status: Record<string, unknown>): IssueStatusCategory {
  const name = text(status.name) ?? "";
  const key = text(record(status.statusCategory).key)?.toLowerCase();
  const category = key ? CATEGORY_KEYS[key] : undefined;
  if (!category) return categoryFromName(name);
  return category === "done" && CANCELLED.test(name) ? "cancelled" : category;
}

function personOf(value: unknown): IssuePerson | null | undefined {
  if (value === null) return null;
  const object = record(value);
  const name = text(object.displayName);
  const email = text(object.emailAddress);
  const id = text(object.accountId);
  if (!name && !email && !id) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(id ? { id } : {}),
  };
}

function jiraComment(value: unknown): IssueComment | undefined {
  const comment = record(value);
  const body = adfToMarkdown(comment.body);
  if (!body) return undefined;
  const author = personOf(comment.author);
  const id = text(comment.id);
  const created = text(comment.created);
  return {
    body,
    ...(id ? { id } : {}),
    ...(author ? { author } : {}),
    ...(created ? { created_at: created } : {}),
  };
}

/** A Jira issue, as `getJiraIssue` or a JQL search returns it, in the shared shape. */
export function jiraIssue(value: unknown, site?: string): ProviderIssue {
  const issue = record(value);
  const key = text(issue.key);
  if (!key)
    throw new IssuesError(
      "provider_error",
      "Jira returned an issue without a key",
    );
  const fields = record(issue.fields);
  const status = record(fields.status);
  const priorityName = text(record(fields.priority).name);
  const priority = priorityName
    ? PRIORITY_FROM_JIRA[priorityName.toLowerCase()]
    : undefined;
  const assignee = personOf(fields.assignee);
  const project = record(fields.project);
  const projectName = firstText(project.key, project.name);
  const issueType = text(record(fields.issuetype).name);
  const description = adfToMarkdown(fields.description);
  const comments = listOf(fields.comment, ["comments"])
    .map(jiraComment)
    .filter((comment): comment is IssueComment => comment !== undefined);
  const created = text(fields.created);
  const updated = text(fields.updated);
  return {
    ref: key,
    title: text(fields.summary) ?? "",
    status: {
      name: text(status.name) ?? "Unknown",
      category: categoryOf(status),
    },
    labels: listOf(fields.labels, []).filter(
      (label): label is string => typeof label === "string",
    ),
    ...(description ? { description } : {}),
    ...(priority ? { priority } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(projectName
      ? {
          container: {
            name: projectName,
            ...(text(project.id) ? { id: text(project.id)! } : {}),
            ...(issueType ? { type: issueType } : {}),
          },
        }
      : {}),
    ...(site ? { url: `${site.replace(/\/$/, "")}/browse/${key}` } : {}),
    ...(created ? { created_at: created } : {}),
    ...(updated ? { updated_at: updated } : {}),
    ...(comments.length ? { comments } : {}),
  };
}

/** A JQL string literal. */
function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export const jiraIssuesProvider: RecipeIssuesProviderModule = {
  kind: "issues",
  apiVersion: 1,
  id: "jira",
  capabilities: {
    commands: {
      search: {
        note: "query is Jira text search; status takes a status name or category.",
      },
      get: {},
      create: {
        note: "Needs a project and issue type: the declaration's, or container and issue_type.",
      },
      update: {},
      comment: {},
      transition: {
        note: "Applies the workflow transition that reaches the status.",
      },
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
    hosts: ["mcp.atlassian.com"],
  },
  mcp: {
    url: "https://mcp.atlassian.com/v2/mcp",
    server: "atlassian",
    tools: JIRA_MCP_TOOLS,
  },
  createSession({ config }): IssuesSession {
    let site: Promise<{ cloudId: string; url?: string }> | undefined;
    const call = (
      use: IssuesMcpToolMapping["serves"][number],
      args: Record<string, unknown>,
      ctx: IssuesCallContext,
      only?: readonly string[],
    ) =>
      callJson(
        ctx.mcp,
        "jira",
        toolsFor(JIRA_MCP_TOOLS, use).filter(
          (tool) => !only || only.includes(tool),
        ),
        args,
        ctx.signal,
      );
    const resource = (ctx: IssuesCallContext) => {
      site ??= call("setup", {}, ctx, ["getAccessibleAtlassianResources"]).then(
        (answer) => {
          const resources = listOf(answer, ["resources", "sites"]).map(record);
          const chosen =
            resources.find((entry) =>
              listOf(entry.scopes, []).some((scope) =>
                String(scope).includes("jira"),
              ),
            ) ?? resources[0];
          const cloudId = chosen && firstText(chosen.id, chosen.cloudId);
          if (!cloudId)
            throw new IssuesError(
              "not_connected",
              "The Atlassian connection reaches no Jira site",
            );
          const url = text(chosen.url);
          return { cloudId, ...(url ? { url } : {}) };
        },
      );
      site.catch(() => (site = undefined));
      return site;
    };
    const accountId = async (
      who: string,
      cloudId: string,
      ctx: IssuesCallContext,
    ) => {
      if (who === "me") {
        const me = record(await call("setup", {}, ctx, ["atlassianUserInfo"]));
        const id = text(me.account_id) ?? text(me.accountId);
        if (!id)
          throw new IssuesError(
            "not_found",
            "Could not resolve the current Jira user",
          );
        return id;
      }
      const found = listOf(
        await call("setup", { cloudId, searchString: who }, ctx, [
          "lookupJiraAccountId",
        ]),
        ["users", "accounts", "values"],
      ).map(record);
      const id = found.length ? text(found[0]!.accountId) : undefined;
      if (!id)
        throw new IssuesError("not_found", `No Jira user matches '${who}'`);
      return id;
    };
    const getIssue = async (ref: string, ctx: IssuesCallContext) => {
      const { cloudId, url } = await resource(ctx);
      return jiraIssue(
        await call(
          "get",
          { cloudId, issueIdOrKey: ref, fields: JIRA_FIELDS },
          ctx,
          ["getJiraIssue"],
        ),
        url,
      );
    };
    return {
      async search(args, ctx) {
        const { cloudId, url } = await resource(ctx);
        const clauses: string[] = [];
        let wantCategory: IssueStatusCategory | undefined;
        if (args.query) clauses.push(`text ~ ${jqlString(args.query)}`);
        if (args.status) {
          const category = args.status
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, "_");
          clauses.push(
            isStatusCategory(category)
              ? `statusCategory = ${jqlString(CATEGORY_NAMES[category])}`
              : `status = ${jqlString(args.status)}`,
          );
          // Jira has no cancelled category: cancellation statuses sit in Done,
          // so done and cancelled are told apart by name after the search.
          if (category === "done" || category === "cancelled")
            wantCategory = category;
        }
        if (args.assignee) {
          const who = args.assignee.trim();
          clauses.push(
            who === "me"
              ? "assignee = currentUser()"
              : who === "none"
                ? "assignee is EMPTY"
                : `assignee = ${jqlString(await accountId(who, cloudId, ctx))}`,
          );
        }
        const project = args.container;
        if (project) clauses.push(`project = ${jqlString(project)}`);
        if (args.label) clauses.push(`labels = ${jqlString(args.label)}`);
        const jql = `${clauses.join(" AND ")}${clauses.length ? " " : ""}ORDER BY updated DESC`;
        const answer = await call(
          "search",
          { cloudId, jql, maxResults: args.limit ?? 20, fields: JIRA_FIELDS },
          ctx,
        );
        return {
          issues: listOf(answer, ["issues", "values"])
            .map((issue) => {
              const { comments: _comments, ...rest } = jiraIssue(issue, url);
              return rest;
            })
            .filter(
              (issue) =>
                !wantCategory || issue.status.category === wantCategory,
            ),
        };
      },
      async get({ ref }, ctx) {
        const issue = await getIssue(ref, ctx);
        if (issue.comments || !ctx.mcp?.hasTool("listJiraIssueComments"))
          return { ...issue, comments: issue.comments ?? [] };
        const { cloudId } = await resource(ctx);
        const comments = listOf(
          await call("get", { cloudId, issueIdOrKey: ref }, ctx, [
            "listJiraIssueComments",
          ]),
          ["comments", "values"],
        )
          .map(jiraComment)
          .filter((comment): comment is IssueComment => comment !== undefined);
        return { ...issue, comments };
      },
      async create(args, ctx) {
        const projectKey = args.container ?? config.project;
        const issueTypeName = args.issue_type ?? config.issueType;
        if (!projectKey || !issueTypeName)
          throw new IssuesError(
            "invalid_request",
            "A Jira issue needs a project and an issue type: name them as container and issue_type, or set project and issueType on the Recipe's pi.issues declaration",
          );
        if (args.priority === "none")
          throw new IssuesError(
            "invalid_request",
            "Jira issues take a priority from low to urgent",
          );
        const { cloudId, url } = await resource(ctx);
        const additional = {
          ...(args.priority !== undefined
            ? { priority: { name: PRIORITY_TO_JIRA[args.priority] } }
            : {}),
          ...(args.labels !== undefined ? { labels: [...args.labels] } : {}),
        };
        const assignee =
          args.assignee !== undefined && args.assignee !== "none"
            ? await accountId(args.assignee, cloudId, ctx)
            : undefined;
        const answer = record(
          await call(
            "create",
            {
              cloudId,
              projectKey,
              issueTypeName,
              summary: args.title,
              ...(args.description !== undefined
                ? { description: args.description }
                : {}),
              ...(assignee ? { assignee_account_id: assignee } : {}),
              ...(Object.keys(additional).length
                ? { additional_fields: additional }
                : {}),
            },
            ctx,
          ),
        );
        const key = text(answer.key);
        if (!key) return jiraIssue(answer, url);
        return getIssue(key, ctx);
      },
      async update({ ref, ...changes }, ctx) {
        if (changes.priority === "none")
          throw new IssuesError(
            "invalid_request",
            "Jira issues take a priority from low to urgent",
          );
        const { cloudId } = await resource(ctx);
        const assignee =
          changes.assignee === undefined
            ? undefined
            : changes.assignee === "none"
              ? null
              : { accountId: await accountId(changes.assignee, cloudId, ctx) };
        await call(
          "update",
          {
            cloudId,
            issueIdOrKey: ref,
            fields: {
              ...(changes.title !== undefined
                ? { summary: changes.title }
                : {}),
              ...(changes.description !== undefined
                ? { description: changes.description }
                : {}),
              ...(changes.priority !== undefined
                ? { priority: { name: PRIORITY_TO_JIRA[changes.priority] } }
                : {}),
              ...(changes.labels !== undefined
                ? { labels: [...changes.labels] }
                : {}),
              ...(assignee !== undefined ? { assignee } : {}),
            },
          },
          ctx,
          ["editJiraIssue"],
        );
        return getIssue(ref, ctx);
      },
      async comment({ ref, body }, ctx) {
        const { cloudId } = await resource(ctx);
        const answer = await call(
          "comment",
          { cloudId, issueIdOrKey: ref, commentBody: body },
          ctx,
        );
        return jiraComment(answer) ?? { body };
      },
      async transition({ ref, status }, ctx) {
        const { cloudId } = await resource(ctx);
        const transitions = listOf(
          await call("transition", { cloudId, issueIdOrKey: ref }, ctx, [
            "listJiraIssueTransitions",
            "getTransitionsForJiraIssue",
          ]),
          ["transitions", "values"],
        ).map(record);
        const wanted = status.trim().toLowerCase();
        const category = wanted.replace(/[\s-]+/g, "_");
        const byName = transitions.find(
          (transition) =>
            text(record(transition.to).name)?.toLowerCase() === wanted ||
            text(transition.name)?.toLowerCase() === wanted,
        );
        const chosen =
          byName ??
          (isStatusCategory(category)
            ? transitions.find(
                (transition) => categoryOf(record(transition.to)) === category,
              )
            : undefined);
        const id = chosen && firstText(chosen.id);
        if (!id) {
          const reachable = transitions
            .map(
              (transition) =>
                text(record(transition.to).name) ?? text(transition.name),
            )
            .filter(Boolean);
          throw new IssuesError(
            "invalid_request",
            `No transition takes ${ref} to '${status}'${reachable.length ? `; reachable: ${reachable.join(", ")}` : ""}`,
          );
        }
        await call(
          "transition",
          { cloudId, issueIdOrKey: ref, transition: { id } },
          ctx,
          ["transitionJiraIssue"],
        );
        return getIssue(ref, ctx);
      },
    };
  },
};
