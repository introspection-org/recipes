# `@introspection-ai/vitest-evals`

Run an Introspection Recipe through a [`vitest-evals`](https://github.com/getsentry/vitest-evals) custom harness.

```ts
import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import {
  createRecipeHarness,
  recipeCases,
  recipeJudge,
} from "@introspection-ai/vitest-evals";

const harness = createRecipeHarness();

describeEval("Support behavior", {
  harness,
  judges: [recipeJudge("useful-support-resolution")],
  judgeThreshold: 1,
}, (it) => {
  it.for(recipeCases("useful-support-resolution"))("$name", async ({ input }, { run }) => {
    const result = await run(input);
    expect(result.output).toContain("account");
    expect(toolCalls(result)).toEqual([]);
  });
});
```

The named loader reads
`evals/vitest/useful-support-resolution.eval.jsonl` from the Recipe root:

```json
{"schema_version":2,"name":"asks for the missing account identifier","input":{"history":[],"prompt":"Please check my account"}}
```

Each row is a rerunnable starting state, not a recording of the original
completion. `history` contains the normalized messages and tool events before
the selected turn; `prompt` is the selected user input. Running the suite asks
the current Recipe to produce a new completion. Production system instructions
are not replayed into the candidate: the current Recipe supplies its own
effective instructions.

Run the suite through the Recipe-aware CLI boundary:

```bash
introspection eval run -p evals/support.eval.ts
```

For the shortest native Vitest loop, the same zero-config harness also works
directly from the Recipe directory:

```bash
npx vitest run evals/support.eval.ts
```

`introspection eval run` owns candidate selection, repeated trials, production
conversation replay, and native artifact locations. The harness invokes
`introspection local`, so the same suite uses normal local Pi authentication on
a developer machine and the managed model transport when an Operator runs it.
Direct Vitest relies on local Recipe discovery and does not create an
Introspection eval-run artifact directory.

## Create cases from production turns

Scaffold a named Vitest suite and a judge with the same behavioral name:

```bash
introspection eval create useful-support-resolution --with-judge
```

If the judge already exists under `judges/`, reference it instead:

```bash
introspection eval create useful-support-resolution --judge support-quality
```

The preferred production selector is a trace id. One command derives the two
purpose-specific artifacts from that same completed turn:

```bash
introspection eval add useful-support-resolution \
  --trace-id <trace-id> \
  --expected fail
```

The paired path defaults to the same-name judge created by `--with-judge`. When
the suite references an existing differently named judge, pass it explicitly:

```bash
introspection eval add useful-support-resolution \
  --trace-id <trace-id> \
  --judge support-quality \
  --expected fail
```

That appends:

- `history + prompt` to the Vitest JSONL, so the current Recipe can rerun it.
- The original completed trajectory, explicit expected verdict, and effective
  system instructions to the judge's working `.eval.jsonl` set.

Omit `--expected` to add only the rerunnable Vitest input. Use `judges add` when
only a labelled judge case is wanted. When a trace id is unavailable, select
the turn explicitly:

```bash
introspection eval add useful-support-resolution \
  --from-conversation <conversation-id> \
  --turn 3
```

Judge-only import:

```bash
introspection judges add support-quality \
  --trace-id <trace-id> \
  --expected fail
```

Judge development and held-out validation remain judge concerns:

```bash
introspection judges eval useful-support-resolution
introspection judges validate useful-support-resolution
```

## Application context and system instructions

The harness runs the Recipe through `introspection local`. `SYSTEM.md`, the
selected agent's `system_instructions`, and Recipe extensions therefore build
the system prompt exactly as they do in a normal local or Operator run. Eval
inputs should not duplicate or override those instructions.

When the application normally appends first-party context to the user message,
keep that context structured in the case and render the model-visible message
at the harness boundary:

```ts
type SupportInput = {
  prompt: string;
  systemContext: {
    accountId: string;
    entryPoint: string;
  };
};

const harness = createRecipeHarness<SupportInput>({
  renderPrompt: ({ prompt, systemContext }) =>
    `${prompt}\n\n<system_context>\n${JSON.stringify(systemContext)}\n</system_context>`,
});
```

The rendered message is both sent to the Recipe and recorded in the normalized
Vitest trajectory. This keeps authored cases readable while ensuring judges
see the same user message the evaluated agent saw. Production-derived JSONL
cases bypass `renderPrompt` because their captured prompt already is the
complete model-visible message, including application context.

`recipeJudge("name")` resolves a YAML judge from the current Recipe's
`judges/` directory and grades the normalized Vitest trajectory with the same
judge engine used for dataset evaluation and production. An explicit relative or
absolute YAML path is also accepted when name lookup is not appropriate.

Judge cases and `recipeJudge` share this evidence contract:

```json
{
  "schema_version": 2,
  "trajectory": [
    { "type": "message", "role": "user", "content": "Research Sentry" },
    { "type": "tool_call", "id": "call-1", "name": "bash", "arguments": {} },
    { "type": "tool_result", "tool_call_id": "call-1", "content": "evidence" },
    { "type": "message", "role": "assistant", "content": "Findings..." }
  ],
  "system_instructions": "Optional effective system prompt"
}
```

Judge dataset rows add `expected` at the top level. Working cases live in
`<judge>.eval.jsonl`; held-out cases live in `<judge>.validate.jsonl`.
Timestamps are optional and are never fabricated. Feedback is separate
operational context: a production `on:` gate can match the event's raw
`name` (for example `thumbs_down`), but feedback is not stored in cases or
sent to the judge model.
