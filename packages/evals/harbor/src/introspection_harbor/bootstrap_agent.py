"""Harbor adapter for a trial whose image is not the Runtime image.

A pinned world (a SWE-style task image, a customer's own base) has no Recipe,
no Pi and no Introspection CLI in it. This adapter bootstraps them: it uploads
the Recipe workspace from the host, installs the CLI and lets
``introspection setup`` install Pi and the Recipes extension, and lays the
result out exactly as the Runtime image does, the Recipe at
a Recipe directory with a ``runtime`` link beside it. From there the
launch, the egress-proxy extension, the capture and the ATIF conversion are
the shared base's, unchanged.
"""

from __future__ import annotations

import shlex
import tempfile
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment

from .base import (
    RUNTIME_LINK_NAME,
    RecipeAgentBase,
    prepare_recipe_command,
)
from .workspace import materialize_workspace, recipe_eval_lib

# A foreign image is someone else's, and the bootstrap owns no path in it.
# /opt is root-owned, the sandbox runs every command as an ordinary user, and
# `pods/exec` cannot change that — so `exec_as_root` is not root here and the
# first `mkdir` fails. /tmp is the one directory every image grants an
# arbitrary uid (mode 1777), and unlike $HOME it is there whether or not the
# image gave that uid a home. The Runtime image's own /opt layout is
# untouched: this base belongs to the bootstrap alone.
BOOTSTRAP_BASE_DIR = "/tmp/introspection"
BOOTSTRAP_RECIPE_DIR = f"{BOOTSTRAP_BASE_DIR}/recipe"
BOOTSTRAP_RUNTIME_LINK_DIR = f"{BOOTSTRAP_RECIPE_DIR}/{RUNTIME_LINK_NAME}"
REMOTE_WORKSPACE_DIR = f"{BOOTSTRAP_BASE_DIR}/workspace"
REMOTE_RUNTIME_DIR = f"{BOOTSTRAP_BASE_DIR}/runtime"
# The proxy-aware fetch Pi loads through the egress-proxy extension. The
# Runtime image carries it under the runtime link; a bootstrapped trial
# installs it into a runtime directory of its own and links that instead.
PROXY_PACKAGE = "@introspection-sdk/introspection-proxy"
NODE_MAJOR = 24
NODE_VERSION_CHECK = (
    'node -e \'process.exit(Number(process.versions.node.split(".")[0]) >= '
    f"{NODE_MAJOR} ? 0 : 1)'"
)
# Every later shell — the Recipe prepare step and the Pi run itself — has to find
# whatever the toolchain step installed, and where that landed depends on which
# branch ran: nvm's own bin, or the user prefix the system-Node branch sets. Both
# are added when present, so the prelude does not need to know which one it was.
TOOLCHAIN_PRELUDE = (
    'if [ -d "$HOME/.local/bin" ]; then PATH="$HOME/.local/bin:$PATH"; export PATH; fi; '
    'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; '
)


# npm's global prefix on a system Node is root-owned (`/usr/local/lib/node_modules`),
# so every `-g` install here — the CLI, bun, and the Pi that `introspection setup`
# installs in a child process — fails as an ordinary user. Moving the prefix into
# $HOME is what makes the toolchain installable without root, and exporting it
# carries it into that child process. Only the system-Node branch sets it: nvm
# supplies a prefix inside $HOME already, and refuses to load at all when
# NPM_CONFIG_PREFIX is set against it.
SYSTEM_NODE_USER_PREFIX = (
    'NPM_CONFIG_PREFIX="$HOME/.local"; export NPM_CONFIG_PREFIX; '
    'PATH="$HOME/.local/bin:$PATH"; export PATH; '
    'mkdir -p "$HOME/.local/bin";'
)


