from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
from importlib.metadata import version
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)

RUN_SPEC_ENV = "INTROSPECTION_EVAL_RUN_SPEC"
REMOTE_SOURCE_DIR = "/tmp/introspection-recipe-source"
BAKED_RECIPE_DIR = "/opt/introspection/recipe"
REMOTE_PATCH_PATH = "/tmp/introspection-recipe.patch"
RECIPE_MODE_ENV = "INTROSPECTION_HARBOR_RECIPE_MODE"
RECIPE_BASE_ENV = "INTROSPECTION_HARBOR_RECIPE_BASE_SHA"
REMOTE_REPLAY_CONTEXT_PATH = "/tmp/introspection-replay-context.json"
REMOTE_EVAL_PROMPT_PATH = "/tmp/introspection-eval-prompt.md"
REMOTE_PROXY_EXTENSION_PATH = "/tmp/introspection-proxy-extension.mjs"
RUNTIME_PROXY_MODULE_PATH = (
    "/repo/apps/runtime-agent/node_modules/"
    "@introspection-sdk/introspection-proxy/dist/index.js"
)
PROXY_EXTENSION_SOURCE = (
    f'import {{ installProxyFetch }} from "file://{RUNTIME_PROXY_MODULE_PATH}";\n'
    "installProxyFetch();\n"
    "export default function introspectionProxyExtension() {}\n"
)
NODE_MAJOR = 24
NODE_VERSION_CHECK = (
    'node -e \'process.exit(Number(process.versions.node.split(".")[0]) >= '
    f"{NODE_MAJOR} ? 0 : 1)'"
)

EXCLUDED_DIRECTORY_NAMES = {
    ".git",
    ".hg",
    ".svn",
    ".aws",
    ".ssh",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
}
EXCLUDED_EVAL_DIRECTORIES = {
    ".evalite",
    "eval-runs",
    "eval-artifacts",
}
EXCLUDED_GENERATED_PI_DIRECTORIES = {
    Path(".pi/bin"),
    Path(".pi/mcp-catalogs"),
}
EXCLUDED_GENERATED_PI_FILES = {
    Path(".pi/mcp-session.json"),
    Path(".pi/mcporter.json"),
}
EXCLUDED_SECRET_FILES = {
    ".npmrc",
    ".pypirc",
    "credentials.json",
    "service-account.json",
    "service_account.json",
}
SECRET_SUFFIXES = {".key", ".pem", ".p12", ".pfx"}
SAFE_ENV_SUFFIXES = {".example", ".sample", ".template"}
MCP_ENV_REFERENCE = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}")


ADAPTER_VERSION = version("introspection-harbor")


def _node_prerequisite_command() -> str:
    """Prepare Node installation without assuming a Debian task image."""

    return (
        "set -eu; "
        f"if {NODE_VERSION_CHECK} 2>/dev/null; then exit 0; fi; "
        "if command -v apk >/dev/null 2>&1; then "
        "apk add --no-cache nodejs npm; "
        f"{NODE_VERSION_CHECK} || {{ "
        f"echo 'The Alpine package repository must provide Node {NODE_MAJOR} or newer' >&2; "
        "exit 1; }; "
        "elif command -v curl >/dev/null 2>&1; then :; "
        "elif command -v apt-get >/dev/null 2>&1; then "
        "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y curl; "
        "elif command -v dnf >/dev/null 2>&1; then dnf install -y curl; "
        "elif command -v microdnf >/dev/null 2>&1; then microdnf install -y curl; "
        "elif command -v yum >/dev/null 2>&1; then yum install -y curl; "
        "elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install curl; "
        "else echo 'Node setup requires curl or a supported system package manager' >&2; "
        "exit 1; fi"
    )


