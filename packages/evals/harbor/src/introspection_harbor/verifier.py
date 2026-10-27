"""What the agent said and which tools it called, for a task's verifier.

A verifier runs inside the trial and reads the trajectory the adapter wrote to
``/logs/agent/trajectory.json``. On a step that continues the conversation the
file covers every turn so far. These helpers read it as plain JSON, so a check
does not depend on how the adapter lays out ATIF.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from .fakes import _pi_tool_names

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
    ``is_error`` (whether the tool reported a failure), and ``structured``,
    the result's structuredContent, when the result's ``extra`` holds it as
    ``structured_content``. The GenAI spans the trajectory is projected from
    do not record it yet, so no call has it until they do.
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
                extra = result.get("extra") or {}
                structured = extra.get("structured_content")
                calls.append(
                    {
                        "name": call.get("function_name") or "",
                        "arguments": arguments if isinstance(arguments, dict) else {},
                        "result": text(result.get("content")),
                        "is_error": extra.get("is_error") is True,
                        **(
                            {"structured": structured}
                            if isinstance(structured, dict)
                            else {}
                        ),
                    }
                )
    return calls


_PI_HASH = re.compile(r"_[0-9a-f]{10}$")


def server_calls(
    calls: list[dict[str, Any]], server: str, tools: Iterable[str] | None = None
) -> list[dict[str, Any]]:
    """One MCP server's calls among ``tool_calls``, under the server's own tool names.

    Pi names an MCP tool ``mcp_<server>_<tool>``, with characters outside
    ``[A-Za-z0-9_-]`` replaced, and may cut it short and append ``_<10 hex>``,
    a hash of the name. Given the server's ``tools``, such as its answers from
    ``introspection_harbor.answers.load_answers``, each call is named by the
    tool whose Pi name it carries, and a call to no listed tool is left out;
    without them, the hash is stripped, which recovers only a short name Pi
    did not have to replace characters of.

    Each is ``name``, ``args``, ``isError``, ``response`` (the result as
    text) and, when the call has it, ``structured``: the keys of
    ``serverCalls`` in ``@introspection-ai/vitest-evals``, which
    ``introspection_harbor.answers.read_result`` reads.
    """

    prefix = f"mcp_{server}_"
    named = (
        None
        if tools is None
        else {name: tool for tool in tools for name in _pi_tool_names(server, tool)}
    )

    def tool_name(call: dict[str, Any]) -> str | None:
        if named is not None:
            return named.get(call["name"])
        if call["name"].startswith(prefix):
            return _PI_HASH.sub("", call["name"][len(prefix) :])
        return None

    return [
        {
            "name": name,
            "args": call["arguments"],
            "isError": call["is_error"],
            "response": call["result"],
            **({"structured": call["structured"]} if "structured" in call else {}),
        }
        for call in calls
        if (name := tool_name(call)) is not None
    ]
