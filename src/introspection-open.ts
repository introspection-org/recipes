/**
 * `introspection_open`: the agent asks the person to open a platform page
 * (connect an integration, a connector, their own account, a binding, or look
 * at a runtime or task) and, with `wait`, continues with what they did.
 *
 * It is a Recipes interaction (docs/interactions.md), so it works on every
 * host. A pause/resume host renders its own card from `details.interrupt`
 * (`metadata.kind` is `introspection_open`, `metadata.target` the target) and
 * resumes with `{ answer: "connected" | "returned" | "failed: …" }` or a
 * decline. In Pi's terminal it runs the Introspection CLI's own loopback
 * (`introspection open --wait`, `connectors authorize`), which returns when the
 * browser comes back.
 */

import { spawn } from "node:child_process";

import type {
  ExtensionContext,
  ExtensionFactory,
  ExtensionUIContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AskUserOutcome } from "./interaction-text.js";
import { askUser, ASK_USER_REASON_INPUT_REQUIRED } from "./interactions.js";
import {
  INTROSPECTION_OPEN_TOOL_NAME,
  introspectionOpenAction,
  introspectionOpenDone,
  introspectionOpenFailed,
  parseIntrospectionOpenTarget,
  type IntrospectionOpenTarget,
} from "./open.js";
import type { RecipeExtensionRegistrationRegistry } from "./extensions.js";

const BUILTIN_OWNER = "<builtin:introspection_open>";

/** How long a person has to finish in the browser before the wait gives up. */
const INTROSPECTION_OPEN_TIMEOUT_MS = 60 * 60 * 1000;

/** What one CLI run ended with. */
export interface CliRunResult {
  /** The exit code, or null when the process could not start or was killed. */
  code: number | null;
  /** The last of its stderr, for a failure's reason. */
  stderr: string;
  /** Whether the executable was missing. */
  missing?: boolean;
}

/** Runs the Introspection CLI with these arguments until it exits or the signal aborts. */
type CliRunner = (
  args: readonly string[],
  signal: AbortSignal | undefined,
) => Promise<CliRunResult>;

export interface IntrospectionOpenToolOptions {
  /** The session's environment: `PI_INTERRUPT_RESUME`, `PI_ASK_USER_AUTO_APPROVE`, `INTROSPECTION_CLI`. */
  env?: NodeJS.ProcessEnv;
  /** Replaces the CLI process, for tests and hosts that embed the CLI. */
  runCli?: CliRunner;
}

const target = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("integration"),
      provider: Type.String({ description: "`github` or `slack`." }),
    },
    {
      additionalProperties: false,
      description: "Install a project-level integration (project admin).",
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("connector"),
      provider: Type.String({
        description: "The catalog template, e.g. `google_workspace`.",
      }),
    },
    {
      additionalProperties: false,
      description:
        "An admin adds the project's connector: its OAuth client (project admin).",
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("connection"),
      provider: Type.String({
        description:
          "The connector's slug or provider, e.g. `google_workspace`.",
      }),
    },
    {
      additionalProperties: false,
      description: "The person connects their own account.",
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("sso"),
      provider: Type.String({ description: "`google` or `entra`." }),
    },
    {
      additionalProperties: false,
      description:
        "An organization admin sets up sign-in to Introspection with this provider.",
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("binding"),
      runtime: Type.String({ description: "The Runtime's slug." }),
      name: Type.String({
        description: "The MCP server id the Recipe declares.",
      }),
      environment: Type.Optional(
        Type.String({
          description: "`development`, `staging` or `production`.",
        }),
      ),
    },
    {
      additionalProperties: false,
      description: "Connect one of a Runtime's MCP servers.",
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("runtime"),
      runtime: Type.String({ description: "The Runtime's slug." }),
    },
    { additionalProperties: false, description: "Show a Runtime's page." },
  ),
  Type.Object(
    {
      kind: Type.Literal("task"),
      task: Type.String({ description: "The task's id." }),
    },
    { additionalProperties: false, description: "Show a task's chat." },
  ),
]);

