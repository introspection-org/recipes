from __future__ import annotations

import asyncio
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from introspection_harbor.agent import (
    IntrospectionRecipeAgent,
    _materialize_workspace,
    _mcp_header_environment,
    _model_environment,
    _node_prerequisite_command,
    _pi_events_to_atif,
    _recipe_run_command,
    _require_run_spec_v2,
    _selected_prompt,
    _write_recipe_patch,
)


class AgentHelpersTest(unittest.TestCase):
    def test_trajectory_records_the_observed_model(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            events = Path(temp_dir) / "pi.jsonl"
            events.write_text(
                '{"type":"message_end","message":{"role":"assistant",'
                '"provider":"openrouter","model":"deepseek/deepseek-v4-flash",'
                '"content":[{"type":"text","text":"done"}],"usage":{}}}\n'
            )
            trajectory = _pi_events_to_atif(events)
            self.assertEqual(
                trajectory.agent.model_name,
                "openrouter/deepseek/deepseek-v4-flash",
            )

    def test_production_conversation_uses_selected_prompt(self) -> None:
        spec = {"input": {"prompt": "counterfactual prompt"}}
        self.assertEqual(
            _selected_prompt(spec, "Harbor instruction"), "counterfactual prompt"
        )

    def test_authored_run_uses_harbor_instruction(self) -> None:
        spec = {"input": {}}
        self.assertEqual(
            _selected_prompt(spec, "Harbor instruction"), "Harbor instruction"
        )

    def test_schema_one_requires_a_newer_cli(self) -> None:
        with self.assertRaisesRegex(ValueError, "Update the Introspection CLI"):
            _require_run_spec_v2({"schema_version": 1})

    def test_schema_two_is_accepted(self) -> None:
        _require_run_spec_v2({"schema_version": 2})

    def test_recipe_pipeline_preserves_the_first_failure(self) -> None:
        command = _recipe_run_command(["introspection", "local"], "pi.jsonl")
        self.assertTrue(command.startswith("set -o pipefail;"))

    def test_recipe_pipeline_only_loads_nvm_when_it_exists(self) -> None:
        command = _recipe_run_command(["introspection", "local"], "pi.jsonl")
        self.assertIn('if [ -s "$HOME/.nvm/nvm.sh" ]', command)
        self.assertNotIn("; . ~/.nvm/nvm.sh;", command)

    def test_recipe_runs_from_the_staged_source_directory(self) -> None:
        command = _recipe_run_command(["introspection", "local"], "pi.jsonl")
        self.assertIn(
            "cd /tmp/introspection-recipe-source && introspection local", command
        )

    def test_recipe_rejects_an_empty_pi_event_stream(self) -> None:
        command = _recipe_run_command(["introspection", "local"], "pi.jsonl")
        self.assertIn("test -s /logs/agent/pi.jsonl", command)

    def test_bedrock_forwards_temporary_session_credentials(self) -> None:
        credentials = {
            "AWS_ACCESS_KEY_ID": "key",
            "AWS_SECRET_ACCESS_KEY": "secret",
            "AWS_SESSION_TOKEN": "token",
            "AWS_REGION": "us-east-1",
        }
        with patch.dict(os.environ, credentials, clear=True):
            self.assertEqual(_model_environment("amazon-bedrock/model"), credentials)

    def test_google_does_not_forward_host_credential_file_paths(self) -> None:
        credentials = {
            "GEMINI_API_KEY": "key",
            "GOOGLE_APPLICATION_CREDENTIALS": "/host/service-account.json",
        }
        with patch.dict(os.environ, credentials, clear=True):
            self.assertEqual(
                _model_environment("google/model"), {"GEMINI_API_KEY": "key"}
            )

    def test_mcp_header_environment_forwards_only_referenced_values(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            recipe = Path(temp_dir)
            config = recipe / ".pi" / "mcp.local.json"
            config.parent.mkdir()
            config.write_text(
                json.dumps(
                    {
                        "servers": [
                            {
                                "id": "hello",
                                "headers": {
                                    "Authorization": "Bearer ${HELLO_MCP_TOKEN}"
                                },
                                "description": "${UNRELATED_SECRET}",
                            }
                        ]
                    }
                )
            )
            with patch.dict(
                os.environ,
                {
                    "HELLO_MCP_TOKEN": "provider-token",
                    "UNRELATED_SECRET": "do-not-forward",
                },
                clear=True,
            ):
                self.assertEqual(
                    _mcp_header_environment(recipe),
                    {"HELLO_MCP_TOKEN": "provider-token"},
                )

    def test_mcp_header_environment_ignores_missing_or_invalid_config(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            recipe = Path(temp_dir)
            self.assertEqual(_mcp_header_environment(recipe), {})
            config = recipe / ".pi" / "mcp.local.json"
            config.parent.mkdir()
            config.write_text("not json")
            self.assertEqual(_mcp_header_environment(recipe), {})

    def test_node_setup_supports_non_debian_task_images(self) -> None:
        command = _node_prerequisite_command()
        self.assertIn("command -v apk", command)
        self.assertIn("command -v dnf", command)
        self.assertIn("command -v yum", command)
        self.assertIn("command -v zypper", command)
        self.assertIn("command -v curl", command)
        self.assertFalse(command.startswith("apt-get"))

    def test_workspace_staging_preserves_monorepo_sources_and_excludes_secrets(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "source"
            staged = Path(temp_dir) / "staged"
            files = {
                "package.json": "{}",
                "pnpm-lock.yaml": "lockfileVersion: '9.0'",
                "pnpm-workspace.yaml": "packages: ['packages/*']",
                ".introspection/runtimes/agent.yaml": "runtime: {}",
                "packages/agent/package.json": "{}",
                "packages/agent/.gitignore": "dist/\n",
                "packages/agent/dist/index.js": "export const generated = true;",
                "packages/shared/index.ts": "export const shared = true;",
                ".env.example": "TOKEN=replace-me",
                ".env": "TOKEN=secret",
                ".npmrc": "//registry.example/:_authToken=secret",
                "certificate.pem": "secret",
                "node_modules/pkg/index.js": "generated",
                ".introspection/eval-runs/run/result.json": "{}",
                ".pi/bin/mcp": "#!/bin/sh\nexec /host-only/mcp-client\n",
                ".pi/mcp-catalogs/deepwiki.json": "{}",
                ".pi/mcp-session.json": "{}",
                ".pi/mcporter.json": "{}",
                ".pi/mcp.local.json": '{"mcpServers": {}}',
            }
            for relative, contents in files.items():
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(contents)
            subprocess.run(["git", "init", "--quiet", root], check=True)

            _materialize_workspace(root, staged)

            for relative in [
                "package.json",
                "pnpm-lock.yaml",
                "pnpm-workspace.yaml",
                ".introspection/runtimes/agent.yaml",
                "packages/agent/package.json",
                "packages/agent/dist/index.js",
                "packages/shared/index.ts",
                ".env.example",
                ".pi/mcp.local.json",
            ]:
                self.assertTrue((staged / relative).is_file(), relative)
            for relative in [
                ".env",
                ".npmrc",
                "certificate.pem",
                ".git/config",
                "node_modules/pkg/index.js",
                ".introspection/eval-runs/run/result.json",
                ".pi/bin/mcp",
                ".pi/mcp-catalogs/deepwiki.json",
                ".pi/mcp-session.json",
                ".pi/mcporter.json",
            ]:
                self.assertFalse((staged / relative).exists(), relative)

    def test_workspace_staging_preserves_directory_symlink_type(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "source"
            staged = Path(temp_dir) / "staged"
            target = root / "packages/shared"
            target.mkdir(parents=True)
            link = root / "packages/linked"
            try:
                link.symlink_to("shared", target_is_directory=True)
            except OSError as error:
                self.skipTest(f"directory symlinks are unavailable: {error}")

            with patch.object(Path, "symlink_to") as symlink_to:
                _materialize_workspace(root, staged)

            symlink_to.assert_called_once()
            self.assertTrue(symlink_to.call_args.kwargs["target_is_directory"])

    def test_harbor_run_preserves_task_workdir_for_default_agent(self) -> None:
        instance = object.__new__(IntrospectionRecipeAgent)
        instance._spec = {
            "candidate": {"runtime": "refunds", "agent": None, "model": None},
            "input": {},
        }
        instance.model_name = None
        instance._recipe_path = Path("/nonexistent")
        instance._OUTPUT_FILENAME = "pi.jsonl"
        environment = Mock()

        async def capture_exec(*args, **kwargs):
            environment.command = kwargs["command"]
            environment.cwd = kwargs.get("cwd")

        instance.exec_as_agent = capture_exec
        asyncio.run(instance.run.__wrapped__(instance, "prompt", environment, Mock()))
        self.assertIn(
            "--work-dir /tmp/introspection-recipe-source", environment.command
        )
        self.assertNotIn("--agent", environment.command)
        self.assertIsNone(environment.cwd)

    def test_harbor_run_selects_inherited_agent_by_declared_name(self) -> None:
        instance = object.__new__(IntrospectionRecipeAgent)
        instance._spec = {
            "candidate": {"runtime": "refunds", "agent": "agent2", "model": None},
            "input": {},
        }
        instance.model_name = None
        instance._recipe_path = Path("/nonexistent")
        instance._OUTPUT_FILENAME = "pi.jsonl"
        environment = Mock()

        async def capture_exec(*args, **kwargs):
            environment.command = kwargs["command"]

        instance.exec_as_agent = capture_exec
        asyncio.run(instance.run.__wrapped__(instance, "prompt", environment, Mock()))
        self.assertIn("--agent agent2", environment.command)

    def test_harbor_run_forwards_replay_context_to_local(self) -> None:
        instance = object.__new__(IntrospectionRecipeAgent)
        instance._spec = {
            "candidate": {"runtime": "refunds", "agent": None, "model": None},
            "input": {
                "prompt": "production prompt",
                "replay_context_path": "/host/replay-context.json",
            },
        }
        instance.model_name = None
        instance._recipe_path = Path("/nonexistent")
        instance._OUTPUT_FILENAME = "pi.jsonl"
        environment = Mock()

        async def capture_exec(*args, **kwargs):
            environment.command = kwargs["command"]

        instance.exec_as_agent = capture_exec
        asyncio.run(instance.run.__wrapped__(instance, "authored", environment, Mock()))
        self.assertIn(
            "--replay-context /tmp/introspection-replay-context.json",
            environment.command,
        )
        self.assertIn("--print 'production prompt'", environment.command)
        self.assertNotIn("--session", environment.command)


class AgentStagingTest(unittest.IsolatedAsyncioTestCase):
    async def test_baked_install_uses_image_recipe_without_upload(self) -> None:
        instance = object.__new__(IntrospectionRecipeAgent)
        instance._spec = {"candidate": {"cli_version": "0.34.0"}, "input": {}}
        instance._recipe_mode = "baked"
        instance._remote_source_dir = "/opt/introspection/recipe"
        instance.exec_as_root = AsyncMock()
        instance.exec_as_agent = AsyncMock()
        environment = Mock()
        environment.upload_dir = AsyncMock()
        environment.upload_file = AsyncMock()

        await instance.install(environment)

        environment.upload_dir.assert_not_awaited()
        environment.upload_file.assert_not_awaited()
        instance.exec_as_root.assert_not_awaited()
        command = instance.exec_as_agent.await_args.kwargs["command"]
        self.assertIn("test -f /opt/introspection/recipe/package.json", command)
        self.assertNotIn("npm install", command)

    def test_sync_patch_is_relative_to_the_recipe(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            recipe = workspace / "recipe"
            recipe.mkdir()
            target = recipe / "package.json"
            target.write_text('{"version":"1"}\n')
            subprocess.run(["git", "init", "--quiet"], cwd=workspace, check=True)
            subprocess.run(["git", "add", "."], cwd=workspace, check=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "--quiet",
                    "-m",
                    "base",
                ],
                cwd=workspace,
                check=True,
            )
            base = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=workspace, text=True
            ).strip()
            target.write_text('{"version":"2"}\n')
            destination = workspace / "recipe.patch"

            _write_recipe_patch(workspace, Path("recipe"), base, destination)

            patch_text = destination.read_text()
            self.assertIn("a/package.json", patch_text)
            self.assertIn("b/package.json", patch_text)
            self.assertNotIn("a/recipe/package.json", patch_text)

    async def test_install_uploads_filtered_workspace_without_tar_or_opt_layout(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir) / "workspace"
            workspace.mkdir()
            (workspace / "package.json").write_text("{}")

            instance = object.__new__(IntrospectionRecipeAgent)
            instance._spec = {
                "candidate": {"cli_version": "0.23.0"},
                "input": {},
            }
            instance._workspace_path = workspace
            instance.exec_as_root = AsyncMock()
            instance.exec_as_agent = AsyncMock()
            environment = Mock()
            environment.upload_dir = AsyncMock()
            environment.upload_file = AsyncMock()

            await instance.install(environment)

        upload = environment.upload_dir.await_args
        self.assertEqual(upload.args[1], "/tmp/introspection-recipe-source")
        self.assertEqual(environment.upload_file.await_count, 0)
        commands = [
            call.kwargs["command"] for call in instance.exec_as_root.await_args_list
        ]
        commands.append(instance.exec_as_agent.await_args.kwargs["command"])
        combined = "\n".join(commands)
        self.assertIn("nvm install 24", combined)
        self.assertNotIn("nvm install 22", combined)
        self.assertNotIn("/opt/introspection-workspace", combined)
        self.assertNotIn("recipe-source.tar", combined)
        self.assertNotIn("tar -xf", combined)
        self.assertIn("git -C /tmp/introspection-recipe-source init --quiet", combined)
        self.assertIn(
            "git -C /tmp/introspection-recipe-source init --quiet",
            instance.exec_as_agent.await_args.kwargs["command"],
        )

    async def test_install_uploads_canonical_replay_context(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            workspace = root / "workspace"
            workspace.mkdir()
            (workspace / "package.json").write_text("{}")
            replay_context = root / "replay-context.json"
            replay_context.write_text(
                '{"schema_version":1,"cwd":"/workspace","trajectory":[]}'
            )

            instance = object.__new__(IntrospectionRecipeAgent)
            instance._spec = {
                "candidate": {"cli_version": "0.23.0"},
                "input": {"replay_context_path": str(replay_context)},
            }
            instance._workspace_path = workspace
            instance.exec_as_root = AsyncMock()
            instance.exec_as_agent = AsyncMock()
            environment = Mock()
            environment.upload_dir = AsyncMock()
            environment.upload_file = AsyncMock()

            await instance.install(environment)

            environment.upload_file.assert_awaited_once_with(
                replay_context, "/tmp/introspection-replay-context.json"
            )


if __name__ == "__main__":
    unittest.main()
