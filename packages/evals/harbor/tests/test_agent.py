from __future__ import annotations

import json
import shlex
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.models.task.config import MCPServerConfig

from introspection_harbor.base import (
    RUNTIME_PROVIDER_HTTP_EXTENSION_PATH,
    managed_model_environment,
    managed_runtime_preloads_command,
    pi_args,
    pi_launcher_command,
    prepare_recipe_command,
    recipe_run_command,
    require_run_spec_v2,
    selected_prompt,
)
from introspection_harbor.runtime_agent import IntrospectionRecipeAgent
from introspection_harbor.trajectory import (
    pi_events_to_atif,
    pi_messages_to_atif,
    pi_terminal_provider_error,
)

_AUTHORED_SPEC = {
    "schema_version": 2,
    "candidate": {"runtime": "refunds", "agent": None, "model": None},
    "input": {},
}


def _agent(spec: dict) -> IntrospectionRecipeAgent:
    instance = object.__new__(IntrospectionRecipeAgent)
    instance._spec = spec
    instance.mcp_servers = []
    instance._OUTPUT_FILENAME = "pi.jsonl"
    return instance


class RunSpecTest(unittest.TestCase):
    def test_schema_one_requires_a_newer_cli(self) -> None:
        with self.assertRaisesRegex(ValueError, "Update the Introspection CLI"):
            require_run_spec_v2({"schema_version": 1})

    def test_schema_two_is_accepted(self) -> None:
        require_run_spec_v2({"schema_version": 2})

    def test_production_conversation_usesselected_prompt(self) -> None:
        spec = {"input": {"prompt": "counterfactual prompt"}}
        self.assertEqual(
            selected_prompt(spec, "Harbor instruction"), "counterfactual prompt"
        )

    def test_authored_run_uses_harbor_instruction(self) -> None:
        self.assertEqual(
            selected_prompt({"input": {}}, "Harbor instruction"),
            "Harbor instruction",
        )

    def test_empty_prompt_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "non-empty"):
            selected_prompt({"input": {"prompt": "  "}}, "instruction")


