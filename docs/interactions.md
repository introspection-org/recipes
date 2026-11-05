# Recipe Interactions

`@introspection-ai/recipes/interactions` gives Recipe tools one contract for
asking the user a question or requesting approval that works on every Pi host:
the local TUI, RPC-driven UIs, headless runs, and hosts that stream tool
results to a remote frontend and can pause/resume a run.

Most Recipes need only the built-in `ask_user_question` tool: list it in an
agent's `tools` (see below). The module itself registers no tools. A Recipe
that needs its own interaction tool — its own name, schema, and prompt — calls
`askUserQuestion()` or `askUserApproval()` from the tool's `execute()`. Those
helpers build the `details.interrupt` request, local Pi dialog copy, and host
metadata. Use raw `askUser()` only when a tool needs a lower-level interaction
shape.

## The built-in `ask_user_question` tool

List `ask_user_question` in an agent's `tools` and the host registers it for
that agent; agents that do not list it never see it.

```yaml
name: agent
ai:
  model: <provider>/<model>  # one Pi has credentials for: pi --list-models
tools: [read, bash, ask_user_question]
```

Its inputs mirror Claude Code's `AskUserQuestion`, so models use it without
extra prompting:

```ts
ask_user_question({
  questions: [            // 1 to 4
    {
      question: string,   // the full question, ending in "?"
      header: string,     // short label, at most 12 characters
      options: [          // 2 to 4
        { label: string, description?: string }
      ],
      multiSelect?: boolean
    }
  ]
})
```

The model never adds an "Other" option: the user can always give their own
answer. The tool description carries the usage guidance (one decision per
question, short enough to read aloud, enough context that a bare option makes
sense, no options inside the question text, no "change it" option on
approvals, and prefer the tool over asking in plain text).

How each host renders it:

| Host | Rendering | Result the model sees |
| --- | --- | --- |
| Pi terminal (TUI) and RPC | One dialog per question, in order. Options are numbered (numbers the model put in labels are stripped), with descriptions after the label, and a last option, `Something else — I'll type it`, opens a text input. `multiSelect` uses the toggle list in the TUI and a toggle-then-`Done` selector over RPC. | One line per question, `<header>: <answer>` (several answers joined with `, `), and `details.questions` / `details.answers` with each answer. |
| Pause/resume host (`PI_INTERRUPT_RESUME`) | The tool returns the `details.interrupt` request from `askUserQuestion()` with bare option labels and their descriptions, `metadata.header` and `metadata.question`; the host renders its own option list and free-text answer. | The host's resume envelope, for example `Answer: Email link`. |
| Headless (`PI_ASK_USER_AUTO_APPROVE`) and child agents | Nothing is shown; every question declines. | `<header>: (no answer)` per question, then an instruction to proceed with best judgment. |
| No channel | Nothing is shown. | The unavailable envelope, telling the model to ask in its reply. |

The built-in tool reads `PI_INTERRUPT_RESUME` and `PI_ASK_USER_AUTO_APPROVE`
from the session's environment, the `env` passed to `createAgentSession()` or
`createRecipesExtension()`, and falls back to `process.env` when none is given.
A Recipe's own tool can do the same by passing `env` to the helpers.

A pause carries one interrupt per tool call, so on a pause/resume host the
schema asks for one question per call and the description tells the model to
make one call per question in the same turn; the host collects them into one
pause. A call that still carries several questions shows nothing and returns
text asking the model to split it.

If a Recipe extension registers its own `ask_user_question`, the host keeps
it and skips the built-in tool, so a Recipe can migrate at its own pace.

### Skills shared with other hosts

A skill that also runs in Claude Code or another host should not name one
host's tool as the only way to ask. Write, for example: "Ask with the host's
question tool (`ask_user_question` here, `AskUserQuestion` in Claude Code);
otherwise ask with numbered options in text."

## Writing your own interaction tool

```ts
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askUserQuestion } from "@introspection-ai/recipes/interactions";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "clarify",
    label: "Clarify",
    description: "Ask the user a clarifying question and wait for the answer.",
    parameters: Type.Object({
      question: Type.String(),
      options: Type.Optional(Type.Array(Type.String())),
      multiple: Type.Optional(Type.Boolean()),
    }),
    // Required: interaction tools must not run concurrently with other tools,
    // otherwise a host pause can strand half-finished parallel tool calls.
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return await askUserQuestion(
        {
          question: params.question,
          options: params.options,
          selection: params.multiple ? "multiple" : "single",
        },
        { toolCallId, ctx, signal }
      );
    },
  });
}
```