def node_prerequisite_command() -> str:
    """Make ``curl`` available for the nvm install without assuming a Debian image."""

    # Every package-manager branch below needs root, and a sandbox that runs the
    # trial as an ordinary user has none. Refusing by name beats letting `apk`
    # or `apt-get` fail on permissions three steps into a trial, where the
    # error names a package rather than the image that cannot be bootstrapped.
    unprivileged = '[ "$(id -u)" -ne 0 ]'
    return (
        "set -eu; "
        f"if {NODE_VERSION_CHECK} 2>/dev/null; then exit 0; fi; "
        "if command -v apk >/dev/null 2>&1; then "
        # nvm's official binaries are glibc-only, so on musl the system package
        # is the only Node there is and curl does not rescue this branch.
        f"if {unprivileged}; then "
        f"echo 'This Alpine image must ship Node {NODE_MAJOR} or newer: installing it needs root, "
        "and the nvm fallback does not run on musl' >&2; exit 1; fi; "
        "apk add --no-cache nodejs npm; "
        f"{NODE_VERSION_CHECK} || {{ "
        f"echo 'The Alpine package repository must provide Node {NODE_MAJOR} or newer' >&2; "
        "exit 1; }; "
        # bash, not just curl: nvm is bash software (its loader guard uses `&>`,
        # which dash reads as backgrounding and waves through), so the fallback
        # cannot run without one even when curl is there.
        "elif command -v curl >/dev/null 2>&1; then "
        "command -v bash >/dev/null 2>&1 || { "
        f"echo 'This image must ship Node {NODE_MAJOR} or newer, or bash: the nvm fallback "
        "that installs Node is bash software' >&2; exit 1; }; "
        f"elif {unprivileged}; then "
        f"echo 'This image must ship Node {NODE_MAJOR} or newer, or curl: the trial runs as a "
        "non-root user and cannot install system packages' >&2; exit 1; "
        "elif command -v apt-get >/dev/null 2>&1; then "
        "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y curl; "
        "elif command -v dnf >/dev/null 2>&1; then dnf install -y curl; "
        "elif command -v microdnf >/dev/null 2>&1; then microdnf install -y curl; "
        "elif command -v yum >/dev/null 2>&1; then yum install -y curl; "
        "elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install curl; "
        "else echo 'Node setup requires curl or a supported system package manager' >&2; "
        "exit 1; fi"
    )


def layout_command(recipe_relative_path: Path) -> str:
    """Lay the uploaded workspace out where the shared launch expects the Recipe."""

    source_dir = Path(REMOTE_WORKSPACE_DIR) / recipe_relative_path
    return (
        f"chmod -R a+rwX {REMOTE_WORKSPACE_DIR} && "
        f"mkdir -p {REMOTE_RUNTIME_DIR} && chmod a+rwX {REMOTE_RUNTIME_DIR} && "
        f"ln -sfn {shlex.quote(source_dir.as_posix())} {BOOTSTRAP_RECIPE_DIR}"
    )


