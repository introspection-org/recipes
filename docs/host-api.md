# Host API

The Recipes Host API turns Recipe source into a complete live Pi agent. It
defines the boundary between the portable agent and the system operating it.

## API layers

```text
resolveRecipe()     parse every agent in the portable package once
    │
    ▼
createAgentSession() select one agent and construct its Pi session
```

Every host resolves the Recipe once and passes that immutable graph to the
single session constructor:

```ts
import { resolveRecipe } from "@introspection-ai/recipes/recipe";
import {
  createAgentSession,
} from "@introspection-ai/recipes/session";

const recipe = resolveRecipe({ recipeDir });
const agent = recipe.selectAgent(agentName);
const credentials = await credentialsFor(agent.modelSpec);

const handle = await createAgentSession({
  recipe,
  agentName,
  cwd: workspaceDir,
  credentials,
});
```

This keeps inspection and construction on the same resolution results and
avoids reparsing the package for every root or child session.

`inspectRecipe(recipe)` projects the exact immutable graph used for execution;
it never reparses the package or reads host-local bindings. In addition to
provider, credential, MCP, and resource summaries,
it returns:

- effective model and prompt provenance;
- fields declared at each point in the `from:` chain;
- authored tools versus root and delegated-session tools;
- selected skills, visible subagents, and MCP policy;
- the ordered package extension and prompt closure.

## `createAgentSession`

`createAgentSession(options)` is the only session-construction API. It consumes
the exact `ResolvedRecipe` the host inspected, selects `agentName`, and uses
that same graph for every default in-process child session.

```ts
const handle = await createAgentSession({
  recipe,
  agentName,
  cwd: workspaceDir,
  credentials,
  modelOverride,
  mcpBindings,
  eventBus,
  customTools,
  extensionFactories,
  runController,
  agentToolOptions,
  settingsManager,
  sessionManager,
  additionalSkillPaths,
  materializedSkillPaths,
  memory: {
    indexPath: "/workspace/memories/MEMORY.md",
  },
  memoryOverride,
  transformSystemPrompt,
  onDiagnostics,
  onEvent,
  onAgentRunEvent,
  otel: {
    tracer,
    meter,
    meta: { conversationId },
    runSpans: false,
    getParentContext: () => currentTurnContext,
  },
});
```

It:

- selects the agent from the supplied immutable Recipe;
- resolves model credentials fail-closed;
- materializes required MCP bindings fail-closed;
- loads the complete ordered Recipe extension closure, selected skills, and
  package prompts;
- registers the shared subagent tool;
- creates and binds the Pi `AgentSession`;
- returns one idempotent `dispose()` boundary.

The returned `RecipeSessionHandle` exposes:

- `session` — Pi prompt, steer, follow-up, abort, messages, and events;
- `agent` — the selected resolved portable definition;
- `agentRuns` — the subagent run controller;
- `dispose()` — child, session, instrumentation, and MCP cleanup.

Host injection is intentional. A managed host can supply durable session state,
cross-process subagent execution, inline endpoint bindings, platform
extensions, its own settings, an event bus, host tools, and a
gateway-decorated model without reimplementing Recipe semantics. The Recipe
continues to own model configuration and tool selection; host seams replace
transport and materialized resources, not the portable definition.

### Persistent memory context

Hosts can provide one durable memory index through `memory`. Recipes loads the
index once during session construction and bounds the injected index content to
200 lines and 25,000 UTF-8 bytes after XML escaping by default. Missing and
empty indexes render nothing. The host owns the directory, persistence, and
identity scope; Recipes assumes no filesystem layout.

The index should stay concise and can link to focused files in its directory.
Recipes injects it without adding usage or precedence instructions.

`memoryOverride` follows Pi's resource override pattern. It can replace, filter,
or disable the loaded index before rendering. The exported `loadMemoryIndex`
and `formatMemoryForPrompt` helpers let custom hosts use the same primitives.
Recipe-specific memory behavior belongs in `SYSTEM.md` or agent
`system_instructions`, while the host binds the actual memory resource.

