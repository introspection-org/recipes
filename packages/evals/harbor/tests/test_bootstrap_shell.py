"""The bootstrap's generated shell, executed against each image shape.

The four steps are shell that runs inside the trial image, and the property that
matters is not what the string contains but what it *does* on an image that has
Node, or musl, or neither, when the trial runs as an ordinary user. These tests
run the real generated commands under `sh` with the probes it branches on --
`node`, `apk`, `curl`, `apt-get`, `id` -- replaced by stubs, so every branch is
exercised on any machine, with no container and no root.

`tests/test_bootstrap_docker.py` runs the same commands against real base images.
"""

from __future__ import annotations

import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from introspection_harbor.bootstrap_agent import (
    NODE_MAJOR,
    node_prerequisite_command,
    toolchain_install_command,
)

# What each shape puts on PATH. `node` is written separately because its answer
# is a version, not a presence.
SHAPES = {
    "node24-slim": {"node": NODE_MAJOR, "tools": ["npm"]},
    "alpine": {"node": None, "tools": ["apk"]},
    "debian-no-curl": {"node": None, "tools": ["apt-get"]},
    "debian-curl": {"node": None, "tools": ["curl", "bash", "apt-get"]},
    "debian-curl-no-bash": {"node": None, "tools": ["curl", "apt-get"]},
    "node18": {"node": 18, "tools": ["curl", "apt-get"]},
}


class Shell:
    """A stubbed PATH plus a HOME, and a `sh -c` that records what ran."""

    def __init__(self, shape: str, *, uid: int) -> None:
        self._dir = tempfile.TemporaryDirectory(prefix=f"bootstrap-{shape}-")
        self.root = Path(self._dir.name)
        self.bin = self.root / "bin"
        self.home = self.root / "home"
        self.bin.mkdir()
        self.home.mkdir()
        self.log = self.root / "ran.log"

        spec = SHAPES[shape]
        for tool in spec["tools"]:
            self._stub(tool)
        if spec["node"] is not None:
            # `node -e 'process.exit(major >= NODE_MAJOR ? 0 : 1)'` is the probe.
            self._write(
                "node",
                f'echo "node $*" >> "{self.log}"\n'
                f"exit {0 if spec['node'] >= NODE_MAJOR else 1}\n",
            )
        self._write(
            "id", f'if [ "$1" = "-u" ]; then echo {uid}; else echo uid={uid}; fi\n'
        )
        # Real, because the prefix snippet is asserted by its effect on disk.
        self._passthrough("mkdir")

    def _passthrough(self, name: str) -> None:
        self._write(name, f'exec {shutil.which(name)} "$@"\n')

    def _stub(self, name: str) -> None:
        self._write(name, f'echo "{name} $*" >> "{self.log}"\n')

    def _write(self, name: str, body: str) -> None:
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)

    def run(self, command: str) -> subprocess.CompletedProcess[str]:
        # PATH is the stub directory and nothing else. Including the host's own
        # /usr/bin let its real curl and node answer the probes, so every shape
        # took the branch the host had rather than the one under test.
        env = {"PATH": str(self.bin), "HOME": str(self.home)}
        return subprocess.run(
            ["/bin/sh", "-c", command],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )

    def ran(self) -> str:
        return self.log.read_text() if self.log.exists() else ""

    def close(self) -> None:
        self._dir.cleanup()


