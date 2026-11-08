import type { RecipeIssuesModule } from "@introspection-ai/recipes/issues";

import { adfToMarkdown } from "./adf.js";
import {
  createIntrospectionIssuesProvider,
  introspectionEnvironment,
  introspectionIssuesProvider,
} from "./introspection.js";
import { JIRA_MCP_TOOLS, jiraIssue, jiraIssuesProvider } from "./jira.js";
import {
  LINEAR_MCP_TOOLS,
  linearIssue,
  linearIssuesProvider,
} from "./linear.js";

/** The issues providers the `issues` tool loads from this package. */
export const issuesProviders: RecipeIssuesModule = {
  kind: "issues",
  apiVersion: 1,
  providers: {
    linear: linearIssuesProvider,
    jira: jiraIssuesProvider,
    introspection: introspectionIssuesProvider,
  },
};

export default issuesProviders;

export {
  adfToMarkdown,
  createIntrospectionIssuesProvider,
  introspectionEnvironment,
  introspectionIssuesProvider,
  JIRA_MCP_TOOLS,
  jiraIssue,
  jiraIssuesProvider,
  LINEAR_MCP_TOOLS,
  linearIssue,
  linearIssuesProvider,
};
export type {
  IntrospectionEventRow,
  IntrospectionIssue,
  IntrospectionIssuesClient,
  IntrospectionProviderOptions,
} from "./introspection.js";
