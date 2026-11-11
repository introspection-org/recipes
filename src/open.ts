/**
 * `introspection_open`, as every host shares it: the targets an agent can ask a
 * person to open, the interrupt metadata a pause/resume host renders, and the
 * answers a host resumes with. Imports nothing from Node, Pi or a renderer, so
 * a browser host renders and answers with the same values the terminal uses;
 * `./review.ts` re-exports it for that reason.
 */

export const INTROSPECTION_OPEN_TOOL_NAME = "introspection_open";

/** What the person is asked to open. The agent names a target, never a URL. */
export type IntrospectionOpenTarget =
  /** A project-level install: `github`, `slack`. */
  | { kind: "integration"; provider: string }
  /** An admin adds the project's connector: its OAuth client. */
  | { kind: "connector"; provider: string }
  /** The person's own account with a provider: `google_workspace`, `notion`. */
  | { kind: "connection"; provider: string }
  /** An organization admin sets up sign-in: `google`, `entra`. */
  | { kind: "sso"; provider: string }
  /** One of a Runtime's MCP bindings. */
  | { kind: "binding"; runtime: string; name: string; environment?: string }
  /** A Runtime's page. */
  | { kind: "runtime"; runtime: string }
  /** A task's chat. */
  | { kind: "task"; task: string }
  /** An Introspection issue: its handle as the issues tool returned it (`introspection:I-7`) or its id. */
  | { kind: "issue"; issue: string }
  /** A new repository the person creates on GitHub, registered once the App reaches it. */
  | { kind: "repository"; provider: "github"; name: string; template?: string };

export type IntrospectionOpenTargetKind = IntrospectionOpenTarget["kind"];

export const INTROSPECTION_OPEN_TARGET_KINDS: readonly IntrospectionOpenTargetKind[] =
  [
    "integration",
    "connector",
    "connection",
    "sso",
    "binding",
    "runtime",
    "task",
    "issue",
    "repository",
  ];

/** The answers a host resumes an `introspection_open` interrupt with, as `payload.answer`. */
export const INTROSPECTION_OPEN_ANSWER = {
  /** The person finished the connection. */
  connected: "connected",
  /** The person came back from a page with nothing to connect (`runtime`, `task`, `issue`). */
  returned: "returned",
} as const;

/** `failed: <error>`, the answer for a flow the provider ended with an error. */
export function introspectionOpenFailed(error: string): string {
  const reason = error.replace(/\s+/g, " ").trim();
  return `failed: ${reason || "unknown error"}`;
}

/**
 * Whether opening the target is the whole action: a `runtime`, `task` or `issue` page,
 * where the person has nothing to finish. Hosts answer `returned` as soon as it
 * opens instead of waiting for the person to come back.
 */
export function introspectionOpenIsPage(
  target: IntrospectionOpenTarget,
): boolean {
  return (
    target.kind === "runtime" ||
    target.kind === "task" ||
    target.kind === "issue"
  );
}

/** The answer for a target the person completed: `returned` for a page, `connected` otherwise. */
export function introspectionOpenDone(target: IntrospectionOpenTarget): string {
  return introspectionOpenIsPage(target)
    ? INTROSPECTION_OPEN_ANSWER.returned
    : INTROSPECTION_OPEN_ANSWER.connected;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const ISSUE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What follows `introspection:` in a handle: the project's key (`I-7`), its number, or the issue id. */
const ISSUE_REF = /^(?:[a-z]{1,5}-\d+|\d+)$/i;

/** The provider an issue handle names (`linear` in `linear:ENG-1`), or null for a bare id. */
export function issueHandleProvider(issue: string): string | null {
  const colon = issue.indexOf(":");
  return colon > 0 ? issue.slice(0, colon).trim().toLowerCase() : null;
}

/** Whether `issue` names an Introspection issue: `introspection:<key, number or id>`, or a bare id. */
function isIntrospectionIssue(issue: string): boolean {
  if (ISSUE_ID.test(issue)) return true;
  if (issueHandleProvider(issue) !== "introspection") return false;
  const ref = issue.slice(issue.indexOf(":") + 1).trim();
  return ISSUE_REF.test(ref) || ISSUE_ID.test(ref);
}

/**
 * A target read back from untrusted input (a tool call's arguments, an
 * interrupt's metadata), or null when it isn't one. Only the fields its kind
 * names survive, trimmed.
 */
export function parseIntrospectionOpenTarget(
  value: unknown,
): IntrospectionOpenTarget | null {
  const raw = record(value);
  if (!raw) return null;
  switch (raw.kind) {
    case "integration":
    case "connector":
    case "connection":
    case "sso": {
      const provider = text(raw.provider);
      return provider ? { kind: raw.kind, provider } : null;
    }
    case "binding": {
      const runtime = text(raw.runtime);
      const name = text(raw.name);
      const environment = text(raw.environment);
      if (!runtime || !name) return null;
      return {
        kind: "binding",
        runtime,
        name,
        ...(environment ? { environment } : {}),
      };
    }
    case "runtime": {
      const runtime = text(raw.runtime);
      return runtime ? { kind: "runtime", runtime } : null;
    }
    case "task": {
      const task = text(raw.task);
      return task ? { kind: "task", task } : null;
    }
    case "issue": {
      const issue = text(raw.issue);
      return issue && isIntrospectionIssue(issue)
        ? { kind: "issue", issue }
        : null;
    }
    case "repository": {
      const name = text(raw.name);
      const template = text(raw.template);
      if (!name || (raw.provider !== undefined && raw.provider !== "github")) {
        return null;
      }
      return {
        kind: "repository",
        provider: "github",
        name,
        ...(template ? { template } : {}),
      };
    }
    default:
      return null;
  }
}

/** The target an `introspection_open` interrupt carries, or null for any other interrupt. */
export function introspectionOpenTargetOf(interrupt: {
  metadata?: unknown;
}): IntrospectionOpenTarget | null {
  const metadata = record(interrupt.metadata);
  if (metadata?.kind !== INTROSPECTION_OPEN_TOOL_NAME) return null;
  return parseIntrospectionOpenTarget(metadata.target);
}

const PROVIDER_NAMES: Record<string, string> = {
  github: "GitHub",
  slack: "Slack",
  linear: "Linear",
  google: "Google",
  google_workspace: "Google Workspace",
  gmail: "Gmail",
  google_calendar: "Google Calendar",
  google_drive: "Google Drive",
  notion: "Notion",
  entra: "Microsoft Entra",
  microsoft_365: "Microsoft 365",
};

/** A provider id as a person reads it: `google_workspace` is "Google Workspace". */
export function providerName(provider: string): string {
  const known = PROVIDER_NAMES[provider.toLowerCase()];
  if (known) return known;
  return provider
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/** The button a host shows for the target, e.g. "Connect GitHub" or "Open the runtime". */
export function introspectionOpenAction(
  target: IntrospectionOpenTarget,
): string {
  switch (target.kind) {
    case "integration":
      return `Install ${providerName(target.provider)}`;
    case "connector":
      return `Add the ${providerName(target.provider)} connector`;
    case "connection":
      return `Connect ${providerName(target.provider)}`;
    case "sso":
      return `Set up ${providerName(target.provider)} sign-in`;
    case "binding":
      return `Connect ${target.name}`;
    case "runtime":
      return "Open the runtime";
    case "task":
      return "Open the task";
    case "issue":
      return "Open the issue";
    case "repository":
      return `Create ${target.name} on GitHub`;
  }
}
