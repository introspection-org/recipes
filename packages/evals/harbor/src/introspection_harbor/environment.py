"""Provider adapters for running Harbor from an Introspection operator."""

from __future__ import annotations

import os
from typing import Any

from harbor.environments.e2b import E2BEnvironment

_EGRESS_URL = "INTROSPECTION_EGRESS_URL"
_PUBLIC_EGRESS_URL = "INTROSPECTION_PUBLIC_EGRESS_URL"
_ENDPOINT_HOSTS = "INTROSPECTION_ENDPOINT_HOSTS"
_SESSION_TOKEN = "INTROSPECTION_TOKEN"


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
        **kwargs: Any,
    ) -> None:
        super().__init__(
            *args,
            persistent_env={
                **(persistent_env or {}),
                **_binding_environment(),
            },
            **kwargs,
        )


__all__ = ["IntrospectionE2BEnvironment"]
