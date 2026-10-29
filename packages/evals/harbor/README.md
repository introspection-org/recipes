# `introspection-harbor`

Harbor installed-agent adapter for Introspection Recipes. Install it through
`introspection setup --target harbor`, then run a task through:

```sh
introspection eval run --runner harbor --path evals/refund-task
```

Select an inherited Recipe agent variant by its declared YAML `name`:

```sh
introspection eval run --runner harbor --path evals/refund-task --agent agent2
```

The selected agent YAML is the only source of the evaluated model; the CLI and
adapter do not apply a separate model override.

The CLI records that declared model as `candidate.model` in the run spec and
`run.json`. The `native` adapter accepts it as candidate metadata and submits
only the prompt to the task. The Runtime loads the selected agent from the
candidate Recipe commit and uses its declared model. The CLI checks the model
observed in the returned trajectory against `candidate.model` and records it as
`result.observed_model` in `run.json`.

### Harbor's own agents

A prefixed agent names one of Harbor's agents instead of a Recipe agent:
`harbor:oracle` runs the task's `solution/` through the environment's exec and
`harbor:nop` sends no turn, both without a Recipe agent or a model. Harbor is
invoked with that agent in place of the Recipe adapter, and on the
Introspection environment the task keeps the Recipe's default agent while the
solution runs through the task's commands. The prefix is the runner's name, so
it is refused with a runner that has no agents of its own, and `-a` after `--`
stays refused: the common option is the one way to choose.

```sh
introspection eval run --runner harbor --path evals/refund-task --agent harbor:oracle
```

### Multi-step tasks

The steps of a multi-step task are turns of one conversation: a later step
sees everything the earlier steps said and did.

- `--fresh-steps` starts a new conversation at every step instead.
  The `native` adapter refuses it: its steps are runs on the trial's one
  task, which holds one conversation.
- Harbor's own agents (`harbor:oracle`, `harbor:nop`) and production replays
  always start fresh.
- With `harbor run` directly, steps are fresh unless you pass
  `--resume-trajectory`.

A verifier reads the conversation from `/logs/agent/trajectory.json`. On a step
that continues the conversation it covers every turn so far, so a later step
can be graded against what an earlier one said. `pi.jsonl` covers the current
step only, and a step's reported tokens and cost are that step's alone.

The trajectory is the platform's own ATIF projection. During each Pi run the
Recipes extension writes the session as the GenAI spans the platform stores
(`genai-spans.json`), and `introspection-sdk` projects those onto ATIF with the
code behind the platform's ATIF conversation export. A trial and a production
conversation therefore produce the same trajectory for the same turns. A step's
usage comes from the spans that start after its Pi run was launched, and its
input tokens include cached tokens, as ATIF defines `prompt_tokens`.

The spans are the trajectory's only source. The adapter names the file in
`PI_RECIPE_GENAI_SPANS_FILE` and the extension replaces it after every turn, so
a run that Harbor stops on its timeout still has the trajectory of the turns it
finished. A trial whose Recipes extension predates the variable (an older
Runtime image, or a CLI whose `introspection setup` installs an older Recipes
release) fails after the agent run with an error that names the missing
`genai-spans.json`. A run that made no model call has no trajectory.

### Retrying infrastructure failures

`--retry-errors <n>` reruns, up to `n` times within the same run and the same
Harbor job, the trials that failed on infrastructure rather than on the agent:

```sh
introspection eval run --runner harbor --path evals --retry-errors 2
```

A trial is rerun when every exception Harbor recorded for it, on the trial or
on one of its steps, is one of these:

- `AgentTimeoutError` with zero tokens used: Pi got no model response.
- `DataPlaneError` for a rejected or expired login (401, "login has expired"),
  a 408, 429 or 5xx response, or a sandbox that never accepted commands.
- A transport error of the adapter's HTTP client, such as `ConnectError` or
  `ReadTimeout`.
- `EnvironmentStartTimeoutError`, `AgentSetupTimeoutError`,
  `VerifierTimeoutError`, `AddTestsDirError`, `DownloadVerifierDirError` and
  `CancelledError`.

Everything else stays as it is: an agent that timed out after using tokens or
whose token usage is unknown, a non-zero agent exit, a missing or unreadable
reward, a request the Data Plane refused (a Recipe that fails validation, a
missing scope, an unknown Runtime), a sidecar image that fails to build, and
any trial that completed with a low score.

The rerun is `harbor job resume` on the job directory, after the failed trials'
directories are removed from it. `run.json` lists each rerun case under
`result.retries` with its `attempts` and the `kind` and `message` of every
discarded trial; a case that is not listed took one attempt. `case` is the `id`
the case has in `result.cases`, which holds the last attempt only. The flag cannot be
combined with `--from-conversation`. Harbor's own `--max-retries` after `--`
still works and selects by exception type alone.

### Local Docker on the Runtime image

With no `--env` and `INTROSPECTION_HARBOR_ENVIRONMENT` unset, Harbor runs its
local Docker environment and the default `runtime` adapter expects the trial
image to carry the Recipe under `/opt/introspection/recipe` and the runtime
under `/usr/local/lib/introspection-runtime`, which is what the Runtime image
has. A plane's Runtime images are private, but `make ensure-runtime-images` in
`introspection-cloud` builds the same image as `introspection-runtime-agent:latest`,
so a task's `environment/Dockerfile` can start from it:

```dockerfile
FROM introspection-runtime-agent:latest
COPY --chown=appuser:appuser . /opt/introspection/recipe
```

