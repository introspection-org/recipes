# Running judges

Run a Recipe's [judges](recipe-judges.md) over conversations. Every run is one
[batch](batch.md): each judge and conversation pair is a line of it. One
conversation under ten judges and a thousand conversations under one judge are
the same run, with the batch's concurrency, its rate-limit retries and its
resume.

## Quick start

```ts
import { resolveRecipe } from "@introspection-ai/recipes";
import {
  createJudgeRunController,
  loadJudges,
  piClassifier,
  runJudges,
} from "@introspection-ai/recipes/judges";

const recipeDir = "./my-recipe";
const judges = loadJudges(recipeDir);
const controller = createJudgeRunController({
  recipe: resolveRecipe({ recipeDir }),
  judges,
  cwd: process.cwd(),
  classify: piClassifier(),
  concurrency: 8,
});

const { results, skipped } = await runJudges({
  judges,
  input: ["monday.jsonl", "tuesday.jsonl"],
  controller,
  directory: "./judged",
});
await controller.shutdown();

for (const line of results) {
  console.log(line.custom_id, line.judge, line.result, line.reasoning);
}
```

The judgements are returned and, with a `directory`, written to
`<directory>/results.jsonl`.

## From the command line

The package ships the same run as a script, for a host that launches it as a
process:

```bash
node node_modules/@introspection-ai/recipes/dist/judges/cli.js \
  --recipe ./my-recipe --input monday.jsonl --input tuesday.jsonl --out ./judged
```

The script is started by Node rather than loaded by Pi, so it finds Pi's own
packages in the folder `PI_PACKAGE_DIR` names, else in the installed Pi whose
`pi` is on `PATH`. With `PI_PACKAGE_DIR` set, it needs no `pi` executable.

`--input -` reads conversations from standard input, and `--judge <name>`
keeps only the judges named. It runs on this machine's Pi: its logins and
provider keys, with each judge's `ai.fallbacks`. It prints one JSON report,
`{ schema_version, results, skipped, counts, stopped }`, and exits 0 when the
run finished, whatever the verdicts.

`--schema` prints the protocol the script speaks, `{"schema_version":2}`, and
exits 0 without loading Pi. A host checks it before running: the report's
`schema_version` is the same number.

### Where the judge definitions come from

The runner doesn't parse judge YAML. `introspection-recipe-check` normalizes
it, so the runner, the checker and the hosted platform all read the same
definition, and an [older `llm:` block](recipe-judges.md#the-older-llm-block)
means the same everywhere. By default, `loadJudges` runs the binary that
`INTROSPECTION_RECIPE_CHECK` names, or the `introspection-recipe-check` on
`PATH`, as `introspection-recipe-check judges`, with the judge files as JSON
`[{ "path", "content" }]` on standard input.

A host that links the recipe-check crate passes the definitions itself, and
nothing is spawned:

```bash
node node_modules/@introspection-ai/recipes/dist/judges/cli.js \
  --recipe ./my-recipe --input monday.jsonl --definitions judges.json
```

`judges.json` is exactly what `introspection-recipe-check judges` prints for the
Recipe's `judges/`: an array of
`{ "source_path", "definition", "warnings"? }`, which is the
`ParsedJudgeDefinition` of `parse_judge_definitions`. In code, pass the same
array as `loadJudges(recipeDir, { definitions })`. The judge files are still
read, for each judge's `definition_hash`.

## Input

`input` is one or more JSONL files, or the lines themselves. Several files run
as one batch. Each line is one conversation:

| Field                 | Required | Meaning                                                                                      |
| --------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `custom_id`           | yes      | Your id for the conversation, unique across every input file. Defaults to `conversation_id`. |
| `trajectory`          | yes      | The conversation: a trajectory export's records, or events already normalized.               |
| `conversation_id`     | no       | The platform conversation this is. Defaults to `custom_id`.                                  |
| `system_instructions` | no       | The agent's effective system instructions, when they are evidence too.                       |
| `feedback_events`     | no       | Feedback on the conversation, for a judge whose `on` matches `feedback`.                     |
| `environment`         | no       | Where the conversation ran. A judge's `sample_rate` applies only to `production` lines.      |

A trajectory export's records are keyed by `role` (`user`, `assistant`, `tool`,
`reasoning`, `meta`); reasoning and meta records are not evidence. Normalized
events are keyed by `type`:

```jsonl
{
  "custom_id": "c-1",
  "trajectory": [
    {
      "type": "message",
      "role": "user",
      "content": "Where is my order?"
    },
    {
      "type": "tool_call",
      "id": "t1",
      "name": "orders_get",
      "arguments": {
        "id": "42"
      }
    },
    {
      "type": "tool_result",
      "tool_call_id": "t1",
      "content": {
        "status": "shipped"
      }
    },
    {
      "type": "message",
      "role": "assistant",
      "content": "It shipped yesterday."
    }
  ]
}
```

A line may name a Pi session file in place of `trajectory`, as
`{"custom_id": "C1", "session_file": "tasks/C1/.introspection/session/….jsonl"}`:
the session's active branch is read as the conversation, without its system
prompt or reasoning.