class IntrospectionRecipeAgent(BaseInstalledAgent):
    """Run the exact Recipe selected by ``introspection eval run``."""

    SUPPORTS_ATIF = True
    _OUTPUT_FILENAME = "pi.jsonl"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        spec_path = os.environ.get(RUN_SPEC_ENV)
        if not spec_path:
            raise ValueError(
                "introspection-recipe must be launched by `introspection eval run --runner harbor`"
            )
        self._spec = json.loads(Path(spec_path).read_text())
        _require_run_spec_v2(self._spec)
        candidate = self._spec.get("candidate") or {}
        workspace_path = Path(candidate.get("workspace_path", ""))
        recipe_path = Path(candidate.get("recipe_path", ""))
        if not workspace_path.is_dir():
            raise ValueError(f"Recipe workspace does not exist: {workspace_path}")
        if not recipe_path.is_dir():
            raise ValueError(f"Recipe source does not exist: {recipe_path}")
        try:
            self._recipe_relative_path = recipe_path.relative_to(workspace_path)
        except ValueError as error:
            raise ValueError("Recipe source must be inside its workspace") from error
        self._workspace_path = workspace_path
        self._recipe_path = recipe_path
        self._recipe_mode = os.environ.get(RECIPE_MODE_ENV, "upload")
        if self._recipe_mode not in {"upload", "baked", "sync"}:
            raise ValueError(f"{RECIPE_MODE_ENV} must be upload, baked, or sync")
        self._remote_source_dir = (
            BAKED_RECIPE_DIR if self._recipe_mode == "baked" else REMOTE_SOURCE_DIR
        )

    @staticmethod
    @override
    def name() -> str:
        return "introspection-recipe"

    @override
    def version(self) -> str | None:
        return ADAPTER_VERSION

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        candidate = self._spec["candidate"]
        if getattr(self, "_recipe_mode", "upload") in {"baked", "sync"}:
            await self._install_baked_recipe(environment)
            return

        await self.exec_as_root(
            environment,
            command=f"rm -rf {shlex.quote(REMOTE_SOURCE_DIR)}",
        )
        with tempfile.TemporaryDirectory(
            prefix="introspection-recipe-source-"
        ) as temp_dir:
            staged = Path(temp_dir) / "workspace"
            _materialize_workspace(self._workspace_path, staged)
            await environment.upload_dir(staged, REMOTE_SOURCE_DIR)
        await self.exec_as_root(
            environment,
            command=f"chmod -R a+rX {shlex.quote(REMOTE_SOURCE_DIR)}",
        )

        replay_context_path = (self._spec.get("input") or {}).get("replay_context_path")
        if replay_context_path:
            await environment.upload_file(
                Path(replay_context_path), REMOTE_REPLAY_CONTEXT_PATH
            )

        await self.exec_as_root(environment, command=_node_prerequisite_command())
        cli_version = shlex.quote(candidate["cli_version"])
        source = shlex.quote(REMOTE_SOURCE_DIR)
        node_install = nvm_node_install_snippet(node_major=NODE_MAJOR)
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"git -C {source} init --quiet && "
                f"if {NODE_VERSION_CHECK}; then npm -v; else {node_install}; fi && "
                f"npm install -g @introspection-ai/cli@{cli_version} && "
                f"if [ -f {source}/pnpm-lock.yaml ]; then "
                f"corepack pnpm --dir {source} install --frozen-lockfile; "
                f"elif [ -f {source}/yarn.lock ]; then "
                f"corepack yarn --cwd {source} install --immutable; "
                f"elif [ -f {source}/bun.lock ] || [ -f {source}/bun.lockb ]; then "
                f"npm install -g bun && bun install --cwd {source} --frozen-lockfile; "
                f"elif [ -f {source}/package-lock.json ]; then npm --prefix {source} ci; "
                f"else npm --prefix {source} install; fi && "
                "introspection setup --yes"
            ),
        )

    async def _install_baked_recipe(self, environment: BaseEnvironment) -> None:
        if self._recipe_mode == "sync":
            base_sha = os.environ.get(RECIPE_BASE_ENV)
            if not base_sha:
                raise ValueError(f"{RECIPE_BASE_ENV} is required in sync mode")
            with tempfile.TemporaryDirectory(
                prefix="introspection-recipe-patch-"
            ) as temp_dir:
                patch_path = Path(temp_dir) / "recipe.patch"
                _write_recipe_patch(
                    self._workspace_path,
                    self._recipe_relative_path,
                    base_sha,
                    patch_path,
                )
                await environment.upload_file(patch_path, REMOTE_PATCH_PATH)
            await self.exec_as_root(
                environment,
                command=(
                    f"rm -rf {shlex.quote(REMOTE_SOURCE_DIR)} && "
                    f"mkdir -p {shlex.quote(REMOTE_SOURCE_DIR)} && "
                    f"cp -a {shlex.quote(BAKED_RECIPE_DIR)}/. "
                    f"{shlex.quote(REMOTE_SOURCE_DIR)}/ && "
                    f"chmod -R a+rX,u+w {shlex.quote(REMOTE_SOURCE_DIR)}"
                ),
            )

        source = shlex.quote(self._remote_source_dir)
        patch = (
            f"git -C {source} apply --binary {shlex.quote(REMOTE_PATCH_PATH)} && "
            if self._recipe_mode == "sync"
            else ""
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"test -f {source}/package.json && "
                f"git -C {source} init --quiet && "
                f"{patch}"
                f"if [ -f {source}/.pi/mcp.local.example.json ] && "
                f"[ ! -f {source}/.pi/mcp.local.json ]; then "
                f"cp {source}/.pi/mcp.local.example.json {source}/.pi/mcp.local.json; fi && "
                "introspection --version && "
                "introspection setup --yes --non-interactive"
            ),
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
        prompt = _selected_prompt(self._spec, instruction)
        source_dir = getattr(self, "_remote_source_dir", REMOTE_SOURCE_DIR)
        with tempfile.TemporaryDirectory(
            prefix="introspection-eval-prompt-"
        ) as temp_dir:
            prompt_path = Path(temp_dir) / "prompt.md"
            prompt_path.write_text(prompt)
            await environment.upload_file(prompt_path, REMOTE_EVAL_PROMPT_PATH)
            proxy_extension_path = Path(temp_dir) / "introspection-proxy-extension.mjs"
            proxy_extension_path.write_text(PROXY_EXTENSION_SOURCE)
            await environment.upload_file(
                proxy_extension_path, REMOTE_PROXY_EXTENSION_PATH
            )

        model_name = candidate.get("model")
        if (self._spec.get("input") or {}).get("replay_context_path"):
            args = [
                "introspection",
                "local",
                "--work-dir",
                source_dir,
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
                "--extension",
                REMOTE_PROXY_EXTENSION_PATH,
                "--recipe",
                source_dir,
            ]
            if candidate.get("agent"):
                args.extend(["--agent", candidate["agent"]])
            if model_name:
                args.extend(["--model", model_name])
        args.extend(
            ["--print", "--mode", "json", "--approve", f"@{REMOTE_EVAL_PROMPT_PATH}"]
        )
        env = {
            **_model_environment(model_name),
            **_mcp_header_environment(self._recipe_path),
        }
        await self.exec_as_agent(
            environment,
            command=_recipe_run_command(
                args,
                self._OUTPUT_FILENAME,
                source_dir,
            ),
            env=env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        output_path = self.logs_dir / self._OUTPUT_FILENAME
        if not output_path.is_file():
            return
        trajectory = _pi_events_to_atif(output_path)
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


def _materialize_workspace(source: Path, destination: Path) -> None:
    destination.mkdir()
    for relative in sorted(_workspace_paths(source), key=lambda path: path.as_posix()):
        if _excluded_workspace_path(relative):
            continue
        source_path = source / relative
        if not source_path.exists() and not source_path.is_symlink():
            continue
        target_path = destination / relative
        target_path.parent.mkdir(parents=True, exist_ok=True)
        if source_path.is_symlink():
            target_path.symlink_to(
                os.readlink(source_path), target_is_directory=source_path.is_dir()
            )
        elif source_path.is_file():
            shutil.copy2(source_path, target_path)


def _write_recipe_patch(
    workspace: Path,
    recipe_relative_path: Path,
    base_sha: str,
    destination: Path,
) -> None:
    recipe = recipe_relative_path.as_posix()
    result = subprocess.run(
        [
            "git",
            "diff",
            "--binary",
            base_sha,
            f"--relative={recipe}",
            "--",
            recipe,
        ],
        cwd=workspace,
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", "replace").strip()
        raise ValueError(f"cannot create Recipe patch from {base_sha}: {message}")
    destination.write_bytes(result.stdout)


def _workspace_paths(source: Path) -> list[Path]:
    paths: list[Path] = []
    for current, directories, files in os.walk(source, followlinks=False):
        current_path = Path(current)
        kept_directories: list[str] = []
        for name in directories:
            relative = (current_path / name).relative_to(source)
            if _excluded_workspace_path(relative):
                continue
            if (current_path / name).is_symlink():
                paths.append(relative)
            else:
                kept_directories.append(name)
        directories[:] = kept_directories
        paths.extend((current_path / name).relative_to(source) for name in files)
    return paths


def _excluded_workspace_path(path: Path) -> bool:
    if path.is_absolute() or ".." in path.parts:
        return True
    if any(part in EXCLUDED_DIRECTORY_NAMES for part in path.parts):
        return True
    if any(part in EXCLUDED_EVAL_DIRECTORIES for part in path.parts):
        return True
    if path in EXCLUDED_GENERATED_PI_FILES:
        return True
    if any(
        path == directory or directory in path.parents
        for directory in EXCLUDED_GENERATED_PI_DIRECTORIES
    ):
        return True
    name = path.name
    if name == ".DS_Store" or name in EXCLUDED_SECRET_FILES:
        return True
    if name == ".env":
        return True
    if name.startswith(".env.") and Path(name).suffix not in SAFE_ENV_SUFFIXES:
        return True
    return path.suffix.lower() in SECRET_SUFFIXES


def _selected_prompt(spec: dict[str, Any], instruction: str) -> str:
    selected_prompt = (spec.get("input") or {}).get("prompt")
    prompt = selected_prompt if selected_prompt is not None else instruction
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("Introspection evaluation prompt must be non-empty")
    return prompt


def _require_run_spec_v2(spec: dict[str, Any]) -> None:
    version = spec.get("schema_version")
    if version != 2:
        raise ValueError(
            f"Introspection evaluation run spec {version} is not supported. "
            "Update the Introspection CLI."
        )


def _recipe_run_command(
    args: list[str], output_filename: str, source_dir: str = REMOTE_SOURCE_DIR
) -> str:
    output_path = f"/logs/agent/{shlex.quote(output_filename)}"
    return (
        'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; '
        f"cd {shlex.quote(source_dir)} && "
        f"{shlex.join(args)} >{output_path} 2>&1 </dev/null; "
        f"status=$?; cat {output_path}; test $status -eq 0 && test -s {output_path}"
    )


def _model_environment(model_name: str | None) -> dict[str, str]:
    if not model_name or "/" not in model_name:
        return {}
    provider = model_name.split("/", 1)[0]
    names = {
        "amazon-bedrock": [
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_REGION",
        ],
        "anthropic": ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
        "github-copilot": ["GITHUB_TOKEN"],
        "google": [
            "GEMINI_API_KEY",
            "GOOGLE_GENERATIVE_AI_API_KEY",
            "GOOGLE_CLOUD_PROJECT",
            "GOOGLE_CLOUD_LOCATION",
            "GOOGLE_GENAI_USE_VERTEXAI",
            "GOOGLE_API_KEY",
        ],
        "groq": ["GROQ_API_KEY"],
        "huggingface": ["HF_TOKEN"],
        "mistral": ["MISTRAL_API_KEY"],
        "openai": ["OPENAI_API_KEY"],
        "openrouter": ["OPENROUTER_API_KEY"],
        "xai": ["XAI_API_KEY"],
    }.get(provider, [])
    return {name: os.environ[name] for name in names if name in os.environ}


def _mcp_header_environment(recipe_path: Path) -> dict[str, str]:
    """Forward only env references used by local MCP authorization headers.

    Hosted bindings materialize the same config shape. Keeping this restricted
    to header values avoids turning an arbitrary Recipe string into permission
    to copy an unrelated host environment variable into the trial.
    """

    config_path = recipe_path / ".pi" / "mcp.local.json"
    if not config_path.is_file():
        return {}
    try:
        config = json.loads(config_path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}

    names: set[str] = set()
    servers = config.get("servers") if isinstance(config, dict) else None
    if not isinstance(servers, list):
        return {}
    for server in servers:
        headers = server.get("headers") if isinstance(server, dict) else None
        if not isinstance(headers, dict):
            continue
        for value in headers.values():
            if isinstance(value, str):
                names.update(MCP_ENV_REFERENCE.findall(value))
    return {name: os.environ[name] for name in sorted(names) if name in os.environ}


def _pi_events_to_atif(path: Path) -> Trajectory:
    messages: list[dict[str, Any]] = []
    for line in path.read_text().splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "message_end" and isinstance(
            event.get("message"), dict
        ):
            messages.append(event["message"])

    steps: list[Step] = []
    calls: dict[str, tuple[int, ToolCall]] = {}
    totals = {"input": 0, "output": 0, "cache": 0, "cost": 0.0}
    observed_models: set[str] = set()
    for message in messages:
        role = message.get("role")
        if role == "user":
            content = message.get("content")
            if isinstance(content, list):
                content = "".join(
                    block.get("text", "")
                    for block in content
                    if block.get("type") == "text"
                )
            steps.append(
                Step(step_id=len(steps) + 1, source="user", message=content or "")
            )
        elif role == "assistant":
            observed_model = _message_model_name(message)
            if observed_model:
                observed_models.add(observed_model)
            text: list[str] = []
            thinking: list[str] = []
            tool_calls: list[ToolCall] = []
            for block in message.get("content") or []:
                if block.get("type") == "text":
                    text.append(block.get("text", ""))
                elif block.get("type") == "thinking":
                    thinking.append(block.get("thinking", ""))
                elif block.get("type") == "toolCall":
                    call = ToolCall(
                        tool_call_id=block["id"],
                        function_name=block["name"],
                        arguments=block.get("arguments") or {},
                    )
                    tool_calls.append(call)
            usage = message.get("usage") or {}
            cost = (usage.get("cost") or {}).get("total", 0) or 0
            totals["input"] += usage.get("input", 0) or 0
            totals["output"] += usage.get("output", 0) or 0
            totals["cache"] += usage.get("cacheRead", 0) or 0
            totals["cost"] += cost
            step = Step(
                step_id=len(steps) + 1,
                source="agent",
                model_name=observed_model,
                message="".join(text),
                reasoning_content="\n".join(thinking) or None,
                tool_calls=tool_calls or None,
                metrics=Metrics(
                    prompt_tokens=usage.get("input", 0) or 0,
                    completion_tokens=usage.get("output", 0) or 0,
                    cached_tokens=usage.get("cacheRead", 0) or 0,
                    cost_usd=cost,
                ),
                llm_call_count=1,
            )
            steps.append(step)
            for call in tool_calls:
                calls[call.tool_call_id] = (len(steps) - 1, call)
        elif role == "toolResult" and message.get("toolCallId") in calls:
            step_index, _ = calls[message["toolCallId"]]
            content = message.get("content") or []
            rendered = "".join(
                block.get("text", "")
                for block in content
                if block.get("type") == "text"
            )
            step = steps[step_index]
            results = list(step.observation.results) if step.observation else []
            results.append(
                ObservationResult(
                    source_call_id=message["toolCallId"],
                    content=rendered,
                )
            )
            step.observation = Observation(results=results)

    observed_model_name = (
        next(iter(observed_models), None) if len(observed_models) == 1 else None
    )
    if not steps:
        steps.append(
            Step(
                step_id=1,
                source="agent",
                message="No Pi events were recorded",
                llm_call_count=0,
            )
        )
    return Trajectory(
        session_id=None,
        agent=Agent(
            name="introspection-recipe",
            version=ADAPTER_VERSION,
            model_name=observed_model_name,
        ),
        steps=steps,
        final_metrics=FinalMetrics(
            total_prompt_tokens=int(totals["input"]),
            total_completion_tokens=int(totals["output"]),
            total_cached_tokens=int(totals["cache"]),
            total_cost_usd=float(totals["cost"]),
            total_steps=len(steps),
        ),
    )


def _message_model_name(message: dict[str, Any]) -> str | None:
    provider = message.get("provider")
    model = message.get("model")
    if (
        not isinstance(provider, str)
        or not provider
        or not isinstance(model, str)
        or not model
    ):
        return None
    return f"{provider}/{model}"