The Recipe's `.pi/mcp.local.json` binds a fake MCP server the compose file
serves as a sidecar. The adapter writes it from the task's
`[[environment.mcp_servers]]`, where `name` is the server id the Recipe
declares and the transport is `streamable-http`. A task that declares none
gets the file seeded from `.pi/mcp.local.example.json` when it is absent. A foreign image takes the `bootstrap` adapter instead.

## Reading the trajectory in a verifier

A task's verifier finds the conversation at `/logs/agent/trajectory.json`.
`introspection_harbor.verifier` reads it without the check knowing the ATIF
layout:

```python
from introspection_harbor.verifier import (
    final_reply,
    load_trajectory,
    server_calls,
    tool_calls,
)

trajectory = load_trajectory()
final_reply(trajectory)  # the agent's last non-empty message
tool_calls(
    trajectory
)  # [{"name", "arguments", "result", "is_error"}], answered calls only
server_calls(tool_calls(trajectory), "attio")  # one MCP server's calls
```

`server_calls(calls, server, tools=None)` keeps one MCP server's calls under
the server's own tool names. Pi names an MCP tool `mcp_<server>_<tool>`, with
characters outside `[A-Za-z0-9_-]` replaced, and may cut it short and append
`_<10 hex>`, a hash of the name. Given the server's `tools`, such as its
answers from `load_answers` below, each call is named by the tool whose Pi name
it carries, and a call to no listed tool is left out; without them, the hash
is stripped, which recovers only a short name Pi did not have to replace
characters of. Each is `{"name", "args", "isError",
"response"}`, the keys of `serverCalls` in `@introspection-ai/vitest-evals`,
so a check ports between the two runners unchanged, plus `structured`, the
result's `structuredContent`, when the call has it. A trajectory carries
`structuredContent` only where the result's ATIF `extra` holds it as
`structured_content`, and the GenAI spans it is projected from do not record
it yet, so for now no call has it.

Add the package to the verifier's environment, for example
`uvx --from harbor-rewardkit --with introspection-harbor rewardkit /tests`.

### Checking a Recipe's MCP fakes

A Recipe's fakes run in one sidecar of the trial, on
`@introspection-ai/mcp-fakes`, which serves each fake's state at
`/<id>/admin/state` and the state it started with at
`/<id>/admin/initial-state`. `introspection_harbor.fakes` reads them and
holds the two checks every case of a Recipe may share. Each returns what it
found, so a criterion passes when it is empty:

```python
from pathlib import Path

from rewardkit import criterion

from introspection_harbor.fakes import load_manifests, state_changes, write_attempts
from introspection_harbor.verifier import load_trajectory, tool_calls

# Each fake's manifest.json, which the sidecar writes there under MCP_FAKES_MANIFEST_DIR.
MANIFESTS = load_manifests(Path("/opt/fakes-verifier/mcp"))
CRM = {"attio": MANIFESTS["attio"]}


@criterion(
    description="No CRM record, email or send attempt differs from the world the trial started in"
)
def nothing_changed(workspace: Path) -> bool:
    return not state_changes({fake: MANIFESTS[fake] for fake in ("attio", "resend")})


@criterion(description="No CRM tool that writes was called")
def no_crm_write_attempted(workspace: Path) -> bool:
    return not write_attempts(tool_calls(load_trajectory()), CRM)
```

| Function | Returns |
| --- | --- |
| `fake_state(id, url=None)`, `fake_initial_state(id, url=None)` | A fake's state now, and when the trial started |
| `load_manifests(directory)` | `{id: manifest}` from `<directory>/<id>/manifest.json`; raises when the directory is missing or holds no manifest |
| `state_changes(manifests, url=None)` | `["<id>.<entity>", ...]`: every entity some tool of these fakes writes whose state differs from the initial one; empty when no state changed |
| `write_attempts(calls, manifests)` | The calls to a tool the write maps say writes, each with its `server` (fake id) and its contract `tool` name; empty when no write was attempted |

The sidecar's base URL is `url`, else the `INTROSPECTION_FAKES_URL`
environment variable, else `http://fakes:7353`, the trial's `fakes` service.
It is reached without the trial's proxy.

Every check raises on an empty set of manifests rather than passing, and
compares states as JSON, so `false` and `0` differ.

- **"No state changed" reads state.** It compares the entities some tool of
  the fake writes, which include outbound effects such as sent emails and the
  send attempts a mail fake rejected. A rejected write or a no-op call is not a
  change; a change undone later in the trial is not seen, so a case that
  forbids a temporary change records each transition in the fake's state.
- **"No write attempted" reads the trajectory.** It counts a call to a write
  tool whether or not the call changed anything, so name and score it as an
  attempt check, beside the state check rather than instead of it. A call is
  matched by the name Pi gives an MCP tool, from the fake's id (its directory
  under `fakes/mcp/`, which is the server id the Recipe declares) and the
  tool's name in its contract; `readOnlyHint` plays no part.

### Reading the fakes' answers

`introspection_harbor.answers` reads a tool's successful answer as
`@introspection-ai/mcp-fakes/answers` does: decoded by its format (`json`,
`toon`, `prefixed_json`, or `text`) and validated against its JSON Schema.
`mcp-fakes serve` writes each fake's answers beside its manifest, as
`mcp/<id>/answers.json` under `MCP_FAKES_MANIFEST_DIR`. TOON is read with
`toon-format`, a dependency of this package, so a task's `test.sh` needs no
`--with toon-format`.

```python
from introspection_harbor.answers import load_answers, read_result

ANSWERS = load_answers(Path("/opt/fakes-verifier/mcp"))

for call in server_calls(tool_calls(load_trajectory()), "attio", ANSWERS["attio"]):
    if call["isError"]:
        continue
    read = read_result(
        ANSWERS["attio"][call["name"]], call["response"], call.get("structured")
    )
    if not read["ok"]:
        raise ValueError(
            f"attio answered {call['name']} outside its contract: {read['error']}"
        )
    rows = read["value"]
```

