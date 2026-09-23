# Agent Composition

A recipe separates behavior into package-wide context and agent-specific
configuration. Use that separation to share one operating model across a team
of agents without making every agent identical.

## The Three Layers

| Layer | Scope | Use it for |
| --- | --- | --- |
| `package.json#pi` | Entire Recipe package | Declaring agents, the executable extension closure, skills, prompts, and MCP servers |
| `SYSTEM.md` | Every root and delegated agent in the recipe | Shared mission, terminology, policies, and workflow rules |
| `agents/*.yaml` | One selected agent | Model, tools, selected skills, visible subagents, MCP policy, and role-specific instructions |

`SYSTEM.md` is the shared recipe instruction layer. A root agent and every
delegated subagent start from the same recipe-level content. Put instructions
there when they should remain true regardless of which agent is selected.

Each agent's `system_instructions` specializes that shared layer:

```yaml
system_instructions:
  mode: append
  content: |
    Review the evidence and return a release recommendation.
```

- `append` adds the agent-specific content after the shared recipe prompt.
- `replace` intentionally replaces the current prompt, including `SYSTEM.md`.

When a Recipe has no `SYSTEM.md`, Pi's normal base prompt is the starting
prompt. When `SYSTEM.md` exists, it becomes the recipe-wide starting prompt.
Recipes then applies the selected agent's `system_instructions` mode. On
`pi --recipe`, Recipes appends Pi's skills prompt after that composed prompt
when the agent has model-invocable skills and a `read` or `bash` tool. The
appended text is Pi's `formatSkillsForPrompt` output, wrapped in `<skills>`.

## Derive Agents With `from:`

Use `from:` to derive a named agent from another agent in the same recipe. This
is useful for model variants, constrained roles, and subagents that share most
of a base configuration.

```yaml
# agents/agent.yaml
name: agent
description: Main release coordinator
ai:
  model: anthropic/claude-sonnet-4-6
  thinking_level: medium
tools: [read, bash]
skills: [release-policy]
subagents: [reviewer]
system_instructions:
  mode: append
  content: Coordinate the complete release decision.
```

```yaml
# agents/reviewer.yaml
name: reviewer
from: agent
ai:
  thinking_level: high
tools: [read]
subagents: []
system_instructions:
  mode: append
  content: Independently review the evidence. Do not make changes.
```

The derived agent inherits the base model name and selected skill, overrides
the thinking level and tool allowlist, clears its visible subagents, and uses
its own specialized instructions. Both agents still receive `SYSTEM.md`.

`from:` chains may contain multiple levels. The referenced name must resolve to
another agent in the same recipe. Missing bases and cycles are validation
errors. References resolve only against explicit agent `name` values; filenames
never become agent identities or aliases.

Inheritance and delegation are separate. `from: reviewer-base` inherits a
definition; it does not expose the derived agent for delegation. A root agent
must still name that agent in its `subagents` list.

## Inheritance Rules

Omission means "inherit" for a derived agent. Declaring a field means
"override or merge" according to its type.

| Field | Derived-agent behavior |
| --- | --- |
| `description` | Child value replaces the base; omission inherits it |
| `ai` | Merges by key when `model` is omitted; declaring `ai.model` starts a fresh AI configuration |
| `session` | Merges by key; nested settings objects merge recursively |
| `tools` | Child array replaces the inherited allowlist; `[]` clears it |
| `skills` | Child array replaces the inherited selection; `[]` clears it |
| `subagents` | Child array replaces inherited visibility; `[]` clears it |
| `mcp` | Omission inherits; a declared block replaces the complete inherited policy |
| `system_instructions` | Omission inherits; `append` composes after inherited instructions; `replace` replaces the complete inherited prompt |

Agent instruction blocks compose in inheritance order. A child's `append`
content follows its inherited agent instructions. A child's `replace` discards
both inherited agent instructions and the recipe or Pi base prompt. Put
package-wide invariants in `SYSTEM.md`; use `replace` only for an intentionally
standalone prompt.

Arrays never merge item by item. This makes capability boundaries reviewable:
a derived agent that declares `tools: [read]` receives only `read`, not the
base agent's other tools.

AI settings merge only while the child omits `ai.model`. Declaring
`ai.model` starts a fresh AI configuration, even when restating the same
identity, so
provider routing, headers, retries, cache policy, and transport tuning cannot
silently cross model boundaries.

