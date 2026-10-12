"""The Data Plane calls the environment adapter makes.

Direct HTTP rather than the CLI subprocess the agent adapters use. An
evaluation trial is created with ``kind``, ``compose`` and ``commands``
together, and no CLI flag expresses that trio; going through the API also
keeps one connection open across the many small ``exec`` calls Harbor makes
during a trial, where a subprocess per call would pay process startup each
time.

Credentials resolve exactly as the CLI's own Data-Plane commands do: the
environment overrides first, then the profile ``introspection login`` wrote.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

DP_URL_ENV = "INTROSPECTION_DP_URL"
TOKEN_ENV = "INTROSPECTION_TOKEN"
CP_URL_ENV = "INTROSPECTION_CP_URL"
# Set by `introspection eval run` while it keeps the stored login fresh for the
# length of the run, so a trial that outlives one access token is expected.
LOGIN_KEEPALIVE_ENV = "INTROSPECTION_EVAL_LOGIN_KEEPALIVE"
CREDENTIALS_PATH = Path.home() / ".introspection" / "credentials.json"

# One command read is held open by the Data Plane for at most this long, so a
# wait longer than a minute is a loop of these rather than one long request.
MAX_COMMAND_WAIT_SECONDS = 60
# Stamped on every file this adapter creates, so a project's file list shows
# what these are and a future platform-owned sweep can find them. No such sweep
# exists yet; callers with files:delete remove them best-effort.
TRANSFER_PURPOSE = "harbor_transfer"
# Generous: a create returns as soon as the row exists, and every long wait in
# this module is a bounded server-held read rather than an open stream.
REQUEST_TIMEOUT_SECONDS = 90.0


class DataPlaneError(RuntimeError):
    """A Data Plane call the trial cannot proceed without."""


@dataclass(frozen=True)
class DataPlaneCredentials:
    """Where the Data Plane is and what authenticates to it.

    ``expires_at`` is the stored login's own expiry, present only when the
    token came from the profile. Nothing here renews it: that flow, with its
    one-time refresh token, belongs to the CLI that wrote it. The client only
    picks up a token the CLI has since written (see ``DataPlaneClient``).
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


@dataclass(frozen=True)
class CreatedTask:
    """What `POST /v1/tasks` returns: the task, and the run it started with."""

    task: dict[str, Any]
    run: dict[str, Any]