| Function | Returns |
| --- | --- |
| `load_answers(directory)` | `{id: {tool: answer}}` from `<directory>/<id>/answers.json`; raises when the directory is missing or holds no answers |
| `read_answer(answer, text)` | `{"ok": True, "value"}`, or `{"ok": False, "error", "issues"}` for text not in the answer's format or a value outside its schema; each issue is `{"path", "keyword", "message"}` |
| `read_result(answer, text, structured=None)` | The same, read where the answer is: the `structured` content of a tool that states an `outputSchema` (`"structured": true` in its answer), whose text is ignored; the text of any other. Without `structured` content such a tool's read fails |
| `decode(answer, text)` | The decoded value, unchecked; raises `ValueError` for text not in the format |

An answer that fails to read is the fake's fault, not the agent's, so treat it
as an invalid measurement rather than a failed criterion. Both packages' tests
run the cases in `integrations/testdata/fakes/answers.json`, so the two read an
answer alike.

`@introspection-ai/mcp-fakes/verify` holds the same checks for a vitest eval
(`changedEntities`, `writeAttempts`), and both packages' tests run the cases in
this repository's `integrations/testdata/fakes/cases.json`, so the two runners
score a trial alike.

## Adapters, one launch

`introspection eval run` selects `introspection_harbor.agent:IntrospectionRecipeAgent`;
`INTROSPECTION_HARBOR_ADAPTER` decides which adapter that resolves to. `runtime`
and `bootstrap` share `base.py`: the run spec, the Pi invocation with the
egress-proxy extension, the captured `pi.jsonl`, and the ATIF trajectory. They
differ only in how the Recipe and Pi reach the trial. `native` launches no Pi:
each step is a run on the trial's evaluation task, so the task carries the
prompt and the platform stores the conversation a judge reads.

| `INTROSPECTION_HARBOR_ADAPTER` | Trial image | What `install` does | Evidence |
| --- | --- | --- | --- |
| `runtime` (default) | the Runtime image | exposes the image's own Pi; downloads nothing | `pi.jsonl` in the trial |
| `bootstrap` | any image (a pinned SWE world, a customer base) | uploads the Recipe workspace from the host, installs Node and the CLI, lets `introspection setup` install Pi and the Recipes extension, lays it out as the Runtime image does, under `/tmp/introspection` (`recipe` + `runtime` link, with the proxy module) | `pi.jsonl` in the trial |
| `native` | the Runtime image, on the `introspection` environment | nothing; each step is `POST /v1/tasks/{id}/runs` | the task's conversation, read back once ingest settles |

```sh
# a foreign image: bootstrap the Recipe into it
INTROSPECTION_HARBOR_ADAPTER=bootstrap introspection eval run --runner harbor --path evals/swe-task
```

### Committed candidates through an existing Runtime

Use `introspection eval run --runner harbor --runtime <slug-or-id>
--commit-sha <full-pushed-sha> --path <recipe-relative-suite> --agent <name>`.
The CLI fetches the exact SHA from the Runtime's registered Recipe repository
using the existing Git credential helper and checks it out temporarily for
Harbor suite discovery. It keeps the Runtime selected by `--runtime`; every
trial sends that Runtime ID and the candidate SHA to the Task API. Neither a
local checkout nor a branch flag is required. Operator forwards `--commit-sha`
to this same command. Naming `IntrospectionEnvironment` by hand through `--env`
without `--commit-sha` sends the local `HEAD` as the commit to materialize, so
the CLI refuses a dirty working tree or a commit on no remote branch: the plane
evaluates what was pushed, never the working tree.
Committed-run results default to the invoking directory's `eval-runs/` (or
`INTROSPECTION_EVAL_RUNS_DIR`); they survive checkout cleanup. Any explicit
Harbor `--jobs-dir` must be an absolute path outside the temporary checkout.

The Task API resolves that Runtime's trusted `RuntimeSpawnContext` and replaces
only its Recipe commit for the eval Task. Repository, subpath, Runtime identity,
bindings, resources, and image policy remain server-owned. The trial reuses the
selected Runtime's published image. Runtime-agent stages the exact candidate
checkout in the writable Task workspace, clears the baked Recipe directory's
contents, copies the selected Recipe subpath into that existing directory, and
reruns normal Recipe setup. The disposable sandbox keeps no backup of the baked
source. There is no second workspace repository, manual token handling,
uploaded checkout helper, candidate archive, or candidate bake. The pushed
commit does not need its own Runtime-version record. A checkout, replacement,
materialization, or dependency setup error is infrastructure/setup failure,
not an agent regression.

Run the focused adapter checks with:

```sh
uv run python -m unittest tests.test_task_environment
```

These prove server-derived candidate selection, committed provenance, and the run
environment without starting a platform Task or calling a model. The Harbor package must be released and
installed in Operator before the production wrapper selects this adapter; the
local Operator build already consumes the CLI checkout's Harbor wheel.

Operator also sets `INTROSPECTION_EVAL_RUNS_DIR` to its Task outputs
`eval-runs/` directory. The CLI writes native artifacts and `run.json` there
directly, so their recorded paths survive detached-checkout cleanup. It must
be an absolute path. `introspection eval view` honors the same override.
Standalone CLI runs still default to Recipe-local `eval-runs/`; generated
results are never included in committed candidate transport.

### Which images the bootstrap adapter can use

The bootstrap installs a toolchain into someone else's image, and on an
Introspection sandbox it does so as an ordinary user with no way to become root.
That rules two shapes out, and the prerequisite step refuses them by name rather
than letting a package manager fail on permissions several steps into a trial:

