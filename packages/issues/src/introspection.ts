import type {
  IssueComment,
  IssuePriority,
  IssueStatusCategory,
  IssuesSession,
  ProviderIssue,
  RecipeIssuesProviderModule,
} from "@introspection-ai/recipes/issues";

import { firstText, IssuesError, isStatusCategory, text } from "./common.js";

/** An issue's status on `/v1/issues`. */
type IntrospectionStatus = "open" | "waiting" | "closed" | "cancelled";
type IntrospectionPriority = "low" | "medium" | "high" | "urgent";

/** The fields of an Introspection issue the provider reads (`@introspection-sdk/types` `Issue`). */
export interface IntrospectionIssue {
  id: string;
  project_id: string;
  title: string;
  description: string;
  priority: IntrospectionPriority;
  status: IntrospectionStatus;
  display_index?: number | null;
  tags: string[];
  /** Absent on a data plane whose issues have no assignee yet. */
  assignee_member_id?: string | null;
  /** The comments, oldest first, when the read included them. */
  comments?: IntrospectionIssueComment[] | null;
  created_at: string;
  updated_at: string;
}

/** The fields of an issue's comment the provider reads (`@introspection-sdk/types` `IssueComment`). */
export interface IntrospectionIssueComment {
  id: string;
  comment: string;
  member_id?: string | null;
  created_at: string;
}

interface Page<T> {
  records: T[];
  next?: string | null;
}

/**
 * The part of the SDK's Data Plane client the provider calls.
 * `@introspection-sdk/introspection-node`'s `DataPlaneClient` is one; a
 * release without issue comments has no `issues.comments`.
 */
export interface IntrospectionIssuesClient {
  issues: {
    list(params: {
      limit?: number;
      status?: IntrospectionStatus | IntrospectionStatus[];
      display_index?: number;
      tag?: string;
      relation?: "assignee"[];
      member_id?: string;
    }): PromiseLike<Page<IntrospectionIssue>>;
    get(
      issueId: string,
      params?: { include?: "comments"[] },
    ): Promise<IntrospectionIssue>;
    create(params: {
      task_id: string;
      title: string;
      description: string;
      priority?: IntrospectionPriority;
      tags?: string[];
      assignee_member_id?: string;
    }): Promise<IntrospectionIssue>;
    update(
      issueId: string,
      patch: {
        title?: string;
        description?: string;
        priority?: IntrospectionPriority;
        status?: IntrospectionStatus;
        tags?: string[];
        assignee_member_id?: string | null;
      },
    ): Promise<IntrospectionIssue>;
    comments?: {
      create(
        issueId: string,
        params: { comment: string },
      ): Promise<IntrospectionIssueComment>;
    };
  };
}