A line that is not JSON, lacks a `trajectory`, has neither a `custom_id` nor a
`conversation_id`, or repeats a `custom_id` stops the run before anything is judged. A line whose trajectory
cannot be read, such as a tool result with no call, records an `error` for that
conversation and the rest carry on.

## Results

One line per judge and conversation, by judge and then in input order:

```json
{
  "custom_id": "c-1",
  "judge": "helpful",
  "conversation_id": "c-1",
  "definition_hash": "9f2c…",
  "contract_version": "3",
  "result": "pass",
  "status": "ok",
  "reasoning": "Answered with the order's shipping status.",
  "sequence_hash": "4be1…",
  "model": "openai/gpt-5",
  "usage": { "input_tokens": 1830, "output_tokens": 41, "total_tokens": 1871 },
  "run_id": "agent-run-1a2b3c4d",
  "attempts": 1
}
```

- `result` is `pass`, `fail`, `not_applicable` or `error`. A judge that could
  not reach a verdict records `error` with the reason in `error`; it is never
  counted as a `fail`.
- A classifier judge adds `scores`, its probability of yes for each question
  from 0 to 1, and its `reasoning` names each score against its threshold.
  Questions are listed in name order.
- `sequence_hash` is the hash of the evidence the judge read (`evidenceHash`
  of its input).
- `model` is the `<provider>/<model>` that answered, after any `ai.fallbacks`.
  `usage` is the tokens the judgement took, counting cached prompt tokens as
  input. It is present only when the model reported tokens, never as zeros.
  Both come from the controller's `runDetails`; a judgement resumed from an
  earlier run has neither.
- `definition_hash` is the SHA-256 of the judge file. Judgements compare only
  when it and `contract_version` match.
- `judgement_id` is present when the judge has a registered id (see
  [Platform settings](#platform-settings)). It is derived from the judge, its
  definition, the evidence and the conversation, so the same judgement made
  twice has the same id.

`skipped` lists each judge that did not run on a conversation, with the reason:
`gate` (its `on` did not match), `no_evidence`, `disabled` or `sampled_out`.
A skipped judgement is not written to the results.

## How a judge runs

- **An LLM judge** runs as a fresh session with the judge's `ai:` settings, no
  tools, and the judge's `instructions` as its whole system prompt. The
  conversation is the prompt. One code fence around the reply (` ```json ` in
  any case, or a bare ` ``` `) is dropped first. A reply that is still not
  JSON is sent back to be fixed, up to two times, and then checked: the
  verdict must be in the vocabulary, and the reply must not repeat a span of
  the conversation.
- **A classifier judge** is one decision-model call through `classify`, with
  the judge's questions and a transcript slimmed to fit: long tool arguments
  and results are clipped first, and what still does not fit loses its middle.
  `piClassifier()` asks Pi's classifier models, with the provider's key read
  from the environment. A run with classifier judges and no `classify` records
  an `error` for each of their lines.

## Fallbacks and retries

A judge's `ai.fallbacks` apply as an agent's do: with Pi's `modelRegistry` and
no `credentials` of your own, the judge starts on the first model that has a
credential.

A batch expects rate limits, so a judge does not leave its model at the first
failure. `fallbackAfterRetries` (default 2) is how many retries the model gets
before the judge moves to the next fallback. Pi's `retry.maxRetries` must be
higher than that for a fallback to be reached. A classifier judge tries each
model once, in order.

When a line still fails on a rate limit, the batch waits, retries it up to
`max_attempts` times and lowers its concurrency until requests succeed again.

## Resuming

Run again with the same `directory` and each judge skips every conversation it
already judged successfully with the same definition and transcript. Editing a
judge file changes its `definition_hash`, so the edited judge runs again in
full; its earlier answers stay in `<directory>/batch/`.

## Platform settings

`operational` carries what a platform has set for each judge, by judge name:

| Field         | Default | Meaning                                                         |
| ------------- | ------- | --------------------------------------------------------------- |
| `judge_id`    | none    | The judge's registered UUID. Judgement ids are derived from it. |
| `enabled`     | `true`  | `false` skips the judge.                                        |
| `sample_rate` | 1       | The fraction of `production` conversations the judge runs on.   |

Sampling is stable: the same judge and conversation are always in or out.

## Options

| Option         | Default  | Meaning                                                       |
| -------------- | -------- | ------------------------------------------------------------- |
| `judges`       | required | The judges to run: `loadJudges(recipeDir)`, or a subset.      |
| `input`        | required | The conversations: JSONL paths (or `file:` URLs), or lines.   |
| `controller`   | required | Runs each judgement: `createJudgeRunController`, or your own. |
| `directory`    | none     | Where the run keeps its state and writes `results.jsonl`.     |
| `concurrency`  | 8        | Judgements in flight at once, across every judge.             |
| `max_attempts` | 3        | How many times a rate-limited judgement is tried.             |
| `operational`  | none     | Platform settings by judge name.                              |
| `signal`       | none     | Abort it to stop gracefully; `stopped` is then `true`.        |
| `onResult`     | none     | Called with each judgement as it completes.                   |

Give the controller at least the run's `concurrency`: an LLM judge's sessions
count against the controller's own limit.
