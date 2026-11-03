from __future__ import annotations

import json
import shlex
import subprocess
import tempfile
import unittest
import unittest.mock
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.bridges.acp import build_acpx_config
from harbor.bridges.base import BaseBridge
from harbor.models.bridge import BridgeConfig, BridgeKind
from harbor.models.task.config import MCPServerConfig

from introspection_harbor.base import (
    ACP_PI_LAUNCHER,
    ACP_SERVER_LAUNCHER,
    PI_ACP_VERSION,
    RUNTIME_PROVIDER_HTTP_EXTENSION_PATH,
    STEP_START_FILENAME,
    acp_install_command,
    acp_pi_launcher,
    managed_model_environment,
    managed_runtime_preloads_command,
    pi_args,
    pi_launcher_command,
    prepare_recipe_command,
    recipe_run_command,
    require_run_spec_v2,
    selected_prompt,
)
from introspection_harbor.bootstrap_agent import (
    TOOLCHAIN_PRELUDE,
    IntrospectionBootstrapAgent,
)
from introspection_harbor.native_agent import IntrospectionNativeAgent
from introspection_harbor.runtime_agent import IntrospectionRecipeAgent
from introspection_harbor.trajectory import (
    pi_terminal_provider_error,
    read_spans,
    spans_to_trajectory,
)

_AUTHORED_SPEC = {
    "schema_version": 2,
    "candidate": {"runtime": "refunds", "agent": None, "model": None},
    "input": {},
}


def _agent(spec: dict, cls: type = IntrospectionRecipeAgent):
    instance = object.__new__(cls)
    instance._spec = spec
    instance.mcp_servers = []
    instance.skills_dir = None
    instance._extra_env = {}
    instance._OUTPUT_FILENAME = "pi.jsonl"
    return instance


def _capturing_agent() -> tuple[IntrospectionRecipeAgent, Mock, list[dict]]:
    """An agent whose commands are recorded, not run, and the environment it uses.

    Returns the agent, the environment and the keyword arguments of each exec.
    """
    instance = _agent(_AUTHORED_SPEC)
    environment = Mock()
    environment.upload_file = AsyncMock()
    calls: list[dict] = []

    async def capture_exec(*args, **kwargs):
        calls.append(kwargs)
        return SimpleNamespace(stdout="")

    instance.exec_as_agent = capture_exec
    return instance, environment, calls


def _spans(*turns: tuple[str, str, int]) -> str:
    """Whole-prompt chat spans, as a Pi session renders: (prompt, reply, tokens).

    Turn ``n`` starts ``n`` seconds into 2026-10-08T04:49.
    """

    history: list[dict] = []
    data = []
    for second, (prompt, reply, tokens) in enumerate(turns, start=1):
        history.append({"role": "user", "parts": [{"type": "text", "content": prompt}]})
        answer = {"role": "assistant", "parts": [{"type": "text", "content": reply}]}
        data.append(
            {
                "trace_id": "session-1",
                "span_id": f"span-{second}",
                "start_time": f"2026-10-08T04:49:{second:02d}Z",
                "attributes": {
                    "gen_ai": {
                        "conversation": {"id": "session-1"},
                        "provider": {"name": "anthropic"},
                        "response": {"model": "claude-sonnet-4-6"},
                        "usage": {
                            "input_tokens": tokens,
                            "output_tokens": 2,
                            "cache_read": {"input_tokens": 1},
                        },
                        "cost": {"usd": 0.5},
                        "input": {"messages": list(history)},
                        "output": {"messages": [answer]},
                    }
                },
            }
        )
        history.append(answer)
    return json.dumps({"object": "list", "data": data})


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


_RECIPE_SPEC = {
    "schema_version": 2,
    "candidate": {
        "runtime": "refunds",
        "agent": "operator-eval",
        "model": "openai/gpt-6.1-sol",
    },
    "input": {},
}


