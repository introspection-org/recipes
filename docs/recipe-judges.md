# Recipe judge definitions

Recipe judges are optional, recipe-owned LLM grading definitions. Author them
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

Evaluation systems own execution: applicability checks, conversation assembly,
transcript protection, model requests, retries, verdict normalization, and
evaluation identity. Implementations should consume or remain explicitly
compatible with the authored specification defined here. New authored fields
must land in this checker and its contract tests rather than appearing in only
one evaluator.

Validation reports do not contain normalized judge definitions or
host-specific registry data.

## Definition shape

The minimal definition is:

```yaml
name: helpful

instructions: |
  Determine whether the assistant answered the user correctly.

llm:
  model: gpt-5
```

`name`, `instructions`, and `llm.model` are required and non-empty. Names use
lowercase kebab-case and must be unique across all judge files in one Recipe.
As with `agents/*.yaml`, the filename has no semantic meaning. Evaluators default
`llm.provider` to `openai`.

Legacy definitions using `judge:` remain accepted as a deprecated input alias.
Parsers normalize that field to `name`; a definition cannot declare both.

The canonical expanded definition is:

```yaml
name: helpful
description: Did the assistant answer correctly?

on:
  - event: message
    match:
      role: assistant

instructions: |
  Determine whether the assistant answered the user correctly.

llm:
  provider: openai
  model: gpt-5
  request:
    temperature: 0
    max_tokens: 1024
    reasoning_effort: medium
  transport:
    timeout_ms: 60000
    max_retries: 2
    max_retry_delay_ms: 5000
  local:
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
```

Unknown fields are errors at every level. The obsolete top-level `model:`
block is rejected.

## Judge types

`type` says when a judge runs:

- `online`, the default: at the end of every runtime conversation.
- `eval`: at the end of each eval trial. It has the same shape as `online`.
- `gate`: on a request leaving the sandbox, which a route in the Recipe's
  `policies/routes.yaml` names. Its answers reach the Recipe's Cedar policy
  before the request is allowed.

A gate judge asks yes-or-no questions instead of grading against a rubric, and
the platform chooses the model:

```yaml
name: booking
type: gate
description: Is this booking what the traveller asked for?
facts: [city, check_in, check_out, total_cents]
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
- `facts` lists the request attributes the judge sees, and is empty to show
  them all.
- `on` and `llm` belong to `online` and `eval` judges and are rejected on a
  gate judge; `questions` and `facts` are rejected on the others.

### LLM settings

- `provider` is a 1-64 byte lowercase slug containing ASCII letters, digits,
  and hyphens. The portable checker does not restrict it to managed platform
  providers because custom slugs can be used with an explicit local endpoint.
- `model` is a trimmed, non-empty string of at most 255 bytes.
- `request.temperature` is a finite number from 0 through 2 and defaults to 0.
- `request.max_tokens` is an integer from 1 through 131072 when present;
  explicit `null` is treated as omitted.
- `request.reasoning_effort` is a 1-64 byte lowercase slug containing ASCII
  letters and hyphens; explicit `null` is treated as omitted.
- `transport.timeout_ms` is an integer from 1 through 600000 and defaults to
  60000.
- `transport.max_retries` is an integer from 0 through 10 and defaults to 0.
- `transport.max_retry_delay_ms` is an integer from 0 through 60000 and
  defaults to 5000.
- `local` requires both `base_url` and `api_key_env`. The URL must be HTTP(S),
  have a host, contain no embedded credentials, query, or fragment, and use
  HTTPS unless it targets `localhost`, `127.0.0.1`, or `::1`. `api_key_env` is
  an environment-variable name, not a credential value.

Transport and local settings affect execution but not authored grading
identity. The evaluator remains responsible for applying defaults, building
requests, and routing execution.

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

Match keys are non-empty field paths. Regex literals use Rust regex syntax and
support unique `i`, `m`, `s`, and `u` flags. `environment`, `runtime_group`, and
paths ending in `pattern_id` are platform-owned and cannot appear as authored
match fields. The evaluator owns dotted-path traversal and gate evaluation.

## Diagnostics

Invalid Recipe content is reported through the normal diagnostics model. Judge
diagnostics use stable `judge.*` codes, Recipe-relative source paths, useful
help text, and deterministic ordering. YAML syntax failures use
`judge.yaml_malformed` and include a 1-based source span when the parser
provides one. An invalid gate judge reports `judge.gate_invalid`, and a
`type` outside `online`, `eval` and `gate` reports `judge.type_invalid`.