| Image | Bootstrap | Why |
| --- | --- | --- |
| Node >= 24 already installed | works | npm's global prefix is moved to `$HOME/.local`, since the image's own is root-owned |
| glibc, no Node, `curl` and `bash` present | works | nvm installs Node under `$HOME`, which needs no root |
| glibc, no Node, no `curl` | refused | installing curl needs a package manager, which needs root |
| glibc, no Node, `curl` but no `bash` | refused | nvm is bash software; the toolchain step runs under bash for that reason |
| musl (Alpine), no Node | refused | `apk` needs root, and nvm's official binaries do not run on musl |

A refused image is not a bug to work around in the adapter — bake Node (or curl)
into it, or use the `runtime` adapter with a Runtime image instead.

Two suites cover this. `tests/test_bootstrap_shell.py` runs the generated
commands under `sh` with the probes they branch on replaced by stubs, so every
shape is exercised anywhere with no container and no root.
`tests/test_bootstrap_docker.py` runs them against the real base images as uid
1000, which is the only way to see whether the branch that runs actually works:

```sh
HARBOR_BOOTSTRAP_DOCKER=1 uv run python -m unittest tests.test_bootstrap_docker
# add HARBOR_BOOTSTRAP_DOCKER_NETWORK=1 for the cases that install from npm
```

Each shape can be pointed at a different image (`HARBOR_IMAGE_NODE`, `_MUSL`,
`_BARE`, `_CURL`) for a network that cannot reach Docker Hub, and
`HARBOR_BOOTSTRAP_DOCKER_CA` mounts a CA for a TLS-intercepting egress proxy.
Use `HARBOR_BOOTSTRAP_DOCKER_UID` where a mirror image happens to grant uid 1000
ownership of its npm prefix, which a stock image does not.

## Where the bootstrap adapter puts things

Everything the bootstrap installs lives under **`/tmp/introspection`**:

| Path | What it is |
| --- | --- |
| `/tmp/introspection/workspace` | the Recipe workspace uploaded from the host |
| `/tmp/introspection/recipe` | a link to the Recipe inside that workspace — what Pi is pointed at |
| `/tmp/introspection/runtime` | the proxy module, linked as the Recipe's `runtime` |

Not `/opt/introspection`, which is where the *Runtime image* bakes its own
Recipe. A foreign image is someone else's: `/opt` is root-owned, the trial runs
as an ordinary user, and on an Introspection sandbox `pods/exec` cannot run a
command as anyone else — so `exec_as_root` is not root there and the first
`mkdir` fails. `/tmp` is the one directory every image grants an arbitrary uid
(mode 1777), and unlike `$HOME` it is there whether or not the image gave that
uid a home. Only the system package install (`curl`, for the nvm branch) still
asks for root, and it refuses by name when it does not have it.

The toolchain itself goes to `$HOME`: npm's global prefix moves to
`$HOME/.local` on the system-Node branch, and nvm keeps its own prefix under
`$HOME/.nvm`.

## The Introspection environment

The adapters above choose how the *agent* reaches the trial. The environment
chooses where the trial *runs*, and `IntrospectionEnvironment` runs it in an
Introspection evaluation task:

```sh
introspection eval run --runner harbor --path evals/refund-task -- \
  --env introspection_harbor.task_environment:IntrospectionEnvironment
```

`start` creates a `kind: eval` task on the Recipe's Runtime, tagged `harbor`,
with `commands: true` and the task's own `docker-compose.yaml` as its
`compose`. Everything Harbor asks of the environment afterwards — `exec`,
`upload_file`, `download_file`, and the healthchecks and directory helpers the
base class derives from `exec` — becomes a row on
`POST /v1/tasks/{id}/commands` that the task workflow runs in that sandbox.

The point of doing it on this axis: Harbor keeps the trial. The verifier runs
through the same channel, in the same sandbox the agent worked in, so a task's
own `tests/test.sh` produces the reward. The alternative — creating a platform
task from an *agent* adapter and leaving the Harbor environment idle — reads
the Recipe's judges back instead, which measures a Recipe but cannot score
somebody else's benchmark. That shape was prototyped and withdrawn.

### A verifier that calls a model

A judge script in `tests/test.sh` that uses the OpenAI or Anthropic SDK, or
LiteLLM, works unchanged. Its calls use the sandbox's managed credential.

Do not pass a provider key in `[verifier.env]`; it is ignored. Other providers
are not supported for judges yet.

`main` is the agent slot and the Runtime image fills it — the agent base plus
the Recipe, either baked or materialized from git — so the eval logic belongs
in the Recipe repository beside the Recipe it measures. A `main` service
therefore carries only `volumes` and `depends_on`, and a task that declares
its own `image:` or `build:` there is **refused by that key** rather than
trimmed: dropping it would run the trial in an image the task did not ask for
and report the number as though it had. The same goes for an
`environment/Dockerfile` that no sidecar builds from — for a task with no
compose file at all, that is the only signal it was written for an environment
that builds its own main.
Every other service is a sidecar, and a sidecar may only name an image the
plane produced — so a `build:` context is packed, uploaded and built through
`POST /v1/images`, and an `image:` is mirrored, which requires it to be
digest-pinned. Every task sends a `compose`, even one with no file of its own: Harbor's
`/logs` and `/tests` sit directly under `/`, which the sandbox user cannot
create, so they are mounted as named volumes the platform renders as
emptyDir under the pod's `fsGroup`. `_reset_dirs_user` is overridden to the
sandbox user for the same reason — asking for root produced a request the
sandbox silently ignored and a `mkdir` that failed as if the trial had.