def toolchain_install_command(cli_version: str) -> str:
    """Install Node, the CLI, the Recipe's dependencies, Pi and the proxy module.

    ``introspection setup`` owns Pi and the Recipes extension, the same way it
    does on a developer's machine, so the trial runs the pairing the CLI
    release was tested with. The proxy module lands in a runtime directory
    linked as the Recipe's ``runtime``, the path the shared extension imports.
    """

    version = shlex.quote(cli_version)
    recipe = shlex.quote(BOOTSTRAP_RECIPE_DIR)
    # (body assembled below, then handed to bash)
    # Every step is a no-op when the image already carries it, so the same
    # command bootstraps a raw Dockerfile image and a base image that has the
    # toolchain but not the Recipe.
    body = (
        # `set -eu`, not `-euo pipefail`: the adapter runs every Harbor command
        # as `/bin/sh -c`, and /bin/sh is dash on the Debian-family images this
        # branch targets, which rejects `-o pipefail` outright and takes the whole
        # step with it. The one pipe here is nvm's own installer, and upstream
        # already checks it landed (`command -v nvm`) rather than trusting the pipe.
        "set -eu; "
        f"if {NODE_VERSION_CHECK} 2>/dev/null; then {SYSTEM_NODE_USER_PREFIX} npm -v; "
        f"else {nvm_node_install_snippet(node_major=NODE_MAJOR)}; fi && "
        f"if [ \"$(introspection --version 2>/dev/null | awk '{{print $NF}}')\" != {version} ]; then "
        f"npm install -g @introspection-ai/cli@{version}; fi && "
        f"if [ -f {recipe}/pnpm-lock.yaml ]; then "
        f"corepack pnpm --dir {recipe} install --frozen-lockfile; "
        f"elif [ -f {recipe}/yarn.lock ]; then "
        f"corepack yarn --cwd {recipe} install --immutable; "
        f"elif [ -f {recipe}/bun.lock ] || [ -f {recipe}/bun.lockb ]; then "
        f"npm install -g bun && bun install --cwd {recipe} --frozen-lockfile; "
        f"elif [ -f {recipe}/package-lock.json ]; then npm --prefix {recipe} ci; "
        f"elif [ -f {recipe}/package.json ]; then npm --prefix {recipe} install; fi && "
        "introspection setup --yes && "
        f"cd {REMOTE_RUNTIME_DIR} && {{ test -f package.json || npm init -y >/dev/null; }} && "
        f"{{ test -d node_modules/{PROXY_PACKAGE} || npm install {PROXY_PACKAGE}; }} && "
        f"ln -sfn {REMOTE_RUNTIME_DIR} {BOOTSTRAP_RUNTIME_LINK_DIR}"
    )
    # Run it under bash. The adapter execs every Harbor command as `/bin/sh -c`,
    # and nvm's snippet is bash-only: `command -v nvm &>/dev/null` is a guard in
    # bash and a backgrounded command in dash, so the failure it exists to catch
    # is waved through and the next step reports `nvm: not found` instead. The
    # prerequisite step is what guarantees a bash to hand this to.
    return f"exec bash -c {shlex.quote(body)}"


class IntrospectionBootstrapAgent(RecipeAgentBase):
    """Bootstrap the Recipe, Pi and the CLI into a foreign trial image."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        candidate = self._spec.get("candidate") or {}
        workspace_path = Path(candidate.get("workspace_path", ""))
        recipe_path = Path(candidate.get("recipe_path", ""))
        if not workspace_path.is_dir():
            raise ValueError(f"Recipe workspace does not exist: {workspace_path}")
        if not recipe_path.is_dir():
            raise ValueError(f"Recipe source does not exist: {recipe_path}")
        try:
            self._recipe_relative_path = recipe_path.relative_to(workspace_path)
        except ValueError as error:
            raise ValueError("Recipe source must be inside its workspace") from error
        self._workspace_path = workspace_path

    recipe_dir = BOOTSTRAP_RECIPE_DIR

    @staticmethod
    @override
    def name() -> str:
        return "introspection-bootstrap"

    @override
    def run_prelude(self) -> str:
        return TOOLCHAIN_PRELUDE

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # As the agent user, not root: every path below is one this user must
        # own afterwards, and a root-created directory on an environment that
        # *can* become root would leave the toolchain step unable to write it.
        await self.exec_as_agent(
            environment,
            command=(f"rm -rf {BOOTSTRAP_BASE_DIR} && mkdir -p {REMOTE_WORKSPACE_DIR}"),
        )
        with tempfile.TemporaryDirectory(
            prefix="introspection-recipe-workspace-"
        ) as temp_dir:
            staged = Path(temp_dir) / "workspace"
            eval_lib = self._recipe_relative_path / recipe_eval_lib(
                self._workspace_path / self._recipe_relative_path
            )
            materialize_workspace(self._workspace_path, staged, [eval_lib])
            await environment.upload_dir(staged, REMOTE_WORKSPACE_DIR)
        await self.exec_as_agent(
            environment, command=layout_command(self._recipe_relative_path)
        )
        await self.exec_as_root(environment, command=node_prerequisite_command())
        await self.exec_as_agent(
            environment,
            command=toolchain_install_command(self._spec["candidate"]["cli_version"]),
        )
        await self.exec_as_agent(
            environment,
            command=TOOLCHAIN_PRELUDE
            + prepare_recipe_command(BOOTSTRAP_RECIPE_DIR, self.mcp_servers),
        )
        await self.upload_replay_context(environment)
