"""What a Recipe's MCP fakes hold and which writes the agent tried, for a task's verifier.

A trial's fakes run in one sidecar on ``@introspection-ai/mcp-fakes``, which
serves each fake's state at ``/<id>/admin/state`` and the state it started
with at ``/<id>/admin/initial-state``. Each fake's ``manifest.json`` maps its
tools to the entities they read and write; the entities some tool writes,
outbound effects such as sent emails and rejected send attempts among them,
are what "no state changed" compares.

Two checks a case may share, scored separately:

- ``state_changes``: did the world change? Empty when it did not. Read from the
  fakes' states, so a rejected write or a no-op call does not count, and a
  change the agent made and undid is not seen.
- ``write_attempts``: did the agent call a tool the write map says writes? Empty
  when it did not, whether or not anything changed? Read from the
  trajectory; an attempt check, never a state check.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.request
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

__all__ = [
    "fake_initial_state",
    "fake_state",
    "load_manifests",
    "state_changes",
    "write_attempts",
]

_URL_ENV = "INTROSPECTION_FAKES_URL"
_DEFAULT_URL = "http://fakes:7353"


def _admin(fake: str, route: str, url: str | None) -> Any:
    base = (url or os.environ.get(_URL_ENV) or _DEFAULT_URL).rstrip("/")
    # The sidecar is local to the trial: never through the trial's egress proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f"{base}/{fake}/admin/{route}", timeout=20) as response:
        return json.load(response)


def fake_state(fake: str, url: str | None = None) -> Any:
    """A fake's state now.

    ``url`` is the sidecar's base URL; ``$INTROSPECTION_FAKES_URL`` when
    omitted, else ``http://fakes:7353``.
    """

    return _admin(fake, "state", url)


def fake_initial_state(fake: str, url: str | None = None) -> Any:
    """A fake's state when the trial started."""

    return _admin(fake, "initial-state", url)


def load_manifests(directory: Path) -> dict[str, dict[str, Any]]:
    """Each fake's ``manifest.json`` under ``directory``, keyed by fake id.

    ``directory`` holds one directory per fake, named by its id, as the
    Recipe's ``fakes/mcp/`` does. A missing directory or one without a
    manifest raises, so a verifier whose mount is missing cannot pass.
    """

    return load_each(directory, "manifest")


def load_each(directory: Path, name: str) -> dict[str, Any]:
    """Each fake's ``<name>.json`` under ``directory``, keyed by fake id; raises for none."""

    directory = Path(directory)
    if not directory.is_dir():
        raise FileNotFoundError(f"No fakes' {name} directory at {directory}")
    files = {
        path.parent.name: json.loads(path.read_text())
        for path in sorted(directory.glob(f"*/{name}.json"))
    }
    if not files:
        raise ValueError(f"No fake's {name}.json under {directory}")
    return files


def _write_tools(manifest: Mapping[str, Any]) -> list[str]:
    return [name for name, tool in manifest["tools"].items() if tool.get("writes")]


def _written_entities(manifest: Mapping[str, Any]) -> list[str]:
    return list(
        dict.fromkeys(
            entity
            for tool in manifest["tools"].values()
            for entity in tool.get("writes") or []
        )
    )


_ABSENT = object()


def _json_equal(left: Any, right: Any) -> bool:
    # Python's == says False == 0 and True == 1; JSON, and the TypeScript runner, do not.
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(
            _json_equal(value, right[key]) for key, value in left.items()
        )
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(map(_json_equal, left, right))
    return type(left) is type(right) and left == right


def _changed_entities(
    manifest: Mapping[str, Any], initial: Any, final: Any
) -> list[str]:
    return [
        entity
        for entity in _written_entities(manifest)
        if not _json_equal(initial.get(entity, _ABSENT), final.get(entity, _ABSENT))
    ]


def state_changes(
    manifests: Mapping[str, Mapping[str, Any]], url: str | None = None
) -> list[str]:
    """``<fake>.<entity>`` for every written entity of these fakes that changed in the trial.

    Empty when no state changed. Compares as JSON, so ``false`` and ``0``
    differ; ``changedEntities`` in ``@introspection-ai/mcp-fakes/verify``
    computes the same. No manifests raises rather than reports no change.
    """

    return _state_changes_between(
        manifests,
        {fake: fake_initial_state(fake, url) for fake in manifests},
        {fake: fake_state(fake, url) for fake in manifests},
    )


def _state_changes_between(
    manifests: Mapping[str, Mapping[str, Any]],
    initial: Mapping[str, Any],
    final: Mapping[str, Any],
) -> list[str]:
    if not manifests:
        raise ValueError("No fakes' manifests to check")
    return [
        f"{fake}.{entity}"
        for fake, manifest in manifests.items()
        for entity in _changed_entities(manifest, initial[fake], final[fake])
    ]


def _sanitized(value: str) -> str:
    return (
        re.sub(r"^[_-]+|[_-]+$", "", re.sub(r"[^A-Za-z0-9_-]+", "_", value)) or "tool"
    )


def _pi_tool_names(server: str, tool: str) -> set[str]:
    # Pi's piMcpToolName: hashed, and the readable form without the hash.
    digest = hashlib.sha256(f"{server}.{tool}".encode()).hexdigest()[:10]
    readable = f"mcp_{_sanitized(server)}_{_sanitized(tool)}"
    prefix = readable[: 64 - len(digest) - 1].rstrip("_")
    return {f"{prefix}_{digest}", readable}


def write_attempts(
    calls: Iterable[Mapping[str, Any]], manifests: Mapping[str, Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """The calls among ``calls`` to a tool these fakes' write maps say writes.

    Empty when no write was attempted, whatever a call did.

    ``calls`` are ``introspection_harbor.verifier.tool_calls(trajectory)``.
    Each attempt is the call with ``server`` and ``tool`` added, the fake and
    the tool's name in its contract. A server is matched by the fake's id,
    which is the server id the Recipe declares and Pi names the tool by.
    No manifests raises rather than reports no attempt.
    """

    if not manifests:
        raise ValueError("No fakes' manifests to check")
    names = {
        name: (fake, tool)
        for fake, manifest in manifests.items()
        for tool in _write_tools(manifest)
        for name in _pi_tool_names(fake, tool)
    }
    return [
        {**call, "server": names[call["name"]][0], "tool": names[call["name"]][1]}
        for call in calls
        if call.get("name") in names
    ]