class AcpTargetTest(unittest.IsolatedAsyncioTestCase):
    def test_the_recipe_adapters_declare_the_acp_bridge_and_skills(self) -> None:
        for cls in (IntrospectionRecipeAgent, IntrospectionBootstrapAgent):
            self.assertIn(BridgeKind.ACP, cls.capabilities.bridges)
            self.assertTrue(cls.capabilities.skills)

    async def test_harbor_bridges_a_recipe_adapter(self) -> None:
        bridge = await BaseBridge.create(
            BridgeConfig(kind=BridgeKind.ACP), _agent(_RECIPE_SPEC)
        )
        self.assertEqual(bridge.env(), {})

    async def test_the_native_adapter_is_no_acp_target(self) -> None:
        native = object.__new__(IntrospectionNativeAgent)
        with self.assertRaisesRegex(ValueError, "does not support the 'acp' bridge"):
            await BaseBridge.create(BridgeConfig(kind=BridgeKind.ACP), native)

    def test_acp_command_starts_pi_acp_with_the_launcher(self) -> None:
        command = _agent(_RECIPE_SPEC).acp_command()

        self.assertEqual(command[0], "env")
        self.assertEqual(command[-1], ACP_SERVER_LAUNCHER)
        self.assertEqual(
            command[1:-1],
            [
                f"PI_ACP_PI_COMMAND={ACP_PI_LAUNCHER}",
                "PI_ACP_ENABLE_EMBEDDED_CONTEXT=true",
                "PI_CODING_AGENT_SESSION_DIR=/logs/agent/pi/sessions",
                "PI_RECIPE_GENAI_SPANS_FILE=/logs/agent/genai-spans.json",
            ],
        )
        # What Harbor writes into .acpxrc.json as the target agent.
        target = build_acpx_config(command)["agents"]["target"]
        self.assertEqual(target["command"], "env")

    def test_acp_env_carries_keys_only_from_the_environment(self) -> None:
        agent = _agent(_RECIPE_SPEC)
        self.assertEqual(agent.acp_env(), {})
        with unittest.mock.patch.dict(
            "os.environ",
            {
                "INTROSPECTION_TOKEN": "synthetic-locator",
                "INTROSPECTION_PUBLIC_EGRESS_URL": "https://egress.example.test",
            },
        ):
            env = agent.acp_env()
        # Under managed egress the session locator is the provider key.
        self.assertEqual(env, {"OPENAI_API_KEY": "synthetic-locator"})
        self.assertNotIn("synthetic", " ".join(agent.acp_command()))

    async def test_acp_install_writes_the_launchers_for_each_adapter(self) -> None:
        for cls, recipe_dir, prelude in (
            (IntrospectionRecipeAgent, "/opt/introspection/recipe", ""),
            (
                IntrospectionBootstrapAgent,
                "/tmp/introspection/recipe",
                TOOLCHAIN_PRELUDE,
            ),
        ):
            agent = _agent(_RECIPE_SPEC, cls)
            agent.skills_dir = "/skills"
            agent.exec_as_agent = AsyncMock()
            await agent.acp_install(Mock())

            agent.exec_as_agent.assert_awaited_once()
            commands = [agent.exec_as_agent.call_args.kwargs["command"]]
            self.assertTrue(commands[0].startswith(prelude))
            self.assertIn(
                f"npm install --no-audit --no-fund pi-acp@{PI_ACP_VERSION}", commands[0]
            )
            self.assertIn(f">{ACP_PI_LAUNCHER}", commands[0])
            self.assertIn(f">{ACP_SERVER_LAUNCHER}", commands[0])
            self.assertIn(f"--recipe {recipe_dir}", commands[0])
            self.assertIn("--skill /skills", commands[0])

    async def test_a_replay_is_not_served_over_acp(self) -> None:
        spec = {**_RECIPE_SPEC, "input": {"replay_context_path": "/tmp/context.json"}}
        agent = _agent(spec)
        agent.exec_as_agent = AsyncMock()
        with self.assertRaisesRegex(ValueError, "cannot be driven over ACP"):
            await agent.acp_install(Mock())
        agent.exec_as_agent.assert_not_called()

    def test_pi_launcher_runs_the_recipe_with_pi_acp_arguments(self) -> None:
        agent = _agent(_RECIPE_SPEC)
        with tempfile.TemporaryDirectory() as root:
            bin_dir = Path(root) / "bin"
            bin_dir.mkdir()
            # Stands in for Pi: prints its arguments and NODE_OPTIONS.
            pi = bin_dir / "pi"
            pi.write_text('#!/bin/sh\necho "$@"\necho "${NODE_OPTIONS:-}" >&2\n')
            pi.chmod(0o755)
            launcher = Path(root) / "launcher"
            stderr = Path(root) / "pi-stderr.log"
            launcher.write_text(
                acp_pi_launcher(agent.launch_args(), stderr_path=str(stderr)) + "\n"
            )
            launcher.chmod(0o755)

            launched = subprocess.run(
                [str(launcher), "--mode", "rpc", "--no-themes"],
                env={"PATH": f"{bin_dir}:/usr/bin:/bin"},
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()

            self.assertEqual(
                launched,
                "--extension "
                f"{RUNTIME_PROVIDER_HTTP_EXTENSION_PATH} "
                "--recipe /opt/introspection/recipe --agent operator-eval "
                "--model openai/gpt-6.1-sol --mode rpc --no-themes",
            )
            # Pi's stderr is kept; the preloads are skipped where they are absent.
            self.assertEqual(stderr.read_text(), "\n")

    def test_install_command_quotes_both_launchers(self) -> None:
        command = acp_install_command(["pi", "--recipe", "/r w"], prelude="P=1; ")
        self.assertTrue(command.startswith("P=1; mkdir -p /tmp/introspection-acp"))
        self.assertIn("'/r w'", acp_pi_launcher(["pi", "--recipe", "/r w"]))


class LaunchCommandTest(unittest.TestCase):
    def test_the_agent_declares_what_harbor_checks_before_a_trial(self) -> None:
        # Harbor refuses a task with ``[[environment.mcp_servers]]`` for an
        # agent that does not declare them, before the environment starts.
        capabilities = IntrospectionRecipeAgent.capabilities
        self.assertTrue(capabilities.mcp_servers)
        self.assertTrue(capabilities.resume)
        self.assertTrue(capabilities.atif)

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
        # The CLI owns the session file; the adapter only says where it lives,
        # so the hydrated session is still there to render after Pi exits.
        self.assertNotIn("--session", args)
        passthrough = args[args.index("--") + 1 :]
        self.assertEqual(passthrough[:2], ["--session-dir", "/logs/agent/pi/sessions"])
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
        # The step's start is marked first, on the trial's clock, and the run
        # is told where to keep its spans, with an earlier step's file gone.
        self.assertTrue(
            command.startswith(
                "node -e 'process.stdout.write(String(Date.now()))' "
                ">/logs/agent/step-start-ms; "
                "rm -f /logs/agent/genai-spans.json; "
                "export PI_RECIPE_GENAI_SPANS_FILE=/logs/agent/genai-spans.json; "
                "cd /opt/introspection/recipe && "
            )
        )
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

    def test_pi_launcher_keeps_a_subcommand_first(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            bin_dir = Path(home) / "bin"
            bin_dir.mkdir()
            # Stands in for Node: prints the arguments Pi would be started with.
            node = bin_dir / "node"
            node.write_text('#!/bin/sh\nshift\necho "$@"\n')
            node.chmod(0o755)
            env = {"HOME": home, "PATH": f"{bin_dir}:/usr/bin:/bin"}
            subprocess.run(["sh", "-c", pi_launcher_command()], env=env, check=True)

            def launched(*args: str) -> str:
                return subprocess.run(
                    [f"{home}/.local/bin/pi", *args],
                    env=env,
                    capture_output=True,
                    text=True,
                    check=True,
                ).stdout.strip()

            # `introspection local` checks its toolchain with `pi list`.
            self.assertEqual(launched("list"), "list")
            for subcommand in (
                "install",
                "remove",
                "uninstall",
                "update",
                "config",
                "auth",
                "mcp",
            ):
                self.assertEqual(launched(subcommand, "x"), f"{subcommand} x")
            self.assertTrue(launched("--print", "list").startswith("--extension "))
            self.assertTrue(launched("--print", "list").endswith(" --print list"))
            self.assertTrue(launched().startswith("--extension "))


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
                name="attio", transport="http", url="http://fakes:7353/attio/mcp"
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
                        "url": "http://fakes:7353/attio/mcp",
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
        instance, environment, calls = _capturing_agent()
        await instance.run.__wrapped__(
            instance, "large inline instruction", environment, Mock()
        )
        # One exec: the run writes its own spans, nothing renders them after.
        (captured,) = calls
        self.assertIn(
            "rm -f /logs/agent/genai-spans.json; "
            "export PI_RECIPE_GENAI_SPANS_FILE=/logs/agent/genai-spans.json; ",
            captured["command"],
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
        instance, environment, calls = _capturing_agent()
        self.assertTrue(instance.SUPPORTS_RESUME)
        # What Harbor's ``resume`` does around ``run`` for a later step.
        instance._resume = True
        await instance.run.__wrapped__(instance, "approval", environment, Mock())
        instance._resume = False
        await instance.run.__wrapped__(instance, "request", environment, Mock())

        self.assertIn("--continue --print", calls[0]["command"])
        self.assertNotIn("--continue", calls[1]["command"])

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
    def test_post_run_projects_the_spans_the_trial_rendered(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            logs_dir = Path(temp_dir)
            # Pi's own output disagrees on purpose: the spans are what is read.
            (logs_dir / "pi.jsonl").write_text(
                '{"type":"message_end","message":{"role":"assistant",'
                '"content":[{"type":"text","text":"from pi"}],"usage":{}}}\n'
            )
            (logs_dir / "genai-spans.json").write_text(_spans(("go", "done", 5)))
            spec = {**_AUTHORED_SPEC, "input": {"metadata": {"kind": "authored"}}}
            instance = _agent(spec)
            instance.logs_dir = logs_dir
            context = Mock(spec=["metadata"])

            instance.populate_context_post_run(context)

            written = json.loads((logs_dir / "trajectory.json").read_text())
            self.assertEqual(context.metadata["introspection"], {"kind": "authored"})
            self.assertEqual(written["schema_version"], "ATIF-v1.7")
            self.assertEqual(written["session_id"], "session-1")
            self.assertEqual(written["agent"]["name"], "introspection-recipe")
            self.assertEqual(
                [(step["source"], step["message"]) for step in written["steps"]],
                [("user", "go"), ("agent", "done")],
            )
            self.assertEqual(context.n_input_tokens, 5)
            self.assertEqual(context.n_output_tokens, 2)
            self.assertEqual(context.n_cache_tokens, 1)
            self.assertEqual(context.cost_usd, 0.5)
            # The whole session is this step, so Harbor reads usage from the file.
            self.assertFalse(hasattr(context, "model_usage"))

    def test_an_acp_target_projects_its_spans_without_an_event_stream(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            logs_dir = Path(temp_dir)
            # pi-acp runs Pi in RPC mode: spans for every prompt, no pi.jsonl.
            (logs_dir / "genai-spans.json").write_text(
                _spans(("first", "one", 5), ("second", "two", 7))
            )
            instance = _agent(_AUTHORED_SPEC)
            instance.logs_dir = logs_dir

            instance.populate_context_post_run(Mock())

            written = json.loads((logs_dir / "trajectory.json").read_text())
            self.assertEqual(
                [step["message"] for step in written["steps"]],
                ["first", "one", "second", "two"],
            )

    def _continued_step(self, logs_dir: Path, started: str) -> None:
        """A second step: the session holds the request turn and the approval."""

        (logs_dir / "pi.jsonl").write_text("{}\n")
        (logs_dir / "genai-spans.json").write_text(
            _spans(("request", "drafted", 5), ("approve", "ok", 7))
        )
        milliseconds = int(datetime.fromisoformat(started).timestamp() * 1000)
        (logs_dir / STEP_START_FILENAME).write_text(str(milliseconds))

    def test_a_continued_step_reports_the_conversation_and_its_own_usage(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            logs_dir = Path(temp_dir)
            # The step's Pi run started between the two turns.
            self._continued_step(logs_dir, "2026-10-08T04:49:01.500+00:00")
            instance = _agent(_AUTHORED_SPEC)
            instance.logs_dir = logs_dir
            context = Mock()

            instance.populate_context_post_run(context)

            written = json.loads((logs_dir / "trajectory.json").read_text())
            self.assertEqual(
                [step["message"] for step in written["steps"]],
                ["request", "drafted", "approve", "ok"],
            )
            # Usage is this step's alone, so a trial does not count a turn twice.
            self.assertEqual(context.n_input_tokens, 7)
            self.assertEqual(context.cost_usd, 0.5)
            usage = context.model_usage["anthropic/claude-sonnet-4-6"]
            self.assertEqual(usage.n_input_tokens, 7)

    def test_a_continued_step_without_a_model_call_reports_no_usage(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            logs_dir = Path(temp_dir)
            self._continued_step(logs_dir, "2026-10-08T04:50:00+00:00")
            instance = _agent(_AUTHORED_SPEC)
            instance.logs_dir = logs_dir
            context = Mock(spec=["metadata", "model_usage"])

            instance.populate_context_post_run(context)

            written = json.loads((logs_dir / "trajectory.json").read_text())
            self.assertEqual(len(written["steps"]), 4)
            self.assertEqual(context.model_usage, {})
            self.assertFalse(hasattr(context, "n_input_tokens"))

    def test_a_run_that_reached_the_model_without_spans_is_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            logs_dir = Path(temp_dir)
            (logs_dir / "pi.jsonl").write_text(
                json.dumps({"type": "message_end", "message": {"role": "assistant"}})
            )
            instance = _agent(_AUTHORED_SPEC)
            instance.logs_dir = logs_dir

            with self.assertRaisesRegex(
                FileNotFoundError, "PI_RECIPE_GENAI_SPANS_FILE"
            ):
                instance.populate_context_post_run(Mock())
            self.assertFalse((logs_dir / "trajectory.json").exists())

    def test_a_run_that_stopped_before_its_session_has_no_trajectory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            logs_dir = Path(temp_dir)
            (logs_dir / "pi.jsonl").write_text("Error: Recipe not found\n")
            instance = _agent(_AUTHORED_SPEC)
            instance.logs_dir = logs_dir

            instance.populate_context_post_run(Mock())

            self.assertFalse((logs_dir / "trajectory.json").exists())

    def test_spans_that_cannot_be_read_are_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "genai-spans.json"
            path.write_text("not json")
            with self.assertRaises(ValueError):
                read_spans(path)

    def test_a_run_without_a_model_call_has_no_trajectory(self) -> None:
        self.assertIsNone(spans_to_trajectory([]))
        with tempfile.TemporaryDirectory() as temp_dir:
            logs_dir = Path(temp_dir)
            (logs_dir / "pi.jsonl").write_text("{}\n")
            # The canonical envelope the extension writes for an empty session.
            (logs_dir / "genai-spans.json").write_text(
                '{"object":"list","data":[],"first_id":null,"last_id":null,'
                '"has_more":false,"next":null}'
            )
            instance = _agent(_AUTHORED_SPEC)
            instance.logs_dir = logs_dir

            instance.populate_context_post_run(Mock())

            self.assertFalse((logs_dir / "trajectory.json").exists())

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
