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
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from .trajectory import ADAPTER_VERSION, pi_events_to_atif

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
PI_LAUNCHER_PATH = "$HOME/.local/bin/pi"
REMOTE_REPLAY_CONTEXT_PATH = "/tmp/introspection-replay-context.json"
REMOTE_EVAL_PROMPT_PATH = "/tmp/introspection-eval-prompt.md"
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
) -> list[str]:
    """Build the Pi invocation, via ``introspection local`` only for a replay.

    A production-conversation replay needs the CLI to hydrate the native Pi
    session from the canonical replay context immediately before Pi starts. An
    authored run has no such state and launches Pi directly.
    """

    if (spec.get("input") or {}).get("replay_context_path"):
        args = [
            "introspection",
            "local",
            "--work-dir",
            recipe_dir,
            "--runtime",
            candidate["runtime"],
        ]
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
    args.extend(
        ["--print", "--mode", "json", "--approve", f"@{REMOTE_EVAL_PROMPT_PATH}"]
    )
    return args


def prepare_recipe_command(recipe_dir: str = BAKED_RECIPE_DIR) -> str:
    """Check the Recipe is where the launch expects it and seed its local MCP config."""

    return (
        f"test -f {recipe_dir}/package.json && "
        f"if [ -f {recipe_dir}/.pi/mcp.local.example.json ] && "
        f"[ ! -f {recipe_dir}/.pi/mcp.local.json ]; then "
        f"cp {recipe_dir}/.pi/mcp.local.example.json "
        f"{recipe_dir}/.pi/mcp.local.json; fi"
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
        await self.exec_as_agent(
            environment,
            command=recipe_run_command(
                pi_args(
                    candidate,
                    self._spec,
                    self.recipe_dir,
                    self.provider_http_extension_path,
                ),
                self._OUTPUT_FILENAME,
                prelude=self.run_prelude(),
                recipe_dir=self.recipe_dir,
            ),
            **({"env": env} if env else {}),
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        output_path = self.logs_dir / self._OUTPUT_FILENAME
        if not output_path.is_file():
            return
        trajectory = pi_events_to_atif(output_path)
        (self.logs_dir / "trajectory.json").write_text(
            json.dumps(trajectory.to_json_dict(), indent=2)
        )
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
