# Batch runs

Run one agent over many prompts. Each prompt is answered in its own fresh
session, and each answer is recorded as soon as it finishes. Batches suit work
where you have many independent questions for the same agent: summarizing a
set of documents, classifying records, or extracting fields from a backlog of
text.

A batch can be stopped at any time and picks up where it left off: prompts
that already succeeded are skipped, and everything else runs again.

## Quick start

Pass the prompts in, and get the answers back:

```ts
import { resolveRecipe } from "@introspection-ai/recipes";
import {
  createInProcessRunController,
  runBatch,
} from "@introspection-ai/recipes/batch";

const recipe = resolveRecipe({ recipeDir: "./my-recipe" });
const controller = createInProcessRunController({
  recipe,
  cwd: process.cwd(),
  concurrency: 4,
});

const { results } = await runBatch({
  agent: "summarize",
  input: [
    {
      custom_id: "doc-1",
      prompt: "Summarize this report in three sentences: ...",
    },
    {
      custom_id: "doc-2",
      prompt: "Summarize this report in three sentences: ...",
    },
  ],
  controller,
  concurrency: 4,
});
await controller.shutdown();

for (const line of results) {
  console.log(line.custom_id, line.result.output);
}
```

Everything runs in your process, with your Recipe's model settings and
provider credentials. Nothing is uploaded anywhere.

## Resumable batches

For a large batch, give it a `directory`. Results are then written to
`<directory>/results.jsonl` as each prompt finishes, and running the same batch
again only runs what is left:

```ts
const outcome = await runBatch({
  agent: "summarize",
  input: "prompts.jsonl", // read from the directory; inline prompts work too
  directory: "./batch",
  controller,
});
console.log(outcome);
// { total: 1000, already_completed: 600, completed: 400, failed: 0, not_started: 0, stopped: false, results: [...] }
```

Without a `directory`, results are kept in memory and returned, and the batch
cannot resume after the process exits.

## Streaming results

To act on each answer as it arrives (write it to your own database, update a
UI), pass `onResult`:

```ts
await runBatch({
  agent: "summarize",
  input,
  controller,
  onResult: async (line) => {
    await saveSummary(line.custom_id, line.result.output); // your own code
  },
});
```

`onResult` is called once per prompt, in the order prompts finish.

## Input format

`input` is either an array of prompts, or the path (or `file:` URL) of a JSONL
file with one prompt per line. Each prompt has:

| Field       | Required | Meaning                                                                    |
| ----------- | -------- | -------------------------------------------------------------------------- |
| `custom_id` | yes      | Your id for the prompt. It must be unique in the batch.                    |
| `prompt`    | yes      | What the agent is asked.                                                   |
| `metadata`  | no       | Any object. It is copied onto the prompt's result as is, for your own use. |

As a file:

```jsonl
{"custom_id": "doc-1", "prompt": "Summarize this report in three sentences: ..."}
{"custom_id": "doc-2", "prompt": "Summarize this report in three sentences: ...", "metadata": {"source": "acme"}}
```

A malformed prompt or a repeated `custom_id` stops the batch before anything
runs, and the error says which one.

## Results format

Each result has the same shape as Anthropic's Message Batches results:

```json
{
  "custom_id": "doc-1",
  "result": {
    "type": "succeeded",
    "output": "The report finds ...",
    "run_id": "..."
  },
  "batch": { "record_index": 0, "input_sha256": "...", "attempts": 1 },
  "metadata": { "source": "acme" }
}
```

- `result.type` is `succeeded`, `errored` (with `result.error.message`), or
  `canceled` (the prompt was still running when the batch was cancelled).
- `batch.record_index` is the prompt's position in the input, and
  `batch.attempts` is how many times it ran.
- `runBatch` returns the latest result for every prompt, in input order. In a
  results file, a prompt that runs again is appended again, so read the last
  line for each `custom_id`.

## Options

