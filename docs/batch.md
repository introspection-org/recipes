# Batch runs

A batch runs one Recipe agent over many independent inputs: each line of a
JSONL file is a prompt, answered in a fresh session of its own, and each answer
is appended to a results file as the line finishes. Code decides what runs next
and when to stop; the model only ever answers one prompt.

`@introspection-ai/recipes/batch` is self-contained. It reads the input, drives
sessions through an `AgentRunController`, and writes results to local files;
nothing else is needed to run, stop and resume a batch. A host that wants more
(copying results elsewhere, reporting progress, per-line conversations) plugs it
in through the optional hooks below, and the core never depends on it.

## Run a batch

```ts
import { runBatchFromFiles } from "@introspection-ai/recipes/batch";

const summary = await runBatchFromFiles({
  params: { agent: "summarize", input_path: "prompts.jsonl", concurrency: 4 },
  controller, // any AgentRunController: your host's, or Recipes' in-process one
  directory: "./batch",
});
// { total, already_completed, completed, failed, not_started, stopped }
```

`runBatchFromFiles` reads `input_path` (relative to `directory`) and appends to
`<directory>/<output_name>`. For full control, call `runBatch(params, deps)`
with your own `BatchFiles`, a `BatchResults` store (`jsonlResults` or
`ResultShards`), and the hooks.

## Input and results

Each input line names the caller's id, the prompt, and optional metadata copied
onto its result unread:

```json
{
  "custom_id": "doc-1",
  "prompt": "Summarize: ...",
  "metadata": { "source": "acme" }
}
```

Each result line follows the Message Batches shape:

```json
{
  "custom_id": "doc-1",
  "result": { "type": "succeeded", "output": "...", "run_id": "..." },
  "batch": { "record_index": 0, "input_sha256": "...", "attempts": 1 },
  "metadata": { "source": "acme" }
}
```

`result.type` is `succeeded`, `errored`, or `canceled` (a line still running
when the run was cancelled). A line that runs again appends again; the last
line per `custom_id` wins.

## Params

| Param           | Default         | Meaning                                                                                         |
| --------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| `agent`         | required        | The Recipe agent each line runs as.                                                             |
| `input_path`    | required        | The input JSONL.                                                                                |
| `output_name`   | `results.jsonl` | The results file name.                                                                          |
| `concurrency`   | 8 (max 32)      | Lines in flight at once.                                                                        |
| `max_attempts`  | 3 (max 5)       | Attempts when the provider rate-limits a line; any other failure is final.                      |
| `deadline_ms`   | none            | Stop starting lines after this long; the rest wait for the next run.                            |
| `output_format` | `text`          | `json` sends an answer that does not parse back to its session, up to `MAX_JSON_REPAIRS` times. |

`parseBatchParams` validates them, refuses unknown keys, and fills defaults.

## Resume, stop and cancel

The results are the run's durable state. Running again skips every line whose
latest result succeeded for the same agent and prompt (`input_sha256`); a line
whose prompt or agent changed runs again, and so does one that failed. A crash
loses only the lines in flight, which run again (at least once).

- Aborting `signal` stops starting lines; the lines in flight finish and are
  recorded, the rest are `not_started`.
- Aborting `cancel` records the lines still in flight as `canceled`, so the next
  run retries them.
- A rate-limited line backs off and retries, and the concurrency halves until
  the provider recovers (`AdaptiveLimiter`). A line stopped during its backoff
  is recorded with the attempt it made.

## Hooks

All optional; the core works without any of them.

- `onProgress(progress)` runs after every line and when the run stops. A host
  may checkpoint or copy results here. With `ResultShards`, `seal()` closes the
  lines recorded so far into the next numbered file, which never changes again,
  so each sealed file needs copying once.
- `lineScope(line, record)` gives each line its own conversation id and wraps
  its session, so a line's whole exchange can be read back by that id.
- `files` replaces the local file system (`nodeBatchFiles`) with any store.

## Subagents

Each line is one run of the controller. If the batch's agent delegates to
subagents, give the controller room for them beyond `concurrency`: a
controller whose active-run limit equals `concurrency` refuses every delegation
while all line slots are busy.
