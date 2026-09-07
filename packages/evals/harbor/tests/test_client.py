"""The Data Plane client against a stubbed transport.

Every method here crosses a contract we do not own — the response envelope a
route returns and the path it is mounted at. Both were wrong and neither was
covered: the adapter mocked its own side of the seam, so a shape mismatch read
as a passing test right up until a real trial.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path

import httpx

from introspection_harbor.client import (
    DataPlaneClient,
    DataPlaneCredentials,
    DataPlaneError,
    load_credentials,
)


def _client(handler) -> DataPlaneClient:
    transport = httpx.MockTransport(handler)
    return DataPlaneClient(
        DataPlaneCredentials(url="https://dp.test", token="t"),
        client=httpx.AsyncClient(base_url="https://dp.test", transport=transport),
    )


class TaskLifecycleTest(unittest.TestCase):
    def test_create_returns_the_task_out_of_the_envelope(self) -> None:
        """`POST /v1/tasks` answers `{task, run}`, not a bare task."""
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(
                201,
                json={
                    "task": {"id": "task-1", "status": "queued"},
                    "run": {"id": "run-1", "status": "queued"},
                },
            )

        task = asyncio.run(_client(handler).create_task({"kind": "eval"}))
        self.assertEqual(task["id"], "task-1")
        self.assertEqual(task["status"], "queued")
        self.assertEqual(seen[0].url.path, "/v1/tasks")

    def test_create_surfaces_the_run_the_task_started_with(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                201,
                json={"task": {"id": "task-1"}, "run": {"id": "run-1"}},
            )

        created = asyncio.run(_client(handler).create_task_with_run({"kind": "eval"}))
        self.assertEqual((created.task["id"], created.run["id"]), ("task-1", "run-1"))

    def test_teardown_uses_a_route_that_exists(self) -> None:
        """`DELETE /v1/tasks/{id}` cancels active work and soft-deletes in one.

        There is no `POST /v1/tasks/{id}/cancel`; the only cancel route is
        per-run and deliberately leaves the sandbox warm, which is the opposite
        of teardown.
        """
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(204)

        asyncio.run(_client(handler).delete_task("task-1"))
        self.assertEqual(
            (seen[0].method, seen[0].url.path), ("DELETE", "/v1/tasks/task-1")
        )


if __name__ == "__main__":
    unittest.main()


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
