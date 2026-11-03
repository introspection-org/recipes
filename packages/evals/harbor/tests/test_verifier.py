from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from harbor.models.trajectories import (
    Agent,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)

from introspection_harbor.verifier import (
    final_reply,
    load_trajectory,
    replies,
    server_calls,
    tool_calls,
)

# The cases @introspection-ai/mcp-fakes' tests share, Pi's tool names among them.
CASES = json.loads(
    (Path(__file__).parents[2] / "testdata" / "fakes" / "cases.json").read_text()
)


def _agent_step(message: str = "", **fields: object) -> dict:
    return {"source": "agent", "message": message, **fields}


def _call(call_id: str, name: str, **arguments: str) -> ToolCall:
    return ToolCall(tool_call_id=call_id, function_name=name, arguments=arguments)


def _results(*results: ObservationResult) -> Observation:
    return Observation(results=list(results))


def _written(steps: list[dict]) -> dict:
    """The trajectory as a verifier finds it: Harbor's ATIF, as JSON."""

    trajectory = Trajectory(
        session_id="session-1",
        agent=Agent(name="introspection-recipe", version="0"),
        steps=[Step(step_id=index, **step) for index, step in enumerate(steps, 1)],
    )
    with tempfile.TemporaryDirectory() as temp_dir:
        path = Path(temp_dir) / "trajectory.json"
        path.write_text(trajectory.model_dump_json())
        return load_trajectory(path)


class VerifierTest(unittest.TestCase):
    def test_a_missing_or_invalid_trajectory_has_no_steps(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            missing = Path(temp_dir) / "trajectory.json"
            self.assertEqual(load_trajectory(missing), {"steps": []})
            missing.write_text("not json")
            self.assertEqual(load_trajectory(missing), {"steps": []})
            missing.write_text("[]")
            self.assertEqual(load_trajectory(missing), {"steps": []})

    def test_the_final_reply_is_the_last_message_the_agent_wrote(self) -> None:
        trajectory = _written(
            [
                {"source": "user", "message": "Which deals are quiet?"},
                _agent_step("Checking."),
                _agent_step(tool_calls=[_call("call-1", "read")]),
                _agent_step("Acme is quiet."),
                _agent_step("  "),
            ]
        )

        self.assertEqual(replies(trajectory), ["Checking.", "Acme is quiet."])
        self.assertEqual(final_reply(trajectory), "Acme is quiet.")

    def test_a_run_without_a_trajectory_has_no_reply(self) -> None:
        self.assertEqual(final_reply({"steps": []}), "")

    def test_tool_calls_carry_their_result_and_skip_unanswered_calls(self) -> None:
        trajectory = _written(
            [
                _agent_step(
                    tool_calls=[
                        _call("call-1", "list-records", object="deals"),
                        _call("call-2", "bash"),
                    ],
                    observation=_results(
                        ObservationResult(
                            source_call_id="call-1", content="records[0]:"
                        )
                    ),
                ),
                _agent_step(
                    tool_calls=[_call("call-3", "get-note")],
                    observation=_results(
                        ObservationResult(
                            source_call_id="call-3",
                            content="Note not found.",
                            extra={"is_error": True},
                        )
                    ),
                ),
            ]
        )

        self.assertEqual(
            tool_calls(trajectory),
            [
                {
                    "name": "list-records",
                    "arguments": {"object": "deals"},
                    "result": "records[0]:",
                    "is_error": False,
                },
                {
                    "name": "get-note",
                    "arguments": {},
                    "result": "Note not found.",
                    "is_error": True,
                },
            ],
        )


class ServerCallsTest(unittest.TestCase):
    def test_a_servers_calls_under_its_own_tool_names(self) -> None:
        trajectory = _written(
            [
                _agent_step(
                    tool_calls=[
                        _call(
                            "call-1",
                            "mcp_attio_list-records_0123456789",
                            object="deals",
                        ),
                        _call("call-2", "mcp_attio_get-record"),
                        _call("call-3", "mcp_resend_send-email"),
                        _call("call-4", "bash"),
                    ],
                    observation=_results(
                        ObservationResult(source_call_id="call-1", content="deals[0]:"),
                        ObservationResult(
                            source_call_id="call-2",
                            content="Found it.",
                            extra={"structured_content": {"id": "d1"}},
                        ),
                        ObservationResult(source_call_id="call-3", content="Sent"),
                        ObservationResult(
                            source_call_id="call-4",
                            content="",
                            extra={"is_error": True},
                        ),
                    ),
                ),
            ]
        )

        self.assertEqual(
            server_calls(tool_calls(trajectory), "attio"),
            [
                {
                    "name": "list-records",
                    "args": {"object": "deals"},
                    "isError": False,
                    "response": "deals[0]:",
                },
                {
                    "name": "get-record",
                    "args": {},
                    "isError": False,
                    "response": "Found it.",
                    "structured": {"id": "d1"},
                },
            ],
        )
        self.assertEqual(
            [call["name"] for call in server_calls(tool_calls(trajectory), "resend")],
            ["send-email"],
        )

    def test_names_a_call_by_the_servers_tools(self) -> None:
        # A cut-short or replaced name only the server's tools recover.
        for server, tool, name in CASES["piToolNames"]:
            with self.subTest(f"{server}.{tool}"):
                calls = [
                    {"name": name, "arguments": {}, "result": "ok", "is_error": False},
                    {
                        "name": f"mcp_{server}_unlisted",
                        "arguments": {},
                        "result": "",
                        "is_error": False,
                    },
                ]
                self.assertEqual(
                    server_calls(calls, server, [tool, "other"]),
                    [{"name": tool, "args": {}, "isError": False, "response": "ok"}],
                )
