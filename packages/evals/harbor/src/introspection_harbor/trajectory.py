"""A Pi run → Harbor's ATIF trajectory.

Harbor and ``introspection eval run`` read the trajectory for the observed
model, token usage and cost, so every adapter that captures a Pi run
(``pi --mode json``) converts through here.

The trajectory is a projection of the platform's GenAI spans, written by
``introspection-sdk`` and shared with the platform's own ATIF export
(``spans_to_trajectory``). The Recipes extension writes those spans during the
Pi run, so a trial needs a Recipes release that supports
``PI_RECIPE_GENAI_SPANS_FILE``.
"""

from __future__ import annotations

import json
from importlib.metadata import version
from pathlib import Path
from typing import Any

from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory
from introspection_sdk.atif import spans_to_atif
from introspection_sdk.schemas.genai_span import GenAiSpan, GenAiSpanList

ADAPTER_VERSION = version("introspection-harbor")
AGENT_NAME = "introspection-recipe"
# The conversation as the platform's GenAI spans, beside Pi's own files in the
# agent log directory. The Recipes extension writes it during the run, to the
# path this variable names.
SPANS_FILENAME = "genai-spans.json"
SPANS_FILE_ENV = "PI_RECIPE_GENAI_SPANS_FILE"
TRAJECTORY_FILENAME = "trajectory.json"


def read_spans(path: Path) -> list[GenAiSpan]:
    """The GenAI spans the Recipes extension wrote during the Pi run.

    A missing file after a run that reached the model means the trial's
    Recipes extension is too old to write it, and there is no other source for
    the trajectory.
    """

    if not path.is_file():
        raise FileNotFoundError(
            f"The trial wrote no GenAI spans to {path.name}: its Recipes "
            "extension does not support PI_RECIPE_GENAI_SPANS_FILE. Use a "
            "current Runtime image, or a CLI whose `introspection setup` "
            "installs a Recipes release that does."
        )
    return GenAiSpanList.model_validate_json(path.read_text()).data


def spans_to_trajectory(spans: list[GenAiSpan]) -> Trajectory | None:
    """The trajectory of ``spans``, or None when no model call was recorded."""

    if not spans:
        return None
    trajectory = spans_to_atif(
        spans, agent_name=AGENT_NAME, agent_version=ADAPTER_VERSION
    )
    # Harbor's own model is the contract a verifier and Harbor read, so a
    # projection it would reject fails here and not in a trial's grading.
    return Trajectory.model_validate(trajectory.model_dump(mode="json"))


def write_conversation_trajectory(
    logs_dir: Path, output_filename: str
) -> tuple[list[GenAiSpan], Trajectory] | None:
    """Write a Pi run's ATIF beside its spans; returns both, if there is one.

    ``None`` when Pi stopped before its session started, so there is no
    conversation and the run's own error is the one to report, and when no
    model call was recorded. A run that reached the model without readable
    spans raises.
    """

    output_path = logs_dir / output_filename
    spans_path = logs_dir / SPANS_FILENAME
    # As an ACP target Pi writes the spans but no event stream.
    if not spans_path.is_file() and (
        not output_path.is_file() or not pi_messages(output_path.read_text())
    ):
        return None
    spans = read_spans(spans_path)
    conversation = spans_to_trajectory(spans)
    if conversation is None:
        return None
    (logs_dir / TRAJECTORY_FILENAME).write_text(
        json.dumps(conversation.to_json_dict(), indent=2)
    )
    return spans, conversation


def record_usage(context: AgentContext, trajectory: Trajectory) -> None:
    """Put a trajectory's token totals and cost in Harbor's context."""

    if metrics := trajectory.final_metrics:
        context.n_input_tokens = metrics.total_prompt_tokens
        context.n_output_tokens = metrics.total_completion_tokens
        context.n_cache_tokens = metrics.total_cached_tokens
        context.cost_usd = metrics.total_cost_usd


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
