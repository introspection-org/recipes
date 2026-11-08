# Recipes documentation

**Recipes is the open format for vertical agents, built on Pi.**

A Recipe keeps the agent-owned layer together as inspectable source. Pi runs
the agent; a compatible host supplies credentials, isolation, persistence,
task lifecycle, protocols, and deployment.

**Audience: developers.** These pages are for people building Recipes and
hosts, and the coding agents helping them. Guidance for the model running
inside a Recipe is a skill, in `skills/`, which the host offers to the agent
at run time.

## Start here

| Goal | Document |
| --- | --- |
| Create, validate, and run a Recipe | [Recipe workflow](recipe-flow.md) |
| Understand the portable artifact contract | [Recipe Format](recipe-format.md) |
| Run a Recipe in your host | [Host API](host-api.md) |
| Run a Recipe in Pi | [Pi extension](pi-extension.md) |
| Compose agents and subagents | [Agent composition](agent-composition.md) |
| Ask for user input across hosts | [Interactions](interactions.md) |
| Declare capability policy and bindings | [MCP configuration](mcp-configuration.md) |
| Answer a chat message from a Recipe | [Channel tools](channels/README.md) |
| Add Slack tools to a Recipe | [Slack channel connector](channels/slack.md) |
| Read and mark up Word and PDF files from a Recipe | [Document tools](documents/README.md) |
| Work with a person's mail, calendar and files | [Productivity tools](productivity/README.md) |
| Search the web from a Recipe | [Web search](search/README.md) |
| Track work in Linear, Jira or Introspection | [Issues tool](issues/README.md) |
| Bring a provider for search, productivity or issues | [Provider modules](providers.md) |
| Define portable evaluation judges | [Recipe judges](recipe-judges.md) |

## Boundary

```text
Recipe source
    │
    ▼
resolveRecipe()          format interpretation
    │
    ▼
createAgentSession()     complete live Pi agent
    │
    └── host              tasks, persistence, auth, protocols, deployment
```

Recipes stops at the live session boundary. It does not ship a generic server,
task store, scheduler, sandbox, or provider-specific hosting integration.

The same contracts power:

- the Pi terminal harness through the Recipes extension;
- Node.js hosts through `createAgentSession()`.

Every host can run the exported conformance suite against its integration.
