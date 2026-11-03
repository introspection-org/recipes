from __future__ import annotations

import asyncio
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock

from harbor.agents.base import BaseAgent
from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory
from harbor.models.trial.config import AgentConfig, TaskConfig, TrialConfig
from test_agent import _spans

from introspection_harbor.base import SESSION_TOKEN_ENV
from introspection_harbor.pi_user_agent import (
    REMOTE_PROMPT_PATH,
    SESSION_SHOW_COMMAND,
    USER_AGENT_TOKEN_ENV,
    USER_AGENT_URL_ENV,
    PiRecipeUserAgent,
    Primitives,
    model_tools,
    pi_argv,
    pi_environment,
    prompt_capabilities,
)
from introspection_harbor.trajectory import SPANS_FILE_ENV
from introspection_harbor.user_agent_mcp import Tool, ToolServer

# A Recipe in the pattern the README documents; a real Pi runs it as is.
SYNTHETIC_RECIPE = Path(__file__).parent / "fixtures" / "synthetic-recipe"
# What each of these tells the fake Pi, through the job config's ``env``.
FAKE_PI_SPANS_ENV = "FAKE_PI_SPANS"
FAKE_PI_MESSAGE_ENV = "FAKE_PI_MESSAGE"
FAKE_PI_CRASH_ENV = "FAKE_PI_CRASH"
# The variables whose values the fake Pi records, for a test whose values are
# all synthetic. Otherwise it records names only: the rest of its environment is
# the machine's, real provider keys included.
FAKE_PI_RECORD_ENV = "FAKE_PI_RECORD"


def spans_with_a_tool_call() -> str:
    """A turn whose tool result has a structured ``details``, then a trailing one."""

    def call(call_id: str) -> dict[str, Any]:
        return {
            "role": "assistant",
            "parts": [
                {"type": "tool_call", "id": call_id, "name": "say", "arguments": {}}
            ],
        }

    def execute(span_id: str, second: int, call_id: str, reply: str) -> dict[str, Any]:
        result = {
            "content": [{"type": "text", "text": reply}],
            "details": {"tool": "say", "reply": reply, "exit_code": 0},
        }
        return {
            "trace_id": "session-1",
            "span_id": span_id,
            "start_time": f"2026-10-08T04:50:{second:02d}Z",
            "attributes": {
                "gen_ai": {
                    "operation": {"name": "execute_tool"},
                    "tool": {
                        "name": "say",
                        "call": {"id": call_id, "result": json.dumps(result)},
                    },
                }
            },
        }

    listed = json.loads(_spans(("Start.", "Calling say.", 5)))
    listed["data"][0]["attributes"]["gen_ai"]["output"]["messages"] = [call("call-1")]
    listed["data"].append(execute("tool-1", 1, "call-1", "synthetic reply"))
    return json.dumps(listed)


class FakeEnvironment:
    """Records uploads and commands; acpx answers from ``replies`` in order.

    A reply is ``(exit code, stdout)``. Each upload keeps the file's content,
    since every prompt reuses one remote path. ``acpx_gate``, when set, is
    awaited before acpx answers. ``acpx sessions show`` answers ``session``,
    the target's session record.
    """

    def __init__(self, replies: list[tuple[int, str]] | None = None) -> None:
        self.replies = list(replies or [])
        self.commands: list[str] = []
        self.uploads: list[tuple[str, bytes]] = []
        self.exec_kwargs: list[dict[str, Any]] = []
        self.on_acpx = lambda: None
        self.acpx_gate: asyncio.Event | None = None
        # What claude-code-acp 0.16.2 advertises.
        self.session: tuple[int, str] = (
            0,
            json.dumps(
                {
                    "agentCapabilities": {
                        "promptCapabilities": {
                            "image": True,
                            "audio": False,
                            "embeddedContext": True,
                        }
                    }
                }
            ),
        )

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        self.uploads.append((target_path, Path(source_path).read_bytes()))

    async def exec(self, command: str, **kwargs: Any) -> SimpleNamespace:
        self.commands.append(command)
        self.exec_kwargs.append(kwargs)
        if command == "pwd":
            return SimpleNamespace(return_code=0, stdout="/app\n", stderr=None)
        if command == SESSION_SHOW_COMMAND:
            code, stdout = self.session
            return SimpleNamespace(return_code=code, stdout=stdout, stderr=None)
        if command.startswith("acpx "):
            self.on_acpx()
            if self.acpx_gate is not None:
                await self.acpx_gate.wait()
            code, stdout = self.replies.pop(0)
            return SimpleNamespace(return_code=code, stdout=stdout, stderr=None)
        if command.startswith("false"):
            return SimpleNamespace(return_code=3, stdout="ran", stderr="warned")
        return SimpleNamespace(return_code=0, stdout="", stderr=None)

    def prompts(self) -> list[list[dict[str, Any]]]:
        """Every ACP prompt uploaded, as the blocks acpx read."""

        return [
            json.loads(content)
            for target, content in self.uploads
            if target == REMOTE_PROMPT_PATH
        ]