class LaunchCommandTest(unittest.TestCase):
    def test_authored_run_launches_the_baked_pi_directly(self) -> None:
        args = pi_args(
            _AUTHORED_SPEC["candidate"],
            _AUTHORED_SPEC,
            provider_http_extension_path=RUNTIME_PROVIDER_HTTP_EXTENSION_PATH,
        )
        self.assertEqual(
            args,
            [
                "pi",
                "--extension",
                "/usr/local/lib/introspection-runtime/provider-http-pi-extension.js",
                "--recipe",
                "/opt/introspection/recipe",
                "--session-dir",
                "/logs/agent/pi/sessions",
                "--print",
                "--mode",
                "json",
                "--approve",
                "@/tmp/introspection-eval-prompt.md",
            ],
        )

    def test_inherited_agent_is_selected_by_declared_name(self) -> None:
        candidate = {**_AUTHORED_SPEC["candidate"], "agent": "agent2"}
        args = pi_args(
            candidate,
            _AUTHORED_SPEC,
            provider_http_extension_path=RUNTIME_PROVIDER_HTTP_EXTENSION_PATH,
        )
        self.assertEqual(args[5:7], ["--agent", "agent2"])

    def test_declared_model_is_selected(self) -> None:
        candidate = {
            **_AUTHORED_SPEC["candidate"],
            "model": "anthropic/claude-sonnet-4-6",
        }
        args = pi_args(
            candidate,
            _AUTHORED_SPEC,
            provider_http_extension_path=RUNTIME_PROVIDER_HTTP_EXTENSION_PATH,
        )
        self.assertEqual(args[5:7], ["--model", "anthropic/claude-sonnet-4-6"])

    def test_replay_runs_through_introspection_local(self) -> None:
        spec = {
            **_AUTHORED_SPEC,
            "input": {
                "prompt": "production prompt",
                "replay_context_path": "/host/replay-context.json",
            },
        }
        args = pi_args(spec["candidate"], spec)
        self.assertEqual(args[:2], ["introspection", "local"])
        self.assertIn("--replay-context", args)
        self.assertIn("/tmp/introspection-replay-context.json", args)
        self.assertEqual(args[-1], "@/tmp/introspection-eval-prompt.md")
        self.assertNotIn("production prompt", args)
        self.assertNotIn("--session", args)
        self.assertNotIn("--session-dir", args)
        self.assertNotIn("provider-http-pi-extension.js", args)

    def test_resumed_step_continues_the_previous_pi_session(self) -> None:
        args = pi_args(_AUTHORED_SPEC["candidate"], _AUTHORED_SPEC, resume=True)
        self.assertEqual(
            args,
            [
                "pi",
                "--recipe",
                "/opt/introspection/recipe",
                "--session-dir",
                "/logs/agent/pi/sessions",
                "--continue",
                "--print",
                "--mode",
                "json",
                "--approve",
                "@/tmp/introspection-eval-prompt.md",
            ],
        )

    def test_first_step_starts_a_new_pi_session(self) -> None:
        self.assertNotIn(
            "--continue", pi_args(_AUTHORED_SPEC["candidate"], _AUTHORED_SPEC)
        )

    def test_replay_refuses_to_resume(self) -> None:
        spec = {
            **_AUTHORED_SPEC,
            "input": {"replay_context_path": "/host/replay-context.json"},
        }
        with self.assertRaisesRegex(ValueError, "cannot resume a previous step"):
            pi_args(spec["candidate"], spec, resume=True)

    def test_replay_with_runtime_id_uses_the_only_baked_manifest(self) -> None:
        spec = {
            **_AUTHORED_SPEC,
            "candidate": {
                **_AUTHORED_SPEC["candidate"],
                "runtime": "01990000-0000-7000-8000-000000000001",
            },
            "input": {"replay_context_path": "/host/replay-context.json"},
        }
        args = pi_args(spec["candidate"], spec)
        self.assertNotIn("--runtime", args)

    def test_run_command_captures_events_and_preserves_exit_status(self) -> None:
        command = recipe_run_command(["pi", "--recipe", "x"], "pi.jsonl")
        self.assertTrue(command.startswith("cd /opt/introspection/recipe && "))
        self.assertIn(
            "if [ -f /usr/local/lib/introspection-runtime/proxy-preload.js ]; then",
            command,
        )
        self.assertIn(
            'export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }'
            "--import file:///usr/local/lib/introspection-runtime/"
            'cli-telemetry-preload.js"',
            command,
        )
        self.assertIn(">/logs/agent/pi.jsonl 2>&1", command)
        self.assertIn("status=$?", command)
        self.assertIn("test $status -eq 0 && test -s /logs/agent/pi.jsonl", command)
        self.assertNotIn("|", command)
        self.assertNotIn("nvm", command)

    def test_managed_runtime_preloads_match_the_runtime_child_contract(
        self,
    ) -> None:
        command = managed_runtime_preloads_command()
        self.assertIn("export INTROSPECTION_LOG_LEVEL=WARN", command)
        self.assertIn(
            "--import file:///usr/local/lib/introspection-runtime/proxy-preload.js",
            command,
        )
        self.assertIn("${NODE_OPTIONS:+$NODE_OPTIONS }--import file:///", command)
        self.assertIn('case " ${NODE_OPTIONS:-} "', command)
        self.assertIn("*) ;;", command)

    def test_pi_launcher_is_skipped_when_the_image_provides_pi(self) -> None:
        command = pi_launcher_command()
        self.assertTrue(
            command.startswith("if command -v pi >/dev/null 2>&1; then exit 0; fi; ")
        )
        self.assertIn('mkdir -p "$HOME/.local/bin"', command)
        self.assertIn('> "$HOME/.local/bin/pi"', command)
        self.assertIn("pi-coding-agent/dist/cli.js", command)
        self.assertIn("recipes/dist/pi-extension.js", command)
        self.assertNotIn("npm", command)
        self.assertNotIn("introspection setup", command)


