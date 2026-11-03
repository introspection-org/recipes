"""A Recipe's MCP fakes' answers, read and checked, for a task's verifier.

The Python twin of ``@introspection-ai/recipe-fakes-mcp/answers``. A tool answers in
one of the formats ``introspection bindings mcp observe`` names (``json``,
``toon``, ``prefixed_json``: JSON between fixed text, and ``text``), and its
answer's schema is JSON Schema. ``mcp-fakes serve`` writes each fake's answers
to ``mcp/<id>/answers.json`` under ``MCP_FAKES_MANIFEST_DIR``, beside its
``manifest.json``; ``load_answers`` reads them.

A read is ``{"ok": True, "value": ...}`` or ``{"ok": False, "error": ...,
"issues": [{"path", "keyword", "message"}]}``, as the TypeScript one is.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.validators import validator_for
from toon_format import decode as decode_toon

from .fakes import load_each

__all__ = ["FORMATS", "decode", "load_answers", "read_answer", "read_result"]

FORMATS = ("json", "toon", "prefixed_json", "text")


def _json(text: str) -> Any:
    # JSON.parse refuses NaN and Infinity, which Python's json accepts.
    def refuse(constant: str) -> Any:
        raise ValueError(f"{constant} is not JSON")

    return json.loads(text, parse_constant=refuse)


def decode(answer: Mapping[str, Any], text: str) -> Any:
    """An answer's text as its value. Raises ``ValueError`` for text not in the answer's format."""

    match answer.get("format"):
        case "text":
            return text
        case "json":
            return _json(text)
        case "prefixed_json":
            prefix = answer.get("prefix")
            if not prefix or not text.startswith(prefix):
                raise ValueError(f"the answer does not start with {json.dumps(prefix)}")
            suffix = answer.get("suffix") or ""
            if not text.endswith(suffix) or len(text) - len(suffix) < len(prefix):
                raise ValueError(f"the answer does not end with {json.dumps(suffix)}")
            return _json(text[len(prefix) : len(text) - len(suffix)])
        case "toon":
            return decode_toon(text)
        case other:
            raise ValueError(f"no format {other}")


def _checked(answer: Mapping[str, Any], value: Any) -> dict[str, Any]:
    schema = answer.get("schema")
    if schema is None:
        return {"ok": True, "value": value}
    # Formats are checked, as TypeBox checks them; date-time needs rfc3339-validator.
    cls = validator_for(schema, default=Draft202012Validator)
    validator = cls(schema, format_checker=cls.FORMAT_CHECKER)
    issues = [
        {
            "path": "".join(f"/{part}" for part in error.absolute_path) or "/",
            "keyword": str(error.validator),
            "message": error.message,
        }
        for error in validator.iter_errors(value)
    ]
    if not issues:
        return {"ok": True, "value": value}
    error = ", ".join(f"{issue['path']} {issue['message']}" for issue in issues)
    return {"ok": False, "error": error, "issues": issues}


def read_answer(answer: Mapping[str, Any], text: str) -> dict[str, Any]:
    """A successful answer's text, decoded and checked. A text answer is its text."""

    if answer.get("format") == "text":
        return {"ok": True, "value": text}
    try:
        value = decode(answer, text)
    except ValueError as error:
        message = f"not {answer.get('format')}: {error}"
        return {"ok": False, "error": message, "issues": []}
    return _checked(answer, value)


def read_result(
    answer: Mapping[str, Any], text: str, structured: Any = None
) -> dict[str, Any]:
    """A successful result of one tool, read where its answer is.

    A tool that states an outputSchema (``"structured": true`` in its answer)
    answers with its structuredContent, whose text may hold anything beside
    it, as the Recipes MCP wrapper and ``observe`` read it; any other answers
    with its text. ``text`` and ``structured`` are a server call's
    ``response`` and ``structured``.
    """

    if not answer.get("structured"):
        return read_answer(answer, text)
    if structured is None:
        return {
            "ok": False,
            "error": (
                "no structuredContent; the tool states an outputSchema, and "
                "the trajectory carries a result's structuredContent only "
                "where its GenAI spans and ATIF projection record it"
            ),
            "issues": [],
        }
    return _checked(answer, structured)


def load_answers(directory: Path) -> dict[str, dict[str, dict[str, Any]]]:
    """Each fake's ``answers.json`` under ``directory``, keyed by fake id, then tool.

    ``directory`` is laid out as ``load_manifests`` reads it, one directory per
    fake. A missing directory or one without answers raises, so a verifier
    whose mount is missing cannot pass.
    """

    return load_each(directory, "answers")
