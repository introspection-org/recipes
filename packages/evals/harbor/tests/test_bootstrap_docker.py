"""The bootstrap's shell against real base images, as an ordinary user.

`test_bootstrap_shell.py` proves the branch logic with stubs, which is enough to
say which branch runs. It cannot say whether that branch *works*: whether npm's
prefix is writable, whether /bin/sh is dash, whether nvm's binaries run on the
image's libc. Those are properties of a real image, and Docker reproduces the one
variable that matters -- the trial running as a non-root user -- exactly as the
sandbox does. No Introspection plane is involved.

Opt in with HARBOR_BOOTSTRAP_DOCKER=1. The network cases need a registry and are
opted into separately with HARBOR_BOOTSTRAP_DOCKER_NETWORK=1, because they pull
from npm, GitHub and nodejs.org and are slow.

    HARBOR_BOOTSTRAP_DOCKER=1 uv run python -m unittest tests.test_bootstrap_docker
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from harbor.environments.tar_transfer import pack_dir_to_file

from introspection_harbor.bootstrap_agent import (
    BOOTSTRAP_BASE_DIR,
    BOOTSTRAP_RECIPE_DIR,
    REMOTE_WORKSPACE_DIR,
    layout_command,
    node_prerequisite_command,
    toolchain_install_command,
)
from introspection_harbor.task_environment import _remote_unpack_command

# The sandbox runs the trial as this user. Override where a mirror image grants
# uid 1000 ownership of its npm prefix, which a stock image does not.
SANDBOX_UID = os.environ.get("HARBOR_BOOTSTRAP_DOCKER_UID", "1000")

# The four shapes a foreign trial image comes in, keyed by what the bootstrap
# must do with each when it cannot become root.
#   ok       -- the step is expected to succeed
#   refused  -- expected to fail with a message naming the reason, not a
#               permission error from a package manager three steps in
#
# Each entry is (env override, default image, outcome, expected reason). The
# defaults are Docker Hub; a network that cannot reach it can point each shape
# at a mirror with the same shape, for example on mcr.microsoft.com:
#
#   HARBOR_IMAGE_NODE=mcr.microsoft.com/devcontainers/javascript-node:24 \
#   HARBOR_IMAGE_MUSL=mcr.microsoft.com/dotnet/runtime-deps:8.0-alpine3.20 \
#   HARBOR_IMAGE_BARE=mcr.microsoft.com/dotnet/runtime-deps:8.0-bookworm-slim \
#   HARBOR_IMAGE_CURL=mcr.microsoft.com/devcontainers/base:bookworm
SHAPES = [
    ("HARBOR_IMAGE_NODE", "node:24-slim", "ok", None),
    ("HARBOR_IMAGE_MUSL", "alpine:3.20", "refused", "musl"),
    ("HARBOR_IMAGE_BARE", "debian:bookworm-slim", "refused", "non-root"),
    ("HARBOR_IMAGE_CURL", "buildpack-deps:bookworm-curl", "ok", None),
]

IMAGES = [
    (os.environ.get(var, default), outcome, reason)
    for var, default, outcome, reason in SHAPES
]


def _ca_bundle() -> str | None:
    """A CA to trust inside the container, for a TLS-intercepting proxy."""
    return os.environ.get("HARBOR_BOOTSTRAP_DOCKER_CA")


def _curl_ca_env(network: bool) -> str:
    """curl, git and OpenSSL each read a different variable for the same file."""
    if not (network and _ca_bundle()):
        return ""
    names = ("CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE")
    return "".join(f"{name}=/ca.crt; export {name}; " for name in names)


def _cli_version() -> str:
    """A dist-tag, so the test does not pin a version that can be unpublished."""
    return os.environ.get("HARBOR_BOOTSTRAP_CLI_VERSION", "latest")


def _docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    return (
        subprocess.run(["docker", "info"], capture_output=True, check=False).returncode
        == 0
    )


@unittest.skipUnless(
    os.environ.get("HARBOR_BOOTSTRAP_DOCKER") == "1", "set HARBOR_BOOTSTRAP_DOCKER=1"
)
@unittest.skipUnless(_docker_available(), "docker is not available")
class BootstrapAgainstRealImagesTest(unittest.TestCase):
    def _run(
        self, image: str, command: str, *, network: bool = False
    ) -> subprocess.CompletedProcess[str]:
        argv = [
            "docker",
            "run",
            "--rm",
            # The whole point: the sandbox runs the trial as an ordinary user,
            # and running this as root proves nothing.
            "--user",
            SANDBOX_UID,
            # A writable HOME the uid owns; the image's own /root is not it.
            "--env",
            "HOME=/tmp/agent",
            *(() if network else ("--network", "none")),
            # A TLS-intercepting egress proxy needs its CA inside the container,
            # or npm's and curl's first request fails on a self-signed chain.
            *(
                (
                    "--volume",
                    f"{_ca_bundle()}:/ca.crt:ro",
                    "--env",
                    "NODE_EXTRA_CA_CERTS=/ca.crt",
                )
                if network and _ca_bundle()
                else ()
            ),
            image,
            "/bin/sh",
            "-c",
            f"mkdir -p /tmp/agent && {_curl_ca_env(network)}{command}",
        ]
        return subprocess.run(
            argv, capture_output=True, text=True, timeout=900, check=False
        )

    def test_the_prerequisite_step_admits_or_refuses_each_image_shape(self) -> None:
        for image, outcome, reason in IMAGES:
            with self.subTest(image=image):
                result = self._run(image, node_prerequisite_command())
                if outcome == "ok":
                    self.assertEqual(result.returncode, 0, result.stderr)
                    continue
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(reason, result.stderr)
                # A package manager's own permission error is the failure this
                # refusal exists to replace, so it must not be what we see.
                self.assertNotIn("Permission denied", result.stderr)
                self.assertNotIn("only root", result.stderr.lower())

    def test_install_creates_its_directories_on_every_shape_without_root(self) -> None:
        """The step before any branch runs: `install` making its own base.

        This is what a stubbed shell cannot answer, because the stub owns the
        filesystem. `exec_as_root` is not root on a sandbox -- `pods/exec` runs
        every command as the container's user and cannot be told otherwise --
        so the base has to be a directory an arbitrary uid may create. It runs
        on the refused shapes too: they refuse at the *toolchain*, and a base
        the bootstrap cannot even create would fail earlier and for a reason
        that has nothing to do with the image's libc.
        """
        command = (
            f"rm -rf {BOOTSTRAP_BASE_DIR} && mkdir -p {REMOTE_WORKSPACE_DIR} && "
            f"mkdir -p {REMOTE_WORKSPACE_DIR}/recipes/refunds && "
            + layout_command(Path("recipes/refunds"))
            + f" && test -d {BOOTSTRAP_RECIPE_DIR}/"
        )
        for image, _, _ in IMAGES:
            with self.subTest(image=image):
                result = self._run(image, command)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertNotIn("Permission denied", result.stderr)

    def test_the_old_root_owned_base_is_what_this_replaced(self) -> None:
        """The failure the base move fixes, so the reason stays legible.

        Kept as a test rather than a comment: it is the one assertion that
        would notice an image where /opt happens to be writable, which is what
        made the original layout look correct for as long as it did.
        """
        for image, _, _ in IMAGES:
            with self.subTest(image=image):
                result = self._run(image, "mkdir -p /opt/introspection/workspace")
                self.assertNotEqual(result.returncode, 0, "/opt was writable")
                self.assertIn("Permission denied", result.stderr)

    @unittest.skipUnless(
        os.environ.get("HARBOR_BOOTSTRAP_DOCKER_NETWORK") == "1",
        "set HARBOR_BOOTSTRAP_DOCKER_NETWORK=1 (pulls from npm, GitHub and nodejs.org)",
    )
    def test_the_toolchain_installs_globally_without_root(self) -> None:
        """The step that was failing: `npm install -g` as uid 1000. On a system
        Node that needs npm's prefix moved into $HOME; under nvm the prefix is
        already there."""
        # Stop after the CLI install; the Recipe steps need an uploaded workspace.
        # Split on the block terminator, never on `&&` -- nvm's snippet is full
        # of them and cutting there leaves an unterminated `if`.
        # The command is `exec bash -c '<body>'`, so truncate the body and
        # re-wrap it; splitting the wrapper leaves an unterminated quote. Split
        # on the block terminator, never on `&&` -- nvm's snippet is full of them.
        body = shlex.split(toolchain_install_command(_cli_version()))[-1]
        blocks = body.split("; fi && ")
        command = f"exec bash -c {shlex.quote(f'{blocks[0]}; fi && {blocks[1]}; fi')}"
        for image, outcome, _ in IMAGES:
            if outcome != "ok":
                continue
            with self.subTest(image=image):
                result = self._run(image, command, network=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertNotIn("EACCES", result.stderr)


@unittest.skipUnless(
    os.environ.get("HARBOR_BOOTSTRAP_DOCKER") == "1", "set HARBOR_BOOTSTRAP_DOCKER=1"
)
@unittest.skipUnless(_docker_available(), "docker is not available")
class DirectoryTransferAgainstMountedVolumeTest(unittest.TestCase):
    def test_upload_does_not_change_the_root_owned_mount(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            root.chmod(0o755)
            source = root / "source"
            source.mkdir(mode=0o700)
            executable = source / "verify.sh"
            executable.write_text("#!/bin/sh\nexit 0\n")
            executable.chmod(0o755)
            archive = root / "upload.tar.gz"
            pack_dir_to_file(source, archive, compress=True)
            archive.chmod(0o644)

            unpack = _remote_unpack_command("/transfer/upload.tar.gz", "/tests")
            command = (
                f"{unpack} && "
                "stat -c '%a %u:%g' /tests && "
                "stat -c '%a' /tests/verify.sh"
            )
            result = subprocess.run(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--user",
                    SANDBOX_UID,
                    "--network",
                    "none",
                    "--mount",
                    "type=tmpfs,destination=/tests,tmpfs-mode=1777",
                    "--volume",
                    f"{root}:/transfer:ro",
                    os.environ.get("HARBOR_IMAGE_BARE", "debian:bookworm-slim"),
                    "/bin/sh",
                    "-c",
                    command,
                ],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(result.stdout.splitlines(), ["1777 0:0", "755"])


if __name__ == "__main__":
    unittest.main()
