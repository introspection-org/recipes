import {
  mcpSessionAllowsTool,
  type McpSessionConfig,
  type McpSessionServer,
} from "../../mcp.js";

export interface McpCliSessionPolicy {
  servers: Map<string, McpSessionServer>;
}

export interface ValidatedMcpCliCommand {
  args: string[];
}

export type McpCliPolicyResult =
  | { command: ValidatedMcpCliCommand; error?: undefined }
  | { command?: undefined; error: string };

const FORBIDDEN_DELEGATED_FLAGS = new Set([
  "--config",
  "--root",
  "--log-level",
  "--http-url",
  "--sse",
  "--stdio",
  "--stdio-bin",
  "--stdio-arg",
  "--header",
  "--env",
  "--cwd",
  "--name",
  "--description",
  "--persist",
  "--allow-http",
  "--insecure",
  "--yes",
  "--server",
  "--tool",
  "--tail-log",
  "--brief",
  "--signatures",
  "--no-oauth",
  "--oauth-timeout",
  "--raw-strings",
  "--no-coerce",
]);

const LIST_OUTPUT_MODES = new Map([
  ["--schema", "schema"],
  ["--all-parameters", "all-parameters"],
  ["--status", "status"],
]);

function flagName(value: string): string {
  const equals = value.indexOf("=");
  return equals === -1 ? value : value.slice(0, equals);
}

function toolSelector(value: string): { server: string; tool: string } | null {
  const ref = value.trim();
  if (/[()]/.test(ref)) return null;
  const dot = ref.indexOf(".");
  if (dot < 1 || dot === ref.length - 1) return null;
  return { server: ref.slice(0, dot), tool: ref.slice(dot + 1) };
}

function withNoOAuth(args: readonly string[]): string[] {
  const literalSeparator = args.indexOf("--");
  if (literalSeparator === -1) return [...args, "--no-oauth"];
  return [
    ...args.slice(0, literalSeparator),
    "--no-oauth",
    ...args.slice(literalSeparator),
  ];
}

function forbiddenFlag(args: readonly string[]): string | undefined {
  const literalSeparator = args.indexOf("--");
  const options = literalSeparator === -1 ? args : args.slice(0, literalSeparator);
  return options.map(flagName).find((flag) => FORBIDDEN_DELEGATED_FLAGS.has(flag));
}

function listOutputModeError(args: readonly string[]): string | undefined {
  const literalSeparator = args.indexOf("--");
  const options = literalSeparator === -1 ? args : args.slice(0, literalSeparator);
  const modes = new Set(
    options
      .map((arg) => LIST_OUTPUT_MODES.get(flagName(arg)))
      .filter((mode): mode is string => Boolean(mode))
  );
  return modes.size > 1
    ? "mcp list accepts only one output mode: --schema, --all-parameters, or --status."
    : undefined;
}

function closestName(input: string, candidates: Iterable<string>): string | undefined {
  const normalize = (value: string) => value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const source = normalize(input);
  const distance = (left: string, right: string): number => {
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= right.length; j += 1) {
        current[j] = Math.min(
          current[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
        );
      }
      previous = current;
    }
    return previous[right.length];
  };
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const candidateDistance = distance(source, normalize(candidate));
    if (candidateDistance < bestDistance) {
      best = candidate;
      bestDistance = candidateDistance;
    }
  }
  if (!best) return undefined;
  const baseline = Math.max(source.length, normalize(best).length, 1);
  return bestDistance <= Math.max(2, Math.floor(baseline / 3)) ? best : undefined;
}

function validateExactTarget(
  policy: McpCliSessionPolicy,
  server: string,
  tool?: string
): string | null {
  const configured = policy.servers.get(server);
  if (!configured) {
    const available = [...policy.servers.keys()];
    const suggestion = closestName(server, available);
    return available.length > 0
      ? `MCP server '${server}' is not available in this session.${suggestion ? ` Did you mean '${suggestion}'?` : ""} Available servers: ${available.join(", ")}.`
      : `MCP server '${server}' is not available in this session. No MCP servers are configured.`;
  }
  if (tool !== undefined && !mcpSessionAllowsTool(configured, tool)) {
    const known = configured.catalog?.map((entry) => entry.name) ?? [];
    const suggestion = closestName(tool, known);
    return `Tool '${tool}' is not available on server '${server}' in this session.${suggestion ? ` Did you mean '${suggestion}'?` : ""} Run \`mcp list ${server}\` to inspect the callable tools.`;
  }
  return null;
}