const parameters = Type.Object(
  {
    target,
    reason: Type.String({
      description:
        'One line the person reads on the card, e.g. "So I can open pull requests on your repository".',
    }),
    wait: Type.Optional(
      Type.Boolean({
        description:
          "Pause until the person is done and continue with what they did. Default false: open it and carry on.",
      }),
    ),
  },
  { additionalProperties: false },
);

const description = [
  "Ask the person to open an Introspection page: install an integration (GitHub, Slack), add a connector, connect their own account, set up sign-in, connect a Runtime's MCP server, or look at a Runtime or task.",
  "Name the target; never write a link yourself. With wait: true the conversation pauses until they finish, and the result is `Answer: connected`, `Answer: returned` (for a page), `Answer: failed: <reason>`, or a decline.",
  "The answer is what the person did, not proof: after `connected`, read the real state with the CLI (`introspection integrations list`, `introspection connectors connections list`, `introspection bindings mcp list`) before saying it is connected.",
  "Call it on its own in a turn, not beside a question, so the person does one thing at a time.",
].join("\n");

/** The CLI command that runs a target's loopback, or null when the CLI has none. */
export function introspectionOpenCliArgs(
  target: IntrospectionOpenTarget,
  wait: boolean,
): string[] | null {
  const waitFlag = wait ? ["--wait"] : [];
  switch (target.kind) {
    case "connection":
      // `connectors authorize` always waits for the connection it opened.
      return wait
        ? ["connectors", "authorize", target.provider, "--subject", "user"]
        : null;
    case "integration":
      // The organization's integrations page installs every provider.
      return ["open", "--integrations", ...waitFlag];
    case "binding":
    case "runtime":
      return ["open", "--runtime", target.runtime, ...waitFlag];
    case "task":
      return ["open", "--task", target.task, ...waitFlag];
    case "connector":
    case "sso":
      return null;
  }
}

function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^error:\s*/i, "").trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

/** The CLI on PATH (or `INTROSPECTION_CLI`), its stdout discarded and the tail of stderr kept. */
function spawnCliRunner(env: NodeJS.ProcessEnv): CliRunner {
  const command = env.INTROSPECTION_CLI?.trim() || "introspection";
  return (args, signal) =>
    new Promise((resolve) => {
      let stderr = "";
      const child = spawn(command, [...args], {
        stdio: ["ignore", "ignore", "pipe"],
        env,
        windowsHide: true,
        ...(signal ? { signal } : {}),
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-4096);
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        resolve({
          code: null,
          stderr: error.message,
          ...(error.code === "ENOENT" ? { missing: true } : {}),
        });
      });
      child.once("close", (code) => resolve({ code, stderr }));
    });
}

/** Ask the person in a dialog, for a target the CLI can't wait on. */
async function askInDialog(
  target: IntrospectionOpenTarget,
  reason: string,
  ui: ExtensionUIContext,
  signal: AbortSignal | undefined,
): Promise<AskUserOutcome> {
  const done = "Done";
  const choice = await ui.select(
    `${reason}\n\n${introspectionOpenAction(target)} in the Introspection dashboard, then come back here.`,
    [done, "Not now"],
    { ...(signal ? { signal } : {}), timeout: INTROSPECTION_OPEN_TIMEOUT_MS },
  );
  return choice === done
    ? { type: "answered", answer: introspectionOpenDone(target) }
    : { type: "declined" };
}

async function runLoopback(
  target: IntrospectionOpenTarget,
  reason: string,
  ui: ExtensionUIContext,
  signal: AbortSignal | undefined,
  runCli: CliRunner,
): Promise<AskUserOutcome> {
  const args = introspectionOpenCliArgs(target, true);
  if (!args) return askInDialog(target, reason, ui, signal);
  ui.notify(
    `${reason}\n${introspectionOpenAction(target)} in the browser that just opened; the agent continues when you're done.`,
    "info",
  );
  const result = await runCli(args, signal);
  if (signal?.aborted) throw new Error("User interaction aborted");
  if (result.missing) return askInDialog(target, reason, ui, signal);
  if (result.code === 0) {
    return { type: "answered", answer: introspectionOpenDone(target) };
  }
  return {
    type: "answered",
    answer: introspectionOpenFailed(
      lastLine(result.stderr) || `exit code ${result.code ?? "unknown"}`,
    ),
  };
}