const TO_CATEGORY: Record<IntrospectionStatus, IssueStatusCategory> = {
  open: "open",
  waiting: "in_progress",
  closed: "done",
  cancelled: "cancelled",
};
const FROM_CATEGORY: Record<IssueStatusCategory, IntrospectionStatus> = {
  open: "open",
  in_progress: "waiting",
  done: "closed",
  cancelled: "cancelled",
};
const STATUSES: readonly string[] = ["open", "waiting", "closed", "cancelled"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many issues a text search reads before matching, since `/v1/issues` has no text filter. */
const TEXT_SEARCH_WINDOW = 200;

/** The Data Plane URL and token the runtime injects into the task's sandbox. */
export function introspectionEnvironment(
  env: NodeJS.ProcessEnv,
): { dpUrl: string; token: string } | undefined {
  const dpUrl = firstText(
    env.INTROSPECTION_DP_URL,
    env.INTROSPECTION_BASE_API_URL,
  );
  const token = text(env.INTROSPECTION_TOKEN);
  return dpUrl && token
    ? { dpUrl: dpUrl.trim(), token: token.trim() }
    : undefined;
}

/** The SDK's Data Plane client on the task's own session, loaded only when a call needs it. */
async function sdkClient(
  env: NodeJS.ProcessEnv,
): Promise<IntrospectionIssuesClient> {
  const target = introspectionEnvironment(env);
  if (!target)
    throw new IssuesError(
      "not_connected",
      "This runtime has no Introspection session (INTROSPECTION_BASE_API_URL and INTROSPECTION_TOKEN)",
    );
  const { DataPlaneClient } =
    await import("@introspection-sdk/introspection-node");
  const client: IntrospectionIssuesClient = new DataPlaneClient(target);
  return client;
}

function statusOf(value: string): IntrospectionStatus {
  const lower = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (STATUSES.includes(lower)) return lower as IntrospectionStatus;
  if (isStatusCategory(lower)) return FROM_CATEGORY[lower];
  throw new IssuesError(
    "invalid_request",
    `'${value}' is not an Introspection issue status; use open, waiting, closed or cancelled`,
  );
}

function priorityOf(value: IssuePriority): IntrospectionPriority {
  if (value === "none")
    throw new IssuesError(
      "invalid_request",
      "Introspection issues always have a priority; use low, medium, high or urgent",
    );
  return value;
}

function sdkError(error: unknown, what: string): never {
  const status = (error as { status?: unknown })?.status;
  if (status === 404)
    throw new IssuesError("not_found", `${what} was not found`);
  if (status === 401 || status === 403)
    throw new IssuesError(
      "not_connected",
      `The task's session may not ${what === "the issue" ? "read or change issues" : `reach ${what}`}`,
    );
  throw error;
}

function toIssue(issue: IntrospectionIssue): ProviderIssue {
  return {
    ref:
      issue.display_index !== undefined && issue.display_index !== null
        ? String(issue.display_index)
        : issue.id,
    title: issue.title,
    description: issue.description,
    status: { name: issue.status, category: TO_CATEGORY[issue.status] },
    priority: issue.priority,
    labels: issue.tags,
    ...(issue.assignee_member_id
      ? { assignee: { id: issue.assignee_member_id } }
      : {}),
    container: { name: "project", id: issue.project_id },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

function toComment(comment: IntrospectionIssueComment): IssueComment {
  return {
    id: comment.id,
    body: comment.comment,
    created_at: comment.created_at,
    ...(comment.member_id ? { author: { id: comment.member_id } } : {}),
  };
}

/** The list filter for `assignee`: the caller for `me`, else that member. */
function assigneeFilter(value: string): {
  relation: "assignee"[];
  member_id?: string;
} {
  const assignee = value.trim();
  if (assignee.toLowerCase() === "me") return { relation: ["assignee"] };
  if (UUID.test(assignee))
    return { relation: ["assignee"], member_id: assignee };
  throw new IssuesError(
    "invalid_request",
    `Introspection issues take me or a member id as the assignee to search by, not '${value}'`,
  );
}

/** The member a write assigns: the API takes an id, and nothing here names the caller's own. */
function assigneeId(value: string): string {
  const assignee = value.trim();
  if (UUID.test(assignee)) return assignee;
  throw new IssuesError(
    "invalid_request",
    `An Introspection issue is assigned by member id; this provider cannot resolve '${value}' to one`,
  );
}

export interface IntrospectionProviderOptions {
  /** The client to call; default: the SDK's `DataPlaneClient` from the runtime's environment. */
  client?: (
    env: NodeJS.ProcessEnv,
  ) => IntrospectionIssuesClient | Promise<IntrospectionIssuesClient>;
}

/**
 * The `introspection` provider: the Data Plane's `/v1/issues`, on the task's
 * own session, through the JavaScript SDK.
 */
export function createIntrospectionIssuesProvider(
  options: IntrospectionProviderOptions = {},
): RecipeIssuesProviderModule {
  const clientFor = options.client ?? sdkClient;
  return {
    kind: "issues",
    apiVersion: 1,
    id: "introspection",
    capabilities: {
      commands: {
        search: {
          note: "Text matches the title and description of the most recent issues; the assignee is me or a member id.",
        },
        get: {},
        create: {
          note: "Files the issue in the Recipe's project, on the calling task; the assignee is a member id, since a write cannot resolve me.",
        },
        update: {
          note: "The assignee is a member id or none, since a write cannot resolve me.",
        },
        comment: {},
        transition: { note: "Statuses: open, waiting, closed, cancelled." },
      },
      fields: [
        "description",
        "priority",
        "assignee",
        "labels",
        "container",
        "comments",
      ],
      hosts: [],
    },
    available: (env) => introspectionEnvironment(env) !== undefined,
    async createSession({ env }): Promise<IssuesSession> {
      const client = await clientFor(env);
      const find = async (ref: string): Promise<IntrospectionIssue> => {
        if (UUID.test(ref))
          return client.issues
            .get(ref)
            .catch((error: unknown) => sdkError(error, "the issue"));
        const index = Number(ref);
        if (!Number.isInteger(index) || index < 0)
          throw new IssuesError(
            "invalid_request",
            `'introspection:${ref}' is not an Introspection issue handle`,
          );
        const page = await Promise.resolve(
          client.issues.list({ display_index: index, limit: 1 }),
        ).catch((error: unknown) => sdkError(error, "the issue"));
        const issue = page.records[0];
        if (!issue)
          throw new IssuesError(
            "not_found",
            `introspection:${ref} was not found`,
          );
        return issue;
      };
      return {
        async search(args) {
          const assignee =
            args.assignee !== undefined
              ? assigneeFilter(args.assignee)
              : undefined;
          const limit = args.limit ?? 20;
          const query = args.query?.trim().toLowerCase();
          const page = await Promise.resolve(
            client.issues.list({
              limit: query ? TEXT_SEARCH_WINDOW : limit,
              ...(args.status !== undefined
                ? { status: statusOf(args.status) }
                : {}),
              ...(args.label !== undefined ? { tag: args.label } : {}),
              ...assignee,
            }),
          ).catch((error: unknown) => sdkError(error, "the issues"));
          // A data plane without assignees ignores the filter and lists every issue.
          if (
            assignee &&
            page.records.some((issue) => issue.assignee_member_id === undefined)
          )
            throw new IssuesError(
              "not_supported",
              "This data plane's issues have no assignee to search by yet",
            );
          const matched = query
            ? page.records.filter((issue) =>
                `${issue.title}\n${issue.description}`
                  .toLowerCase()
                  .includes(query),
              )
            : page.records;
          return { issues: matched.slice(0, limit).map(toIssue) };
        },
        async get({ ref }) {
          const id = UUID.test(ref) ? ref : (await find(ref)).id;
          const issue = await client.issues
            .get(id, { include: ["comments"] })
            .catch((error: unknown) => sdkError(error, "the issue"));
          return {
            ...toIssue(issue),
            comments: (issue.comments ?? []).map(toComment),
          };
        },
        async create(args) {
          const taskId = text(env.INTROSPECTION_TASK_ID);
          if (!taskId)
            throw new IssuesError(
              "not_connected",
              "An Introspection issue is created on the calling task, and this runtime names none (INTROSPECTION_TASK_ID)",
            );
          const created = await client.issues
            .create({
              task_id: taskId.trim(),
              title: args.title,
              description: args.description?.trim()
                ? args.description
                : args.title,
              ...(args.priority !== undefined
                ? { priority: priorityOf(args.priority) }
                : {}),
              ...(args.labels !== undefined ? { tags: [...args.labels] } : {}),
              ...(args.assignee !== undefined
                ? { assignee_member_id: assigneeId(args.assignee) }
                : {}),
            })
            .catch((error: unknown) => sdkError(error, "the issues"));
          return toIssue(created);
        },
        async update(args) {
          const issue = await find(args.ref);
          const updated = await client.issues
            .update(issue.id, {
              ...(args.title !== undefined ? { title: args.title } : {}),
              ...(args.description !== undefined
                ? { description: args.description }
                : {}),
              ...(args.priority !== undefined
                ? { priority: priorityOf(args.priority) }
                : {}),
              ...(args.labels !== undefined ? { tags: [...args.labels] } : {}),
              ...(args.assignee !== undefined
                ? {
                    assignee_member_id:
                      args.assignee.trim().toLowerCase() === "none"
                        ? null
                        : assigneeId(args.assignee),
                  }
                : {}),
            })
            .catch((error: unknown) => sdkError(error, "the issue"));
          return toIssue(updated);
        },
        async comment({ ref, body }) {
          const issue = await find(ref);
          const comments = client.issues.comments;
          if (!comments)
            throw new IssuesError(
              "not_supported",
              "The installed Introspection SDK cannot comment on an issue yet",
            );
          const created = await comments
            .create(issue.id, { comment: body })
            .catch((error: unknown) => {
              // The issue was just read, so a missing route is the data plane's.
              const status = (error as { status?: unknown })?.status;
              if (status === 404 || status === 405)
                throw new IssuesError(
                  "not_supported",
                  "This data plane does not take issue comments yet",
                );
              return sdkError(error, "the issue");
            });
          return toComment(created);
        },
        async transition({ ref, status }) {
          const issue = await find(ref);
          const updated = await client.issues
            .update(issue.id, { status: statusOf(status) })
            .catch((error: unknown) => sdkError(error, "the issue"));
          return toIssue(updated);
        },
      };
    },
  };
}

export const introspectionIssuesProvider = createIntrospectionIssuesProvider();