| Option          | Default         | Meaning                                                                                                                                                   |
| --------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`         | required        | The Recipe agent that answers each prompt.                                                                                                                |
| `input`         | required        | The prompts, or a JSONL file of them.                                                                                                                     |
| `controller`    | required        | Runs each prompt: `createInProcessRunController`, or your own `AgentRunController`.                                                                       |
| `directory`     | none            | Where results are written and resumed from. A relative `input` path is read from here too.                                                                |
| `output_name`   | `results.jsonl` | The results file name in `directory`.                                                                                                                     |
| `concurrency`   | 8 (max 32)      | How many prompts run at once.                                                                                                                             |
| `max_attempts`  | 3 (max 5)       | How many times a rate-limited prompt is tried. Other failures are not retried.                                                                            |
| `deadline_ms`   | none            | Stop starting new prompts after this long. Prompts not started run next time.                                                                             |
| `output_format` | `text`          | With `json`, an answer that is not valid JSON is sent back to the agent to fix, up to two times.                                                          |
| `signal`        | none            | Abort it to stop gracefully.                                                                                                                              |
| `onResult`      | none            | Called with each result as it is recorded.                                                                                                                |
| `onProgress`    | none            | Called with the counts after every prompt and when the batch stops.                                                                                       |
| `batch_id`      | derived         | Names the batch in each prompt's conversation id. Derived from the results file with a `directory`, so a resumed batch keeps its ids; random without one. |
| `baggage`       | none            | Extra OpenTelemetry baggage set around each prompt's session: an object, or a function of the prompt.                                                     |

Unknown options are rejected, so a typo fails fast instead of being ignored.

## Stopping and resuming

- **Abort the `signal`** to stop gracefully. No new prompts start, the ones
  already running finish and are recorded, and the rest are counted as
  `not_started`.
- **Stop the process outright** and only the prompts that were running are
  lost; with a `directory`, they run again next time.
- **Run again with the same `directory`** and the batch skips every prompt
  whose last result succeeded for the same agent and prompt text. A prompt
  whose text or agent changed runs again, as does any prompt that failed.

When the provider rate-limits a prompt, the batch waits and retries it, and
lowers its concurrency until requests succeed again.

## Traces

Each prompt runs as its own conversation, with the id
`<batch_id>:<index>`. That id is on the prompt's result as
`result.conversation_id`, so a result and its trace join on it.

The batch sets the id as OpenTelemetry baggage (`gen_ai.conversation.id`)
around the prompt's session. A Recipes session takes its conversation id from
that baggage, unless its `otel.meta` names one, and so do the subagents it
starts. Any other baggage entries, including your own from `baggage`, are added
to every span the session records:

```ts
await runBatch({
  agent: "summarize",
  input,
  controller,
  baggage: (line) => ({ "acme.document_id": line.custom_id }),
});
```

Recipes uses your process's own `@opentelemetry/api` (a peer dependency), so it
sees the context and baggage your SDK registers. Baggage only flows through `await` when your OpenTelemetry SDK has registered
an async context manager, which the Node SDK does by default. If your SDK also
propagates W3C baggage on outgoing HTTP requests, these entries are sent with
those requests too, so keep them to ids rather than anything sensitive.

## Agents that use subagents

Each prompt is one run of the controller. If the batch's agent starts
subagents of its own, those count against the same controller, so give the
controller a higher `concurrency` than the batch's. If the two are equal, every
subagent is refused while all the batch's slots are busy.

## Hosting batches

Applications that run batches for others can take full control with
`runBatchWith(params, deps)`. It takes validated settings (`parseBatchParams`)
and lets you supply each part yourself:

- **`results`**: where results are kept. `jsonlResults` appends to one file;
  `ResultShards` closes finished results into numbered files that never change
  once written, so each only needs copying somewhere durable once.
- **`files`**: replaces the local file system with your own storage.
- **`lineScope`**: gives each prompt its own conversation id and wraps its
  session, so its full exchange can be read back later.
- **`cancel`**: a second signal for when a stopping batch can wait no longer;
  prompts still running are recorded as `canceled` and run again next time.

None of these are needed to run a batch with `runBatch`.
