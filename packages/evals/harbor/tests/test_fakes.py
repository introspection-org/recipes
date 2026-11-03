from __future__ import annotations

import copy
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from unittest import mock

from introspection_harbor import fakes
from introspection_harbor.fakes import (
    fake_initial_state,
    fake_state,
    load_manifests,
    state_changes,
    write_attempts,
)

# The cases @introspection-ai/recipe-fakes-mcp' verify tests share, with the manifests they read.
FAKES = Path(__file__).parents[3] / "fakes" / "testdata"
MANIFESTS = load_manifests(FAKES / "mcp")

WORLD = {
    "crm": {
        "now": "2026-10-01T09:00:00Z",
        "deals": [{"name": "Acme", "stage": "Proposal"}],
    },
    "mail": {"blocked": ["ops@example.test"], "emails": [], "sendAttempts": []},
}


class _Sidecar(ThreadingHTTPServer):
    """Answers the two admin routes of an mcp-fakes sidecar from in-memory states."""

    def __init__(self) -> None:
        self.initial: dict[str, Any] = copy.deepcopy(WORLD)
        self.states: dict[str, Any] = copy.deepcopy(WORLD)
        self.requests: list[str] = []
        super().__init__(("127.0.0.1", 0), _AdminHandler)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"


class _AdminHandler(BaseHTTPRequestHandler):
    server: _Sidecar

    def do_GET(self) -> None:
        self.server.requests.append(self.path)
        _, fake, *route = self.path.split("/")
        states = {
            "admin/state": self.server.states,
            "admin/initial-state": self.server.initial,
        }.get("/".join(route))
        if states is None or fake not in states:
            self.send_error(404)
            return
        body = json.dumps(states[fake]).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        pass


class SidecarReadTest(unittest.TestCase):
    """The reads and the state check against a stub of the sidecar's admin routes."""

    def setUp(self) -> None:
        self.sidecar = _Sidecar()
        thread = threading.Thread(target=self.sidecar.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.sidecar.server_close)
        self.addCleanup(self.sidecar.shutdown)
        environment = mock.patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop("INTROSPECTION_FAKES_URL", None)
        # The sidecar is reached without the trial's proxy, even when one is set.
        os.environ["http_proxy"] = os.environ["HTTP_PROXY"] = "http://127.0.0.1:9"

    def test_reads_a_fakes_state_and_the_state_it_started_with(self) -> None:
        self.sidecar.states["crm"]["deals"][0]["stage"] = "Won"

        self.assertEqual(
            fake_initial_state("crm", self.sidecar.url)["deals"],
            [{"name": "Acme", "stage": "Proposal"}],
        )
        self.assertEqual(
            fake_state("crm", f"{self.sidecar.url}/")["deals"],
            [{"name": "Acme", "stage": "Won"}],
        )
        self.assertEqual(
            self.sidecar.requests, ["/crm/admin/initial-state", "/crm/admin/state"]
        )

    def test_the_sidecar_url_comes_from_the_environment(self) -> None:
        os.environ["INTROSPECTION_FAKES_URL"] = self.sidecar.url
        self.assertEqual(fake_state("mail")["emails"], [])
        self.assertEqual(fake_initial_state("mail")["sendAttempts"], [])

    def test_the_default_url_is_the_trials_fakes_service(self) -> None:
        self.assertEqual(fakes._DEFAULT_URL, "http://fakes:7353")
        with mock.patch.object(fakes, "_DEFAULT_URL", self.sidecar.url):
            self.assertEqual(fake_state("mail")["blocked"], ["ops@example.test"])

    def test_nothing_changed_while_the_agent_only_read(self) -> None:
        self.assertEqual(state_changes(MANIFESTS, self.sidecar.url), [])

    def test_a_write_changes_its_entity(self) -> None:
        self.sidecar.states["crm"]["deals"][0]["stage"] = "Won"

        self.assertEqual(state_changes(MANIFESTS, self.sidecar.url), ["crm.deals"])
        # Only the fakes a check names are compared.
        self.assertEqual(
            state_changes({"mail": MANIFESTS["mail"]}, self.sidecar.url), []
        )

    def test_a_rejected_send_is_an_outbound_effect_the_state_keeps(self) -> None:
        self.sidecar.states["mail"]["sendAttempts"].append({"to": "ops@example.test"})

        self.assertEqual(
            state_changes(MANIFESTS, self.sidecar.url), ["mail.sendAttempts"]
        )

    def test_a_fake_the_sidecar_does_not_serve_is_an_error_not_a_pass(self) -> None:
        with self.assertRaises(OSError):
            state_changes({"calendar": MANIFESTS["crm"]}, self.sidecar.url)


