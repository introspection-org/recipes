from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from introspection_harbor.trajectory import pi_messages_to_atif
from introspection_harbor.verifier import (
    final_reply,
    load_trajectory,
    replies,
    tool_calls,
)


def _assistant(*blocks: dict) -> dict:
    return {"role": "assistant", "content": list(blocks)}


def _written(messages: list[dict]) -> dict:
    """The trajectory as a verifier finds it: the adapter's ATIF, as JSON."""

    with tempfile.TemporaryDirectory() as temp_dir:
        path = Path(temp_dir) / "trajectory.json"
        path.write_text(pi_messages_to_atif(messages).model_dump_json())
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
                {"role": "user", "content": "Which deals are quiet?"},
                _assistant({"type": "text", "text": "Checking."}),
                _assistant({"type": "toolCall", "id": "call-1", "name": "read"}),
                _assistant({"type": "text", "text": "Acme is quiet."}),
                _assistant({"type": "text", "text": "  "}),
            ]
        )

        self.assertEqual(replies(trajectory), ["Checking.", "Acme is quiet."])
        self.assertEqual(final_reply(trajectory), "Acme is quiet.")

    def test_a_run_that_recorded_nothing_has_no_reply(self) -> None:
        trajectory = _written([])

        self.assertEqual(len(trajectory["steps"]), 1)
        self.assertEqual(final_reply(trajectory), "")

    def test_tool_calls_carry_their_result_and_skip_unanswered_calls(self) -> None:
        trajectory = _written(
            [
                _assistant(
                    {
                        "type": "toolCall",
                        "id": "call-1",
                        "name": "list-records",
                        "arguments": {"object": "deals"},
                    },
                    {"type": "toolCall", "id": "call-2", "name": "bash"},
                ),
                {
                    "role": "toolResult",
                    "toolCallId": "call-1",
                    "content": [{"type": "text", "text": "records[0]:"}],
                },
                _assistant({"type": "toolCall", "id": "call-3", "name": "get-note"}),
                {
                    "role": "toolResult",
                    "toolCallId": "call-3",
                    "content": [{"type": "text", "text": "Note not found."}],
                    "isError": True,
                },
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