async def open_call(
    url: str, token: str, name: str, arguments: dict[str, Any]
) -> asyncio.StreamWriter:
    """Send a ``tools/call`` on a raw socket and return without reading it."""

    host, port = url.removeprefix("http://").removesuffix("/mcp").split(":")
    _, writer = await asyncio.open_connection(host, int(port))
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }
    ).encode()
    writer.write(
        f"POST /mcp HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\n"
        f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n".encode()
        + body
    )
    await writer.drain()
    return writer


async def hang_up(writer: asyncio.StreamWriter) -> None:
    writer.close()
    await writer.wait_closed()


def mcp_request(
    url: str, token: str | None, payload: dict[str, Any]
) -> tuple[int, list[dict]]:
    """POST one JSON-RPC message; returns the status and the SSE data events."""

    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode()
            status = response.status
    except urllib.error.HTTPError as error:
        error.close()
        return error.code, []
    events = [
        json.loads(line.removeprefix("data: "))
        for line in body.splitlines()
        if line.startswith("data: ")
    ]
    return status, events


def call_tool(url: str, token: str, name: str, arguments: dict[str, Any]) -> dict:
    """``tools/call`` through the server; the final JSON-RPC result."""

    payload = {
        "jsonrpc": "2.0",
        "id": 7,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }
    return mcp_request(url, token, payload)[1][-1]["result"]


def fake_pi_main() -> None:
    """Stands in for Pi running a Recipe whose extension calls the primitives.

    It finds the server in its environment, as the Recipe's extension does
    when it registers it with Pi's MCP client, and records what it got in
    ``context.logs_dir``. It refuses to run with codemode in reach of the model.
    """

    recipe = Path(sys.argv[sys.argv.index("--recipe") + 1])
    if not (recipe / "package.json").is_file():
        sys.exit(f"no Recipe at {recipe}")
    if sys.argv[sys.argv.index("--tools") + 1] != "say":
        sys.exit("the model may call only the Recipe's `say`")
    url = os.environ[USER_AGENT_URL_ENV]
    token = os.environ[USER_AGENT_TOKEN_ENV]
    context = call_tool(url, token, "context", {})["structuredContent"]
    logs = Path(context["logs_dir"])
    recorded = os.environ.get(FAKE_PI_RECORD_ENV, "").split(",")
    (logs / "pi-env.json").write_text(
        json.dumps(
            {
                "names": sorted(os.environ),
                "values": {
                    name: os.environ[name] for name in recorded if name in os.environ
                },
            }
        )
    )
    (logs / "pi-argv.json").write_text(json.dumps(sys.argv))
    # The Recipes extension keeps the file current, turn by turn, so a run cut
    # off below has it too.
    if spans := os.environ.get(FAKE_PI_SPANS_ENV):
        Path(os.environ[SPANS_FILE_ENV]).write_text(spans)
    if message := os.environ.get(FAKE_PI_MESSAGE_ENV):
        print(json.dumps({"type": "message_end", "message": {"role": message}}))
    reply = call_tool(
        url,
        token,
        "prompt_target",
        {"prompt": [{"type": "text", "text": "Hello from the user."}]},
    )
    (logs / "recipe-log.jsonl").write_text(json.dumps(reply["structuredContent"]))
    (logs / "metadata.json").write_text(json.dumps({"inputs": context["inputs"]}))
    print(json.dumps({"type": "tool_result", "result": reply}))
    if os.environ.get(FAKE_PI_CRASH_ENV):
        sys.exit(2)