function textResult(text: string, target: IntrospectionOpenTarget) {
  return {
    content: [{ type: "text" as const, text }],
    details: { target, waited: false },
  };
}

/** Without `wait`: open the page where this host can, and carry on. */
async function openWithoutWaiting(
  target: IntrospectionOpenTarget,
  ctx: ExtensionContext,
  runCli: CliRunner,
  signal: AbortSignal | undefined,
) {
  const args = ctx.hasUI ? introspectionOpenCliArgs(target, false) : null;
  if (args) {
    const result = await runCli(args, signal);
    if (result.code === 0) {
      return textResult(
        `Opened it for the person (${introspectionOpenAction(target)}). Nothing paused: don't assume they did anything; check the state before relying on it.`,
        target,
      );
    }
  }
  return textResult(
    `Nothing was opened and nothing paused. Ask the person in your reply to ${introspectionOpenAction(target).toLowerCase()} in the Introspection dashboard, or call introspection_open again with wait: true so they can do it from here.`,
    target,
  );
}

export function createIntrospectionOpenTool(
  options: IntrospectionOpenToolOptions = {},
): ToolDefinition {
  const env = () => options.env ?? process.env;
  const tool: ToolDefinition<typeof parameters> = {
    name: INTROSPECTION_OPEN_TOOL_NAME,
    label: "Open in Introspection",
    description,
    promptSnippet:
      "Ask the person to connect something or open a page, and wait for them",
    promptGuidelines: [
      "When the person must connect an integration, a connector or their own account, or look at a Runtime or task, use introspection_open with wait: true instead of writing a link.",
    ],
    parameters,
    // Interactions must not race other tools: a host pause would strand
    // half-finished parallel calls.
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const parsed = parseIntrospectionOpenTarget(params.target);
      if (!parsed) {
        throw new Error(
          "introspection_open needs a target with its kind's fields filled in.",
        );
      }
      const reason = params.reason.trim() || introspectionOpenAction(parsed);
      const runCli = options.runCli ?? spawnCliRunner(env());
      if (params.wait !== true) {
        return openWithoutWaiting(parsed, ctx, runCli, signal);
      }
      const result = await askUser(
        {
          reason: ASK_USER_REASON_INPUT_REQUIRED,
          message: reason,
          metadata: {
            kind: INTROSPECTION_OPEN_TOOL_NAME,
            target: parsed,
            action: introspectionOpenAction(parsed),
          },
          display: {
            kind: INTROSPECTION_OPEN_TOOL_NAME,
            title: introspectionOpenAction(parsed),
            body: reason,
          },
          expiresAt: new Date(
            Date.now() + INTROSPECTION_OPEN_TIMEOUT_MS,
          ).toISOString(),
        },
        {
          toolCallId,
          ctx,
          signal,
          timeoutMs: INTROSPECTION_OPEN_TIMEOUT_MS,
          env: env(),
          interactive: (ui) => runLoopback(parsed, reason, ui, signal, runCli),
        },
      );
      return {
        content: result.content,
        details: { ...result.details, target: parsed, waited: true },
      };
    },
  };
  return tool as unknown as ToolDefinition;
}

/**
 * An extension factory registering the built-in tool, unless a Recipe or host
 * extension already registered one by this name. Callers add it only when the
 * agent lists `introspection_open` in `tools`, after the Recipe's own extensions.
 */
export function introspectionOpenExtension(
  registrations?: RecipeExtensionRegistrationRegistry,
  env?: NodeJS.ProcessEnv,
): ExtensionFactory {
  return (pi) => {
    if (registrations?.owner("tool", INTROSPECTION_OPEN_TOOL_NAME)) return;
    registrations?.claim("tool", INTROSPECTION_OPEN_TOOL_NAME, BUILTIN_OWNER);
    pi.registerTool(createIntrospectionOpenTool(env ? { env } : {}));
  };
}

/** Whether the agent opted into the built-in tool. */
export function wantsIntrospectionOpen(agentTools: readonly string[]): boolean {
  return agentTools.includes(INTROSPECTION_OPEN_TOOL_NAME);
}
