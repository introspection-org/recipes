from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from harbor.agents.installed.base import NonZeroAgentExitCodeError

from introspection_harbor.base import (
    RUNTIME_PROVIDER_HTTP_EXTENSION_PATH,
    managed_model_environment,
    managed_runtime_preloads_command,
    pi_args,
    pi_launcher_command,
    recipe_run_command,
    require_run_spec_v2,
    selected_prompt,
)
from introspection_harbor.runtime_agent import IntrospectionRecipeAgent
from introspection_harbor.trajectory import (
    pi_events_to_atif,
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
        self.assertNotIn("provider-http-pi-extension.js", args)

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