class ManagedModelEnvironmentTest(unittest.TestCase):
    def test_managed_egress_presents_the_session_locator_as_the_provider_key(
        self,
    ) -> None:
        host_env = {
            "INTROSPECTION_TOKEN": "session-locator",
            "INTROSPECTION_PUBLIC_EGRESS_URL": "https://egress.example.com",
            "ANTHROPIC_API_KEY": "real-host-key",
        }
        self.assertEqual(
            managed_model_environment("anthropic/claude-sonnet-4-6", host_env),
            {"ANTHROPIC_API_KEY": "session-locator"},
        )

    def test_without_managed_egress_no_key_is_forwarded(self) -> None:
        # The host's own provider key never reaches the trial from here; the
        # explicit passthrough allow-list in the environment class is the only path.
        host_env = {"ANTHROPIC_API_KEY": "real-host-key"}
        self.assertEqual(
            managed_model_environment("anthropic/claude-sonnet-4-6", host_env), {}
        )

    def test_unknown_provider_or_bare_model_gets_nothing(self) -> None:
        host_env = {
            "INTROSPECTION_TOKEN": "session-locator",
            "INTROSPECTION_PUBLIC_EGRESS_URL": "https://egress.example.com",
        }
        self.assertEqual(managed_model_environment("acme/model", host_env), {})
        self.assertEqual(managed_model_environment("claude-sonnet-4-6", host_env), {})
        self.assertEqual(managed_model_environment(None, host_env), {})


