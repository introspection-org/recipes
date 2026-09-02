"""Provider adapters for running Harbor from an Introspection operator."""

from __future__ import annotations

import os
from typing import Any

import harbor.environments.e2b as harbor_e2b
from harbor.environments.e2b import E2BEnvironment
from tenacity import retry, stop_after_attempt, wait_exponential

_EGRESS_URL = "INTROSPECTION_EGRESS_URL"
_PUBLIC_EGRESS_URL = "INTROSPECTION_PUBLIC_EGRESS_URL"
_ENDPOINT_HOSTS = "INTROSPECTION_ENDPOINT_HOSTS"
_SESSION_TOKEN = "INTROSPECTION_TOKEN"
_PASSTHROUGH_ENV = "INTROSPECTION_HARBOR_PASSTHROUGH_ENV"
INTROSPECTION_RECIPE_WORKDIR = "/opt/introspection/recipe"


def _binding_environment() -> dict[str, str]:
    """Build the scoped public-egress contract inherited by the E2B trial."""

    required = (_SESSION_TOKEN, _PUBLIC_EGRESS_URL, _ENDPOINT_HOSTS)
    configured = [name for name in required if os.environ.get(name)]
    if not configured:
        return {}

    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise ValueError("Introspection E2B requires " + ", ".join(sorted(missing)))

    return {
        _SESSION_TOKEN: os.environ[_SESSION_TOKEN],
        _EGRESS_URL: os.environ[_PUBLIC_EGRESS_URL],
        _ENDPOINT_HOSTS: os.environ[_ENDPOINT_HOSTS],
    }


def _passthrough_environment() -> dict[str, str]:
    """Resolve the explicitly allowlisted host variables for a direct trial."""

    configured = os.environ.get(_PASSTHROUGH_ENV, "")
    names = [name.strip() for name in configured.split(",") if name.strip()]
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        raise ValueError(
            f"{_PASSTHROUGH_ENV} references unset variables: "
            + ", ".join(sorted(missing))
        )
    return {name: os.environ[name] for name in names}


class IntrospectionE2BEnvironment(E2BEnvironment):
    """Native Harbor E2B with scoped binding locators in the trial.

    ``E2B_API_KEY`` is supplied to Operator by its credential binding and is a
    scoped locator, not the stored E2B key. Harbor's native E2B implementation
    therefore owns preflight, templates, sandbox creation, resources, and
    networking unchanged. This adapter only uses the public ``persistent_env``
    constructor input to make the scoped public-egress contract available
    inside the created trial.
    """

    def __init__(
        self,
        *args: Any,
        persistent_env: dict[str, str] | None = None,
        sandbox_timeout_seconds: int | None = None,
        template_name: str | None = None,
        **kwargs: Any,
    ) -> None:
        if sandbox_timeout_seconds is not None and sandbox_timeout_seconds <= 0:
            raise ValueError("sandbox_timeout_seconds must be positive")
        self.sandbox_timeout_seconds = sandbox_timeout_seconds or 86_400
        self.external_template_name = template_name
        super().__init__(
            *args,
            persistent_env={
                **(persistent_env or {}),
                **_binding_environment(),
                **_passthrough_environment(),
            },
            **kwargs,
        )
        if template_name:
            self._template_name = template_name

    @retry(
        stop=stop_after_attempt(2),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        reraise=True,
    )
    async def _create_sandbox(self) -> None:
        """Create a managed-template sandbox with a configurable timeout."""

        self._sandbox = await harbor_e2b.AsyncSandbox.create(
            template=self._template_name,
            metadata={
                "environment_name": self.environment_name,
                "session_id": self.session_id,
            },
            envs=self._startup_env(),
            timeout=self.sandbox_timeout_seconds,
            allow_internet_access=(
                self.network_policy.network_mode != harbor_e2b.NetworkMode.NO_NETWORK
            ),
            network=self._sandbox_create_network_options(),
        )

    async def start(self, force_build: bool) -> None:
        if not self.external_template_name:
            await super().start(force_build)
            return

        if self.task_env_config.workdir is None:
            self.task_env_config.workdir = INTROSPECTION_RECIPE_WORKDIR
        await self._create_sandbox()
        if not self._sandbox:
            raise RuntimeError(
                "Sandbox not found but was just created. This should never happen."
            )
        await self.ensure_dirs(self._mount_targets(writable_only=True))
        await self._upload_environment_dir_after_start()


__all__ = ["IntrospectionE2BEnvironment"]