Credentials resolve as the CLI's own Data-Plane commands do: `INTROSPECTION_DP_URL`
and `INTROSPECTION_TOKEN` first, then the profile `introspection login` wrote.
Resolving a Runtime slug to its active version is a Control-Plane read, so a run
that selects the Runtime by slug, or with `--commit-sha`, needs a login with a
project selected. A run pinned to a Runtime version does not (below).

`introspection eval run` renews the stored login for as long as Harbor runs, so
a run may outlive the access token it started with: the CLI refreshes the
profile once the token has five minutes left, and a trial whose token is
rejected reads the profile again and repeats the request once. An
`INTROSPECTION_TOKEN` is used as given and is never renewed, and neither is the
login under `harbor run` invoked directly.

**A browser login is not sufficient on its own.** A trial needs `tasks:eval` to
create the task, `images:write` to build a sidecar and `tasks:exec` to run a
command, all of which are in the `evals` capability — and a CLI login carries
`runtimes` and `reviews` only. Set `INTROSPECTION_TOKEN` to a project API key
minted with **both** `evals` and `runtimes`: the second is not redundant, since
uploading a sidecar's build context goes through the Files API and `files:write`
is in the `runtimes` bundle rather than `evals`. With a login alone the
Control-Plane resolution succeeds and the task create then 403s.

### Under a service credential

A trial pinned to a Runtime version makes no Control-Plane request, so a service
credential alone runs it, with no person's login: a service account's Data-Plane
token (an Application's `client_credentials` token for the project, its
`allowed_scopes` naming `evals` and `runtimes`) or a project API key with those
capabilities. A CI job holding either runs it:

```sh
INTROSPECTION_DP_URL=https://api.<plane> \
INTROSPECTION_TOKEN=<service account token or project API key, with evals and runtimes> \
INTROSPECTION_HARBOR_ENVIRONMENT=introspection_harbor.task_environment:IntrospectionEnvironment \
introspection eval run --runner harbor --path evals/refund-task \
  --runtime support-agent --runtime-version <runtime version UUID>
```

`--runtime` names the Recipe's local Runtime manifest by slug and
`--runtime-version` pins the platform Runtime version the trial starts on. The
trial materializes the checkout's `HEAD`, which must be committed and pushed.
Redeploying the Runtime makes a new version, which the caller then pins.

| Variable | What it changes |
| --- | --- |
| `INTROSPECTION_HARBOR_TASK_ENVIRONMENT` | the Runtime's environment lane for version resolution (default `production`) |
| `INTROSPECTION_HARBOR_SANDBOX_PROVIDER` | pins the task to a sandbox provider |
| `INTROSPECTION_HARBOR_TRIAL_TIMEOUT_SECONDS` | the sandbox's wall-clock ceiling, as the task's `idle_timeout_seconds` (default 3600) |
| `INTROSPECTION_HARBOR_START_TIMEOUT_SECONDS` | how long to wait for the sandbox to accept commands, including queueing (default 3600) |
| `INTROSPECTION_HARBOR_IMAGE_TIMEOUT_SECONDS` | how long to wait for a sidecar image to build (default 1800) |
| `INTROSPECTION_HARBOR_EXEC_TIMEOUT_SECONDS` | the default per-command bound (default 900) |

### Timeouts, admission and fan-out

`idle_timeout_seconds` is the trial's wall-clock ceiling, not a grace period
before the first command. Commands reach the sandbox through `pods/exec`,
which the runtime agent never observes, so the idle seconds it reports climb
for the whole trial however busy Harbor is. That is deliberate: it is also
what releases the sandbox of a trial that has wedged. Size `INTROSPECTION_HARBOR_TRIAL_TIMEOUT_SECONDS` to the longest trial you
expect, not to the pause before Harbor starts work.

**A trial cannot exceed two hours.** The plane clamps `idle_timeout_seconds` to
the task's own `timeout_seconds`, and that field is not on `POST /v1/tasks` —
it sits on the internal workflow request at a fixed 7200s — so no caller can
raise it. Configuring a longer budget is refused at startup rather than
accepted and halved.

Trials are admitted per org on the vqueue `eval` lane, so a task can sit in
`pending` / `queued` / `scheduled` for a while before its sandbox exists. The
adapter waits through those patiently and the idle clock does not start until
the sandbox is running, so queueing does not eat the trial's budget. It does
eat a Harbor worker slot, though: Harbor's `n_concurrent_trials` defaults to
4, and setting it above the org's `eval_concurrency` just parks the excess
trials inside `start`. Match the two.

### Directories, and which ones exist

Harbor's blessed set is `EnvironmentPaths`, a frozen dataclass — there is no
task field for declaring extra directories. Harbor writes into these and
`start` creates the `/logs` children, but none can be created directly under a
root-owned `/` as uid 1000, so the adapter mounts them as compose named
volumes, which the platform renders as `emptyDir` under the pod's
`fsGroup: 1000`.

| Path | Mounted | What writes it |
| --- | --- | --- |
| `/logs` | yes | Harbor. Its children are the directories Harbor bind-mounts on a mounted provider (`agent/`, `verifier/`, `artifacts/`, and `user-agent/` for a simulated user), and Harbor creates only `verifier/` itself, before verifying, so `start` creates each one inside the mount once the sandbox accepts commands |
| `/logs/verifier/reward.{txt,json}` | — | the verifier's result, read back as the trial's reward |
| `/tests` | yes | the Verifier, after the agent runs |
| `/solution` | yes | the OracleAgent only |
| `/harbor/skills` | **no** | an agent *reads* it, guarding on `is_dir` — an empty mount would answer "yes, skills" where the truth is "no skills" |