class DataPlaneClient:
    """The subset of the Data Plane API an evaluation trial drives."""

    def __init__(
        self,
        credentials: DataPlaneCredentials,
        *,
        client: httpx.AsyncClient | None = None,
        reload: Callable[[], DataPlaneCredentials] | None = None,
    ) -> None:
        """*reload* re-resolves the credentials after a 401.

        `introspection eval run` refreshes the stored login while a run is in
        progress, and a trial that started on the previous access token learns
        of the new one only by reading the profile again.
        """

        self._credentials = credentials
        self._reload = reload
        self._client = client or httpx.AsyncClient(
            base_url=credentials.url,
            headers={"authorization": f"Bearer {credentials.token}"},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )

    @property
    def credentials(self) -> DataPlaneCredentials:
        return self._credentials

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        **kwargs: Any,
    ) -> httpx.Response:
        token = self._credentials.token
        response = await self._client.request(method, path, **kwargs)
        if response.status_code == 401 and self._adopt_newer_token(token):
            response = await self._client.request(method, path, **kwargs)
        if response.is_error:
            raise DataPlaneError(
                f"{method} {path} failed with {response.status_code}: {response.text}"
            )
        return response

    def _adopt_newer_token(self, rejected: str) -> bool:
        """Switch to a token other than the *rejected* one, if there is one.

        True means the request is worth one more attempt. Another request on
        this client may already have switched, which counts the same.
        """

        if self._credentials.token != rejected:
            return True
        if self._reload is None:
            return False
        try:
            credentials = self._reload()
        except DataPlaneError:
            return False
        if credentials.token == rejected or credentials.url != self._credentials.url:
            return False
        self._credentials = credentials
        self._client.headers["authorization"] = f"Bearer {credentials.token}"
        return True

    # -- tasks -------------------------------------------------------------

    async def create_task_with_run(self, body: dict[str, Any]) -> CreatedTask:
        """`POST /v1/tasks`, which answers `{task, run}` rather than a bare task."""

        response = await self._request("POST", "/v1/tasks", json=body)
        payload = response.json()
        return CreatedTask(task=payload["task"], run=payload["run"])

    async def create_task(self, body: dict[str, Any]) -> dict[str, Any]:
        return (await self.create_task_with_run(body)).task

    async def get_task(self, task_id: str) -> dict[str, Any]:
        response = await self._request("GET", f"/v1/tasks/{task_id}")
        return response.json()

    async def delete_task(self, task_id: str) -> None:
        """Best-effort release of a trial task after Harbor has its result.

        The only cancel route is per-run and deliberately leaves the sandbox
        warm so the task can take another turn — the opposite of teardown, and
        it needs a run id besides. A credential with ``tasks:delete`` releases
        the trial immediately. Operator deliberately has no destructive scope,
        so its delete is refused and the task's wall-clock ceiling releases the
        sandbox instead. Cleanup must not turn an otherwise valid score into a
        failed trial.
        """

        try:
            await self._request("DELETE", f"/v1/tasks/{task_id}")
        except DataPlaneError:
            pass

    # -- commands ----------------------------------------------------------

    async def create_command(
        self, task_id: str, spec: dict[str, Any]
    ) -> dict[str, Any]:
        response = await self._request(
            "POST", f"/v1/tasks/{task_id}/commands", json=spec
        )
        return response.json()

    async def get_command(
        self,
        task_id: str,
        command_id: str,
        *,
        wait_seconds: int = 0,
    ) -> dict[str, Any]:
        """Read a command, optionally as a bounded server-held long read."""

        params = {"wait_seconds": min(wait_seconds, MAX_COMMAND_WAIT_SECONDS)}
        response = await self._request(
            "GET", f"/v1/tasks/{task_id}/commands/{command_id}", params=params
        )
        return response.json()

    # -- files -------------------------------------------------------------

    async def upload_file(
        self,
        source: Path,
        *,
        name: str,
        purpose: str = TRANSFER_PURPOSE,
    ) -> dict[str, Any]:
        """Upload a transient transfer artifact.

        `encryption: false` puts it in the raw blob store rather than the
        encrypted one, which is what the build-context and upload-command
        paths already read. These are machine-generated tars intended for one
        transfer. Callers with files:delete remove them afterwards; Operator
        deliberately lacks that scope, and no platform TTL exists yet.
        """

        response = await self._request(
            "POST",
            "/v1/files",
            files={"file": (name, source.read_bytes())},
            data={
                "name": name,
                "file_type": "other",
                "metadata": json.dumps({"encryption": False, "purpose": purpose}),
            },
        )
        return response.json()

    async def delete_file(self, file_id: str) -> None:
        """Attempt to drop a transfer artifact once it has been read.

        Best effort: a trial that fails mid-transfer should surface that
        failure, not a cleanup error on top of it. Operator deliberately lacks
        files:delete, so its artifacts remain until project deletion.
        """

        try:
            await self._request("DELETE", f"/v1/files/{file_id}")
        except DataPlaneError:
            pass

    async def download_file(self, file_id: str, target: Path) -> None:
        response = await self._request("GET", f"/v1/files/{file_id}/content")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(response.content)

    # -- images ------------------------------------------------------------

    async def create_image(self, body: dict[str, Any]) -> dict[str, Any]:
        response = await self._request("POST", "/v1/images", json=body)
        return response.json()

    async def get_image(self, image_id: str) -> dict[str, Any]:
        response = await self._request("GET", f"/v1/images/{image_id}")
        return response.json()


class ControlPlaneClient:
    """The one Control Plane read a trial needs: a Runtime selector."""

    def __init__(
        self,
        credentials: ControlPlaneCredentials,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._credentials = credentials
        self._client = client or httpx.AsyncClient(
            base_url=credentials.url,
            headers={"cookie": f"intro_cp_session={credentials.session}"},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def resolve_runtime(self, runtime: str, environment: str) -> str:
        """The deployed Runtime version active for *runtime* in *environment*."""

        response = await self._client.get(
            "/v1/runtimes",
            params={
                "project": self._credentials.project,
                "runtime": runtime,
                "environment": environment,
                "limit": 1,
            },
        )
        if response.is_error:
            raise DataPlaneError(
                f"resolving runtime {runtime!r} failed with "
                f"{response.status_code}: {response.text}"
            )
        records = response.json().get("records") or []
        if not records or not records[0].get("id"):
            raise DataPlaneError(
                f"Runtime {runtime!r} has no active version in {environment}"
            )
        return records[0]["id"]


def pull_reference(image: dict[str, Any]) -> str | None:
    """The digest-pinned reference a compose service names, once ready.

    Composed here rather than read off the row: the Data Plane exposes it as a
    Python property, which does not survive serialization.
    """

    ref = image.get("image_ref")
    digest = image.get("image_digest")
    if ref and digest:
        return f"{ref}@{digest}"
    return None