class PiEnvironmentTest(unittest.TestCase):
    def test_pi_keeps_what_a_local_run_needs(self) -> None:
        host = {
            "PATH": "/bin",
            "HOME": "/home/synthetic",
            "LC_ALL": "C",
            "NODE_OPTIONS": "--import preload.js",
            "HTTPS_PROXY": "http://proxy",
            "NVM_DIR": "/nvm",
            "OPENAI_API_KEY": "synthetic-openai",
            "OPENAI_BASE_URL": "http://synthetic",
            "ANTHROPIC_OAUTH_TOKEN": "synthetic-anthropic",
            "AWS_PROFILE": "synthetic",
            "GOOGLE_APPLICATION_CREDENTIALS": "/gcp.json",
            "FIREWORKS_API_KEY": "synthetic-fireworks",
            "PI_CODING_AGENT_DIR": "/pi",
        }

        self.assertEqual(pi_environment("openai/gpt-6-luna", host), host)

    def test_pi_gets_nothing_of_the_operators_identity(self) -> None:
        host = {
            SESSION_TOKEN_ENV: "synthetic-session",
            "INTROSPECTION_TASK_CONVERSATION_ID": "the-operators-conversation",
            "INTROSPECTION_TASK_ID": "task",
            "INTROSPECTION_BASE_OTEL_URL": "http://otel",
            "INTROSPECTION_SERVICE_NAME": "operator",
            "INTROSPECTION_API_KEY": "synthetic-project-key",
            "E2B_API_KEY": "synthetic-sandbox-key",
            "OTEL_EXPORTER_OTLP_ENDPOINT": "http://otel",
            "SOME_UNRELATED_SECRET": "synthetic",
        }

        self.assertEqual(pi_environment("openai/gpt-6-luna", host), {})

    def test_under_managed_egress_pi_presents_what_the_target_presents(self) -> None:
        host = {
            SESSION_TOKEN_ENV: "synthetic-locator",
            "INTROSPECTION_PUBLIC_EGRESS_URL": "https://egress",
            "INTROSPECTION_EGRESS_URL": "http://egress",
            "INTROSPECTION_ENDPOINT_HOSTS": "api.openai.com",
            "INTROSPECTION_PROXY_KEY": "synthetic-locator",
            "OPENAI_API_KEY": "a-real-key",
        }

        env = pi_environment("openai/gpt-6-luna", host)

        self.assertEqual(env["OPENAI_API_KEY"], "synthetic-locator")
        self.assertEqual(env["INTROSPECTION_EGRESS_URL"], "http://egress")
        self.assertEqual(env["INTROSPECTION_ENDPOINT_HOSTS"], "api.openai.com")
        self.assertEqual(env["INTROSPECTION_PROXY_KEY"], "synthetic-locator")
        self.assertNotIn(SESSION_TOKEN_ENV, env)
        self.assertNotIn("INTROSPECTION_PUBLIC_EGRESS_URL", env)


class PiArgvTest(unittest.TestCase):
    def test_pi_runs_the_recipe_in_print_mode(self) -> None:
        argv = pi_argv(
            recipe_dir=Path("/r/owner"),
            session_dir=Path("/w/sessions"),
            prompt="Start.",
            tools=["say", "log_*"],
            model="openai/gpt-6-luna",
            agent="owner",
        )

        self.assertEqual(argv[:4], ["pi", "--print", "--mode", "json"])
        self.assertIn("--no-context-files", argv)
        self.assertEqual(argv[argv.index("--recipe") + 1], "/r/owner")
        self.assertEqual(argv[argv.index("--agent") + 1], "owner")
        self.assertEqual(argv[argv.index("--tools") + 1], "say,log_*")
        self.assertEqual(argv[argv.index("--model") + 1], "openai/gpt-6-luna")
        self.assertEqual(argv[-2:], ["--", "Start."])
        self.assertNotIn("--extension", argv)

    def test_pi_takes_the_provider_extension_when_there_is_one(self) -> None:
        argv = pi_argv(
            recipe_dir=Path("/r/owner"),
            session_dir=Path("/w/sessions"),
            prompt="Start.",
            tools=["say"],
            provider_http_extension_path="/runtime/provider.js",
        )

        self.assertEqual(argv[argv.index("--extension") + 1], "/runtime/provider.js")

    def test_the_model_gets_no_tool_that_reaches_the_primitives(self) -> None:
        for tools in (
            ["say", "codemode"],
            ["tool_search"],
            ["mcp__harbor__prompt_target"],
            ["*"],
            ["code*"],
            ["+say"],
            ["-codemode"],
            ["say,codemode"],
            ["say,tool_search"],
            ["say", " codemode"],
            ["say", "  "],
            ["say", ""],
            [""],
            [],
            "say",
        ):
            with self.subTest(tools=tools), self.assertRaises(ValueError):
                model_tools(tools)

        self.assertEqual(model_tools(["say", "done"]), ["say", "done"])


class PrimitivesTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())

    def primitives(self, env: FakeEnvironment, **kwargs: Any) -> Primitives:
        return Primitives(env, self.root, **kwargs)

    async def test_prompt_target_sends_the_acp_prompt_as_is_through_acpx(
        self,
    ) -> None:
        env = FakeEnvironment([(0, "  Done, see app.py.\n")])
        prompt = [
            {"type": "text", "text": "Build it."},
            {"type": "image", "mimeType": "image/png", "data": "c3ludGhldGlj"},
        ]

        result = await self.primitives(env).prompt_target({"prompt": prompt})

        self.assertEqual(result, {"reply": "Done, see app.py.", "exit_code": 0})
        self.assertEqual(env.prompts(), [prompt])
        self.assertEqual(env.commands, [f"acpx prompt --file {REMOTE_PROMPT_PATH}"])
        self.assertTrue((self.root / "prompts" / "001.json").is_file())

    async def test_a_failing_acpx_is_an_exit_code_not_an_error(self) -> None:
        env = FakeEnvironment([(1, "session closed")])

        result = await self.primitives(env).prompt_target(
            {"prompt": [{"type": "text", "text": "Hi"}]}
        )

        self.assertEqual(result, {"reply": "session closed", "exit_code": 1})

    async def test_prompt_target_refuses_an_empty_or_malformed_prompt(self) -> None:
        primitives = self.primitives(FakeEnvironment())

        for arguments in (
            {},
            {"prompt": []},
            {"prompt": "Hi"},
            {"prompt": [{"text": "no type"}]},
            {"prompt": [{"type": 3}]},
            {"text": "the dropped shortcut"},
        ):
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                await primitives.prompt_target(arguments)

    async def test_upload_file_resolves_a_relative_target_in_the_workspace(
        self,
    ) -> None:
        env = FakeEnvironment()
        source = self.root / "report.png"
        source.write_bytes(b"synthetic")

        result = await self.primitives(env).upload_file(
            {"source": str(source), "target": "media/report.png"}
        )

        self.assertEqual(result, {"path": "/app/media/report.png"})
        self.assertEqual(env.commands, ["pwd", "mkdir -p /app/media"])
        self.assertEqual(env.uploads, [("/app/media/report.png", b"synthetic")])

    async def test_upload_file_refuses_a_missing_source(self) -> None:
        with self.assertRaisesRegex(ValueError, "No file at"):
            await self.primitives(FakeEnvironment()).upload_file(
                {"source": str(self.root / "missing"), "target": "/app/x"}
            )

    async def test_exec_returns_the_exit_code_and_both_streams(self) -> None:
        env = FakeEnvironment()

        result = await self.primitives(env, exec_timeout_sec=60).exec(
            {"command": "false --synthetic", "cwd": "/app"}
        )

        self.assertEqual(result, {"exit_code": 3, "stdout": "ran", "stderr": "warned"})
        self.assertEqual(env.exec_kwargs, [{"cwd": "/app", "timeout_sec": 60}])

    async def test_context_describes_the_run(self) -> None:
        primitives = self.primitives(
            FakeEnvironment(),
            instruction="Build a synthetic CRM agent.",
            inputs={"task_dir": "/tasks/create-1"},
            target_capabilities=["image"],
        )

        self.assertEqual(
            await primitives.context({}),
            {
                "logs_dir": str(self.root),
                "target_capabilities": ["image"],
                "workspace_dir": "/app",
                "instruction": "Build a synthetic CRM agent.",
                "inputs": {"task_dir": "/tasks/create-1"},
            },
        )

    async def test_context_reads_the_capabilities_the_target_advertised(
        self,
    ) -> None:
        # pi-acp 0.0.34's answer, as `acpx --format json sessions show` prints it.
        session = {
            "acpSessionId": "synthetic-session",
            "agentCapabilities": {
                "loadSession": True,
                "promptCapabilities": {
                    "image": True,
                    "audio": False,
                    "embeddedContext": True,
                },
            },
        }
        env = FakeEnvironment()
        env.session = (0, json.dumps(session))
        primitives = self.primitives(env)

        for _ in range(2):
            context = await primitives.context({})
            self.assertEqual(
                context["target_capabilities"], ["embeddedContext", "image"]
            )
        # Read once, from the session the bridge started.
        self.assertEqual(env.commands.count(SESSION_SHOW_COMMAND), 1)

    async def test_context_fails_without_a_target_session(self) -> None:
        env = FakeEnvironment()
        env.session = (1, "no session")
        primitives = self.primitives(env)

        with self.assertRaisesRegex(RuntimeError, "no session"):
            await primitives.context({})

    def test_prompt_capabilities_need_the_agent_capabilities(self) -> None:
        self.assertEqual(
            prompt_capabilities(
                json.dumps({"agentCapabilities": {"promptCapabilities": {}}})
            ),
            (),
        )
        for broken in ("not json", "{}", '{"agentCapabilities": null}'):
            with self.assertRaisesRegex(RuntimeError, "no agent capabilities"):
                prompt_capabilities(broken)


class ToolServerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        async def slow(arguments: dict[str, Any]) -> dict[str, Any]:
            await asyncio.sleep(0.3)
            return {"echo": arguments["text"]}

        async def broken(arguments: dict[str, Any]) -> dict[str, Any]:
            raise ValueError("no such file")

        self.hang_started = asyncio.Event()
        self.hang_cancelled = asyncio.Event()

        async def hang(arguments: dict[str, Any]) -> dict[str, Any]:
            self.hang_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                self.hang_cancelled.set()
            return {}

        tools = [
            Tool("echo", "Echo", {"type": "object"}, slow),
            Tool("broken", "Fails", {"type": "object"}, broken),
            Tool("hang", "Never answers", {"type": "object"}, hang),
        ]
        self.server = ToolServer(tools, "secret", keepalive_sec=0.05)
        self.url = await self.server.start()

    async def asyncTearDown(self) -> None:
        await self.server.close()

    async def request(self, payload: dict[str, Any], token: str | None = "secret"):
        return await asyncio.to_thread(mcp_request, self.url, token, payload)

    async def test_initialize_and_list_tools(self) -> None:
        status, [init] = await self.request(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-03-26"},
            }
        )
        self.assertEqual(status, 200)
        self.assertEqual(init["result"]["protocolVersion"], "2025-03-26")
        self.assertIn("tools", init["result"]["capabilities"])

        _, [listed] = await self.request(
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
        )
        self.assertEqual(
            [tool["name"] for tool in listed["result"]["tools"]],
            ["echo", "broken", "hang"],
        )

    async def test_a_slow_call_streams_progress_then_the_result(self) -> None:
        _, events = await self.request(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "echo",
                    "arguments": {"text": "hi"},
                    "_meta": {"progressToken": "p"},
                },
            }
        )

        *progress, final = events
        self.assertTrue(progress)
        self.assertTrue(all(e["method"] == "notifications/progress" for e in progress))
        self.assertEqual(final["id"], 3)
        self.assertEqual(final["result"]["structuredContent"], {"echo": "hi"})
        self.assertEqual(
            json.loads(final["result"]["content"][0]["text"]), {"echo": "hi"}
        )
        self.assertFalse(final["result"]["isError"])

    async def test_a_failing_tool_is_an_error_result(self) -> None:
        result = await asyncio.to_thread(call_tool, self.url, "secret", "broken", {})

        self.assertTrue(result["isError"])
        self.assertEqual(result["content"][0]["text"], "no such file")
        self.assertNotIn("structuredContent", result)

    async def test_a_call_is_cancelled_when_the_client_hangs_up(self) -> None:
        writer = await open_call(self.url, "secret", "hang", {})
        await asyncio.wait_for(self.hang_started.wait(), 5)

        await hang_up(writer)

        await asyncio.wait_for(self.hang_cancelled.wait(), 5)

    async def test_close_cancels_and_awaits_a_running_call(self) -> None:
        writer = await open_call(self.url, "secret", "hang", {})
        await asyncio.wait_for(self.hang_started.wait(), 5)

        await asyncio.wait_for(self.server.close(), 5)

        self.assertTrue(self.hang_cancelled.is_set())
        await hang_up(writer)

    async def test_requests_without_the_token_are_refused(self) -> None:
        status, events = await self.request(
            {"jsonrpc": "2.0", "id": 4, "method": "tools/list"}, token=None
        )

        self.assertEqual((status, events), (401, []))

    async def test_notifications_are_accepted_without_a_body(self) -> None:
        status, events = await self.request(
            {"jsonrpc": "2.0", "method": "notifications/initialized"}
        )

        self.assertEqual((status, events), (202, []))


class PiRecipeUserAgentTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.logs = self.root / "user-agent"
        self.logs.mkdir()  # Harbor creates it before the agent

    def agent(self, **kwargs: Any) -> PiRecipeUserAgent:
        recipe = self.root / "recipe"
        shutil.copytree(SYNTHETIC_RECIPE, recipe, dirs_exist_ok=True)
        fake_pi = self.root / "fake-pi"
        fake_pi.write_text(
            f"#!{sys.executable}\nimport sys\n"
            f"sys.path.insert(0, {str(Path(__file__).parent)!r})\n"
            "from test_pi_user_agent import fake_pi_main\nfake_pi_main()\n"
        )
        fake_pi.chmod(fake_pi.stat().st_mode | stat.S_IXUSR)
        return PiRecipeUserAgent(
            self.logs,
            "openai/gpt-6-luna",
            **{
                "recipe_dir": recipe,
                "tools": ["say"],
                "pi_command": str(fake_pi),
                **kwargs,
            },
        )

    async def test_run_serves_the_primitives_and_keeps_the_record_in_logs_dir(
        self,
    ) -> None:
        agent = self.agent(inputs={"task_dir": "/tasks/create-1"})
        env = FakeEnvironment([(0, "Hi, what do you need?")])
        during: list[str] = []
        env.on_acpx = lambda: during.extend(path.name for path in self.logs.iterdir())
        context = AgentContext()

        with mock.patch("secrets.token_urlsafe", return_value="synthetic-token"):
            await agent.run("rendered instruction", env, context)  # ty: ignore[invalid-argument-type]
        # Harbor calls the hook only on a context the run left empty.
        self.assertTrue(context.is_empty())
        agent.populate_context_post_run(context)

        # The target can read logs_dir while it runs: nothing is there yet.
        self.assertEqual(during, [])
        self.assertEqual(
            json.loads((self.logs / "recipe-log.jsonl").read_text()),
            {"reply": "Hi, what do you need?", "exit_code": 0},
        )
        self.assertIn("Hi, what do you need?", (self.logs / "pi.jsonl").read_text())
        self.assertTrue((self.logs / "prompts" / "001.json").is_file())
        self.assertEqual(
            context.metadata["user_agent"],
            {
                "exit_code": 0,
                "prompts": 1,
                "metadata": {"inputs": {"task_dir": "/tasks/create-1"}},
            },
        )
        # The token reached Pi's environment only, never a kept file.
        for path in self.logs.rglob("*"):
            if path.is_file():
                self.assertNotIn("synthetic-token", path.read_text())

    async def test_pi_failing_fails_the_run_and_keeps_the_logs(self) -> None:
        agent = self.agent()
        agent._extra_env = {FAKE_PI_CRASH_ENV: "1"}
        env = FakeEnvironment([(1, "agent crashed")])

        with self.assertRaisesRegex(RuntimeError, "Pi exited 2"):
            await agent.run("x", env, AgentContext())  # ty: ignore[invalid-argument-type]
        self.assertTrue((self.logs / "recipe-log.jsonl").is_file())

    async def test_relative_paths_resolve_against_harbors_working_directory(
        self,
    ) -> None:
        cwd = os.getcwd()
        os.chdir(self.root)
        try:
            agent = self.agent(recipe_dir="recipe", pi_command="./fake-pi")
        finally:
            os.chdir(cwd)
        env = FakeEnvironment([(0, "Hi.")])

        self.assertTrue(agent.recipe_dir.is_absolute())
        self.assertTrue(agent.recipe_dir.samefile(self.root / "recipe"))
        # Pi runs in its own temp directory and still finds both.
        await agent.run("x", env, AgentContext())  # ty: ignore[invalid-argument-type]
        self.assertTrue((self.logs / "recipe-log.jsonl").is_file())

    async def test_a_missing_recipe_is_refused_before_pi_starts(self) -> None:
        agent = self.agent()
        (agent.recipe_dir / "package.json").unlink()

        with self.assertRaisesRegex(FileNotFoundError, "No Recipe"):
            await agent.run("x", FakeEnvironment(), AgentContext())  # ty: ignore[invalid-argument-type]

    async def test_cancelling_the_run_ends_every_call_before_the_logs_are_copied(
        self,
    ) -> None:
        agent = self.agent()
        env = FakeEnvironment([(0, "never sent")])
        env.acpx_gate = asyncio.Event()  # the target's turn never ends
        asked = asyncio.Event()
        env.on_acpx = asked.set
        context = AgentContext()

        run = asyncio.ensure_future(agent.run("x", env, context))  # ty: ignore[invalid-argument-type]
        await asyncio.wait_for(asked.wait(), 30)
        run.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await run
        agent.populate_context_post_run(context)

        # The cut-off prompt was recorded, and nothing of the run is left
        # running: releasing the target now changes nothing in logs_dir.
        self.assertTrue((self.logs / "prompts" / "001.json").is_file())
        before = sorted(str(path) for path in self.logs.rglob("*"))
        env.acpx_gate.set()
        await asyncio.sleep(0.1)
        self.assertEqual(sorted(str(path) for path in self.logs.rglob("*")), before)
        self.assertEqual(env.replies, [(0, "never sent")])
        self.assertIsNone(context.metadata["user_agent"]["exit_code"])

    def write_trial_config(self, agent: AgentConfig) -> None:
        """The config Harbor writes into the trial directory before any agent runs."""

        config = TrialConfig(
            task=TaskConfig(path=self.root / "task"),
            trial_name="synthetic-trial",
            agent=agent,
        )
        (self.root / "config.json").write_text(
            config.model_dump_json(exclude_defaults=True)
        )

    async def test_the_post_run_hook_runs_the_targets_own_hook_on_its_logs(
        self,
    ) -> None:
        self.write_trial_config(
            AgentConfig(
                import_path=f"{__name__}:FakeTarget",
                kwargs={"reply": "synthetic reply"},
            )
        )
        agent = self.agent()
        context = AgentContext()
        await agent.run("x", FakeEnvironment([(0, "Hi.")]), context)  # ty: ignore[invalid-argument-type]

        agent.populate_context_post_run(context)

        # The target wrote its trajectory where a verifier reads it, and its
        # usage is kept apart from the user agent's context.
        self.assertEqual(
            json.loads((self.root / "agent" / "trajectory.json").read_text()),
            {"steps": [{"message": "synthetic reply"}]},
        )
        self.assertEqual(context.metadata["target"], {"n_input_tokens": 3})
        self.assertEqual(context.metadata["user_agent"]["prompts"], 1)
        self.assertIsNone(context.n_input_tokens)

    async def test_run_writes_its_trajectory_and_the_hook_reports_its_usage(
        self,
    ) -> None:
        self.write_trial_config(
            AgentConfig(import_path=f"{__name__}:FakeTarget", kwargs={"reply": "r"})
        )
        agent = self.agent()
        agent._extra_env = {FAKE_PI_SPANS_ENV: spans_with_a_tool_call()}
        env = FakeEnvironment([(0, "Hi.")])
        during: list[str] = []
        env.on_acpx = lambda: during.extend(path.name for path in self.logs.iterdir())
        context = AgentContext()

        await agent.run("x", env, context)  # ty: ignore[invalid-argument-type]

        self.assertEqual(during, [])
        self.assertTrue(context.is_empty())
        written = json.loads((self.logs / "trajectory.json").read_text())
        Trajectory.model_validate(written)
        results = [
            result
            for step in written["steps"]
            for result in (step.get("observation") or {}).get("results", [])
        ]
        self.assertEqual(results[0]["extra"]["details"]["reply"], "synthetic reply")
        self.assertEqual(results[0]["extra"]["details"]["tool"], "say")

        agent.populate_context_post_run(context)

        self.assertEqual(context.n_input_tokens, 5)
        self.assertEqual(context.n_output_tokens, 2)
        self.assertEqual(context.n_cache_tokens, 1)
        self.assertEqual(context.cost_usd, 0.5)
        self.assertEqual(context.metadata["user_agent"]["atif"], "trajectory.json")
        # The target's usage stays apart.
        self.assertEqual(context.metadata["target"], {"n_input_tokens": 3})

    async def test_spans_go_to_the_run_directory_not_logs_dir(self) -> None:
        agent = self.agent()
        agent._extra_env = {FAKE_PI_RECORD_ENV: SPANS_FILE_ENV}

        await agent.run("x", FakeEnvironment([(0, "Hi.")]), AgentContext())  # ty: ignore[invalid-argument-type]

        recorded = json.loads((self.logs / "pi-env.json").read_text())
        spans = recorded["values"][SPANS_FILE_ENV]
        self.assertEqual(Path(spans).name, "genai-spans.json")
        self.assertFalse(Path(spans).is_relative_to(self.logs))
        self.assertFalse(Path(spans).parent.exists())

    async def test_a_run_pi_failed_still_leaves_its_trajectory(self) -> None:
        agent = self.agent()
        agent._extra_env = {
            FAKE_PI_CRASH_ENV: "1",
            FAKE_PI_SPANS_ENV: spans_with_a_tool_call(),
        }

        with self.assertRaisesRegex(RuntimeError, "Pi exited 2"):
            await agent.run("x", FakeEnvironment([(0, "Hi.")]), AgentContext())  # ty: ignore[invalid-argument-type]

        self.assertTrue((self.logs / "trajectory.json").is_file())

    async def test_a_run_cut_off_still_leaves_its_trajectory(self) -> None:
        agent = self.agent()
        agent._extra_env = {FAKE_PI_SPANS_ENV: spans_with_a_tool_call()}
        env = FakeEnvironment([(0, "never sent")])
        env.acpx_gate = asyncio.Event()
        asked = asyncio.Event()
        env.on_acpx = asked.set

        run = asyncio.ensure_future(agent.run("x", env, AgentContext()))  # ty: ignore[invalid-argument-type]
        await asyncio.wait_for(asked.wait(), 30)
        run.cancel()
        # The cancellation is what comes out, as Harbor's timeout needs.
        with self.assertRaises(asyncio.CancelledError):
            await run

        self.assertTrue((self.logs / "trajectory.json").is_file())

    async def test_a_trajectory_failure_still_runs_the_targets_hook(self) -> None:
        for name, extra_env, expected in (
            ("no spans", {FAKE_PI_MESSAGE_ENV: "assistant"}, SPANS_FILE_ENV),
            ("bad spans", {FAKE_PI_SPANS_ENV: "not json"}, "Invalid JSON"),
        ):
            with self.subTest(name):
                self.setUp()
                self.write_trial_config(
                    AgentConfig(
                        import_path=f"{__name__}:FakeTarget",
                        kwargs={"reply": "synthetic reply"},
                    )
                )
                agent = self.agent()
                agent._extra_env = extra_env
                context = AgentContext()

                # The type Harbor records before it goes on to the verifier.
                with self.assertRaisesRegex(NonZeroAgentExitCodeError, expected):
                    await agent.run("x", FakeEnvironment([(0, "Hi.")]), context)  # ty: ignore[invalid-argument-type]
                agent.populate_context_post_run(context)

                self.assertFalse((self.logs / "trajectory.json").exists())
                self.assertTrue((self.root / "agent" / "trajectory.json").is_file())
                self.assertEqual(context.metadata["target"], {"n_input_tokens": 3})
                self.assertIn(
                    expected, context.metadata["user_agent"]["trajectory_error"]
                )
                self.assertIsNone(context.n_input_tokens)

    async def test_a_run_that_never_started_pi_has_no_trajectory_and_no_error(
        self,
    ) -> None:
        agent = self.agent()
        context = AgentContext()

        await agent.run("x", FakeEnvironment([(0, "Hi.")]), context)  # ty: ignore[invalid-argument-type]
        agent.populate_context_post_run(context)

        self.assertFalse((self.logs / "trajectory.json").exists())
        self.assertNotIn("trajectory_error", context.metadata["user_agent"])
        self.assertNotIn("atif", context.metadata["user_agent"])

    async def test_pi_gets_an_explicit_environment_without_the_session_token(
        self,
    ) -> None:
        agent = self.agent()
        agent._extra_env = {
            "RECIPE_SETTING": "from the job config",
            FAKE_PI_RECORD_ENV: "OPENAI_API_KEY,RECIPE_SETTING",
        }
        host = {
            SESSION_TOKEN_ENV: "synthetic-locator",
            "INTROSPECTION_PUBLIC_EGRESS_URL": "https://egress",
            "INTROSPECTION_TASK_CONVERSATION_ID": "the-operators-conversation",
            "SOME_UNRELATED_SECRET": "synthetic",
        }

        with mock.patch.dict(os.environ, host):
            await agent.run("x", FakeEnvironment([(0, "Hi.")]), AgentContext())  # ty: ignore[invalid-argument-type]

        recorded = json.loads((self.logs / "pi-env.json").read_text())
        self.assertNotIn(SESSION_TOKEN_ENV, recorded["names"])
        self.assertNotIn("INTROSPECTION_TASK_CONVERSATION_ID", recorded["names"])
        self.assertNotIn("SOME_UNRELATED_SECRET", recorded["names"])
        self.assertIn("PATH", recorded["names"])
        # A Runtime with no provider key: the managed one, as the target gets.
        self.assertEqual(
            recorded["values"],
            {
                "OPENAI_API_KEY": "synthetic-locator",
                "RECIPE_SETTING": "from the job config",
            },
        )

    async def test_a_runtime_host_gives_pi_the_provider_extension(self) -> None:
        extension = self.root / "provider-http-pi-extension.js"
        extension.write_text("")
        agent = self.agent()

        with mock.patch(
            "introspection_harbor.pi_user_agent.RUNTIME_PROVIDER_HTTP_EXTENSION_PATH",
            str(extension),
        ):
            await agent.run("x", FakeEnvironment([(0, "Hi.")]), AgentContext())  # ty: ignore[invalid-argument-type]

        argv = json.loads((self.logs / "pi-argv.json").read_text())
        self.assertEqual(argv[argv.index("--extension") + 1], str(extension))

    def test_without_a_trial_config_there_is_no_target(self) -> None:
        context = AgentContext()

        self.agent().populate_context_post_run(context)

        self.assertTrue(context.is_empty())
        self.assertFalse((self.root / "agent").exists())


class FakeTarget(BaseAgent):
    """A target whose post-run hook writes a trajectory, as Harbor's agents do."""

    def __init__(self, logs_dir: Path, *args: Any, reply: str, **kwargs: Any) -> None:
        super().__init__(logs_dir, *args, **kwargs)
        self.reply = reply

    @staticmethod
    def name() -> str:
        return "fake-target"

    def version(self) -> str:
        return "0"

    async def setup(self, environment: Any) -> None:
        pass

    async def run(self, instruction: str, environment: Any, context: Any) -> None:
        raise AssertionError("a bridged target is never run")

    def populate_context_post_run(self, context: AgentContext) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "trajectory.json").write_text(
            json.dumps({"steps": [{"message": self.reply}]})
        )
        context.n_input_tokens = 3


if __name__ == "__main__":
    unittest.main()