class NodePrerequisiteTest(unittest.TestCase):
    """`node_prerequisite_command` runs first and decides whether the image can
    be bootstrapped at all. As an ordinary user only two shapes can proceed:
    one that already has Node, and one that has curl for the nvm fallback."""

    def _run(self, shape: str, *, uid: int) -> subprocess.CompletedProcess[str]:
        shell = Shell(shape, uid=uid)
        self.addCleanup(shell.close)
        self.shell = shell
        return shell.run(node_prerequisite_command())

    def test_an_image_with_a_recent_node_needs_nothing(self) -> None:
        for uid in (0, 1000):
            with self.subTest(uid=uid):
                self.assertEqual(self._run("node24-slim", uid=uid).returncode, 0)

    def test_an_image_with_curl_defers_to_the_nvm_fallback(self) -> None:
        result = self._run("debian-curl", uid=1000)
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("apt-get", self.shell.ran())

    def test_curl_without_bash_is_refused_by_name(self) -> None:
        """nvm is bash software, so curl alone does not make the fallback usable."""
        result = self._run("debian-curl-no-bash", uid=1000)
        self.assertEqual(result.returncode, 1)
        self.assertIn("bash", result.stderr)

    def test_alpine_without_root_is_refused_by_name(self) -> None:
        result = self._run("alpine", uid=1000)
        self.assertEqual(result.returncode, 1)
        self.assertIn("musl", result.stderr)
        self.assertIn(str(NODE_MAJOR), result.stderr)
        self.assertNotIn("apk", self.shell.ran(), "apk was attempted without root")

    def test_an_image_without_node_or_curl_is_refused_by_name(self) -> None:
        result = self._run("debian-no-curl", uid=1000)
        self.assertEqual(result.returncode, 1)
        self.assertIn("non-root", result.stderr)
        self.assertNotIn(
            "apt-get", self.shell.ran(), "apt-get was attempted without root"
        )

    def test_the_package_manager_branches_still_run_as_root(self) -> None:
        """Harbor's own environments exec as root, and this must keep working
        there: the refusal is about the uid, not about the adapter."""
        result = self._run("debian-no-curl", uid=0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("apt-get", self.shell.ran())

    def test_alpine_installs_the_system_node_as_root(self) -> None:
        shell = Shell("alpine", uid=0)
        self.addCleanup(shell.close)
        # `apk add` succeeds and the re-probe then finds Node, which the stub
        # PATH cannot do on its own, so the second probe is what fails here.
        result = shell.run(node_prerequisite_command())
        self.assertIn("apk add", shell.ran())
        self.assertEqual(result.returncode, 1)
        self.assertIn("Alpine package repository", result.stderr)


class ToolchainPrefixTest(unittest.TestCase):
    """A global npm install as an ordinary user only works when npm's prefix is
    somewhere that user owns. nvm supplies one; a system Node does not."""

    def _toolchain(self) -> str:
        return toolchain_install_command("1.2.3")

    def test_a_system_node_moves_npms_prefix_into_the_home_directory(self) -> None:
        shell = Shell("node24-slim", uid=1000)
        self.addCleanup(shell.close)
        # Just the node if-block: everything after it reaches the network. It
        # cannot be split on `&&` (nvm's snippet is full of them), and the whole
        # command is `exec bash -c '<body>'`, so unwrap the body first.
        body = shlex.split(self._toolchain())[-1]
        branch = body.split("; fi && ", 1)[0] + "; fi"
        result = shell.run(
            branch + '; echo "prefix=$NPM_CONFIG_PREFIX"; echo "path=$PATH"'
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"prefix={shell.home}/.local", result.stdout)
        self.assertIn(f"{shell.home}/.local/bin:", result.stdout)
        self.assertTrue((shell.home / ".local" / "bin").is_dir())

    def test_the_toolchain_runs_under_bash(self) -> None:
        """nvm's loader guard uses `&>`, which dash reads as backgrounding and
        waves through, so the failure it exists to catch reaches the next step
        as `nvm: not found`."""
        self.assertTrue(self._toolchain().startswith("exec bash -c "))

    def test_the_nvm_branch_never_sets_a_prefix_against_nvm(self) -> None:
        """nvm refuses to load when NPM_CONFIG_PREFIX is set against it, so the
        prefix belongs to the system-Node branch alone."""
        toolchain = self._toolchain()
        nvm_branch = toolchain.split("else", 1)[1]
        self.assertNotIn("NPM_CONFIG_PREFIX", nvm_branch)


class ShellDialectTest(unittest.TestCase):
    """The adapter runs every Harbor command as `/bin/sh -c`, and /bin/sh is
    dash on the Debian-family images the working branch targets. A bash-only
    construct in these commands fails on its first token, before anything the
    step is actually for."""

    def test_the_generated_commands_parse_under_a_posix_shell(self) -> None:
        for name, command in (
            ("node_prerequisite_command", node_prerequisite_command()),
            ("toolchain_install_command", toolchain_install_command("1.2.3")),
        ):
            with self.subTest(command=name):
                parsed = subprocess.run(
                    ["/bin/sh", "-n", "-c", command],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                self.assertEqual(parsed.returncode, 0, parsed.stderr)

    def test_no_command_asks_a_posix_shell_for_pipefail(self) -> None:
        """dash exits 2 on `set -o pipefail` rather than ignoring it."""
        shell = Shell("node24-slim", uid=1000)
        self.addCleanup(shell.close)
        for name, command in (
            ("node_prerequisite_command", node_prerequisite_command()),
            ("toolchain_install_command", toolchain_install_command("1.2.3")),
        ):
            with self.subTest(command=name):
                self.assertNotIn("pipefail", command, f"{name} would abort under dash")


if __name__ == "__main__":
    unittest.main()
