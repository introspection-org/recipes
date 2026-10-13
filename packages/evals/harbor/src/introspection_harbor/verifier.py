"""What the agent said and which tools it called, for a task's verifier.

A verifier runs inside the trial and reads the trajectory the adapter wrote to
``/logs/agent/trajectory.json``. On a step that continues the conversation the
file covers every turn so far. These helpers read it as plain JSON, so a check
does not depend on how the adapter lays out ATIF.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

TRAJECTORY_PATH = Path("/logs/agent/trajectory.json")


def load_trajectory(path: Path = TRAJECTORY_PATH) -> dict[str, Any]:
    """The trajectory, or one without steps when the agent left none."""

    try:
        trajectory = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {"steps": []}
    return trajectory if isinstance(trajectory, dict) else {"steps": []}


def text(content: Any) -> str:
    """A message or tool result as text; ATIF allows a string or content parts."""

    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part["text"]
            for part in content
            if isinstance(part, dict)
            and part.get("type") == "text"
            and isinstance(part.get("text"), str)
        )
    return ""


def replies(trajectory: dict[str, Any]) -> list[str]:
    """Every non-empty message the agent wrote, in order."""

    return [
        text(step.get("message"))
        for step in trajectory.get("steps") or []
        if step.get("source") == "agent" and text(step.get("message")).strip()
    ]


def final_reply(trajectory: dict[str, Any]) -> str:
    """The agent's last non-empty message, or an empty string."""

    return (replies(trajectory) or [""])[-1]


def tool_calls(trajectory: dict[str, Any]) -> list[dict[str, Any]]:
    """Every tool call that has a result, in order.

    Each is ``name``, ``arguments``, ``result`` (the result as text) and
    ``is_error`` (whether the tool reported a failure).
    """

    calls = []
    for step in trajectory.get("steps") or []:
        results = {
            result.get("source_call_id"): result
            for result in (step.get("observation") or {}).get("results") or []
        }
        for call in step.get("tool_calls") or []:
            result = results.get(call.get("tool_call_id"))
            if result is not None:
                arguments = call.get("arguments")
                calls.append(
                    {
                        "name": call.get("function_name") or "",
                        "arguments": arguments if isinstance(arguments, dict) else {},
                        "result": text(result.get("content")),
                        "is_error": (result.get("extra") or {}).get("is_error") is True,
                    }
                )
    return calls
