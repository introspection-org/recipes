from __future__ import annotations

import asyncio
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from introspection_harbor.agent import (
    IntrospectionRecipeAgent,
    _materialize_workspace,
    _model_environment,
    _node_prerequisite_command,
    _recipe_run_command,
    _selected_prompt,
)


class AgentHelpersTest(unittest.TestCase):
    def test_production_run_uses_selected_prompt(self) -> None:
        spec = {
            "source": {"kind": "production_task"},
            "input": {"prompt": "counterfactual prompt"},
        }
        self.assertEqual(_selected_prompt(spec, "Harbor instruction"), "counterfactual prompt")

    def test_authored_run_uses_harbor_instruction(self) -> None:
        spec = {"source": {"kind": "authored"}, "input": {"prompt": None}}
        self.assertEqual(_selected_prompt(spec, "Harbor instruction"), "Harbor instruction")

    def test_recipe_pipeline_preserves_the_first_failure(self) -> None:
        command = _recipe_run_command(["introspection", "local"], "pi.jsonl")
        self.assertTrue(command.startswith("set -o pipefail;"))

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

    def test_node_setup_supports_non_debian_task_images(self) -> None:
        command = _node_prerequisite_command()
        self.assertIn("command -v apk", command)
        self.assertIn("command -v dnf", command)
        self.assertIn("command -v yum", command)
        self.assertIn("command -v zypper", command)
        self.assertIn("command -v curl", command)
        self.assertFalse(command.startswith("apt-get"))

    def test_workspace_staging_preserves_monorepo_sources_and_excludes_secrets(self) -> None:
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
            ]:
                self.assertTrue((staged / relative).is_file(), relative)
            for relative in [
                ".env",
                ".npmrc",
                "certificate.pem",
                ".git/config",
                "node_modules/pkg/index.js",
                ".introspection/eval-runs/run/result.json",
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

    def test_harbor_run_omits_agent_when_recipe_default_is_selected(self) -> None:
        instance = object.__new__(IntrospectionRecipeAgent)
        instance._spec = {
            "candidate": {"runtime": "refunds", "agent": None, "model": None},
            "source": {"kind": "authored"},
            "input": {},
        }
        instance.model_name = None
        instance._OUTPUT_FILENAME = "pi.jsonl"
        environment = Mock()

        async def capture_exec(*args, **kwargs):
            environment.command = kwargs["command"]
            environment.cwd = kwargs["cwd"]

        instance.exec_as_agent = capture_exec
        asyncio.run(instance.run.__wrapped__(instance, "prompt", environment, Mock()))
        self.assertIn("--work-dir /tmp/introspection-recipe-source", environment.command)
        self.assertNotIn("--agent", environment.command)
        self.assertEqual(environment.cwd, "/app")

    def test_harbor_run_selects_inherited_agent_by_declared_name(self) -> None:
        instance = object.__new__(IntrospectionRecipeAgent)
        instance._spec = {
            "candidate": {"runtime": "refunds", "agent": "agent2", "model": None},
            "source": {"kind": "authored"},
            "input": {},
        }
        instance.model_name = None
        instance._OUTPUT_FILENAME = "pi.jsonl"
        environment = Mock()

        async def capture_exec(*args, **kwargs):
            environment.command = kwargs["command"]

        instance.exec_as_agent = capture_exec
        asyncio.run(instance.run.__wrapped__(instance, "prompt", environment, Mock()))
        self.assertIn("--agent agent2", environment.command)


class AgentStagingTest(unittest.IsolatedAsyncioTestCase):
    async def test_install_uploads_filtered_workspace_without_tar_or_opt_layout(self) -> None:
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


if __name__ == "__main__":
    unittest.main()