class WriteMapTest(unittest.TestCase):
    def test_loads_each_fakes_manifest_by_its_id(self) -> None:
        self.assertEqual(sorted(MANIFESTS), ["crm", "mail"])
        self.assertEqual(fakes._write_tools(MANIFESTS["crm"]), ["update-deal"])
        self.assertEqual(
            fakes._written_entities(MANIFESTS["mail"]), ["emails", "sendAttempts"]
        )

    def test_compares_only_the_entities_a_tool_writes(self) -> None:
        initial = {"now": "2026-10-01", "deals": [{"stage": "Proposal"}]}
        self.assertEqual(
            fakes._changed_entities(
                MANIFESTS["crm"], initial, {**initial, "now": "2026-10-02"}
            ),
            [],
        )
        self.assertEqual(
            fakes._changed_entities(
                MANIFESTS["crm"], initial, {**initial, "deals": []}
            ),
            ["deals"],
        )

    def test_a_missing_entity_differs_from_null(self) -> None:
        self.assertEqual(
            fakes._changed_entities(MANIFESTS["crm"], {"deals": None}, {}), ["deals"]
        )

    def test_a_missing_manifest_directory_is_refused(self) -> None:
        with self.assertRaises(FileNotFoundError):
            load_manifests(FAKES / "missing")
        with self.assertRaises(ValueError):
            load_manifests(FAKES / "mcp" / "crm")


CASES = json.loads((FAKES / "cases.json").read_text())


def _manifests(case: dict) -> dict:
    manifests = case.get("manifests", MANIFESTS)
    return {fake: manifests[fake] for fake in case.get("fakes") or manifests}


class SharedCasesTest(unittest.TestCase):
    """The cases @introspection-ai/recipe-fakes-mcp' verify tests run too, so both runners score alike."""

    def test_load_manifests(self) -> None:
        for case in CASES["loadManifests"]:
            with self.subTest(case["name"]):
                directory = FAKES / case["directory"]
                if "error" in case:
                    with self.assertRaisesRegex(Exception, case["error"]):
                        load_manifests(directory)
                else:
                    self.assertEqual(sorted(load_manifests(directory)), case["fakes"])

    def test_state_changes(self) -> None:
        for case in CASES["stateChanges"]:
            with self.subTest(case["name"]):
                if "error" in case:
                    with self.assertRaisesRegex(ValueError, case["error"]):
                        fakes._state_changes_between(
                            _manifests(case), case["initial"], case["final"]
                        )
                    # Refused before the sidecar is read.
                    with self.assertRaisesRegex(ValueError, case["error"]):
                        state_changes(_manifests(case), "http://127.0.0.1:9")
                    continue
                self.assertEqual(
                    fakes._state_changes_between(
                        _manifests(case), case["initial"], case["final"]
                    ),
                    case["changed"],
                )

    def test_write_attempts(self) -> None:
        for case in CASES["writeAttempts"]:
            with self.subTest(case["name"]):
                manifests = _manifests(case)
                if "error" in case:
                    with self.assertRaisesRegex(ValueError, case["error"]):
                        write_attempts(case["calls"], manifests)
                    continue
                attempts = write_attempts(case["calls"], manifests)
                self.assertEqual(
                    [[attempt["server"], attempt["tool"]] for attempt in attempts],
                    case["attempts"],
                )
                # An attempt keeps the call it was.
                for attempt in attempts:
                    self.assertIn("is_error", attempt)

    def test_names_tools_as_pi_does(self) -> None:
        # Computed with piMcpToolName from @introspection-ai/recipes.
        for server, tool, name in CASES["piToolNames"]:
            with self.subTest(f"{server}.{tool}"):
                self.assertIn(name, fakes._pi_tool_names(server, tool))


if __name__ == "__main__":
    unittest.main()
