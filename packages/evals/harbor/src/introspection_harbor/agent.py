from __future__ import annotations

import json
import os
import shlex
import shutil
import tempfile
from importlib.metadata import PackageNotFoundError, version
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

_RUN_SPEC_ENV = "INTROSPECTION_EVAL_RUN_SPEC"
_REMOTE_SOURCE_DIR = "/tmp/introspection-recipe-source"
_REMOTE_SESSION_PATH = "/tmp/introspection-session.jsonl"
_NODE_MAJOR = 24
_NODE_VERSION_CHECK = (
    "node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= "
    f"{_NODE_MAJOR} ? 0 : 1)'"
)

_EXCLUDED_DIRECTORY_NAMES = {
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
_EXCLUDED_EVAL_DIRECTORIES = {
    ".evalite",
    "eval-runs",
    "eval-artifacts",
}
_EXCLUDED_SECRET_FILES = {
    ".npmrc",
    ".pypirc",
    "credentials.json",
    "service-account.json",
    "service_account.json",
}
_SECRET_SUFFIXES = {".key", ".pem", ".p12", ".pfx"}
_SAFE_ENV_SUFFIXES = {".example", ".sample", ".template"}


def _adapter_version() -> str:
    try:
        return version("introspection-harbor")
    except PackageNotFoundError:
        return "0.1.0"


_ADAPTER_VERSION = _adapter_version()


def _node_prerequisite_command() -> str:
    """Prepare Node installation without assuming a Debian task image."""

    return (
        "set -eu; "
        f"if {_NODE_VERSION_CHECK} 2>/dev/null; then exit 0; fi; "
        "if command -v apk >/dev/null 2>&1; then "
        "apk add --no-cache nodejs npm; "
        f"{_NODE_VERSION_CHECK} || {{ "
        f"echo 'The Alpine package repository must provide Node {_NODE_MAJOR} or newer' >&2; "
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
        spec_path = os.environ.get(_RUN_SPEC_ENV)
        if not spec_path:
            raise ValueError(
                "introspection-recipe must be launched by `introspection eval run --runner harbor`"
            )
        self._spec = json.loads(Path(spec_path).read_text())
        if self._spec.get("schema_version") != 1:
            raise ValueError("unsupported Introspection evaluation run specification")
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

    @staticmethod
    @override
    def name() -> str:
        return "introspection-recipe"

    @override
    def version(self) -> str | None:
        return _ADAPTER_VERSION

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        candidate = self._spec["candidate"]
        await self.exec_as_root(
            environment,
            command=f"rm -rf {shlex.quote(_REMOTE_SOURCE_DIR)}",
        )
        with tempfile.TemporaryDirectory(prefix="introspection-recipe-source-") as temp_dir:
            staged = Path(temp_dir) / "workspace"
            _materialize_workspace(self._workspace_path, staged)
            await environment.upload_dir(staged, _REMOTE_SOURCE_DIR)
        await self.exec_as_root(
            environment,
            command=f"chmod -R a+rX {shlex.quote(_REMOTE_SOURCE_DIR)}",
        )

        session_path = (self._spec.get("input") or {}).get("pi_session_path")
        if session_path:
            await environment.upload_file(Path(session_path), _REMOTE_SESSION_PATH)

        await self.exec_as_root(environment, command=_node_prerequisite_command())
        cli_version = shlex.quote(candidate["cli_version"])
        source = shlex.quote(_REMOTE_SOURCE_DIR)
        node_install = nvm_node_install_snippet(node_major=_NODE_MAJOR)
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"if {_NODE_VERSION_CHECK}; then npm -v; else {node_install}; fi && "
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
        args = [
            "introspection",
            "local",
            "--work-dir",
            _REMOTE_SOURCE_DIR,
            "--runtime",
            candidate["runtime"],
        ]
        if candidate.get("agent"):
            args.extend(["--agent", candidate["agent"]])
        args.extend(["--print", prompt, "--mode", "json"])
        pi_args: list[str] = []
        if (self._spec.get("input") or {}).get("pi_session_path"):
            pi_args.extend(["--session", _REMOTE_SESSION_PATH])
        model_name = candidate.get("model") or self.model_name
        if model_name:
            provider, model = model_name.split("/", 1)
            pi_args.extend(["--provider", provider, "--model", model])
        if pi_args:
            args.extend(["--", *pi_args])

        env = _model_environment(model_name)
        await self.exec_as_agent(
            environment,
            command=_recipe_run_command(args, self._OUTPUT_FILENAME),
            env=env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        output_path = self.logs_dir / self._OUTPUT_FILENAME
        if not output_path.is_file():
            return
        trajectory = _pi_events_to_atif(
            output_path,
            model_name=(self._spec.get("candidate") or {}).get("model") or self.model_name,
        )
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
            "source_snapshot": (self._spec.get("source") or {}).get("snapshot_hash"),
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
    if any(part in _EXCLUDED_DIRECTORY_NAMES for part in path.parts):
        return True
    if any(part in _EXCLUDED_EVAL_DIRECTORIES for part in path.parts):
        return True
    name = path.name
    if name == ".DS_Store" or name in _EXCLUDED_SECRET_FILES:
        return True
    if name == ".env":
        return True
    if name.startswith(".env.") and Path(name).suffix not in _SAFE_ENV_SUFFIXES:
        return True
    return path.suffix.lower() in _SECRET_SUFFIXES


def _selected_prompt(spec: dict[str, Any], instruction: str) -> str:
    source = spec.get("source") or {}
    selected_prompt = (spec.get("input") or {}).get("prompt")
    prompt = selected_prompt if source.get("kind") == "production_task" else instruction
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("Introspection evaluation prompt must be non-empty")
    return prompt


def _recipe_run_command(args: list[str], output_filename: str) -> str:
    return (
        "set -o pipefail; "
        "if [ -s \"$HOME/.nvm/nvm.sh\" ]; then . \"$HOME/.nvm/nvm.sh\"; fi; "
        f"{shlex.join(args)} 2>&1 </dev/null | "
        f"stdbuf -oL tee /logs/agent/{shlex.quote(output_filename)}"
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


def _pi_events_to_atif(path: Path, model_name: str | None) -> Trajectory:
    messages: list[dict[str, Any]] = []
    for line in path.read_text().splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "message_end" and isinstance(event.get("message"), dict):
            messages.append(event["message"])

    steps: list[Step] = []
    calls: dict[str, tuple[int, ToolCall]] = {}
    totals = {"input": 0, "output": 0, "cache": 0, "cost": 0.0}
    for message in messages:
        role = message.get("role")
        if role == "user":
            content = message.get("content")
            if isinstance(content, list):
                content = "".join(
                    block.get("text", "") for block in content if block.get("type") == "text"
                )
            steps.append(Step(step_id=len(steps) + 1, source="user", message=content or ""))
        elif role == "assistant":
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
                model_name=model_name,
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
                block.get("text", "") for block in content if block.get("type") == "text"
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

    if not steps:
        steps.append(Step(step_id=1, source="agent", message="No Pi events were recorded", llm_call_count=0))
    return Trajectory(
        session_id=None,
        agent=Agent(name="introspection-recipe", version=_ADAPTER_VERSION, model_name=model_name),
        steps=steps,
        final_metrics=FinalMetrics(
            total_prompt_tokens=int(totals["input"]),
            total_completion_tokens=int(totals["output"]),
            total_cached_tokens=int(totals["cache"]),
            total_cost_usd=float(totals["cost"]),
            total_steps=len(steps),
        ),
    )
