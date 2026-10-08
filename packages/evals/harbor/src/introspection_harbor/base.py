"""Shared shape of every Introspection Harbor adapter.

An adapter differs only in how the Recipe and Pi reach the trial (``install``).
What is common lives here: the run spec ``introspection eval run`` hands over,
the Pi invocation with the runtime proxy and telemetry preloads, the captured
event stream, and the ATIF conversion Harbor needs for model, usage and cost.
"""

from __future__ import annotations

import json
import os
import shlex
import tempfile
from collections.abc import Sequence
from pathlib import Path, PurePosixPath
from typing import Any, override
from uuid import UUID

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.task.config import MCPServerConfig
from harbor.models.trajectories import Trajectory
from harbor.models.trial.paths import EnvironmentPaths
from harbor.utils.trajectory_utils import compute_model_usage

from .trajectory import (
    ADAPTER_VERSION,
    pi_events_to_atif,
    pi_messages_to_atif,
    pi_session_messages,
    pi_terminal_provider_error,
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
RUNTIME_PROXY_PRELOAD_PATH = "/usr/local/lib/introspection-runtime/proxy-preload.js"
RUNTIME_TELEMETRY_PRELOAD_PATH = (
    "/usr/local/lib/introspection-runtime/cli-telemetry-preload.js"
)
RUNTIME_PROVIDER_HTTP_EXTENSION_PATH = (
    "/usr/local/lib/introspection-runtime/provider-http-pi-extension.js"
)
SESSION_TOKEN_ENV = "INTROSPECTION_TOKEN"
PROXY_KEY_ENV = "INTROSPECTION_PROXY_KEY"
PUBLIC_EGRESS_URL_ENV = "INTROSPECTION_PUBLIC_EGRESS_URL"
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
    """Write a ``pi`` launcher for the baked Pi unless the image has one."""

    launcher = "\n".join(
        [
            "#!/bin/sh",
            f'exec node "{RUNTIME_LINK_DIR}/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" \\',
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


def pi_args(
    candidate: dict[str, Any],
    spec: dict[str, Any],
    recipe_dir: str = BAKED_RECIPE_DIR,
    provider_http_extension_path: str | None = None,
    resume: bool = False,
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
        args.extend(["--yes", "--non-interactive", "--"])
    else:
        args = [
            "pi",
        ]
        if provider_http_extension_path:
            args.extend(["--extension", provider_http_extension_path])
        args.extend(["--recipe", recipe_dir])
        if candidate.get("agent"):
            args.extend(["--agent", candidate["agent"]])
        if candidate.get("model"):
            args.extend(["--model", candidate["model"]])
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
    """Run Pi from the Recipe root, capturing its event stream for the trajectory.

    ``prelude`` is shell an adapter needs before the launch (a bootstrapped
    trial sources nvm so the Node it installed is the one that runs Pi).
    """

    output_path = f"/logs/agent/{shlex.quote(output_filename)}"
    return (
        f"{prelude}"
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


class RecipeAgentBase(BaseInstalledAgent):
    """Run a Recipe with Pi inside a Harbor trial and report the trajectory.

    Subclasses decide how the Recipe and Pi get into the trial (``install``);
    launching, capture and ATIF conversion are shared.
    """

    SUPPORTS_ATIF = True
    # Harbor calls ``resume`` for the later steps of a multi-step task when the
    # run sets ``--resume-trajectory``; ``run`` then continues the Pi session.
    SUPPORTS_RESUME = True
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
        # This run alone: what the step cost.
        trajectory = pi_events_to_atif(output_path)
        # A continued step's verifier grades the conversation, so the file it
        # reads covers the earlier turns too, as Harbor's own resumable agents
        # write it. Harbor uploads this directory to the sandbox afterwards.
        conversation = self._session_trajectory(len(trajectory.steps)) or trajectory
        (self.logs_dir / "trajectory.json").write_text(
            json.dumps(conversation.to_json_dict(), indent=2)
        )
        if conversation is not trajectory:
            # Harbor fills a step's per-model usage from the file unless the
            # agent reports it, which would count the earlier steps again.
            context.model_usage = compute_model_usage(trajectory)
        if trajectory.final_metrics:
            context.n_input_tokens = trajectory.final_metrics.total_prompt_tokens
            context.n_output_tokens = trajectory.final_metrics.total_completion_tokens
            context.n_cache_tokens = trajectory.final_metrics.total_cached_tokens
            context.cost_usd = trajectory.final_metrics.total_cost_usd
        context.metadata = {
            "pi_events": self._OUTPUT_FILENAME,
            "atif": "trajectory.json",
            "introspection": (self._spec.get("input") or {}).get("metadata"),
        }

    def _session_trajectory(self, step_count: int) -> Trajectory | None:
        """The whole conversation, when the session holds more than this run."""

        sessions_dir = self.logs_dir / PurePosixPath(PI_SESSION_DIR).relative_to(
            EnvironmentPaths().agent_dir
        )
        conversation = pi_messages_to_atif(pi_session_messages(sessions_dir))
        return conversation if len(conversation.steps) > step_count else None
