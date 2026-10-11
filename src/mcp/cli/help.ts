export function mcpCliHelpText(): string {
  return [
    "mcp - use available MCP tools",
    "Supported: search, list, call, and run.",
    "Run `mcp <command> --help` for complete command syntax.",
    "Use this session-local `mcp` command, not `mcporter` or `npx mcporter`; it enforces the materialized recipe capabilities.",
    "",
    "Flow:",
    "  mcp search \"what you need\"                Matches with their full input and output contracts.",
    "  mcp call <server>.<tool> --json '{...}'  One call.",
    "  mcp run <<'JS' ... JS                     Two or more calls, in one script.",
    "  Metadata is compact text; actual structured tool results are JSON.",
    "",
    "Batch or compose multiple calls in JavaScript:",
    "  mcp run <<'JS'",
    '  const ids = ["id-1", "id-2", "id-3"]',
    '  const settled = await Promise.allSettled(ids.map(id => tools["server"]["tool"]({ id })))',
    "  console.log(JSON.stringify(Object.fromEntries(settled.map((s, i) => [ids[i], s.status === \"fulfilled\" ? s.value : { error: String(s.reason) }])), null, 2))",
    "  JS",
    "  Keep the heredoc quoted (<<'JS'). Never chain mcp call in the shell; one script prints one JSON value.",
    "  When a tool declares no output contract and you have not seen its result, print that result whole and read its fields in the next command.",
    "",
    "Notes:",
    "  mcp list <server> --schema shows every tool on one server; mcp list browses the inventory.",
    "  Run `mcp call --help` or `mcp run --help` for advanced argument, output, and workflow options.",
    "  Tool commands are always headless. If authentication is required, ask the user to authenticate the MCP connection outside the agent session, then retry.",
    "",
    "Availability:",
    "  Search and list expose only tools callable in this session.",
    "  Only exact tool names returned by mcp list are callable.",
    "  Descriptions may mention related tools that are not exposed; mentions do not grant access.",
    "  If no listed tool supports an action, report that the connected capability is unavailable.",
    "  MCP resources and administrative or ad-hoc connection commands are not exposed.",
  ].join("\n");
}

export function mcpListHelpText(): string {
  return [
    "Usage: mcp list [server | server.tool] [flags]",
    "",
    "Shows a compact view of tools materialized in this recipe session.",
    "",
    "Flags:",
    "  --all-parameters          Include every optional parameter.",
    "  --schema                  Show the input/output contract of one tool, or of every tool on a server.",
    "  --verbose                 Include full tool and parameter descriptions.",
    "  --status                  Show concise status for an exact server target.",
    "  --quiet, --exit-code      Health checks for an exact server target.",
    "  --timeout <ms>            Override discovery timeout for an exact target.",
    "  JSON is reserved for actual tool results; metadata is compact text.",
    "",
    "URLs, ad-hoc transports, config overrides, and persistence are unavailable in recipe sessions.",
  ].join("\n");
}

export function mcpCallHelpText(): string {
  return [
    "Usage: mcp call <server>.<tool> [arguments] [flags]",
    "",
    "Calls exact tools materialized in this recipe session.",
    "",
    "Arguments:",
    "  key=value                 Named arguments with schema-aware coercion.",
    "  key=@path                 Read an exact UTF-8 string; use @@ for a literal @.",
    "  --json <json|->           Supply a structured JSON object directly or from stdin.",
    '  Array example: mcp call server.tool --json \'{"tags":["a","b"]}\'.',
    "  Quote argument tokens containing shell operators such as |, <, >, &, or ;. JSON stdin avoids nested shell quoting.",
    "",
    "Output/runtime flags:",
    "  --output text|markdown|json|raw",
    "  --timeout <ms>",
    "  Machine-readable output is forwarded unchanged.",
    "  When parsing JSON, keep stderr separate and do not truncate stdout with head or sed.",
    "",
    "URLs, ad-hoc transports, config overrides, and persistence are unavailable in recipe sessions.",
  ].join("\n");
}

export function mcpSearchHelpText(): string {
  return [
    'Usage: mcp search "what you need" [--limit N] [--regex]',
    "",
    "Searches only MCP tools available in this session.",
    "Each match shows its full contract: description, input, output, and a call example.",
    "Call a match directly; no separate schema lookup is needed. Default limit is 5.",
    "Try broader or alternate terms when no result matches.",
  ].join("\n");
}

export function mcpRunHelpText(): string {
  return [
    "Usage: mcp run [--var KEY=value] [--json-errors] [file]",
    "",
    'Runs a short JavaScript workflow with available MCP tools such as `tools["server"]["tool"]`.',
    "With no file, code is read from stdin. Keep heredocs quoted and pass dynamic values with --var.",
    "Scripts are killed after 120s by default (override with PI_RECIPES_MCP_RUN_TIMEOUT_MS).",
    "Each tool call is capped at 60s; workflows allow at most 100 calls and run 16 at a time by default.",
    "Extra calls wait in a FIFO queue and inherit the remaining workflow deadline.",
    "Always await or return tool-call chains.",
    "Detached .then/.catch calls fail if still pending when the script exits.",
    "Structured MCP errors retain code, retryable, action, request_id, and outcome fields when supplied.",
    "Calls return decoded JSON by default, so read response fields directly from the awaited value.",
    "Only when a tool documents another response type, call the format on the tool itself: tool.text(args), tool.markdown(args), tool.images(args), tool.content(args), tool.structuredContent(args), or tool.raw(args).",
    "Use Promise.allSettled for independent reads, so one failed call keeps the others' results. Await dependent calls and mutations in order.",
    "Do not loop over or chain mcp call in the shell. Print one JSON value, keyed by call.",
    "When a tool declares no output contract and you have not seen its result, print that result whole; read its fields in the next run.",
    "A refused connection handshake (HTTP 5xx before the call starts) is retried automatically; any other failure is reported, since the call may have run.",
    "Use --var/vars for dynamic input; process.argv is intentionally unavailable inside workflows.",
    "--json-errors emits a structured error object on stderr while preserving the nonzero exit code.",
    "MCP calls are always headless. If authentication is required, ask the user to authenticate the connection outside the agent session, then retry.",
    "A synchronous busy-loop is force-killed at the deadline.",
    "Code runs with the same OS privileges as the active shell sandbox; mcp run is not a separate security boundary.",
    "",
    "Example — batch or compose multiple calls:",
    "  mcp run <<'JS'",
    '  const ids = ["id-1", "id-2", "id-3"]',
    '  const settled = await Promise.allSettled(ids.map(id => tools["server"]["tool"]({ id })))',
    "  console.log(JSON.stringify(Object.fromEntries(settled.map((s, i) => [ids[i], s.status === \"fulfilled\" ? s.value : { error: String(s.reason) }])), null, 2))",
    "  JS",
  ].join("\n");
}