The default in-process subagent controller uses that same Recipe snapshot for
every child, so no session reparses the package or observes a different source
snapshot. Injected controllers own child selection and execution after the root
session is constructed.

`onEvent` observes the root Pi session. `onAgentRunEvent` observes each event
from the default in-process children as an `AgentRunEvent` envelope containing
the run id, parent id, agent identity, depth, and canonical Pi event. Hosts can
merge the two streams without copying root events. An injected `runController`
owns its own observation contract and does not trigger this callback.

The Pi extension records those same envelopes as non-context custom entries,
so Pi's session and JSON event surfaces preserve child runs through their
normal event machinery. Embedded hosts receive the observer directly and do
not need Pi entry transport.

An injected `runController` is owned by the returned session handle.
`dispose()` calls the controller's `shutdown()` exactly once; controller
implementations use it to release all live child sessions and controller-level
resources. `close(id)` remains the lifecycle operation for one run.

Recipes are trusted application code, not untrusted data. A package can contain
TypeScript extensions that execute in the Pi process with that process's
filesystem, environment, and network authority. Hosts accepting third-party
Recipes must provide their own review, sandbox, and tenant-isolation boundary
before session construction.

`${VAR}` resolution and the session environment come from `env`, defaulting to
`process.env`. Set `RECIPES_CURRENT_TIME` to an ISO 8601 UTC timestamp to freeze
the `current-time` tool for local launchers and evals.

In CLI mode, default MCP provisioning leases the supplied `env` object until
the handle is disposed and restores its prior MCP/PATH state afterward.
Concurrent CLI sessions must receive separate environment objects. Tools mode
uses an isolated session environment and does not expose its MCP runtime to
shell tools. A host that provisions MCP separately passes
`mcpProvisioning: "host"` to each session.

## Inspection

```ts
import { inspectRecipe } from "@introspection-ai/recipes/inspect";

const requirements = inspectRecipe(recipe);
```

Inspection derives agents, providers, expected credential variables, required
and optional MCP servers, and resource counts without creating a session.
Concrete binding files remain host state and are intentionally excluded.

## Pi prompt templates

Recipe prompt templates are ordinary Pi prompt templates. No Recipes-specific
invocation API is added:

```ts
const names = handle.session.promptTemplates.map((template) => template.name);
await handle.session.prompt("/review src/auth.ts");
```

Pi expands the slash command and its arguments through the standard
`AgentSession.prompt()` behavior.

## OpenTelemetry

Pass a tracer through `otel` to attach the JS SDK's OpenTelemetry GenAI
semantic-convention instrumentation to the session. Recipes derives default
agent identity from the resolved package and generates a conversation id when
the host does not provide one. The default in-process subagent controller
inherits that conversation id while each child derives its own Recipe agent
identity. Injected run controllers own their child-session instrumentation.

Recipes does not create or register an OTel provider, processor, exporter, or
global context manager. The host owns that pipeline and its content policy, so
the same session instrumentation works with any OTLP-compatible backend. A
host that needs structure-only traces can wrap its exporter with
`GenAiContentScrubbingExporter` from `@introspection-sdk/introspection-pi`.

Hosts must flush and shut down their provider with the host lifecycle.

## Host conformance

```ts
import { hostConformanceCases } from "@introspection-ai/recipes/test-utils";

for (const testCase of hostConformanceCases(myHost)) {
  it(testCase.name, testCase.run);
}
```

Passing the suite means the host is using the same session construction
contract as Pi. Protocol behavior, persistence, tenancy, and
deployment remain host-specific and require their own tests.

## Deliberate non-features

The package does not provide:

- an HTTP server or wire protocol;
- a task database or task state machine;
- a scheduler or queue;
- sandbox or tenant isolation;
- a deployment CLI;
- provider-specific hosting integrations.

Those layers compose above `createAgentSession`.