function validateList(
  args: string[],
  policy: McpCliSessionPolicy
): McpCliPolicyResult {
  const blocked = forbiddenFlag(args.slice(1));
  if (blocked) return { error: `mcp list option '${blocked}' is unavailable in recipe sessions.` };
  const outputModeError = listOutputModeError(args.slice(1));
  if (outputModeError) return { error: outputModeError };
  const adHocTarget = args
    .slice(1)
    .find((arg) => !arg.startsWith("-") && /^(?:https?:\/\/|[^/]+\/)/i.test(arg));
  if (adHocTarget) {
    return { error: "mcp list accepts only servers materialized for this recipe session; URLs and ad-hoc servers are unavailable." };
  }

  // mcporter's grammar places the optional target directly after `list`.
  // Do not parse or normalize any remaining arguments; mcporter owns them.
  const target = args[1] && !args[1].startsWith("-") ? args[1] : undefined;
  if (target !== undefined) {
    const selector = toolSelector(target);
    const server = selector?.server ?? target;
    const error = validateExactTarget(policy, server, selector?.tool);
    if (error) return { error };
  }
  return {
    command: {
      args: withNoOAuth(args),
    },
  };
}

// mcporter parses --args, --params and --json through one handler
// (dist/cli/call-arguments.js), so all three spellings reach the same place.
const CALL_FLAGS_WITH_VALUE = new Set([
  "--args",
  "--json",
  "--output",
  "--params",
  "--timeout",
]);

function callSyntaxError(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      return "mcp call positional arguments are unavailable; use key=value or --json instead.";
    }
    if (arg.startsWith("--")) {
      const flag = flagName(arg);
      if (!CALL_FLAGS_WITH_VALUE.has(flag)) {
        return `mcp call option '${flag}' is unavailable; use key=value or --json for tool arguments.`;
      }
      if (!arg.includes("=")) index += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_.-]*=/.test(arg)) continue;
    return `mcp call argument '${arg}' must use key=value syntax or be supplied through --json.`;
  }
  return undefined;
}

function validateCall(
  args: string[],
  policy: McpCliSessionPolicy
): McpCliPolicyResult {
  const rawSelector = args[1];
  const selector = rawSelector ? toolSelector(rawSelector) : null;
  if (!selector) {
    const splitTool = rawSelector ? args[2] : undefined;
    if (
      rawSelector &&
      splitTool &&
      policy.servers.has(rawSelector) &&
      mcpSessionAllowsTool(policy.servers.get(rawSelector)!, splitTool)
    ) {
      return {
        error:
          `mcp call requires a dotted tool selector. ` +
          `Use mcp call ${rawSelector}.${splitTool} key=value or --json for structured arguments.`,
      };
    }
    return {
      error:
        "mcp call requires an exact session tool selector: mcp call <server>.<tool> key=value ...",
    };
  }
  if (/^(?:https?:\/\/|[^/]+\/)/i.test(selector.server)) {
    return { error: "mcp call accepts only tools materialized for this recipe session; URLs and ad-hoc servers are unavailable." };
  }
  const targetError = validateExactTarget(policy, selector.server, selector.tool);
  if (targetError) return { error: targetError };
  const blocked = forbiddenFlag(args.slice(2));
  if (blocked) return { error: `mcp call option '${blocked}' is unavailable in recipe sessions.` };
  const syntaxError = callSyntaxError(args.slice(2));
  if (syntaxError) return { error: syntaxError };

  return {
    command: {
      args: withNoOAuth(args),
    },
  };
}

export function createMcpCliSessionPolicy(
  session: McpSessionConfig
): McpCliSessionPolicy {
  return {
    servers: new Map(
      session.servers.map((server) => [server.id, server])
    ),
  };
}

export function validateDelegatedMcpCommand(
  args: string[],
  policy: McpCliSessionPolicy
): McpCliPolicyResult {
  if (args[0] === "list") return validateList(args, policy);
  if (args[0] === "call") return validateCall(args, policy);
  return {
    error:
      args[0] === "auth"
        ? "Interactive authentication is unavailable in the agent MCP CLI. Ask the user to authenticate this MCP connection outside the agent session, then retry."
        : `mcp command '${args[0] ?? ""}' is unavailable in recipe sessions. Use mcp search, list, call, or run.`,
  };
}
