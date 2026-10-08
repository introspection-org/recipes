from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock

from introspection_harbor.bootstrap_agent import (
    TOOLCHAIN_PRELUDE,
    IntrospectionBootstrapAgent,
    layout_command,
    node_prerequisite_command,
    toolchain_install_command,
)
from introspection_harbor.workspace import (
    excluded_workspace_path,
    materialize_workspace,
)


def _agent(workspace: Path, recipe: Path) -> IntrospectionBootstrapAgent:
    instance = object.__new__(IntrospectionBootstrapAgent)
    instance.mcp_servers = []
    instance._spec = {
        "schema_version": 2,
        "candidate": {
            "runtime": "refunds",
            "agent": None,
            "model": None,
            "cli_version": "0.4.6",
            "workspace_path": str(workspace),
            "recipe_path": str(recipe),
        },
        "input": {},
    }
    instance._OUTPUT_FILENAME = "pi.jsonl"
    instance._workspace_path = workspace
    instance._recipe_relative_path = recipe.relative_to(workspace)
    return instance


class BootstrapCommandsTest(unittest.TestCase):
    def test_layout_links_the_uploaded_recipe_where_the_shared_launch_expects_it(
        self,
    ) -> None:
        command = layout_command(Path("recipes/refunds"))
        # Under /tmp, not /opt: the bootstrap runs as an ordinary user in
        # someone else's image and cannot create a directory under /opt.
        self.assertIn(
            "ln -sfn /tmp/introspection/workspace/recipes/refunds /tmp/introspection/recipe",
            command,
        )
        self.assertIn("chmod -R a+rwX /tmp/introspection/workspace", command)
        self.assertIn("mkdir -p /tmp/introspection/runtime", command)
        self.assertNotIn("/opt/introspection", command)

    def test_toolchain_install_lets_setup_own_pi_and_links_the_proxy_runtime(
        self,
    ) -> None:
        command = toolchain_install_command("0.4.6")
        self.assertIn("npm install -g @introspection-ai/cli@0.4.6", command)
        # Idempotent on an image that already carries the toolchain (a base
        # template): the CLI, Pi and the proxy module are only installed when absent.
        self.assertIn("introspection --version 2>/dev/null", command)
        self.assertIn(
            "test -d node_modules/@introspection-sdk/introspection-proxy ||", command
        )
        self.assertIn("introspection setup --yes", command)
        self.assertIn("npm install @introspection-sdk/introspection-proxy", command)
        self.assertIn(
            "ln -sfn /tmp/introspection/runtime /tmp/introspection/recipe/runtime",
            command,
        )
        self.assertNotIn("/opt/introspection", command)
        # Pi itself is never npm-installed here: setup installs the pairing
        # the CLI release was tested with.
        self.assertNotIn("pi-coding-agent", command)
        self.assertIn("nvm install 24", command)

    def test_node_prerequisite_supports_non_debian_images(self) -> None:
        command = node_prerequisite_command()
        for manager in ("apk", "apt-get", "dnf", "microdnf", "yum", "zypper"):
            self.assertIn(manager, command)

    def test_run_prelude_sources_the_bootstrapped_node(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            recipe = workspace / "recipe"
            recipe.mkdir()
            self.assertEqual(_agent(workspace, recipe).run_prelude(), TOOLCHAIN_PRELUDE)
            self.assertIn(".nvm/nvm.sh", TOOLCHAIN_PRELUDE)


class BootstrapInstallTest(unittest.IsolatedAsyncioTestCase):
    async def test_install_uploads_the_staged_workspace_then_bootstraps(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            recipe = workspace / "recipes" / "refunds"
            recipe.mkdir(parents=True)
            (recipe / "package.json").write_text("{}")
            (workspace / ".env").write_text("SECRET=1")
            (workspace / ".git").mkdir()
            (workspace / ".git" / "HEAD").write_text("ref")
            instance = _agent(workspace, recipe)
            root_commands: list[str] = []
            agent_commands: list[str] = []
            uploaded: list[tuple[Path, str]] = []

            async def as_root(environment, *, command):
                root_commands.append(command)

            async def as_agent(environment, *, command):
                agent_commands.append(command)

            async def upload_dir(source, target):
                uploaded.append((Path(source), target))
                self.assertTrue(
                    (Path(source) / "recipes/refunds/package.json").is_file()
                )
                self.assertFalse((Path(source) / ".env").exists())
                self.assertFalse((Path(source) / ".git").exists())

            instance.exec_as_root = as_root
            instance.exec_as_agent = as_agent
            environment = Mock()
            environment.upload_dir = upload_dir
            environment.upload_file = AsyncMock()

            await instance.install(environment)

        self.assertEqual(uploaded[0][1], "/tmp/introspection/workspace")
        # Only the system package install asks for root. Everything else runs
        # as the agent user, which is the only user a sandbox has: `pods/exec`
        # cannot change it, so a step that needed root would simply fail — and
        # on an environment that *can* become root, a root-created directory
        # would leave the toolchain step unable to write its own workspace.
        self.assertEqual(len(root_commands), 1)
        self.assertTrue(root_commands[0].startswith("set -eu; if node -e"))
        self.assertIn("rm -rf /tmp/introspection", agent_commands[0])
        self.assertIn("mkdir -p /tmp/introspection/workspace", agent_commands[0])
        self.assertIn(
            "ln -sfn /tmp/introspection/workspace/recipes/refunds", agent_commands[1]
        )
        self.assertIn("introspection setup --yes", agent_commands[2])
        self.assertTrue(agent_commands[3].startswith(TOOLCHAIN_PRELUDE))
        self.assertIn(
            "test -f /tmp/introspection/recipe/package.json", agent_commands[3]
        )
        self.assertNotIn("/opt/introspection", "".join(agent_commands))
        environment.upload_file.assert_not_awaited()


class WorkspaceStagingTest(unittest.TestCase):
    def test_secrets_and_generated_state_never_leave_the_host(self) -> None:
        for path in (
            ".env",
            ".env.local",
            "node_modules/x.js",
            ".git/HEAD",
            ".pi/mcp-session.json",
            ".pi/bin/tool",
            "keys/server.pem",
            ".npmrc",
            "eval-runs/out.json",
        ):
            self.assertTrue(excluded_workspace_path(Path(path)), path)
        for path in (
            ".env.example",
            "package.json",
            ".pi/mcp.local.example.json",
            "src/a.ts",
        ):
            self.assertFalse(excluded_workspace_path(Path(path)), path)

    def test_materialize_preserves_directory_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "src"
            source.mkdir()
            (source / "real").mkdir()
            (source / "real" / "a.txt").write_text("a")
            (source / "link").symlink_to("real", target_is_directory=True)
            destination = Path(temp_dir) / "dst"
            materialize_workspace(source, destination)
            self.assertTrue((destination / "link").is_symlink())
            self.assertEqual((destination / "real" / "a.txt").read_text(), "a")
