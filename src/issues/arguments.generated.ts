// Generated from src/issues/arguments.ts by scripts/generate-tool-schemas.mjs; do not edit.
import type { ArgumentsSchema } from "../command-parameters.js";
import type {
  IssuesSearchArguments,
  IssuesGetArguments,
  IssuesCreateArguments,
  IssuesUpdateArguments,
  IssuesCommentArguments,
  IssuesTransitionArguments,
} from "./arguments.js";

export const ISSUES_ARGUMENTS = {
  search: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        description: "Which tracker, when several are on offer",
      },
      query: { type: "string", description: "Free text" },
      status: { type: "string", description: "A status name or {statuses}" },
      assignee: { type: "string", description: "A name or email, or me" },
      container: { type: "string", description: "A team or project" },
      label: { type: "string", description: "Only issues with this label" },
      limit: {
        type: "integer",
        description: "At most this many issues",
        minimum: 1,
        maximum: 50,
      },
    },
    additionalProperties: false,
  } as ArgumentsSchema<IssuesSearchArguments>,
  get: {
    type: "object",
    properties: {
      handle: {
        type: "string",
        description:
          "The issue's handle, provider:ref, as search and get return it",
        minLength: 1,
      },
    },
    required: ["handle"],
    additionalProperties: false,
  } as ArgumentsSchema<IssuesGetArguments>,
  create: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        description: "Which tracker, when several are on offer",
      },
      title: { type: "string", description: "The issue's title", minLength: 1 },
      description: { type: "string", description: "Markdown" },
      container: { type: "string", description: "A team or project" },
      assignee: { type: "string", description: "A name or email, or me" },
      priority: {
        type: "string",
        enum: ["none", "low", "medium", "high", "urgent"],
        description: "The issue's priority",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Replaces the labels",
      },
      issue_type: { type: "string", description: "Jira's issue type" },
    },
    required: ["title"],
    additionalProperties: false,
  } as ArgumentsSchema<IssuesCreateArguments>,
  update: {
    type: "object",
    properties: {
      handle: {
        type: "string",
        description:
          "The issue's handle, provider:ref, as search and get return it",
        minLength: 1,
      },
      title: { type: "string", description: "The issue's title", minLength: 1 },
      description: { type: "string", description: "Markdown" },
      assignee: {
        type: "string",
        description: "A name or email, me, or none to unassign",
      },
      priority: {
        type: "string",
        enum: ["none", "low", "medium", "high", "urgent"],
        description: "The issue's priority",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Replaces the labels",
      },
    },
    required: ["handle"],
    additionalProperties: false,
  } as ArgumentsSchema<IssuesUpdateArguments>,
  comment: {
    type: "object",
    properties: {
      handle: {
        type: "string",
        description:
          "The issue's handle, provider:ref, as search and get return it",
        minLength: 1,
      },
      body: { type: "string", description: "Markdown", minLength: 1 },
    },
    required: ["handle", "body"],
    additionalProperties: false,
  } as ArgumentsSchema<IssuesCommentArguments>,
  transition: {
    type: "object",
    properties: {
      handle: {
        type: "string",
        description:
          "The issue's handle, provider:ref, as search and get return it",
        minLength: 1,
      },
      status: { type: "string", description: "A status name or {statuses}" },
    },
    required: ["handle", "status"],
    additionalProperties: false,
  } as ArgumentsSchema<IssuesTransitionArguments>,
};
