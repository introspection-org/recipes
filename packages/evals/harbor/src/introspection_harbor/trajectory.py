"""Pi's JSON event stream → Harbor's ATIF trajectory.

Harbor and ``introspection eval run`` read the trajectory for the observed
model, token usage and cost, so every adapter that captures a Pi run
(``pi --mode json``) converts through here.
"""

from __future__ import annotations

import json
from importlib.metadata import version
from pathlib import Path
from typing import Any

from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)

ADAPTER_VERSION = version("introspection-harbor")


def pi_messages(output: str) -> list[dict[str, Any]]:
    """Read the canonical messages from Pi's mixed JSONL and diagnostic output."""

    messages: list[dict[str, Any]] = []
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "message_end" and isinstance(
            event.get("message"), dict
        ):
            messages.append(event["message"])
    return messages


def pi_terminal_provider_error(output: str) -> str | None:
    """Return the final provider failure, ignoring errors Pi later recovered from."""

    for message in reversed(pi_messages(output)):
        if message.get("role") != "assistant":
            continue
        if message.get("stopReason") != "error":
            return None
        detail = message.get("errorMessage")
        return (
            detail.strip() if isinstance(detail, str) and detail.strip() else "unknown"
        )
    return None


def pi_session_messages(sessions_dir: Path) -> list[dict[str, Any]]:
    """Read every message of the conversation from Pi's session file.

    ``pi.jsonl`` is what one Pi run printed. The session file is what Pi keeps
    across runs, so after ``--continue`` it also holds the earlier turns. Pi
    names session files by start time; the last one is the session in use.
    """

    files = sorted(sessions_dir.rglob("*.jsonl")) if sessions_dir.is_dir() else []
    if not files:
        return []
    messages: list[dict[str, Any]] = []
    for line in files[-1].read_text().splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(entry, dict)
            and entry.get("type") == "message"
            and isinstance(entry.get("message"), dict)
        ):
            messages.append(entry["message"])
    return messages


def pi_events_to_atif(path: Path) -> Trajectory:
    return pi_messages_to_atif(pi_messages(path.read_text()))


def pi_messages_to_atif(messages: list[dict[str, Any]]) -> Trajectory:
    steps: list[Step] = []
    calls: dict[str, tuple[int, ToolCall]] = {}
    totals = {"input": 0, "output": 0, "cache": 0, "cost": 0.0}
    observed_models: set[str] = set()
    for message in messages:
        role = message.get("role")
        if role == "user":
            content = message.get("content")
            if isinstance(content, list):
                content = "".join(
                    block.get("text", "")
                    for block in content
                    if block.get("type") == "text"
                )
            steps.append(
                Step(step_id=len(steps) + 1, source="user", message=content or "")
            )
        elif role == "assistant":
            observed_model = message_model_name(message)
            if observed_model:
                observed_models.add(observed_model)
            text: list[str] = []
            thinking: list[str] = []
            tool_calls: list[ToolCall] = []
            for block in message.get("content") or []:
                if block.get("type") == "text":
                    text.append(block.get("text", ""))
                elif block.get("type") == "thinking":
                    thinking.append(block.get("thinking", ""))
                elif block.get("type") == "toolCall":
                    call = ToolCall(
                        tool_call_id=block["id"],
                        function_name=block["name"],
                        arguments=block.get("arguments") or {},
                    )
                    tool_calls.append(call)
            usage = message.get("usage") or {}
            cost = (usage.get("cost") or {}).get("total", 0) or 0
            totals["input"] += usage.get("input", 0) or 0
            totals["output"] += usage.get("output", 0) or 0
            totals["cache"] += usage.get("cacheRead", 0) or 0
            totals["cost"] += cost
            step = Step(
                step_id=len(steps) + 1,
                source="agent",
                model_name=observed_model,
                message="".join(text),
                reasoning_content="\n".join(thinking) or None,
                tool_calls=tool_calls or None,
                metrics=Metrics(
                    prompt_tokens=usage.get("input", 0) or 0,
                    completion_tokens=usage.get("output", 0) or 0,
                    cached_tokens=usage.get("cacheRead", 0) or 0,
                    cost_usd=cost,
                ),
                llm_call_count=1,
            )
            steps.append(step)
            for call in tool_calls:
                calls[call.tool_call_id] = (len(steps) - 1, call)
        elif role == "toolResult" and message.get("toolCallId") in calls:
            step_index, _ = calls[message["toolCallId"]]
            content = message.get("content") or []
            rendered = "".join(
                block.get("text", "")
                for block in content
                if block.get("type") == "text"
            )
            step = steps[step_index]
            results = list(step.observation.results) if step.observation else []
            results.append(
                ObservationResult(
                    source_call_id=message["toolCallId"],
                    content=rendered,
                )
            )
            step.observation = Observation(results=results)

    observed_model_name = (
        next(iter(observed_models), None) if len(observed_models) == 1 else None
    )
    if not steps:
        steps.append(
            Step(
                step_id=1,
                source="agent",
                message="No Pi events were recorded",
                llm_call_count=0,
            )
        )
    return Trajectory(
        session_id=None,
        agent=Agent(
            name="introspection-recipe",
            version=ADAPTER_VERSION,
            model_name=observed_model_name,
        ),
        steps=steps,
        final_metrics=FinalMetrics(
            total_prompt_tokens=int(totals["input"]),
            total_completion_tokens=int(totals["output"]),
            total_cached_tokens=int(totals["cache"]),
            total_cost_usd=float(totals["cost"]),
            total_steps=len(steps),
        ),
    )


def message_model_name(message: dict[str, Any]) -> str | None:
    provider = message.get("provider")
    model = message.get("model")
    if (
        not isinstance(provider, str)
        or not provider
        or not isinstance(model, str)
        or not model
    ):
        return None
    return f"{provider}/{model}"
