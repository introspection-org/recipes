"""The credentials an Introspection trial reaches the platform with.

The trial calls the platform through ``introspection-sdk`` rather than the CLI
subprocess the agent adapters use: an evaluation trial is created with
``kind``, ``compose`` and ``commands`` together, which no CLI flag expresses,
and one client keeps a connection open across the many small ``exec`` calls
Harbor makes, where a subprocess per call would pay process startup each time.

Credentials resolve exactly as the CLI's own Data-Plane commands do: the
environment overrides first, then the profile ``introspection login`` wrote.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from introspection_sdk import (
    AsyncIntrospectionClient,
    IntrospectionAPIError,
    NetworkError,
)

DP_URL_ENV = "INTROSPECTION_DP_URL"
TOKEN_ENV = "INTROSPECTION_TOKEN"
CP_URL_ENV = "INTROSPECTION_CP_URL"
# Set by `introspection eval run` while it keeps the stored login fresh for the
# length of the run, so a trial that outlives one access token is expected.
LOGIN_KEEPALIVE_ENV = "INTROSPECTION_EVAL_LOGIN_KEEPALIVE"
CREDENTIALS_PATH = Path.home() / ".introspection" / "credentials.json"

# Stamped on every file this adapter creates, so a project's file list shows
# what these are and a future platform-owned sweep can find them. No such sweep
# exists yet; callers with files:delete remove them best-effort.
TRANSFER_PURPOSE = "harbor_transfer"


class DataPlaneError(RuntimeError):
    """A Data Plane call the trial cannot proceed without."""


@contextmanager
def platform_call(operation: str) -> Iterator[None]:
    """Report a failed SDK call as the trial's own error.

    `introspection eval run --retry-errors` reads the exception Harbor records:
    a `DataPlaneError` whose message carries `failed with <status>:`, or the
    HTTP client's own transport error, which is why a `NetworkError` re-raises
    its cause.
    """

    try:
        yield
    except NetworkError as exc:
        if isinstance(exc.__cause__, Exception):
            raise exc.__cause__ from exc
        raise
    except IntrospectionAPIError as exc:
        raise DataPlaneError(
            f"{operation} failed with {exc.status_code}: {exc}"
        ) from exc


@dataclass(frozen=True)
class DataPlaneCredentials:
    """Where the Data Plane is and what authenticates to it.

    ``expires_at`` is the stored login's own expiry, present only when the
    token came from the profile. Nothing here renews it: that flow, with its
    one-time refresh token, belongs to the CLI that wrote it. The client only
    picks up a token the CLI has since written (see ``ProfileCredentials``).
    """

    url: str
    token: str
    expires_at: int | None = None


@dataclass(frozen=True)
class ControlPlaneCredentials:
    """Where the Control Plane is, and the project a Runtime resolves within.

    The Control Plane authenticates with the ``intro_cp_session`` cookie the
    login captured, not a bearer — it resolves server-side to the member and
    their live role.
    """

    url: str
    session: str
    project: str


def load_profile(credentials_path: Path | None = None) -> dict[str, Any]:
    """The profile ``introspection login`` wrote, or an empty one."""

    path = CREDENTIALS_PATH if credentials_path is None else credentials_path
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def load_control_plane_credentials(
    *,
    environ: dict[str, str] | None = None,
    credentials_path: Path | None = None,
) -> ControlPlaneCredentials:
    """Resolve the Control Plane session, which resolves a Runtime selector.

    A task is created with a `runtime_id`, but a trial may select a Runtime by
    group slug plus environment lane or pin an exact version UUID.
    """

    env = os.environ if environ is None else environ
    profile = load_profile(credentials_path)
    url = env.get(CP_URL_ENV) or profile.get("cp_url")
    session = profile.get("cp_session")
    project = profile.get("project_id")
    if not url or not session or not project:
        raise DataPlaneError(
            "No project-scoped Control Plane session. Run `introspection login` "
            "and select a project."
        )
    return ControlPlaneCredentials(
        url=url.rstrip("/"), session=session, project=project
    )


def load_credentials(
    *,
    environ: dict[str, str] | None = None,
    credentials_path: Path | None = None,
) -> DataPlaneCredentials:
    """Resolve the Data Plane base URL and bearer.

    The environment wins over the stored profile, so a trial can be pointed at
    a different plane without touching the login — the same precedence the CLI
    applies to ``--url`` / ``--token``.
    """

    env = os.environ if environ is None else environ
    url = env.get(DP_URL_ENV)
    token = env.get(TOKEN_ENV)
    if url and token:
        return DataPlaneCredentials(url=url.rstrip("/"), token=token)

    profile = load_profile(credentials_path)
    url = url or profile.get("dp_url")
    token = token or profile.get("access_token")
    if not url or not token:
        raise DataPlaneError(
            "No Data Plane credentials. Run `introspection login`, or set "
            f"{DP_URL_ENV} and {TOKEN_ENV}."
        )
    expires_at = profile.get("expires_at")
    if isinstance(expires_at, int) and expires_at <= time.time():
        # Refusing here names the cause once. Carried into the trial it becomes
        # a 401 from whichever request went first, reported as that step
        # failing — and a sweep's worth of trials failing the same way.
        raise DataPlaneError(
            "The stored Introspection login has expired. Run `introspection login`, "
            f"or set {DP_URL_ENV} and {TOKEN_ENV} to a credential this run owns."
        )
    return DataPlaneCredentials(
        url=url.rstrip("/"),
        token=token,
        expires_at=expires_at if isinstance(expires_at, int) else None,
    )


class ProfileCredentials:
    """The SDK credential provider over the login ``introspection login`` wrote.

    A trial outlives one access token, and ``introspection eval run`` renews
    the stored login while it runs. A request rejected with ``401`` therefore
    picks up a token the CLI has since written, once; nothing here renews a
    login itself, since that flow and its one-time refresh token belong to the
    CLI.
    """

    def __init__(
        self,
        credentials: DataPlaneCredentials,
        *,
        reload: Callable[[], DataPlaneCredentials] | None = None,
    ) -> None:
        self._credentials = credentials
        self._reload = reload

    @property
    def credentials(self) -> DataPlaneCredentials:
        return self._credentials

    async def authorization(self) -> str | None:
        return f"Bearer {self._credentials.token}"

    async def refresh_after_unauthorized(self, rejected: str | None) -> bool:
        """Switch to a token other than the *rejected* one, if there is one.

        True means the request is worth one more attempt. Another request may
        already have switched, which counts the same. A token is never adopted
        for another plane.
        """

        if rejected != f"Bearer {self._credentials.token}":
            return True
        if self._reload is None:
            return False
        try:
            credentials = self._reload()
        except DataPlaneError:
            return False
        if (
            f"Bearer {credentials.token}" == rejected
            or credentials.url != self._credentials.url
        ):
            return False
        self._credentials = credentials
        return True


def client_from_profile(
    credentials: ProfileCredentials,
    control_plane: ControlPlaneCredentials | None,
) -> AsyncIntrospectionClient:
    """An SDK client on the Data Plane login, and the Control Plane session if any.

    The member's own login rather than a runner: a runner's session token is
    bound to one Runtime and carries a sandbox's scopes, while a trial needs
    ``tasks:exec``, ``images:write`` and ``files:delete`` on the project.
    """

    return AsyncIntrospectionClient(
        cp_session=control_plane.session if control_plane else None,
        base_api_url=control_plane.url if control_plane else None,
        dp_url=credentials.credentials.url,
        credentials=credentials,
    )