The helpers always return a finished tool result (`content` + `details`), so
the tool can return them directly. Pass the tool's own `signal` parameter —
not `ctx.signal` — so an aborted turn dismisses any open dialog.

## Channel resolution

The interaction helpers pick the best available channel, in order:

1. **`PI_ASK_USER_AUTO_APPROVE`** (env) — headless/CI runs: confirmations
   resolve `approved`, everything else resolves `declined`. Deterministic and
   never blocks.
2. **Interactive UI** (`ctx.hasUI`, TUI and RPC modes) — the built-in dialog
   walk: a themed toggle list for TUI multi-select questions, a portable
   selector loop for RPC multi-select questions, a select for single fixed
   options and approvals, and a text input otherwise.
   A caller-provided `interactive` walk replaces the dialogs (return
   `undefined` to fall through). In RPC mode dialogs get a default timeout
   (`DEFAULT_RPC_DIALOG_TIMEOUT_MS`, 120s) so a client that never renders
   them cannot wedge the session; a timed-out or dismissed dialog declines.
3. **Pause/resume host** (`PI_INTERRUPT_RESUME` env, set by the host) —
   the tool returns `Awaiting user response.` with a Recipes
   `details.interrupt` request whose outcome is `awaiting_user`. The host
   pauses the run, adapts the request to its own UI protocol, and later resumes
   the run by rewriting this tool result with the response envelope (below).
   Root sessions only. In-process child agents resolve interactions internally
   and never emit a pause request.
4. **Fallback** — the result states that nothing was shown to the user and
   directs the model to ask in its normal assistant reply. An unrendered
   question is never treated as declined.

## The interrupt request

Pi's native tool-result shape is `content` plus arbitrary structured
`details`. Recipes stores its interaction state at `details.interrupt`.
A host that supports pause/resume treats
`details.interrupt.outcome.type === "awaiting_user"` as a pause request.
Hosts generate their own pause state from this record.

| Field | Meaning |
| --- | --- |
| `reason` | Open string; well-known: `input_required`, `confirmation`, `tool_call` |
| `message` | Concise human-readable prompt |
| `options` | Optional structured answer suggestions: `{ label, value?, description? }[]` |
| `selection` | Optional answer cardinality: `single` (default) or `multiple` |
| `metadata` | Renderer or tool hints (`kind`, `header`, source tool parameters, …) |
| `display` | Optional structured display copy for richer local or remote UI |
| `expiresAt` | Optional ISO-8601 instant after which the host may auto-decline |
| `outcome` | Local result, or `{ type: "awaiting_user" }` when the host must pause |

Question options are suggestions, not a closed enum. Local Pi shows them in a
selector plus an `Other` input path. Multi-select TUI questions use Space or
number keys to toggle choices and a `Done` action to submit. Hosts should
preserve the same custom-answer path unless a specific tool explicitly does
something else.

Resume payloads are `{ answer }` for single-answer questions,
`{ answers: string[] }` for multi-select questions, and
`{ approved, feedback? }` for confirmations. A decline is a resume with
status `cancelled` and **no payload**. A resume with status `cancelled` and
`{ dismissed: true }` means the user dismissed the question to reply in the
chat: the model is told to stop and wait for their message rather than
proceed. `formatInteractionResume` and `formatInteractionOutcome` are
importable without Node or Pi from `@introspection-ai/recipes/review`, with
the `review_artifacts` answer format (`formatReviews`, `parseReviews`), so a
browser host renders the same bytes as Pi's terminal. Any host-specific pause/resume state
should be generated by the host from this request, not authored inside a
Recipe.

## AG-UI compatibility

`details.interrupt` is intentionally close to the shape needed by AG-UI-style
frontends, while remaining Pi-native Recipe metadata. A host that deploys a
Recipe behind the Agent User Interaction Protocol can map an awaiting
`details.interrupt` request into `RUN_FINISHED` with
`outcome: { type: "interrupt", interrupts: [...] }`, then resume with the
same `{ answer }`, `{ answers }`, `{ approved, feedback? }`, or cancelled
payloads described above.

