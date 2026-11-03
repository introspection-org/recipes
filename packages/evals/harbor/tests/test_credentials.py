"""The trial's credentials, and the SDK client built on them.

The client crosses a contract we do not own — the response envelope a route
returns and the path it is mounted at — so the seam is exercised against a
stubbed transport rather than by mocking our own side of it.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import httpx2 as httpx
from introspection_sdk import AsyncIntrospectionClient, AuthenticationError

from introspection_harbor.credentials import (
    DataPlaneCredentials,
    DataPlaneError,
    ProfileCredentials,
    load_credentials,
)
from introspection_harbor.task_environment import IntrospectionEnvironment

TASK = {
    "id": "01990000-0000-7000-8000-0000000000a0",
    "org_id": "01990000-0000-7000-8000-0000000000b0",
    "project_id": "01990000-0000-7000-8000-0000000000b1",
    "status": "queued",
    "created_at": "2026-10-27T00:00:00Z",
    "updated_at": "2026-10-27T00:00:00Z",
}


def _client(handler, credentials: ProfileCredentials) -> AsyncIntrospectionClient:
    return AsyncIntrospectionClient(
        dp_url="https://dp.test",
        credentials=credentials,
        transport=httpx.MockTransport(handler),
    )


class RefreshedLoginTest(unittest.TestCase):
    """`introspection eval run` renews the stored login while a trial is running."""

    def _credentials(self, reload) -> ProfileCredentials:
        return ProfileCredentials(
            DataPlaneCredentials(url="https://dp.test", token="old"), reload=reload
        )

    def _rejecting_all_but(self, accepted: str, seen: list[str]):
        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.headers["authorization"])
            if request.headers["authorization"] != f"Bearer {accepted}":
                return httpx.Response(401, json={"detail": "Invalid token"})
            return httpx.Response(200, json=TASK)

        return handler

    def _assert_rejected_once(self, credentials: ProfileCredentials, seen) -> None:
        client = _client(self._rejecting_all_but("new", seen), credentials)
        with self.assertRaises(AuthenticationError):
            asyncio.run(client.tasks.get(TASK["id"]))
        self.assertEqual(seen, ["Bearer old"])

    def test_a_rejected_token_is_replaced_by_the_one_the_cli_wrote_since(self) -> None:
        seen: list[str] = []
        credentials = self._credentials(
            lambda: DataPlaneCredentials(url="https://dp.test", token="new")
        )
        client = _client(self._rejecting_all_but("new", seen), credentials)

        async def twice() -> None:
            await client.tasks.get(TASK["id"])
            # The next request starts on the new token rather than rediscovering it.
            await client.tasks.get(TASK["id"])

        asyncio.run(twice())
        self.assertEqual(seen, ["Bearer old", "Bearer new", "Bearer new"])
        self.assertEqual(credentials.credentials.token, "new")

    def test_an_unchanged_login_fails_once_with_the_rejection(self) -> None:
        seen: list[str] = []
        self._assert_rejected_once(
            self._credentials(
                lambda: DataPlaneCredentials(url="https://dp.test", token="old")
            ),
            seen,
        )

    def test_a_login_that_can_no_longer_be_read_keeps_the_rejection(self) -> None:
        def expired() -> DataPlaneCredentials:
            raise DataPlaneError("The stored Introspection login has expired.")

        seen: list[str] = []
        self._assert_rejected_once(self._credentials(expired), seen)

    def test_a_token_is_never_sent_to_another_plane(self) -> None:
        seen: list[str] = []
        self._assert_rejected_once(
            self._credentials(
                lambda: DataPlaneCredentials(url="https://other.test", token="new")
            ),
            seen,
        )

    def test_without_a_reload_a_rejection_is_final(self) -> None:
        seen: list[str] = []
        self._assert_rejected_once(self._credentials(None), seen)


class TaskTeardownTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.seen: list[tuple[str, str]] = []
        self.response_status = 204

        def handler(request: httpx.Request) -> httpx.Response:
            self.seen.append((request.method, request.url.path))
            return httpx.Response(self.response_status)

        self.client = _client(
            handler,
            ProfileCredentials(DataPlaneCredentials(url="https://dp.test", token="t")),
        )
        self.environment = object.__new__(IntrospectionEnvironment)
        self.environment._task_id = "task-1"
        self.environment._client = self.client
        self.environment._control_plane = Mock()
        self.environment.logger = Mock()

    async def asyncTearDown(self) -> None:
        await self.client.shutdown()

    async def test_cleanup_archives_the_remote_task(self) -> None:
        with patch.object(self.client, "shutdown", wraps=self.client.shutdown) as close:
            await self.environment.stop(delete=True)
        self.assertEqual(self.seen, [("POST", "/v1/tasks/task-1/archive")])
        close.assert_awaited_once()
        self.assertIsNone(self.environment._task_id)
        self.assertIsNone(self.environment._client)
        self.assertIsNone(self.environment._control_plane)

    async def test_no_delete_leaves_the_remote_task_alone(self) -> None:
        with patch.object(self.client, "shutdown", wraps=self.client.shutdown) as close:
            await self.environment.stop(delete=False)
        self.assertEqual(self.seen, [])
        close.assert_awaited_once()

    async def test_archive_rejection_is_best_effort(self) -> None:
        self.response_status = 403
        with patch.object(self.client, "shutdown", wraps=self.client.shutdown) as close:
            await self.environment.stop(delete=True)
        self.assertEqual(self.seen, [("POST", "/v1/tasks/task-1/archive")])
        self.environment.logger.debug.assert_called_once()
        close.assert_awaited_once()
        self.assertIsNone(self.environment._client)


class CredentialExpiryTest(unittest.TestCase):
    """The login the profile holds is not refreshed here, so its expiry is load-bearing."""

    def _profile(self, expires_at: int) -> Path:
        directory = Path(tempfile.mkdtemp())
        (directory / "credentials.json").write_text(
            json.dumps(
                {
                    "dp_url": "https://dp.test",
                    "access_token": "t",
                    "expires_at": expires_at,
                }
            )
        )
        return directory / "credentials.json"

    def test_an_expired_login_is_refused_with_the_way_out(self) -> None:
        # Nothing here refreshes the token — that flow lives in the Rust CLI —
        # so an expired one otherwise surfaces as a 401 from whichever request
        # happened to go first, attributed to the trial.
        stale = self._profile(int(time.time()) - 60)
        with self.assertRaises(DataPlaneError) as refused:
            load_credentials(environ={}, credentials_path=stale)
        self.assertIn("introspection login", str(refused.exception))

    def test_a_live_login_is_accepted_and_carries_its_expiry(self) -> None:
        fresh = self._profile(int(time.time()) + 3600)
        credentials = load_credentials(environ={}, credentials_path=fresh)
        self.assertEqual(credentials.token, "t")
        self.assertGreater(credentials.expires_at or 0, time.time())

    def test_an_environment_token_is_taken_as_given(self) -> None:
        # No profile to read an expiry from, and the operator chose it.
        credentials = load_credentials(
            environ={
                "INTROSPECTION_DP_URL": "https://other.test",
                "INTROSPECTION_TOKEN": "x",
            },
            credentials_path=self._profile(0),
        )
        self.assertEqual(
            (credentials.url, credentials.token), ("https://other.test", "x")
        )
        self.assertIsNone(credentials.expires_at)


if __name__ == "__main__":
    unittest.main()
