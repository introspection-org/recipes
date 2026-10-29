"""Shared shape of every Introspection Harbor adapter.

An adapter differs only in how the Recipe and Pi reach the trial (``install``).
What is common lives here: the run spec ``introspection eval run`` hands over,
the Pi invocation with the runtime proxy and telemetry preloads, the captured
event stream, and the ATIF conversion Harbor needs for model, usage and cost.

The same adapter is also an ACP target. In a trial with a simulated user
(``bridge: {kind: acp}``) Harbor never calls ``run``: the user agent reaches
the Recipe through ``acpx``, which starts ``acp_command()`` in the container.
That is pi-acp driving the same Pi invocation in RPC mode.
"""

from __future__ import annotations

import json
import os
import shlex
import tempfile
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, override
from uuid import UUID

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import (
    BaseInstalledAgent,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.agents.protocols.acp import ACPAgentMixin
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.bridge import BridgeKind
from harbor.models.task.config import MCPServerConfig
from harbor.utils.trajectory_utils import compute_model_usage
from introspection_sdk.schemas.genai_span import GenAiSpan

from .trajectory import (
    ADAPTER_VERSION,
    pi_messages,
    pi_terminal_provider_error,
    read_spans,
    spans_to_trajectory,
)

RUN_SPEC_ENV = "INTROSPECTION_EVAL_RUN_SPEC"
# Where the Runtime image puts the Recipe. Mirrors INTROSPECTION_RECIPE_ROOT's
# default in the runtime image (runtime/constants.ts defaultRecipeRoot); this
# adapter runs on the host, not in the sandbox, so it cannot read that variable
# and has to state the path. One constant, imported by everything that needs it
# — there were two copies of this string with different names.
#
# An adapter that materializes the Recipe into a foreign image cannot write
# here — /opt is root-owned and a sandbox runs as an ordinary user — so it
# overrides `recipe_dir` and the shared commands below take the directory as
# an argument rather than reading this constant.
BAKED_RECIPE_DIR = "/opt/introspection/recipe"
# The Runtime image links the shared runtime (and its node_modules) into the
# baked Recipe, so Pi and the Recipes extension resolve from the Recipe itself.
# An adapter that materializes the Recipe elsewhere creates the same link
# beside its own Recipe, so everything below the install step is shared.
RUNTIME_LINK_NAME = "runtime"
RUNTIME_LINK_DIR = f"{BAKED_RECIPE_DIR}/{RUNTIME_LINK_NAME}"


def is_runtime_id(value: str) -> bool:
    """Whether a Runtime selector is an immutable version UUID."""

    try:
        return str(UUID(value)) == value.lower()
    except ValueError:
        return False


PI_LAUNCHER_PATH = "$HOME/.local/bin/pi"
REMOTE_REPLAY_CONTEXT_PATH = "/tmp/introspection-replay-context.json"
REMOTE_EVAL_PROMPT_PATH = "/tmp/introspection-eval-prompt.md"
# Same place Harbor's own Pi agent keeps sessions. Harbor empties the agent log
# directory before a step that starts fresh and preserves it for one that
# resumes, so a session here is exactly as long-lived as the conversation.
PI_SESSION_DIR = "/logs/agent/pi/sessions"
# The words Pi takes as a subcommand when they come first on its command line:
# the commands `pi --help` lists.
PI_SUBCOMMANDS = (
    "install",
    "remove",
    "uninstall",
    "update",
    "list",
    "config",
    "auth",
    "mcp",
)
RUNTIME_PROXY_PRELOAD_PATH = "/usr/local/lib/introspection-runtime/proxy-preload.js"
RUNTIME_TELEMETRY_PRELOAD_PATH = (
    "/usr/local/lib/introspection-runtime/cli-telemetry-preload.js"
)
RUNTIME_PROVIDER_HTTP_EXTENSION_PATH = (
    "/usr/local/lib/introspection-runtime/provider-http-pi-extension.js"
)
# The conversation as the platform's GenAI spans, beside Pi's own files in the
# agent log directory. The Recipes extension writes it during the run, to the
# path this variable names.
SPANS_FILENAME = "genai-spans.json"
SPANS_FILE_ENV = "PI_RECIPE_GENAI_SPANS_FILE"
# When the step's Pi run started, in milliseconds on the trial's own clock: the
# clock Pi stamps its messages with, so it separates this step's spans from
# those of the steps a continued session also holds.
STEP_START_FILENAME = "step-start-ms"
SESSION_TOKEN_ENV = "INTROSPECTION_TOKEN"
PROXY_KEY_ENV = "INTROSPECTION_PROXY_KEY"
PUBLIC_EGRESS_URL_ENV = "INTROSPECTION_PUBLIC_EGRESS_URL"
# The ACP server that puts Pi behind Harbor's ACP bridge, pinned like Harbor
# pins claude-code-acp for Claude Code.
PI_ACP_VERSION = "0.0.34"
# pi-acp and the two launchers below. /tmp because every image grants it to an
# arbitrary uid (see the bootstrap adapter), and not under the bootstrap's own
# base, which its install empties.
ACP_DIR = "/tmp/introspection-acp"
# pi-acp takes Pi's command as one executable (PI_ACP_PI_COMMAND) and appends
# ``--mode rpc --no-themes [--session <file>]`` itself, so the Recipe's Pi
# invocation lives in a launcher.
ACP_PI_LAUNCHER = f"{ACP_DIR}/pi"
ACP_SERVER_LAUNCHER = f"{ACP_DIR}/pi-acp"
# pi-acp drops Pi's stderr.
ACP_PI_STDERR = "/logs/agent/pi-stderr.log"
# Under managed egress the provider key Pi presents is the session locator;
# the egress proxy swaps it for the real credential. Nothing else from the
# host environment reaches the trial.
MANAGED_PROVIDER_KEYS = {
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GEMINI_API_KEY",
    "groq": "GROQ_API_KEY",
    "mistral": "MISTRAL_API_KEY",
    "openai": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "xai": "XAI_API_KEY",
}


def load_run_spec() -> dict[str, Any]:
    """The run spec ``introspection eval run --runner harbor`` wrote for us."""

    spec_path = os.environ.get(RUN_SPEC_ENV)
    if not spec_path:
        raise ValueError(
            "Introspection Harbor adapters must be launched by "
            "`introspection eval run --runner harbor`"
        )
    spec = json.loads(Path(spec_path).read_text())
    require_run_spec_v2(spec)
    return spec


def require_run_spec_v2(spec: dict[str, Any]) -> None:
    version = spec.get("schema_version")
    if version != 2:
        raise ValueError(
            f"Introspection evaluation run spec {version} is not supported. "
            "Update the Introspection CLI."
        )


def selected_prompt(spec: dict[str, Any], instruction: str) -> str:
    selected = (spec.get("input") or {}).get("prompt")
    prompt = selected if selected is not None else instruction
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("Introspection evaluation prompt must be non-empty")
    return prompt


def pi_launcher_command() -> str:
    """Write a ``pi`` launcher for the baked Pi unless the image has one.

    Pi reads a subcommand only as its first argument. Behind the extension
    flag ``pi list`` is a prompt: the readiness check ``introspection local``
    makes before a replay would run the agent on the word "list".
    """

    pi_cli = (
        f"{RUNTIME_LINK_DIR}/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
    )
    launcher = "\n".join(
        [
            "#!/bin/sh",
            'case "${1:-}" in',
            f'  {"|".join(PI_SUBCOMMANDS)}) exec node "{pi_cli}" "$@" ;;',
            "esac",
            f'exec node "{pi_cli}" \\',
            f'  --extension "{RUNTIME_LINK_DIR}/node_modules/@introspection-ai/recipes/dist/pi-extension.js" \\',
            '  "$@"',
        ]
    )
    return (
        "if command -v pi >/dev/null 2>&1; then exit 0; fi; "
        'mkdir -p "$HOME/.local/bin" && '
        f"printf '%s\\n' {shlex.quote(launcher)} > \"{PI_LAUNCHER_PATH}\" && "
        f'chmod 0755 "{PI_LAUNCHER_PATH}"'
    )


def pi_launch_args(
    candidate: dict[str, Any],
    recipe_dir: str = BAKED_RECIPE_DIR,
    provider_http_extension_path: str | None = None,
    skills_dir: str | None = None,
) -> list[str]:
    """Pi with the Recipe, its agent and the task's skills.

    What an authored run and the ACP target share.
    """

    args = ["pi"]
    if provider_http_extension_path:
        args.extend(["--extension", provider_http_extension_path])
    args.extend(["--recipe", recipe_dir])
    if candidate.get("agent"):
        args.extend(["--agent", candidate["agent"]])
    if candidate.get("model"):
        args.extend(["--model", candidate["model"]])
    if skills_dir:
        args.extend(["--skill", skills_dir])
    return args


def pi_args(
    candidate: dict[str, Any],
    spec: dict[str, Any],
    recipe_dir: str = BAKED_RECIPE_DIR,
    provider_http_extension_path: str | None = None,
    resume: bool = False,
    skills_dir: str | None = None,
) -> list[str]:
    """Build the Pi invocation, via ``introspection local`` only for a replay.

    A production-conversation replay needs the CLI to hydrate the native Pi
    session from the canonical replay context immediately before Pi starts. An
    authored run has no such state and launches Pi directly.

    ``resume`` continues the session the previous step of the same trial left
    in ``PI_SESSION_DIR``, so a later step of a multi-step task is the next
    turn of one conversation rather than a new one.
    """

    if (spec.get("input") or {}).get("replay_context_path"):
        if resume:
            # The replay context would be hydrated again over the session the
            # previous step produced.
            raise ValueError(
                "a production-conversation replay cannot resume a previous step"
            )
        args = [
            "introspection",
            "local",
            "--work-dir",
            recipe_dir,
        ]
        if not is_runtime_id(candidate["runtime"]):
            args.extend(["--runtime", candidate["runtime"]])
        if candidate.get("agent"):
            args.extend(["--agent", candidate["agent"]])
        args.extend(["--replay-context", REMOTE_REPLAY_CONTEXT_PATH])
        # After `--`: the CLI hydrates the replay into the session directory Pi
        # is given, and leaves it there for the span rendering.
        args.extend(["--yes", "--non-interactive", "--"])
        args.extend(["--session-dir", PI_SESSION_DIR])
    else:
        args = pi_launch_args(
            candidate, recipe_dir, provider_http_extension_path, skills_dir
        )
        args.extend(["--session-dir", PI_SESSION_DIR])
        if resume:
            args.append("--continue")
    args.extend(
        ["--print", "--mode", "json", "--approve", f"@{REMOTE_EVAL_PROMPT_PATH}"]
    )
    return args


def mcp_binding(mcp_servers: Sequence[MCPServerConfig]) -> str:
    """The task's MCP servers as Pi's ``.pi/mcp.local.json``.

    A declared ``name`` is the id of the server the Recipe declares. Pi binds
    streamable HTTP only, so any other transport is refused.
    """

    for server in mcp_servers:
        if server.transport != "streamable-http":
            raise ValueError(
                f"MCP server {server.name!r} uses transport {server.transport!r}; "
                "a Recipe binds streamable-http servers only"
            )
    return json.dumps(
        {
            "servers": [
                {"id": server.name, "transport": "streamable_http", "url": server.url}
                for server in mcp_servers
            ]
        }
    )


def prepare_recipe_command(
    recipe_dir: str = BAKED_RECIPE_DIR,
    mcp_servers: Sequence[MCPServerConfig] = (),
) -> str:
    """Check the Recipe is where the launch expects it and write its local MCP config.

    The servers a task declares in ``[[environment.mcp_servers]]`` are the
    binding. Without any, the Recipe's example file seeds it.
    """

    binding_path = f"{recipe_dir}/.pi/mcp.local.json"
    if mcp_servers:
        return (
            f"test -f {recipe_dir}/package.json && mkdir -p {recipe_dir}/.pi && "
            f"printf %s {shlex.quote(mcp_binding(mcp_servers))} >{binding_path}"
        )
    return (
        f"test -f {recipe_dir}/package.json && "
        f"if [ -f {recipe_dir}/.pi/mcp.local.example.json ] && "
        f"[ ! -f {binding_path} ]; then "
        f"cp {recipe_dir}/.pi/mcp.local.example.json {binding_path}; fi"
    )


def recipe_run_command(
    args: list[str],
    output_filename: str,
    prelude: str = "",
    recipe_dir: str = BAKED_RECIPE_DIR,
) -> str:
    """Run Pi from the Recipe root, capturing its event stream and GenAI spans.

    The Recipes extension writes the spans itself, after every turn, so a run
    Harbor cancels on a timeout still leaves the turns it finished: Harbor
    reads the agent's output and runs the verifier after a timeout too.

    ``prelude`` is shell an adapter needs before the launch (a bootstrapped
    trial sources nvm so the Node it installed is the one that runs Pi).
    """

    output_path = f"/logs/agent/{shlex.quote(output_filename)}"
    spans_path = f"/logs/agent/{SPANS_FILENAME}"
    return (
        f"{prelude}"
        "node -e 'process.stdout.write(String(Date.now()))' "
        f">/logs/agent/{STEP_START_FILENAME}; "
        # Removed first, so the file is this run's or absent: never the one an
        # earlier step left for a run that did not get as far as its session.
        f"rm -f {spans_path}; export {SPANS_FILE_ENV}={spans_path}; "
        f"cd {recipe_dir} && "
        f"{managed_runtime_preloads_command()} "
        f"{shlex.join(args)} >{output_path} 2>&1 </dev/null; "
        f"status=$?; cat {output_path}; test $status -eq 0 && test -s {output_path}"
    )


def managed_runtime_preloads_command() -> str:
    """Restore the runtime's proxy and child telemetry imports for direct Pi."""

    commands = []
    for preload_path in (
        RUNTIME_PROXY_PRELOAD_PATH,
        RUNTIME_TELEMETRY_PRELOAD_PATH,
    ):
        preload_url = f"file://{preload_path}"
        commands.append(
            f"if [ -f {preload_path} ]; then "
            f'case " ${{NODE_OPTIONS:-}} " in *"{preload_url}"*) ;; *) '
            'export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }'
            f'--import {preload_url}" ;; esac; '
            "fi;"
        )
    return "export INTROSPECTION_LOG_LEVEL=WARN; " + " ".join(commands)


def acp_pi_launcher(
    launch_args: list[str], prelude: str = "", stderr_path: str = ACP_PI_STDERR
) -> str:
    """The script pi-acp starts as Pi, with its own arguments appended.

    Pi runs in the ACP session's directory, the task's workspace, as it does
    under the Runtime; the Recipe's ``.pi/mcp.local.json`` is read from the
    Recipe directory either way.
    """

    return "\n".join(
        [
            "#!/bin/sh",
            prelude + managed_runtime_preloads_command(),
            f'exec {shlex.join(launch_args)} "$@" 2>>{shlex.quote(stderr_path)}',
        ]
    )


def acp_install_command(launch_args: list[str], prelude: str = "") -> str:
    """Install pi-acp and write the launchers ``acp_command`` starts.

    pi-acp goes into a prefix of its own rather than npm's global one, which
    is root-owned on a system Node.
    """

    pi_launcher = acp_pi_launcher(launch_args, prelude)
    server_launcher = "\n".join(
        [
            "#!/bin/sh",
            prelude,
            f'exec {ACP_DIR}/node_modules/.bin/pi-acp "$@"',
        ]
    )
    return (
        f"{prelude}"
        f"mkdir -p {ACP_DIR} && cd {ACP_DIR} && "
        "{ test -f package.json || npm init -y >/dev/null; } && "
        f"npm install --no-audit --no-fund pi-acp@{PI_ACP_VERSION} && "
        f"printf '%s\\n' {shlex.quote(pi_launcher)} >{ACP_PI_LAUNCHER} && "
        f"printf '%s\\n' {shlex.quote(server_launcher)} >{ACP_SERVER_LAUNCHER} && "
        f"chmod 0755 {ACP_PI_LAUNCHER} {ACP_SERVER_LAUNCHER}"
    )


def managed_model_environment(
    model_name: str | None, host_env: dict[str, str] | None = None
) -> dict[str, str]:
    """Provider key for the trial when the run rides managed egress.

    With a session locator and a public egress URL in the host environment,
    Pi presents the locator as the provider's API key and the egress proxy
    injects the real credential. Without them the trial gets no key from
    here; a developer's own provider key reaches it only through the explicit
    ``INTROSPECTION_HARBOR_PASSTHROUGH_ENV`` path in the environment class.
    """

    env = os.environ if host_env is None else host_env
    if not model_name or "/" not in model_name:
        return {}
    session_token = env.get(SESSION_TOKEN_ENV)
    if not session_token or not env.get(PUBLIC_EGRESS_URL_ENV):
        return {}
    managed_key = MANAGED_PROVIDER_KEYS.get(model_name.split("/", 1)[0])
    return {managed_key: session_token} if managed_key else {}


class RecipeAgentBase(BaseInstalledAgent, ACPAgentMixin):
    """Run a Recipe with Pi inside a Harbor trial and report the trajectory.

    Subclasses decide how the Recipe and Pi get into the trial (``install``);
    launching, capture and ATIF conversion are shared, and so is serving the
    Recipe over ACP (``acp_install``, ``acp_command``).
    """

    # ``resume``: Harbor calls it for the later steps of a multi-step task when
    # the run sets ``--resume-trajectory``; ``run`` then continues the Pi
    # session. ``mcp_servers``: a task's ``[[environment.mcp_servers]]`` become
    # the Recipe's local MCP bindings, and Harbor refuses such a task for an
    # agent that does not declare it. ``bridges``: Harbor's ACP bridge refuses
    # a target that does not declare it. ``skills``: a task's ``skills_dir`` is
    # handed to Pi as ``--skill``.
    capabilities = AgentCapabilities(
        atif=True,
        resume=True,
        mcp_servers=True,
        skills=True,
        bridges=frozenset({BridgeKind.ACP}),
    )
    _OUTPUT_FILENAME = "pi.jsonl"
    # Where this adapter's Recipe ends up. The Runtime image bakes it; an
    # adapter that has to create the directory itself overrides this.
    recipe_dir: str = BAKED_RECIPE_DIR
    provider_http_extension_path: str | None = None

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._spec = load_run_spec()

    @override
    def version(self) -> str | None:
        return ADAPTER_VERSION

    def run_prelude(self) -> str:
        """Shell prepended to the launch; empty when the image's Pi is on ``PATH``."""

        return ""

    def launch_args(self) -> list[str]:
        """Pi with this trial's Recipe, agent and the task's skills."""

        return pi_launch_args(
            self._spec["candidate"],
            self.recipe_dir,
            self.provider_http_extension_path,
            self.skills_dir,
        )

    @override
    async def acp_install(self, environment: BaseEnvironment) -> None:
        """Install pi-acp and the launchers on top of what ``install`` laid out.

        Harbor's ACP bridge calls this after ``install``, and only in a trial
        it drives, so a trial without a simulated user fetches nothing more.
        A production-conversation replay hydrates its session through
        ``introspection local``, which pi-acp cannot start.
        """

        if (self._spec.get("input") or {}).get("replay_context_path"):
            raise ValueError(
                "a production-conversation replay cannot be driven over ACP"
            )
        await self.exec_as_agent(
            environment,
            command=acp_install_command(self.launch_args(), self.run_prelude()),
        )

    @override
    def acp_command(self) -> list[str]:
        return [
            "env",
            f"PI_ACP_PI_COMMAND={ACP_PI_LAUNCHER}",
            # Lets the user agent send ``resource`` blocks, as it can to
            # Claude Code; acpx refuses a block the target did not advertise.
            "PI_ACP_ENABLE_EMBEDDED_CONTEXT=true",
            f"PI_CODING_AGENT_SESSION_DIR={PI_SESSION_DIR}",
            f"{SPANS_FILE_ENV}=/logs/agent/{SPANS_FILENAME}",
            ACP_SERVER_LAUNCHER,
        ]

    @override
    def acp_env(self) -> dict[str, str]:
        # Harbor merges this into every exec of the user agent, so acpx, then
        # pi-acp, then Pi inherit it; it is never written into the container.
        # The target's own ``--ae`` variables are merged in by Harbor itself.
        return managed_model_environment(self._spec["candidate"].get("model"))

    async def upload_replay_context(self, environment: BaseEnvironment) -> None:
        """Ship the canonical replay context when the CLI selected one."""

        replay_context_path = (self._spec.get("input") or {}).get("replay_context_path")
        if replay_context_path:
            await environment.upload_file(
                Path(replay_context_path), REMOTE_REPLAY_CONTEXT_PATH
            )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        candidate = self._spec["candidate"]
        prompt = selected_prompt(self._spec, instruction)
        with tempfile.TemporaryDirectory(
            prefix="introspection-eval-prompt-"
        ) as temp_dir:
            prompt_path = Path(temp_dir) / "prompt.md"
            prompt_path.write_text(prompt)
            await environment.upload_file(prompt_path, REMOTE_EVAL_PROMPT_PATH)

        env = managed_model_environment(candidate.get("model"))
        result = await self.exec_as_agent(
            environment,
            command=recipe_run_command(
                pi_args(
                    candidate,
                    self._spec,
                    self.recipe_dir,
                    self.provider_http_extension_path,
                    resume=self._resume,
                    skills_dir=self.skills_dir,
                ),
                self._OUTPUT_FILENAME,
                prelude=self.run_prelude(),
                recipe_dir=self.recipe_dir,
            ),
            **({"env": env} if env else {}),
        )
        if detail := pi_terminal_provider_error(result.stdout or ""):
            raise NonZeroAgentExitCodeError(f"Pi provider error: {detail}")

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        output_path = self.logs_dir / self._OUTPUT_FILENAME
        if not output_path.is_file():
            return
        spans_path = self.logs_dir / SPANS_FILENAME
        if not spans_path.is_file() and not pi_messages(output_path.read_text()):
            # Pi stopped before its session started, so there is no
            # conversation and the run's own error is the one to report.
            return
        spans = read_spans(spans_path)
        # A continued step's verifier grades the conversation, so the file it
        # reads covers the earlier turns too, as Harbor's own resumable agents
        # write it. Harbor uploads this directory to the sandbox afterwards.
        conversation = spans_to_trajectory(spans)
        if conversation is None:
            return
        (self.logs_dir / "trajectory.json").write_text(
            json.dumps(conversation.to_json_dict(), indent=2)
        )
        # This run alone: what the step cost.
        step_spans = self._step_spans(spans)
        step = conversation
        if len(step_spans) < len(spans):
            step = spans_to_trajectory(step_spans)
            # Harbor fills a step's per-model usage from the file unless the
            # agent reports it, which would count the earlier steps again.
            context.model_usage = compute_model_usage(step) if step else {}
        if step and step.final_metrics:
            context.n_input_tokens = step.final_metrics.total_prompt_tokens
            context.n_output_tokens = step.final_metrics.total_completion_tokens
            context.n_cache_tokens = step.final_metrics.total_cached_tokens
            context.cost_usd = step.final_metrics.total_cost_usd
        context.metadata = {
            "pi_events": self._OUTPUT_FILENAME,
            "atif": "trajectory.json",
            "introspection": (self._spec.get("input") or {}).get("metadata"),
        }

    def _step_spans(self, spans: list[GenAiSpan]) -> list[GenAiSpan]:
        """The spans of this step's Pi run; all of them without a start mark."""

        try:
            started = datetime.fromtimestamp(
                int((self.logs_dir / STEP_START_FILENAME).read_text()) / 1000, UTC
            )
        except (OSError, ValueError):
            return spans
        return [span for span in spans if span.start_time >= started]
