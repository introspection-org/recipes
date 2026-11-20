# Recipe judge definitions

Recipe judges are optional, recipe-owned grading definitions. Author them
as direct children of `judges/` using a lowercase `.yaml` or `.yml` extension:

```text
my-recipe/
  judges/
    helpful.yaml
```

Nested files such as `judges/calibration/helpful.yaml` are not judge sources.
`introspection check` discovers this direct-child set. Recipes without judge
sources have no judge diagnostics.

## Ownership boundary

The validator behind `introspection check` owns the portable authored YAML
specification and its static, file-oriented diagnostics.

`@introspection-ai/recipes/judges` owns execution: applicability checks,
transcript assembly and protection, model requests, verdict normalization and
evaluation identity. See [Running judges](judges.md). New authored fields must
land in the checker and its contract tests as well as in the runner.

Validation reports do not contain normalized judge definitions or
host-specific registry data.

## Definition shape

A judge is answered either by a chat model reading `instructions`, or by a
classifier answering yes-or-no `questions`. It declares exactly one of the two.

The minimal LLM judge is:

```yaml
name: helpful

instructions: |
  Determine whether the assistant answered the user correctly.

ai:
  model: anthropic/claude-sonnet-5-5
```

`name`, `ai.model` and one of `instructions` and `questions` are required.
Names use lowercase kebab-case and must be unique across all judge files in one
Recipe. As with `agents/*.yaml`, the filename has no semantic meaning.

Legacy definitions using `judge:` remain accepted as a deprecated input alias.
Parsers normalize that field to `name`; a definition cannot declare both.

The expanded definition is:

```yaml
name: helpful
description: Did the assistant answer correctly?

on:
  - event: message
    match:
      role: assistant

instructions: |
  Determine whether the assistant answered the user correctly.

ai:
  model: anthropic/claude-sonnet-5-5
  fallbacks:
    - openai/gpt-6-luna
  thinking_level: low
  options:
    temperature: 0
```

Unknown fields are errors at every level.

### The older `llm:` block

A judge declares its model under `ai:`. The `llm:` block that earlier versions
read is still accepted in its place, but never beside it: a judge with both, or
with neither, reports `judge.kind_invalid`. Every reader of the judge
(the checker, the runner and the hosted platform) sees the `ai:` block it maps
to:

| `llm:`                     | `ai:`                                                        |
| -------------------------- | ------------------------------------------------------------ |
| `provider` and `model`     | `model: <provider>/<model>`; `provider` defaults to `openai` |
| `request.max_tokens`       | `options.max_tokens`                                         |
| `request.temperature`      | `options.temperature`, unless it is 0 (the model's default)  |
| `request.reasoning_effort` | `thinking_level`; `none` is `off`                            |
| `transport`                | dropped: the host owns timeouts and retries                  |
| `local`                    | dropped with the warning `judge.llm.local_ignored`           |

`ai:` cannot name a local endpoint, so a judge that declared `llm.local` runs on
its provider's hosted model. A `reasoning_effort` that names no thinking level
is an error.

```yaml
# Read as ai: { model: anthropic/claude-sonnet-5-5, thinking_level: low }
llm:
  provider: anthropic
  model: claude-sonnet-5-5
  request:
    reasoning_effort: low
```

### Model settings

`ai:` is the block an agent declares, with the same keys and the same rules:
`model`, `fallbacks`, `thinking_level`, `options` and `providers`. See
[Agents](recipe-format.md#agents). A judge has no `session:` block; the host's
retry settings apply.

An LLM judge returns `pass`, `fail` or `not_applicable` with a short reason.
That contract is the runner's and cannot be authored.

### Classifier judges

A classifier judge asks a decision model yes-or-no questions and reads a
probability for each:

```yaml
name: polite

ai:
  model: typesafe/jev-latest
  fallbacks:
    - openai/gpt-6-luna

questions:
  greeted:
    instructions: Did the assistant greet the user?
    criteria:
      "true": The first reply opens with a greeting.
      "false": It does not.
    threshold: 0.8
  apologised:
    instructions: Did the assistant apologise for the delay?
    criteria:
      "true": It says sorry for the wait.
      "false": It does not mention the wait.
```

- `questions` maps between one and eight lowercase snake_case names to
  questions.
- `instructions` is non-empty text, and `criteria` describes both `true` and
  `false`.
- `threshold` is the probability of yes, above 0 and at most 1, that the
  question must reach. It defaults to 0.5.
- The judge is `pass` when every question reaches its own threshold, and `fail`
  otherwise. A classifier cannot abstain: `not_applicable` comes only from
  `on`.
- `ai.model` names a classifier model. `thinking_level` and `options` do not
  apply to one.

## Judge types

`type` says when a judge runs:

- `online`, the default: at the end of every runtime conversation `on`
  selects, or of a sample of them (see [Sampling](#sampling)).
- `mission`: on a request leaving the sandbox, which a route in the Recipe's
  `policies/routes.yaml` names. Its answers reach the Recipe's Cedar policy
  before the request is allowed.

An eval-only judge is defined in its eval suite, not in `judges/`: a Vitest
`createJudge`, or a judge YAML under `evals/vitest/judges/` loaded by path
through `recipeJudge`; for Harbor, a RewardKit `[judge]` and `[[criterion]]`
TOML in the task's `tests/`. `type: offline` reports `judge.type_invalid`.

A mission judge asks yes-or-no questions instead of grading against a rubric, and
the platform chooses the model:

```yaml
name: booking
type: mission
description: Is this booking what the traveller asked for?
attributes: [city, check_in, check_out, total_cents]
questions:
  requested:
    instructions: >
      Is the booking something the traveller asked for, or a natural part of
      that trip?
    criteria:
      "true": The same destination and dates.
      "false": Another place, other dates, or something they never asked for.
  personal:
    instructions: Did the traveller describe this part of the trip as personal?
```

- `questions` maps between one and eight lowercase identifiers to questions;
  each name is the field its answer is read as.
- `instructions` is non-empty text. `criteria` is optional and, when present,
  describes both `true` and `false` in non-empty text.
- `attributes` lists the request attributes the judge sees, and is empty to show
  them all.
- `on`, `ai` and `sample` belong to `online` judges and are rejected on a
  mission judge; `attributes` is rejected on online judges.

## Applicability

`on` is optional. Omission, an empty mapping, or an empty list makes the judge
applicable to every conversation selected for judging. Otherwise it is an
OR-list of matchers. Supported events are `message`, `tool`, and `feedback`;
fields within one `match` mapping are ANDed by the evaluator.

```yaml
on:
  - event: message
    match:
      role: user
      text: /refund|invoice/i
  - event: tool
    match:
      name: shell
      args.command: /pytest/i
  - event: feedback
    match:
      sentiment: negative
```

Match keys are non-empty field paths. Regex literals support unique `i`, `m`,
`s`, and `u` flags. A pattern must compile both as a Rust regex, which the
hosted platform evaluates, and as a JavaScript `RegExp`, which the runner
evaluates. The runner compiles a pattern with the `v` flag and, when that
refuses it, with the `u` flag, so `[\w-]+` (which only `u` compiles) and
`[\w--\d]+` (which only `v` compiles) are both valid. The checker reports
`judge.on.regex_invalid` for a pattern either engine refuses, such as a
lookahead (`(?=…)`, which Rust refuses) or a Rust named group (`(?P<name>…)`,
which JavaScript refuses under both flags). `environment`, `runtime_group`, and
paths ending in `pattern_id` are platform-owned and cannot appear as authored
match fields. The runner owns dotted-path traversal and gate evaluation.

The checker compiles the JavaScript side with a Rust implementation of the
`RegExp` grammar, not with the runner's own engine, and the two differ at the
edges: the checker accepts `\Afoo\z`, `\-` and `\#`, which the runner refuses,
and `[[:alpha:]]` is a POSIX class to Rust and a nested class to JavaScript. A
pattern the checker accepts can therefore still be refused by the runner at
run time, where it records an error for that judgement.

## Sampling

`sample` is optional on an online judge: the fraction of the conversations
`on` selects that the judge runs on, a number above 0 and at most 1. It
defaults to 1, every selected conversation.

```yaml
name: helpful
sample: 0.1
```

Sampling is deterministic per conversation, so a rerun, and every host that
judges the same conversation, makes the same choice. A conversation is sampled
when `h / 2^64 < sample`, where `h` is the first eight bytes, read as a
big-endian unsigned integer, of the SHA-256 of
`<judge name>:<conversation id>`. The judge's name is part of the key, so two judges that each sample a
tenth of conversations do not pick the same tenth; renaming a judge draws a
new sample.

A conversation the sample leaves out records no verdict; it is not
`not_applicable`, which only `on` produces. An eval run judges every trial it
asks a judge for, whatever its `sample`.

## Diagnostics

Invalid Recipe content is reported through the normal diagnostics model. Judge
diagnostics use stable `judge.*` codes, Recipe-relative source paths, useful
help text, and deterministic ordering. YAML syntax failures use
`judge.yaml_malformed` and include a 1-based source span when the parser
provides one. An invalid mission judge reports `judge.mission_invalid`, and a
`type` other than `online` and `mission` reports `judge.type_invalid`. A
`sample` that is not a number above 0 and at most 1 reports
`judge.sample_invalid`; on a mission judge it reports `judge.mission_invalid`.