For structured MCP configuration, the entire child block is an authorization
boundary. Restate every server and selector the child may use. `mcp: { servers:
{} }` clears inherited MCP access, and an omitted `mcp` block inherits it.
Each resolved root or child agent may select its own mode; each live session
receives only that selected agent's MCP policy.

## AI and Session Configuration

The `ai` block selects the model and carries request/provider configuration.
The `session` block controls portable Pi session behavior. Set only what a case
needs.

```yaml
ai:
  model: anthropic/claude-sonnet-4-6
  thinking_level: medium
  options:
    temperature: 0.2
    max_tokens: 4096
    cache_retention: short
    timeout_ms: 60000
  providers:
    anthropic:
      betas: [context-1m]
      context_management: {}
    openrouter:
      routing:                  # forwarded opaquely to OpenRouter
        order: [anthropic]
        only: [anthropic]
        allow_fallbacks: true
    vercel_ai_gateway:
      routing:                  # providerOptions.gateway on Vercel requests
        order: [anthropic, bedrock]
        only: [anthropic, bedrock]
session:
  steering_mode: one-at-a-time
  follow_up_mode: one-at-a-time
  tool_execution: parallel
  retry:
    enabled: true
    max_retries: 2
```

`ai.options` accepts current and future portable Pi `streamSimple` request
options using snake_case; Recipes converts only the option names to Pi
camelCase. Provider-adapter-only options are not implied by this block. Its safe
outer envelope is validated, while explicit provider maps and nested payloads
remain opaque except for credential and runtime-binding controls. All AI
settings except the fully resolved model are optional and merge by key along a
`from:` chain until a child explicitly declares `ai.model`.

The former `model:` block remains readable for existing Recipes. New Recipes
should use `ai:`; mixing both blocks in one agent is a validation error.

`session` covers the managed runtime's portable model-independent policy:
steering and follow-up queues, tool execution, retry (including provider
retry), compaction, and image handling. Pi settings for UI presentation, shell
and filesystem authority, package loading, persistence, networking, analytics,
telemetry, and model defaults remain host-owned or belong under `ai`.
Unlike transparent AI payloads, every nested `session` key, type, enum, and
numeric range is checked by the Recipe validator. Interactive tree navigation
and branch summaries are not part of the managed runtime contract.

## Resources and Capabilities

The manifest declares the package's executable closure and resource inventory;
the selected agent narrows model-visible capability:

- `package.json#pi.skills` declares physical skill resources. `agent.skills`
  selects the skill names Pi discovers for that agent.
- `package.json#pi.extensions` declares the executable closure resolved
  deterministically and loaded for every root and child session.
- `package.json#pi.mcp` defines the package's upper-bound MCP policy.
  `agent.mcp` narrows tool access per server.
- `agent.tools` is the exact allowlist for Pi built-ins and tools registered by
  the package extension closure.
- `agent.subagents` controls which other recipe agents are visible through the
  `agent` tool.
- Prompt templates declared by the package are recipe resources; they are not
  specialized through `from:`.

The `agent` delegation tool is not authored in `tools`. The host adds it only
to root sessions with visible subagents; delegated children remain one level
deep.

Skill and subagent selection controls prompt exposure and active capability,
not filesystem isolation. All agents run in the same Recipe package and current
workspace. Use sandboxing and external authorization for security boundaries.

## Root Agents and Subagents

An agent selected with `--agent` is a root agent. If its effective `subagents`
list is non-empty, Recipes enables the `agent` tool and exposes only those
named agents.

A delegated subagent resolves its own complete effective definition:

1. follow its `from:` chain;
2. apply its model, tools, skills, MCP, and instruction overrides;
3. start from the same recipe `SYSTEM.md` as the root agent; and
4. append or replace with its effective `system_instructions`.

Delegation is one level deep. A definition may expose subagents when selected
directly as a root agent, but the same definition does not receive the `agent`
tool while running as a delegated child.

## Recommended Structure

- Put shared identity, policies, terminology, and workflow invariants in
  `SYSTEM.md`.
- Put role-specific duties and response contracts in the relevant agent's
  `system_instructions`.
- Put reusable detailed judgment in skills and select only the skills each
  agent needs.
- Use `from:` for real variants, not merely to avoid a few repeated lines.
- Declare narrow tool, MCP, and subagent lists at the point where a
  role's capability boundary changes.
- Run `introspection check` after changing inheritance, then prove each important
  root agent and delegated path in a fresh Pi session.