Anything else a task needs writable — `/app`, `/srv`, `/data`, whatever its own
Dockerfile used — is the task's to declare, in the compose document it already
sends:

```yaml
services:
  main:
    volumes: [task-app:/app]
volumes:
  task-app:
```

`main` accepts `volumes` and `depends_on` and nothing else, and the platform
mounts them on the agent container. This needs no new field anywhere.

**What a volume does not give you.** It is an *empty* writable directory, not
the task image's contents. The Runtime image fills the `main` slot, so
everything the task's own Dockerfile set up — a seeded `/app`, installed
packages, fixture files — is absent, and mounting a volume over such a path
would mask whatever the Runtime image had there. This closes "the directory
does not exist and is not writable"; it does not close "the task's files are
missing". A task that needs its own filesystem wants the `bootstrap` adapter or
a Runtime built from its image.

### Transfer artifacts

Uploads are staged through the Files API as raw (`encryption: false`) files
stamped `purpose: harbor_transfer`. The adapter attempts best-effort deletion as
soon as the sandbox has the bytes. An `evals` API key includes `files:delete`,
so direct CLI orchestration can soft-delete their rows; the Operator session deliberately
lacks that destructive scope, so its delete is refused and suppressed rather
than turning a successful trial into a cleanup failure. No TTL or transfer-file
sweep currently exists. The Files API delete does not itself erase blob bytes.
Download outputs also use raw storage (`metadata.encryption=false`) and have
the same retention limitation. This applies to Harbor's remaining test-input,
prompt, replay, sidecar and result transfers; candidate Git checkout and setup
do not create transfer Files.

Trial Task cleanup archives the remote task through the SDK's `tasks.archive`
operation (`tasks:write`), retaining its record for inspection and platform
teardown judging. Harbor's `--no-delete` skips this call and leaves the remote
task available for debugging, subject to its configured wall-clock ceiling.
Archive requests asynchronous teardown of the sandbox and sidecars; acceptance
does not confirm that resources have stopped. Harbor does not poll for teardown.
Cleanup remains best effort: an API error is logged at debug level and suppressed
so it does not turn a valid verifier score into `completed_with_errors` or mask
an agent or verifier failure. The task's configured wall-clock ceiling remains
the fallback. This does not change platform judge eligibility.

Known gaps, all of them in the command contract rather than this adapter:
`exec`'s `user` cannot be honoured (the sandbox runs every command as its own
user, so the argument is ignored and a command that needed another user fails
on its own exit code); the network policy is fixed when the pod is created, so
`set_network_policy` mid-trial is refused; and a command row carries a bounded
output tail rather than unbounded output, so a chatty command wants
redirect-then-download. `stop_service` is the one per-service operation this
adapter cannot offer — a pod's containers stop together — so sidecar evidence
is collected with the agent still running, which Harbor treats as a warning.

Sidecar artifact collection and verifier collect hooks do work: `service_exec`
and `service_download_file` address one compose service through the command's
own `service` field, the directory walks are generic over that pair, and the
plane refuses a service the task did not declare in its own compose. A sidecar
command inherits none of the agent's workdir, user or persistent environment,
as on every other compose-capable provider.

## What the runtime adapter does

The trial image is the Runtime image the Data Plane published for the Recipe,
so the Recipe (`/opt/introspection/recipe`), Pi, the Recipes extension, and the
Introspection CLI are already inside it. The adapter installs nothing. Per
trial it:

1. writes a `pi` launcher for the image's own Pi when the image has none on
   `PATH` (the Operator image already provides one);
