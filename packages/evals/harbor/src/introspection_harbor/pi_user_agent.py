"""A Harbor user agent that runs a Pi Recipe on the host.

Harbor loads ``PiRecipeUserAgent`` through ``user_agent.import_path`` in a job
config whose ``bridge`` is ``acp``. It is a plain ``BaseAgent``: ``setup`` is
empty, because Harbor sets up the user agent before the target and before the
ACP bridge, so ``acpx`` exists only once ``run`` starts.

``run`` starts Pi on the host with the Recipe (``pi --recipe <dir>``) and
serves the Recipe's extensions a few environment primitives through an MCP
server on 127.0.0.1 (``user_agent_mcp``):

- ``prompt_target``: one ACP prompt to the target, through ``acpx``;
- ``upload_file``: a host file into the container;
- ``exec``: a command in the container;
- ``context``: the logs directory, the target's ACP prompt capabilities (what
  it advertised when the bridge started its session), the workspace, the
  instruction and the job's ``inputs``.

What the user agent says, when it stops and what it records is the Recipe's:
this module adds no conversation rules of its own.

The server is named only in Pi's environment (``USER_AGENT_URL_ENV`` and
``USER_AGENT_TOKEN_ENV``). A Recipe extension registers it with Pi's own MCP
client (``pi.registerMcpServer`` with ``exposure: "codemode"``) and calls a
primitive from its tools with ``ctx.executeTool("mcp__<server>__<primitive>")``.
Pi turns ``codemode`` on whenever such a server connects, and a codemode
script could call the primitives, so Pi gets a ``--tools`` allowlist of the
Recipe's model-callable tools that leaves codemode out: the model reaches the
target only through the Recipe's own tools, and the Recipe's limits hold.

Harbor bind-mounts the trial's log directory into a Docker container, so the
target could read ``logs_dir`` while it runs. Everything the run writes (Pi's
events and session, each prompt sent, what the Recipe writes to
``context.logs_dir``) is therefore kept in a host temp directory and copied
into ``logs_dir`` only when Pi has exited and every primitive call has ended.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import secrets
import shlex
import shutil
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path, PurePosixPath
from typing import Any, override

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from .trajectory import ADAPTER_VERSION
from .user_agent_mcp import Tool, ToolServer

USER_AGENT_URL_ENV = "INTROSPECTION_USER_AGENT_URL"
USER_AGENT_TOKEN_ENV = "INTROSPECTION_USER_AGENT_TOKEN"
METADATA_FILENAME = "metadata.json"
PI_EVENTS_FILENAME = "pi.jsonl"
PI_STDERR_FILENAME = "pi-stderr.log"
# acpx refuses an audio or resource block the target didn't advertise, so the
# Recipe is told what the target's ACP session reported (``acpx sessions
# show``): claude-code-acp advertises ``image`` and ``embeddedContext``,
# pi-acp ``image`` and, with PI_ACP_ENABLE_EMBEDDED_CONTEXT, ``embeddedContext``.
SESSION_SHOW_COMMAND = "acpx --format json sessions show"
REMOTE_PROMPT_PATH = "/tmp/introspection-user-agent-prompt.json"
# Tools that reach the primitives of a codemode-exposed MCP server. None may be
# declared to the model: an MCP tool is named ``mcp__<server>__<tool>``.
INDIRECT_TOOLS = ("codemode", "tool_search", "mcp__server__tool")


def model_tools(tools: Sequence[str]) -> list[str]:
    """The Recipe's model-callable tools, checked for Pi's ``--tools``.

    An entry is a tool name or a pattern where ``*`` matches anything; one that
    names or matches a tool in ``INDIRECT_TOOLS``, names an MCP tool, is a
    ``+``/``-`` entry (which edits Pi's default selection instead of replacing
    it), or holds a comma or whitespace (Pi splits ``--tools`` on commas, so
    ``"say,codemode"`` would enable ``codemode``) is refused.
    """

    if isinstance(tools, str) or not tools:
        raise ValueError("`tools` must list the Recipe's model-callable tools")
    for entry in tools:
        pattern = re.compile(".*".join(map(re.escape, entry.split("*"))))
        if (
            not entry
            or entry[0] in "+-"
            or re.search(r"[,\s]", entry)
            or entry.startswith("mcp__")
            or any(map(pattern.fullmatch, INDIRECT_TOOLS))
        ):
            raise ValueError(
                f"`tools` entry {entry!r} would let the model call the primitives"
            )
    return list(tools)


def pi_argv(
    *,
    recipe_dir: Path,
    session_dir: Path,
    prompt: str,
    tools: Sequence[str],
    pi_command: str = "pi",
    model: str | None = None,
    agent: str | None = None,
) -> list[str]:
    """Pi on the host: one print-mode run of the Recipe for the whole conversation.

    ``tools`` is the allowlist of model-callable tools (see ``model_tools``);
    no context files of the host directory are loaded.
    """

    argv = [
        pi_command,
        "--print",
        "--mode",
        "json",
        "--no-context-files",
        "--recipe",
        str(recipe_dir),
        "--session-dir",
        str(session_dir),
        "--tools",
        ",".join(model_tools(tools)),
    ]
    if agent:
        argv += ["--agent", agent]
    if model:
        argv += ["--model", model]
    return [*argv, "--", prompt]


class Primitives:
    """The environment primitives for one run.

    Each returns a JSON object. An exception is the call failing (bad
    arguments, or the environment raising); a non-zero exit of ``acpx`` or a
    command is data, in ``exit_code``.
    """

    def __init__(
        self,
        environment: BaseEnvironment,
        logs_dir: Path,
        *,
        instruction: str = "",
        inputs: Mapping[str, Any] | None = None,
        target_capabilities: Sequence[str] | None = None,
        workspace_dir: str | None = None,
        exec_timeout_sec: int | None = None,
    ) -> None:
        self.environment = environment
        self.logs_dir = logs_dir
        self.instruction = instruction
        self.inputs = dict(inputs or {})
        self.target_capabilities = (
            None if target_capabilities is None else tuple(target_capabilities)
        )
        self.workspace_dir = workspace_dir
        self.exec_timeout_sec = exec_timeout_sec
        self.prompts = 0
        self._turn = asyncio.Lock()

    def tools(self) -> list[Tool]:
        return [
            Tool(
                "prompt_target",
                "Send one ACP prompt to the target and wait for its turn to end.",
                _schema(
                    {
                        "prompt": {
                            "type": "array",
                            "items": {"type": "object", "required": ["type"]},
                            "minItems": 1,
                            "description": "ACP content blocks, sent as-is",
                        },
                    },
                    required=["prompt"],
                ),
                self.prompt_target,
            ),
            Tool(
                "upload_file",
                "Copy a host file into the container.",
                _schema(
                    {
                        "source": {"type": "string", "description": "Host path"},
                        "target": {
                            "type": "string",
                            "description": "Container path; relative to the workspace",
                        },
                    },
                    required=["source", "target"],
                ),
                self.upload_file,
            ),
            Tool(
                "exec",
                "Run a shell command in the container.",
                _schema(
                    {
                        "command": {"type": "string"},
                        "cwd": {"type": "string"},
                        "timeout_sec": {"type": "integer", "minimum": 1},
                    },
                    required=["command"],
                ),
                self.exec,
            ),
            Tool(
                "context",
                "The run: logs directory, target capabilities, workspace, "
                "instruction and inputs.",
                _schema({}),
                self.context,
            ),
        ]

    async def prompt_target(self, arguments: dict[str, Any]) -> dict[str, Any]:
        """``{"prompt": ContentBlock[]}`` -> ``{"reply", "exit_code"}``.

        ``prompt`` is ACP's own prompt array and is sent as-is. It is written
        as JSON on the host (kept in ``prompts/``), uploaded, and sent with
        ``acpx prompt --file``. One prompt runs at a time. acpx's quiet format
        prints an error on stdout as well, so only ``exit_code`` tells a reply
        from an error.
        """

        blocks = arguments.get("prompt")
        if not isinstance(blocks, list) or not all(
            isinstance(block, dict) and isinstance(block.get("type"), str)
            for block in blocks
        ):
            raise ValueError("`prompt` must be ACP content blocks with a `type`")
        if not blocks:
            raise ValueError("`prompt` needs at least one content block")
        async with self._turn:
            self.prompts += 1
            local = self.logs_dir / "prompts" / f"{self.prompts:03d}.json"
            local.parent.mkdir(exist_ok=True)
            local.write_text(json.dumps(blocks))
            await self.environment.upload_file(local, REMOTE_PROMPT_PATH)
            result = await self.environment.exec(
                shlex.join(["acpx", "prompt", "--file", REMOTE_PROMPT_PATH])
            )
        return {"reply": (result.stdout or "").strip(), "exit_code": result.return_code}

    async def upload_file(self, arguments: dict[str, Any]) -> dict[str, Any]:
        """``{"source", "target"}`` -> ``{"path"}``, the container path written.

        The target's parent directories are created.
        """

        source = Path(_required(arguments, "source")).expanduser()
        if not source.is_file():
            raise ValueError(f"No file at {source}")
        target = PurePosixPath(_required(arguments, "target"))
        if not target.is_absolute():
            target = PurePosixPath(await self._workspace()) / target
        made = await self.environment.exec(
            f"mkdir -p {shlex.quote(str(target.parent))}"
        )
        if made.return_code != 0:
            raise RuntimeError(f"mkdir {target.parent} failed: {made.stdout or ''}")
        await self.environment.upload_file(source, str(target))
        return {"path": str(target)}

    async def exec(self, arguments: dict[str, Any]) -> dict[str, Any]:
        """``{"command", "cwd"?, "timeout_sec"?}`` -> ``{"exit_code", "stdout", "stderr"}``."""

        command = _required(arguments, "command")
        cwd = arguments.get("cwd")
        timeout = arguments.get("timeout_sec", self.exec_timeout_sec)
        result = await self.environment.exec(command, cwd=cwd, timeout_sec=timeout)
        return {
            "exit_code": result.return_code,
            "stdout": result.stdout or "",
            "stderr": result.stderr or "",
        }

    async def context(self, arguments: dict[str, Any]) -> dict[str, Any]:
        """The run, as data; see the README for the fields."""

        return {
            "logs_dir": str(self.logs_dir),
            "target_capabilities": list(await self._target_capabilities()),
            "workspace_dir": await self._workspace(),
            "instruction": self.instruction,
            "inputs": self.inputs,
        }

    async def _target_capabilities(self) -> tuple[str, ...]:
        """The prompt capabilities the target's ACP session advertised.

        The bridge started the session before the user agent runs, so acpx
        has the target's ``initialize`` answer on record.
        """

        if self.target_capabilities is None:
            result = await self.environment.exec(SESSION_SHOW_COMMAND)
            if result.return_code != 0:
                raise RuntimeError(
                    "Could not read the target's ACP session: "
                    f"{result.stderr or result.stdout or ''}".strip()
                )
            self.target_capabilities = prompt_capabilities(result.stdout or "")
        return self.target_capabilities

    async def _workspace(self) -> str:
        if self.workspace_dir is None:
            result = await self.environment.exec("pwd")
            if result.return_code != 0:
                raise RuntimeError(f"pwd failed: {result.stdout or result.stderr}")
            self.workspace_dir = (result.stdout or "").strip()
        return self.workspace_dir


def prompt_capabilities(session: str) -> tuple[str, ...]:
    """The prompt capabilities an ``acpx sessions show`` record advertises."""

    try:
        record = json.loads(session)
        advertised = record["agentCapabilities"].get("promptCapabilities") or {}
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        raise RuntimeError(
            "The target's ACP session records no agent capabilities"
        ) from error
    return tuple(sorted(name for name, enabled in advertised.items() if enabled))


def _schema(
    properties: dict[str, Any], *, required: Sequence[str] = ()
) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": list(required),
        "additionalProperties": False,
    }


def _required(arguments: dict[str, Any], name: str) -> str:
    value = arguments.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"`{name}` is required")
    return value


class PiRecipeUserAgent(BaseAgent):
    """A Pi Recipe as a Harbor user agent (``bridge: {kind: acp}``).

    Job-config ``kwargs``:

    - ``recipe_dir`` (required): the Recipe folder on the host.
    - ``tools`` (required): the Recipe's model-callable tools, passed to Pi as
      ``--tools``; codemode, ``tool_search`` and MCP tools are refused.
    - ``agent``: the Recipe agent to run (Pi's ``--agent``).
    - ``inputs``: JSON data for the Recipe, served as ``context.inputs``.
    - ``prompt``: Pi's first message; defaults to the trial's instruction.
    - ``target_capabilities``: the target's ACP prompt capabilities; by
      default the ones its ACP session advertised.
    - ``workspace_dir``: the container directory relative ``upload_file``
      targets resolve against; defaults to the container's working directory,
      which is the ACP session's.
    - ``exec_timeout_sec``: the default ``exec`` timeout.
    - ``pi_command``: Pi's executable; a path relative to Harbor's working
      directory works like ``recipe_dir``.

    The user agent's ``model_name`` is Pi's model.
    """

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        *args,
        recipe_dir: str | Path,
        tools: Sequence[str],
        agent: str | None = None,
        inputs: Mapping[str, Any] | None = None,
        prompt: str | None = None,
        target_capabilities: Sequence[str] | None = None,
        workspace_dir: str | None = None,
        exec_timeout_sec: int | None = 900,
        pi_command: str = "pi",
        **kwargs,
    ) -> None:
        super().__init__(logs_dir, model_name, *args, **kwargs)
        # Pi runs in a fresh temp directory, so a path relative to Harbor's
        # working directory is made absolute here, while it still means that.
        self.recipe_dir = Path(recipe_dir).expanduser().absolute()
        self.tools = model_tools(tools)
        self.agent = agent
        self.inputs = dict(inputs or {})
        self.prompt = prompt
        self.target_capabilities = (
            None if target_capabilities is None else tuple(target_capabilities)
        )
        self.workspace_dir = workspace_dir
        self.exec_timeout_sec = exec_timeout_sec
        self.pi_command = (
            str(Path(pi_command).expanduser().absolute())
            if os.sep in pi_command or "/" in pi_command
            else pi_command
        )

    @staticmethod
    @override
    def name() -> str:
        return "introspection-pi-user-agent"

    @override
    def version(self) -> str:
        return ADAPTER_VERSION

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        pass

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not (self.recipe_dir / "package.json").is_file():
            raise FileNotFoundError(f"No Recipe at {self.recipe_dir}")
        work_dir = Path(tempfile.mkdtemp(prefix="introspection-user-agent-"))
        primitives = Primitives(
            environment,
            work_dir,
            instruction=instruction,
            inputs=self.inputs,
            target_capabilities=self.target_capabilities,
            workspace_dir=self.workspace_dir,
            exec_timeout_sec=self.exec_timeout_sec,
        )
        token = secrets.token_urlsafe(32)
        server = ToolServer(primitives.tools(), token, version=ADAPTER_VERSION)
        process: asyncio.subprocess.Process | None = None
        exit_code: int | None = None
        try:
            url = await server.start()
            argv = pi_argv(
                recipe_dir=self.recipe_dir,
                session_dir=work_dir / "sessions",
                prompt=self.prompt or instruction,
                tools=self.tools,
                pi_command=self.pi_command,
                model=self.model_name,
                agent=self.agent,
            )
            with (
                (work_dir / PI_EVENTS_FILENAME).open("wb") as events,
                (work_dir / PI_STDERR_FILENAME).open("wb") as stderr,
            ):
                process = await asyncio.create_subprocess_exec(
                    *argv,
                    cwd=work_dir,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=events,
                    stderr=stderr,
                    env={
                        **os.environ,
                        **self._extra_env,
                        USER_AGENT_URL_ENV: url,
                        USER_AGENT_TOKEN_ENV: token,
                    },
                )
                exit_code = await process.wait()
        finally:
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
            # Every primitive call has ended before anything is copied.
            await server.close()
            metadata = self._keep_logs(work_dir)
            context.metadata = {
                **(context.metadata or {}),
                "user_agent": {
                    "exit_code": exit_code,
                    "prompts": primitives.prompts,
                    **({"metadata": metadata} if metadata is not None else {}),
                },
            }
        if exit_code != 0:
            raise RuntimeError(
                f"Pi exited {exit_code}; see {self.logs_dir / PI_STDERR_FILENAME}"
            )

    def _keep_logs(self, work_dir: Path) -> Any:
        """Copy the run's directory into ``logs_dir`` and drop it.

        Returns the Recipe's ``metadata.json`` from ``context.logs_dir``, if it
        wrote one, for the trial's agent metadata.
        """

        metadata = None
        written = work_dir / METADATA_FILENAME
        if written.is_file():
            with contextlib.suppress(ValueError):
                metadata = json.loads(written.read_text())
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        shutil.copytree(work_dir, self.logs_dir, dirs_exist_ok=True, symlinks=True)
        shutil.rmtree(work_dir, ignore_errors=True)
        return metadata
