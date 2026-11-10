/**
 * The arguments each `issues` command takes, as the model sees them.
 * `scripts/generate-tool-schemas.mjs` turns each `Issues<Command>Arguments`
 * type into the JSON Schema in `arguments.generated.ts`: a field's doc comment
 * is its description and its tags are its limits. `{statuses}` is filled in at
 * registration, and `provider` is narrowed to the providers on offer, or left
 * out when there is one.
 */

import type { IssuePriority } from "./types.js";

/** Which tracker, when several are on offer */
type Provider = string;

/**
 * The issue's handle, provider:ref, as search and get return it
 * @minLength 1
 */
type Handle = string;

/** A status name or {statuses} */
type Status = string;

/** A team or project */
type Container = string;

/** A name or email, or me */
type Assignee = string;

/**
 * The issue's title
 * @minLength 1
 */
type Title = string;

/** Markdown */
type Description = string;

/** The issue's priority */
type Priority = IssuePriority;

/** Replaces the labels */
type Labels = string[];

export interface IssuesSearchArguments {
  provider?: Provider;
  /** Free text */
  query?: string;
  status?: Status;
  assignee?: Assignee;
  container?: Container;
  /** Only issues with this label */
  label?: string;
  /**
   * At most this many issues
   * @asType integer
   * @minimum 1
   * @maximum 50
   */
  limit?: number;
}

export interface IssuesGetArguments {
  handle: Handle;
}

export interface IssuesCreateArguments {
  provider?: Provider;
  title: Title;
  description?: Description;
  container?: Container;
  assignee?: Assignee;
  priority?: Priority;
  labels?: Labels;
  /** Jira's issue type */
  issue_type?: string;
}

export interface IssuesUpdateArguments {
  handle: Handle;
  title?: Title;
  description?: Description;
  /** A name or email, me, or none to unassign */
  assignee?: string;
  priority?: Priority;
  labels?: Labels;
}

export interface IssuesCommentArguments {
  handle: Handle;
  /**
   * Markdown
   * @minLength 1
   */
  body: string;
}

export interface IssuesTransitionArguments {
  handle: Handle;
  status: Status;
}