2. uploads the Harbor instruction, or the CLI-selected replay prompt, as a
   prompt file and runs the baked Recipe:

   ```sh
   pi --recipe /opt/introspection/recipe \
     --session-dir /logs/agent/pi/sessions \
     --print --mode json --approve \
     @/tmp/introspection-eval-prompt.md
   ```

   A production-conversation replay runs the same command through
   `introspection local --replay-context`, which creates the temporary native
   Pi session immediately before Pi starts. Every step after the first adds
   `--continue` when the run resumes (see [Multi-step tasks](#multi-step-tasks));
3. captures Pi's JSON event stream as `pi.jsonl` under the agent log directory
   and converts it into `trajectory.json` (ATIF) with token usage, cost, and
   the observed model, which `introspection eval run` verifies against the
   agent YAML.

Recipe source is never uploaded or patched inside the trial. An exact-commit
evaluation uses the selected Runtime version's published bake when available;
its ordinary cold path otherwise materializes that version's requested SHA
before this adapter runs.

## E2B through scoped Data Plane egress

Operator can use E2B without receiving a real E2B, OpenAI, or Anthropic key.
Configure E2B in the Data Plane's `sandbox_providers`; `weight: 0` keeps it out
of normal traffic while allowing an explicitly pinned Operator task to use it.
Then select the Introspection environment class in the arguments forwarded to
Harbor, naming the Runtime's published template:

```sh
introspection eval run --runner harbor --path evals/refund-task -- \
  --env introspection_harbor.environment:IntrospectionE2BEnvironment \
  --environment-kwarg "template_name=$(introspection runtimes get "$RUNTIME_ID" \
    --query image_build_metadata.external_image_name -o json | jq -r .)"
```

Harbor's native E2B implementation still owns preflight, sandbox creation,
resources, and networking. The adapter only:

- skips Harbor's template build when `template_name` names a published
  Runtime template, and defaults the task workdir to the baked Recipe;
- copies the scoped public-egress contract (`INTROSPECTION_TOKEN`,
  `INTROSPECTION_PUBLIC_EGRESS_URL` as the trial's `INTROSPECTION_EGRESS_URL`,
  `INTROSPECTION_ENDPOINT_HOSTS`, and `INTROSPECTION_RELAY_TARGET` when set)
  into the trial through Harbor's supported `persistent_env` input. A template
  snapshot carries no session state, so this is the only way the baked Pi
  learns where its egress is. The Data Plane exchanges the locator for
  credentials at egress; model provider keys never enter the trial;
- forwards the host variables named in `INTROSPECTION_HARBOR_PASSTHROUGH_ENV`
  (comma-separated) for direct, non-egress runs such as a laptop trial with a
  developer's own provider key.

The platform Operator image sets
`INTROSPECTION_HARBOR_ENVIRONMENT=introspection_harbor.environment:IntrospectionE2BEnvironment`.
When the variable is set, `introspection eval run` supplies that environment to
Harbor unless the caller explicitly passes `--env` or `-e`. Ordinary developer
installs leave it unset, so the same command keeps Harbor's local Docker default.

When none of the three Introspection egress variables are set, the same class
adds no egress configuration and Harbor uses E2B's normal environment and
credentials. A partial egress contract is rejected rather than silently mixing
direct and routed traffic.

## A Pi Recipe as Harbor's user agent

`introspection_harbor.pi_user_agent:PiRecipeUserAgent` runs a Pi Recipe on the
host as Harbor's user agent: the Recipe talks to the target coding agent
(Claude Code first) through Harbor's ACP bridge. What the user agent says,
when it stops, what it may share and what it records all belong to the Recipe
(for example the owner Recipe in `introspection-operator-evals`). This adapter
only runs Pi and serves the Recipe a few environment primitives. It is a plain
Harbor agent in the Harbor process, named by `user_agent.import_path` in a job
config:

```yaml
agents:
  - name: claude-code
user_agent:
  import_path: introspection_harbor.pi_user_agent:PiRecipeUserAgent
  model_name: openai/gpt-6-luna          # Pi's model
  kwargs:
    recipe_dir: recipes/owner            # the Recipe folder on the host
    tools: [say, share_media, done]      # the model-callable tools: Pi's --tools
    agent: owner                         # optional: the Recipe agent
    inputs:                              # optional: JSON data for the Recipe
      task_dir: use-cases/outbound-desk/tasks/create-1
  bridge:
    kind: acp
```

Other `kwargs`: `prompt` (Pi's first message; default: the trial's
instruction), `target_capabilities` (default: what the target's ACP session
advertised, read with `acpx sessions show`), `workspace_dir` (where relative
`upload_file` targets go; default: the container's working directory),
`exec_timeout_sec` (default 900) and `pi_command`.

`tools` is required: it lists the Recipe's own tools the model may call, and
goes to Pi as `--tools`. An entry is a name or a pattern with `*`. An entry
that names or matches `codemode`, `tool_search` or an MCP tool (`mcp__...`),
a `+name`/`-name` entry, or one with a comma or whitespace (Pi splits `--tools`
on commas, so `say,codemode` would enable `codemode`) is refused, since through
any of them the model could call the primitives itself (see below).

Its `setup` is empty: Harbor sets up the user agent before the target and the
bridge, so `acpx` is only there once `run` starts. `run` starts
`pi --print --mode json --no-context-files --recipe <recipe_dir> --tools <tools>`
once, for the whole conversation, in a fresh host temp directory. Pi's exit
ends the run, and a non-zero exit fails it.

### The primitives

The primitives are MCP tools on a streamable-HTTP server inside the Harbor
process, on 127.0.0.1 with a per-run bearer token. Pi gets both in its
environment:

| Variable | Value |
| --- | --- |
| `INTROSPECTION_USER_AGENT_URL` | The endpoint, `http://127.0.0.1:<port>/mcp` |
| `INTROSPECTION_USER_AGENT_TOKEN` | Send it as `Authorization: Bearer <token>` |

A Recipe extension registers the server with Pi's own MCP client and calls a
primitive from its tools with `ctx.executeTool`:

```ts
export default function (pi) {
  pi.registerMcpServer("harbor", {
    url: process.env.INTROSPECTION_USER_AGENT_URL, // Pi refuses `${...}` in `url`
    headers: { Authorization: "Bearer ${INTROSPECTION_USER_AGENT_TOKEN}" },
    exposure: "codemode",
  });
  pi.registerTool({
    name: "say",
    // label, description, parameters ...
    async execute(id, params, signal, onUpdate, ctx) {
      const outcome = await ctx.executeTool(
        "mcp__harbor__prompt_target",
        { prompt: [{ type: "text", text: params.text }] },
        { signal, onUpdate },
      );
      const { reply, exit_code } = JSON.parse(outcome.result.content[0].text);
      // ... the Recipe's own rules and log ...
    },
  });
}
```

Pi expands `${NAME}` in `headers`, so the token stays out of the extension's
code; `url` must already be a URL when it is registered, so it is read from
`process.env`. `tests/fixtures/synthetic-recipe` is a complete Recipe in this
pattern.

`exposure: "codemode"` keeps the primitives out of the model's tool list, but
Pi turns its `codemode` tool on as soon as such a server connects, and a
codemode script can call them. That is why `tools` is a `--tools` allowlist
without `codemode`: the model reaches the target only through the Recipe's own
tools, and the Recipe's limits (a message cap, media rules) can't be bypassed.
`executeTool` doesn't depend on the model's tools, so the extension still
reaches every primitive.

A prompt can wait minutes for the target's turn, longer than Pi's 60-second
MCP request timeout. Pi sends a `progressToken` with each call, and the server
answers with a progress notification every 15 s while the call runs. Each one
resets the timeout and reaches the extension's `onUpdate`. Any other MCP
client works too: one JSON-RPC request per POST, answered as a server-sent
event stream, with a comment every 15 s when the request has no
`progressToken`.

A result is the tool's JSON object, in `structuredContent` and as the text
content (through `executeTool`, `outcome.result.content[0].text`). `isError: true`, with the message as text, means the primitive could
not run: bad arguments, or the environment raised. A non-zero exit of `acpx`
or of a command is data, in `exit_code`.

| Tool | Arguments | Result |
| --- | --- | --- |
| `prompt_target` | `prompt`: ACP's own prompt array of content blocks (`ContentBlock[]`), sent as-is. Each block needs a `type`; at least one block is needed. | `{reply, exit_code}`. One ACP prompt through `acpx prompt --file`; the blocks are written as JSON on the host (kept as `prompts/NNN.json`), uploaded and sent. Prompts run one at a time. acpx prints an error on stdout too, so only `exit_code` tells a reply from an error. |
| `upload_file` | `source`: a host path; `target`: a container path, relative to the workspace or absolute | `{path}`, the container path written. Parent directories are created. |
| `exec` | `command`: a shell command; `cwd?`; `timeout_sec?` (default `exec_timeout_sec`) | `{exit_code, stdout, stderr}` |
| `context` | none | `{logs_dir, target_capabilities, workspace_dir, instruction, inputs}`: see below |

`context` fields:

- `logs_dir`: the run's host directory. Whatever the Recipe writes there ends
  up in `<trial>/user-agent/`.
- `target_capabilities`: the target's ACP prompt capabilities, for the Recipe's
  own gating. acpx refuses an `audio` or `resource` block the target didn't
  advertise.
- `workspace_dir`: the container directory relative `upload_file` targets
  resolve against.
- `instruction`: the trial's instruction.
- `inputs`: the job's `inputs`, as given.

A call lasts no longer than its connection. When Pi exits or is killed, or
Harbor cancels the trial, every call still running is cancelled and awaited
before anything is copied.

### What the target can see

Harbor bind-mounts the trial's log directory into a Docker container, so the
target could read `<trial>/user-agent/` while it runs. So `logs_dir` in
`context` is a host temp directory, not that one. The temp directory (Pi's
`pi.jsonl` and `pi-stderr.log`, `sessions/`, `prompts/`, and what the Recipe
wrote) is copied into `<trial>/user-agent/` only once Pi has exited and every
primitive call has ended. The token is never written to a file. Only what the
Recipe sends with `prompt_target`, `upload_file` or `exec` reaches the
container. Claude Code's ACP shell tool (`mcp__acp__Bash`) does see the
target's credential: in a trial, `CLAUDE_CODE_OAUTH_TOKEN` was set in its
environment, so a command the agent runs there has it.

The trial result's agent metadata carries `user_agent: {exit_code, prompts}`,
plus `metadata` with the contents of `metadata.json`, when the Recipe wrote one
to `logs_dir`.

### A Recipe as the target

The runtime and bootstrap adapters are ACP targets too, so the user agent can
talk to a Recipe instead of Claude Code:

```sh
introspection eval run --chain use-cases/<case>/chain.yaml --agent <recipe agent> \
  --user-agent introspection_harbor.pi_user_agent:PiRecipeUserAgent --bridge acp ...
```

Harbor's bridge then calls the adapter's `acp_install` after `install`: it
installs `pi-acp@0.0.34` into `/tmp/introspection-acp` and writes two
launchers there. `pi` runs Pi with the same Recipe, agent, provider extension,
skills and runtime preloads as an authored run; pi-acp adds `--mode rpc` and
the session itself. `acp_command` starts pi-acp with that launcher as
`PI_ACP_PI_COMMAND`, `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` (so the Recipe may
send `resource` blocks), Pi's sessions under `/logs/agent/pi/sessions` and the
spans in `/logs/agent/genai-spans.json`. Pi runs in the session's directory,
the task's workspace, and its stderr goes to `/logs/agent/pi-stderr.log`.
Under managed egress `acp_env` hands the provider key on to acpx, pi-acp and
Pi, as Harbor does with the target's `--ae` variables; nothing is written into
the container.
A trial that is not driven over ACP installs nothing more. The native adapter
is no ACP target: the platform runs its Recipe, so there is no process to
attach to.

## Where this is heading

The adapter has two seams: how the Recipe is launched (`run`) and how the
result is collected (`populate_context_post_run`). Today the launch executes Pi
inside a Harbor-owned sandbox and the result is read back from that sandbox as
`pi.jsonl`. A bare `pi` process exports no telemetry, so nothing from a trial
reaches the platform's conversation store.

The intended end state keeps Harbor as the trial orchestrator but moves both
seams onto the platform: the launch becomes a task on the Runtime, and the
result is read from that task's conversation and judgement events, which the
Runtime already exports. That removes the direct E2B dependency and the
file-based verifier from the path, and a Recipe judge becomes the reward.

## End-to-end MCP example

[recipe-harbor-mcp-agent](https://github.com/introspection-org/recipe-harbor-mcp-agent)
runs a Harbor trial in E2B against a published Runtime whose Recipe calls an
authenticated MCP server. See that repository's README for the setup and the
`scripts/run-e2b.sh` helper.

### Explicit offline judgement subjects

A verifier that calls `introspection judges evaluate` can publish its completed
judgement through the standard OTLP judgement event by passing both
`--runtime-slug <slug>` and `--conversation-id <evaluated-conversation-id>`.
Use the evaluated trial's conversation ID, not the parent command's ambient
conversation. The YAML `name` supplies the judge slug; each grading attempt
mints a UUIDv7 result ID. The existing session token and collector must be
available to the verifier. Production `judges run` keeps its registry identity
and deterministic deduplication IDs.
