import type {
  IssueComment,
  IssuePriority,
  IssueStatusCategory,
  IssuesSession,
  ProviderIssue,
  RecipeIssuesProviderModule,
} from "@introspection-ai/recipes/issues";

import {
  firstText,
  IssuesError,
  isStatusCategory,
  MAX_PAGES,
  record,
  text,
} from "./common.js";

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
  created_at: string;
  updated_at: string;
}

/** One row of `GET /v1/events`: the envelope and its payload. */
export interface IntrospectionEventRow {
  id: string;
  timestamp: string;
  event_name: string;
  payload?: unknown;
}

interface Page<T> {
  records: T[];
  next?: string | null;
}

/**
 * The part of the SDK's Data Plane client the provider calls: its issues
 * client for the row and its events client for comments.
 * `@introspection-sdk/introspection-node`'s `DataPlaneClient` is one.
 */
export interface IntrospectionIssuesClient {
  issues: {
    list(params: {
      limit?: number;
      next?: string;
      status?: IntrospectionStatus | IntrospectionStatus[];
      display_index?: number;
      tag?: string;
    }): PromiseLike<Page<IntrospectionIssue>>;
    get(issueId: string): Promise<IntrospectionIssue>;
    create(params: {
      task_id: string;
      title: string;
      description: string;
      priority?: IntrospectionPriority;
      tags?: string[];
    }): Promise<IntrospectionIssue>;
    update(
      issueId: string,
      patch: {
        title?: string;
        description?: string;
        priority?: IntrospectionPriority;
        status?: IntrospectionStatus;
        tags?: string[];
      },
    ): Promise<IntrospectionIssue>;
  };
  events: {
    list(params: {
      event_name: string;
      limit?: number;
      next?: string;
    }): PromiseLike<Page<IntrospectionEventRow>>;
  };
}

/** The family the issue events are read from; a comment is one whose payload carries `comment`. */
const INTROSPECTION_ISSUE_EVENT = "introspection.issue";

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
    container: { name: "project", id: issue.project_id },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

/** A comment from an `introspection.issue` event, or undefined when the event is not one. */
function commentOf(row: IntrospectionEventRow): IssueComment | undefined {
  const payload = record(row.payload);
  const comment = payload.comment;
  if (comment === undefined || comment === null) return undefined;
  const fields = record(comment);
  const body =
    typeof comment === "string" ? comment : firstText(fields.body, fields.text);
  if (body === undefined) return undefined;
  const author = record(fields.author ?? payload.actor);
  const authorName = firstText(fields.author, author.name, author.display_name);
  const authorEmail = text(author.email);
  const authorId = firstText(author.id, author.member_id, payload.member_id);
  const by =
    authorName || authorEmail || authorId
      ? {
          ...(authorName ? { name: authorName } : {}),
          ...(authorEmail ? { email: authorEmail } : {}),
          ...(authorId ? { id: authorId } : {}),
        }
      : undefined;
  return {
    id: firstText(fields.id, row.id)!,
    body,
    created_at: firstText(fields.created_at, row.timestamp) ?? row.timestamp,
    ...(by ? { author: by } : {}),
  };
}

export interface IntrospectionProviderOptions {
  /** The client to call; default: the SDK's `DataPlaneClient` from the runtime's environment. */
  client?: (
    env: NodeJS.ProcessEnv,
  ) => IntrospectionIssuesClient | Promise<IntrospectionIssuesClient>;
}

/**
 * The `introspection` provider: the Data Plane's `/v1/issues`, on the task's
 * own session, through the JavaScript SDK. `comment` is not offered until the
 * platform accepts a comment on `PATCH /v1/issues/{id}`; `get` reads
 * comments already recorded on the issue's events.
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
          note: "Text matches the title and description of the most recent issues; no assignee filter.",
        },
        get: {},
        create: {
          note: "Files the issue in the Recipe's project, on the calling task.",
        },
        update: {
          note: "No assignee: an issue has an owner, not an assignee.",
        },
        transition: { note: "Statuses: open, waiting, closed, cancelled." },
      },
      fields: ["description", "priority", "labels", "container", "comments"],
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
      const comments = async (
        issue: IntrospectionIssue,
      ): Promise<IssueComment[]> => {
        const rows: IntrospectionEventRow[] = [];
        let next: string | undefined;
        for (let pages = 0; pages < MAX_PAGES; pages += 1) {
          let page: Page<IntrospectionEventRow>;
          try {
            page = await client.events.list({
              event_name: INTROSPECTION_ISSUE_EVENT,
              issue_id: issue.id,
              limit: 100,
              ...(next ? { next } : {}),
            } as Parameters<IntrospectionIssuesClient["events"]["list"]>[0]);
          } catch (error) {
            // A data plane that does not record issue events yet refuses the family.
            const status = (error as { status?: unknown })?.status;
            if (status === 400 || status === 422) return [];
            throw error;
          }
          rows.push(...page.records);
          next = page.next ?? undefined;
          if (!next) break;
        }
        return rows
          .map(commentOf)
          .filter((comment): comment is IssueComment => comment !== undefined)
          .sort((a, b) =>
            (a.created_at ?? "").localeCompare(b.created_at ?? ""),
          );
      };
      return {
        async search(args) {
          if (args.assignee !== undefined)
            throw new IssuesError(
              "not_supported",
              "Introspection issues have no assignee to filter by",
            );
          const limit = args.limit ?? 20;
          const query = args.query?.trim().toLowerCase();
          const page = await Promise.resolve(
            client.issues.list({
              limit: query ? TEXT_SEARCH_WINDOW : limit,
              ...(args.status !== undefined
                ? { status: statusOf(args.status) }
                : {}),
              ...(args.label !== undefined ? { tag: args.label } : {}),
            }),
          ).catch((error: unknown) => sdkError(error, "the issues"));
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
          const issue = await find(ref);
          return { ...toIssue(issue), comments: await comments(issue) };
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
            })
            .catch((error: unknown) => sdkError(error, "the issue"));
          return toIssue(updated);
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