class AgentLifecycleTest(unittest.IsolatedAsyncioTestCase):
    async def test_install_only_verifies_the_baked_recipe(self) -> None:
        instance = _agent(_AUTHORED_SPEC)
        instance.exec_as_root = AsyncMock()
        instance.exec_as_agent = AsyncMock()
        environment = Mock()
        environment.upload_dir = AsyncMock()
        environment.upload_file = AsyncMock()

        await instance.install(environment)

        environment.upload_dir.assert_not_awaited()
        environment.upload_file.assert_not_awaited()
        instance.exec_as_root.assert_not_awaited()
        agent_commands = [
            call.kwargs["command"] for call in instance.exec_as_agent.await_args_list
        ]
        self.assertIn("$HOME/.local/bin/pi", agent_commands[0])
        self.assertIn(
            "test -f /opt/introspection/recipe/package.json", agent_commands[1]
        )
        self.assertIn("mcp.local.example.json", agent_commands[1])
        for command in agent_commands:
            for forbidden in ("npm", "git ", "introspection setup", "apt-get"):
                self.assertNotIn(forbidden, command)

    async def test_install_binds_the_mcp_servers_the_task_declares(self) -> None:
        instance = _agent(_AUTHORED_SPEC)
        instance.mcp_servers = [
            MCPServerConfig(
                name="attio", transport="http", url="http://fakes:4318/attio/mcp"
            )
        ]
        instance.exec_as_agent = AsyncMock()

        await instance.install(Mock())

        command = instance.exec_as_agent.await_args_list[1].kwargs["command"]
        self.assertNotIn("mcp.local.example.json", command)
        binding, target = shlex.split(command)[-2:]
        self.assertEqual(
            json.loads(binding),
            {
                "servers": [
                    {
                        "id": "attio",
                        "transport": "streamable_http",
                        "url": "http://fakes:4318/attio/mcp",
                    }
                ]
            },
        )
        self.assertEqual(target, ">/opt/introspection/recipe/.pi/mcp.local.json")

    def test_a_task_mcp_server_pi_cannot_bind_is_refused(self) -> None:
        server = MCPServerConfig(name="crm", transport="stdio", command="crm-mcp")

        with self.assertRaisesRegex(ValueError, "'crm' uses transport 'stdio'"):
            prepare_recipe_command(mcp_servers=[server])

    async def test_install_uploads_the_canonical_replay_context(self) -> None:
        spec = {
            **_AUTHORED_SPEC,
            "input": {"replay_context_path": "/host/replay-context.json"},
        }
        instance = _agent(spec)
        instance.exec_as_root = AsyncMock()
        instance.exec_as_agent = AsyncMock()
        environment = Mock()
        environment.upload_file = AsyncMock()

        await instance.install(environment)

        environment.upload_file.assert_awaited_once_with(
            Path("/host/replay-context.json"),
            "/tmp/introspection-replay-context.json",
        )

    async def test_run_uploads_the_prompt_file_and_passes_no_host_env(self) -> None:
        instance = _agent(_AUTHORED_SPEC)
        environment = Mock()
        environment.upload_file = AsyncMock()
        captured: dict = {}

        async def capture_exec(*args, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(stdout="")

        instance.exec_as_agent = capture_exec
        await instance.run.__wrapped__(
            instance, "large inline instruction", environment, Mock()
        )

        environment.upload_file.assert_awaited_once()
        uploaded_path, remote_path = environment.upload_file.await_args_list[0].args
        self.assertEqual(remote_path, "/tmp/introspection-eval-prompt.md")
        self.assertEqual(uploaded_path.name, "prompt.md")
        self.assertIn(
            "pi --extension "
            "/usr/local/lib/introspection-runtime/provider-http-pi-extension.js "
            "--recipe /opt/introspection/recipe",
            captured["command"],
        )
        self.assertIn("@/tmp/introspection-eval-prompt.md", captured["command"])
        self.assertNotIn("large inline instruction", captured["command"])
        self.assertNotIn("env", captured)
        self.assertNotIn("cwd", captured)

    async def test_resume_continues_the_session_for_that_step_only(self) -> None:
        instance = _agent(_AUTHORED_SPEC)
        environment = Mock()
        environment.upload_file = AsyncMock()
        commands: list[str] = []

        async def capture_exec(*args, **kwargs):
            commands.append(kwargs["command"])
            return SimpleNamespace(stdout="")

        instance.exec_as_agent = capture_exec
        self.assertTrue(instance.SUPPORTS_RESUME)
        # What Harbor's ``resume`` does around ``run`` for a later step.
        instance._resume = True
        await instance.run.__wrapped__(instance, "approval", environment, Mock())
        instance._resume = False
        await instance.run.__wrapped__(instance, "request", environment, Mock())

        self.assertIn("--continue --print", commands[0])
        self.assertNotIn("--continue", commands[1])

    async def test_run_rejects_a_terminal_provider_error(self) -> None:
        instance = _agent(_AUTHORED_SPEC)
        instance.exec_as_agent = AsyncMock(
            return_value=SimpleNamespace(
                stdout=(
                    "not-json diagnostic output\n"
                    '{"type":"message_end","message":{"role":"assistant",'
                    '"stopReason":"error","errorMessage":"401 authentication_error"}}\n'
                )
            )
        )
        environment = Mock()
        environment.upload_file = AsyncMock()

        with self.assertRaisesRegex(
            NonZeroAgentExitCodeError,
            "Pi provider error: 401 authentication_error",
        ):
            await instance.run.__wrapped__(instance, "instruction", environment, Mock())


class TrajectoryTest(unittest.TestCase):
    def test_trajectory_records_the_observed_model(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            events = Path(temp_dir) / "pi.jsonl"
            events.write_text(
                '{"type":"message_end","message":{"role":"assistant",'
                '"provider":"openrouter","model":"deepseek/deepseek-v4-flash",'
                '"content":[{"type":"text","text":"done"}],"usage":{}}}\n'
            )
            trajectory = pi_events_to_atif(events)
            self.assertEqual(
                trajectory.agent.model_name,
                "openrouter/deepseek/deepseek-v4-flash",
            )

    def test_trajectory_links_tool_results_and_sums_usage(self) -> None:
        events = [
            {"type": "message_start"},
            {
                "type": "message_end",
                "message": {"role": "user", "content": "write the greeting"},
            },
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "provider": "anthropic",
                    "model": "claude-sonnet-4-6",
                    "content": [
                        {"type": "thinking", "thinking": "call the tool"},
                        {
                            "type": "toolCall",
                            "id": "call-1",
                            "name": "write",
                            "arguments": {"path": "/app/greeting.txt"},
                        },
                    ],
                    "usage": {
                        "input": 10,
                        "output": 5,
                        "cacheRead": 3,
                        "cost": {"total": 0.25},
                    },
                },
            },
            {
                "type": "message_end",
                "message": {
                    "role": "toolResult",
                    "toolCallId": "call-1",
                    "content": [{"type": "text", "text": "ok"}],
                },
            },
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "pi.jsonl"
            path.write_text("".join(json.dumps(event) + "\n" for event in events))
            trajectory = pi_events_to_atif(path)

        self.assertEqual([step.source for step in trajectory.steps], ["user", "agent"])
        agent_step = trajectory.steps[1]
        self.assertEqual(agent_step.reasoning_content, "call the tool")
        self.assertEqual(agent_step.tool_calls[0].function_name, "write")
        self.assertEqual(agent_step.observation.results[0].content, "ok")
        metrics = trajectory.final_metrics
        self.assertEqual(metrics.total_prompt_tokens, 10)
        self.assertEqual(metrics.total_completion_tokens, 5)
        self.assertEqual(metrics.total_cached_tokens, 3)
        self.assertEqual(metrics.total_cost_usd, 0.25)

    def test_pi_events_mark_a_failed_tool_result(self) -> None:
        def call(call_id: str) -> dict:
            return {
                "role": "assistant",
                "content": [{"type": "toolCall", "id": call_id, "name": "read"}],
            }

        def result(call_id: str, **fields: bool) -> dict:
            return {
                "role": "toolResult",
                "toolCallId": call_id,
                "content": [{"type": "text", "text": call_id}],
                **fields,
            }

        trajectory = pi_messages_to_atif(
            [
                call("failed"),
                result("failed", isError=True),
                call("passed"),
                result("passed", isError=False),
                call("unmarked"),
                result("unmarked"),
            ]
        )

        extras = [step.observation.results[0].extra for step in trajectory.steps]
        self.assertEqual(extras, [{"is_error": True}, None, None])

    def test_post_run_writes_the_atif_trajectory_and_context_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            logs_dir = Path(temp_dir)
            (logs_dir / "pi.jsonl").write_text(
                '{"type":"message_end","message":{"role":"assistant",'
                '"provider":"anthropic","model":"claude-sonnet-4-6",'
                '"content":[{"type":"text","text":"done"}],'
                '"usage":{"input":4,"output":2,"cacheRead":1,"cost":{"total":0.5}}}}\n'
            )
            spec = {**_AUTHORED_SPEC, "input": {"metadata": {"kind": "authored"}}}
            instance = _agent(spec)
            instance.logs_dir = logs_dir
            context = Mock()

            instance.populate_context_post_run(context)

            written = json.loads((logs_dir / "trajectory.json").read_text())
            self.assertEqual(written["agent"]["name"], "introspection-recipe")
            self.assertEqual(context.n_input_tokens, 4)
            self.assertEqual(context.n_output_tokens, 2)
            self.assertEqual(context.n_cache_tokens, 1)
            self.assertEqual(context.cost_usd, 0.5)
            self.assertEqual(context.metadata["introspection"], {"kind": "authored"})

    def _continued_step(self, logs_dir: Path) -> None:
        """A second step: Pi printed the approval turn; the session has both."""

        def assistant(text: str, tokens: int) -> dict:
            return {
                "role": "assistant",
                "provider": "anthropic",
                "model": "claude-sonnet-4-6",
                "content": [{"type": "text", "text": text}],
                "usage": {"input": tokens, "output": 1, "cost": {"total": 0.25}},
            }

        def user(text: str) -> dict:
            return {"role": "user", "content": [{"type": "text", "text": text}]}

        review = [user("Send the email."), assistant("Please review.", 10)]
        approval = [user("Approved."), assistant("Sent.", 4)]
        (logs_dir / "pi.jsonl").write_text(
            "".join(
                json.dumps({"type": "message_end", "message": message}) + "\n"
                for message in approval
            )
        )
        sessions = logs_dir / "pi" / "sessions" / "--opt-introspection-recipe--"
        sessions.mkdir(parents=True)
        (sessions / "2026-10-08T04-49-00-000Z_session.jsonl").write_text(
            json.dumps({"type": "session", "id": "session"})
            + "\n"
            + json.dumps({"type": "message", "message": {"role": "system"}})
            + "\n"
            + "".join(
                json.dumps({"type": "message", "message": message}) + "\n"
                for message in [*review, *approval]
            )
        )

    def test_a_continued_step_reports_the_whole_conversation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            logs_dir = Path(temp_dir)
            self._continued_step(logs_dir)
            instance = _agent(_AUTHORED_SPEC)
            instance.logs_dir = logs_dir
            context = Mock()

            instance.populate_context_post_run(context)

            written = json.loads((logs_dir / "trajectory.json").read_text())
            self.assertEqual(
                [(step["source"], step["message"]) for step in written["steps"]],
                [
                    ("user", "Send the email."),
                    ("agent", "Please review."),
                    ("user", "Approved."),
                    ("agent", "Sent."),
                ],
            )
            # Usage is this step's alone, so a trial does not count a turn twice.
            self.assertEqual(context.n_input_tokens, 4)
            self.assertEqual(context.cost_usd, 0.25)

    def test_a_continued_step_reports_its_own_model_usage(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            logs_dir = Path(temp_dir)
            self._continued_step(logs_dir)
            instance = _agent(_AUTHORED_SPEC)
            instance.logs_dir = logs_dir
            context = Mock()

            instance.populate_context_post_run(context)

            usage = context.model_usage["anthropic/claude-sonnet-4-6"]
            self.assertEqual(usage.n_input_tokens, 4)

    def test_a_first_step_keeps_the_trajectory_of_its_own_run(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            logs_dir = Path(temp_dir)
            message = {
                "role": "assistant",
                "content": [{"type": "text", "text": "done"}],
                "usage": {},
            }
            (logs_dir / "pi.jsonl").write_text(
                json.dumps({"type": "message_end", "message": message}) + "\n"
            )
            sessions = logs_dir / "pi" / "sessions"
            sessions.mkdir(parents=True)
            (sessions / "session.jsonl").write_text(
                json.dumps({"type": "message", "message": message}) + "\n"
            )
            instance = _agent(_AUTHORED_SPEC)
            instance.logs_dir = logs_dir
            context = Mock(spec=["metadata"])

            instance.populate_context_post_run(context)

            written = json.loads((logs_dir / "trajectory.json").read_text())
            self.assertEqual(len(written["steps"]), 1)
            self.assertFalse(hasattr(context, "model_usage"))

    def test_completion_accepts_a_retry_that_ends_successfully(self) -> None:
        events = [
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "stopReason": "error",
                    "errorMessage": "transient provider error",
                    "content": [],
                    "usage": {},
                },
            },
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "stopReason": "stop",
                    "content": [{"type": "text", "text": "done"}],
                    "usage": {},
                },
            },
        ]
        output = "".join(json.dumps(event) + "\n" for event in events)
        self.assertIsNone(pi_terminal_provider_error(output))

    def test_post_run_is_a_no_op_without_events(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            instance = _agent(_AUTHORED_SPEC)
            instance.logs_dir = Path(temp_dir)
            context = Mock()
            instance.populate_context_post_run(context)
            self.assertFalse((Path(temp_dir) / "trajectory.json").exists())