For a multi-select question, the host should use an array response schema:

```json
{
  "type": "object",
  "properties": {
    "answers": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 1,
      "uniqueItems": true
    }
  },
  "required": ["answers"]
}
```

Recipes should still emit only `details.interrupt`. The host owns ids,
tool-call binding, response schemas, transport events, persistence, and any
frontend-specific rendering.

## Display data

`message` is the concise prompt every host can show without understanding
recipe-specific metadata. Keep it meaningful, for example
`Approve search proposal: Senior product leaders in Sydney?`.

When a tool needs richer approval UI copy, pass card fields to
`askUserApproval()`:

```ts
await askUserApproval(
  {
    kind: "plan_search",
    message: "Approve search proposal: Senior product leaders in Sydney?",
    title: "Senior product leaders in Sydney",
    body: "Target senior product leaders in Sydney with B2B SaaS or marketplace experience.",
    sections: [
      {
        title: "Starting angles",
        items: [
          "Product leadership titles in Sydney",
          "Growth product leaders in Sydney",
          "Marketplace product operators",
        ],
      },
    ],
    metadata: {
      proposal: "Target senior product leaders in Sydney with B2B SaaS or marketplace experience.",
    },
  },
  { toolCallId, ctx, signal }
);
```

Local pi dialogs format the generated display into readable prompt text.
Remote hosts can adapt the same object into their own UI. Hosts that do not
understand the structured display can still render `message` and basic
options.

## Response envelopes (frozen)

The envelope is the tool-result text the model sees after the user responds.
It is a byte-exact wire contract: the local dialog walk and every pause/resume
host must synthesize identical text for the same outcome,
so Recipe tools cannot tell where the answer came from. Do not reword these
without a coordinated protocol change across all hosts.

| Outcome | Envelope |
| --- | --- |
| Answered | `Answer: <answer>` |
| Multiple answers | `Answers: ["<answer>","<answer>"]` |
| Approved | `Approved.` |
| Approved with feedback | `Approved. Feedback: <feedback>` |
| Revision requested | `Revision requested.` |
| Revision requested with feedback | `Revision requested. Feedback: <feedback>` |
| Declined | `User declined to answer. Proceed with your best judgment.` |
| Pending host resume | `Awaiting user response.` |

Declines are **not** tool errors — the model is expected to proceed with its
best judgment.

## Rules for interaction tools

- **`executionMode: "sequential"` is mandatory.** A host pause must never
  race concurrently executing tools.
- **Prefer the wrappers.** Use `askUserQuestion()` and `askUserApproval()` so
  Recipe tools do not hand-author interrupt details, reasons, or display
  metadata.
- **Never format envelopes yourself.** Return the helper result as-is; envelope
  authorship must not split across layers.
- **Thread the tool's `signal`** into the helper and check for aborts after any
  custom dialog (`undefined` from a dialog means dismissal *or* abort — only
  the signal distinguishes them).
- **Custom UIs are enhancements.** A richer TUI walk goes through the
  `interactive` option; remote hosts can adapt `metadata` and `display`.
  Hosts that recognize neither must still work off `reason`, `message`, and
  `options`.
- **Child agents cannot ask the user directly.** Inside an in-process child
  agent run, approvals resolve as approved and questions resolve as declined.
  Child tools never open UI or interrupt the root session.

## Host checklist (implementing `PI_INTERRUPT_RESUME`)

1. Wrap every in-process child session prompt with
   `autoResolveInteractions()`. The guard is shared across separately resolved
   copies of Recipes, so Recipe-owned interaction tools observe the child
   boundary too.
2. Watch root-session `tool_execution_end` events for
   `details.interrupt.outcome.type === "awaiting_user"`.
3. Convert the Recipes interrupt request into the host UI protocol, pause the run, and
   persist the host descriptor(s); the pause frame itself is not replayable,
   so persisted descriptors are the source of truth.
4. On resume, rewrite the paused tool result's text with the frozen envelope
   for the user's response and continue the run. Declines (`cancelled`,
   no payload) use the declined envelope and are not errors.
5. Set `PI_INTERRUPT_RESUME=1` in the session environment only when all of
   the above is wired.
