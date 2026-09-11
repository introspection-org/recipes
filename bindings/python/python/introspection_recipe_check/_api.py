from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import TypedDict, cast
from urllib.parse import unquote, urlparse

from . import _native


class _RecipeFileOptional(TypedDict, total=False):
    content: str | None


class RecipeFile(_RecipeFileOptional):
    path: str


class _RecipeFilesOptional(TypedDict, total=False):
    directories: list[str]


class RecipeFiles(_RecipeFilesOptional):
    files: list[RecipeFile]


@dataclass(frozen=True, slots=True)
class Span:
    line: int
    column: int


@dataclass(frozen=True, slots=True)
class Diagnostic:
    code: str
    path: str
    message: str
    span: Span | None = None
    help: str | None = None


@dataclass(frozen=True, slots=True)
class Report:
    valid: bool
    diagnostics: tuple[Diagnostic, ...]
    resources: dict[str, int]

    def to_dict(self) -> dict[str, object]:
        return cast(dict[str, object], asdict(self))


def check_recipe_files(snapshot: RecipeFiles) -> Report:
    """Validate an in-memory Recipe tree without filesystem access."""
    raw = cast(
        dict[str, object],
        json.loads(
            _native.check_recipe_files_json(
                json.dumps(snapshot, separators=(",", ":")),
            )
        ),
    )
    return Report(
        valid=cast(bool, raw["valid"]),
        diagnostics=tuple(
            _diagnostic(cast(dict[str, object], item))
            for item in cast(list[object], raw["diagnostics"])
        ),
        resources=cast(dict[str, int], raw.get("resources", {})),
    )


@dataclass(frozen=True, slots=True)
class RecipeIdentity:
    """The identity a template is being rewritten to.

    `slug`, `name` and `description` are named as the platform's Runtime
    resource names them, so a `GET /runtimes/{id}` payload can be passed
    through `from_runtime`. `variables` fills the `{{placeholder}}` tokens a
    template declares for everything identity does not cover.
    """

    slug: str
    name: str | None = None
    description: str | None = None
    recipe_path: str | None = None
    variables: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_runtime(
        cls,
        runtime: dict[str, object],
        *,
        recipe_path: str | None = None,
        variables: dict[str, str] | None = None,
    ) -> RecipeIdentity:
        """Build an identity from a Runtime resource, ignoring its other fields."""
        slug = runtime.get("slug")
        if not isinstance(slug, str) or not slug:
            raise ValueError("a Runtime payload needs a slug to format a Recipe")
        name = runtime.get("name")
        description = runtime.get("description")
        return cls(
            slug=slug,
            name=name if isinstance(name, str) else None,
            description=description if isinstance(description, str) else None,
            recipe_path=recipe_path,
            variables=dict(variables or {}),
        )


def format_recipe_files(
    snapshot: RecipeFiles,
    identity: RecipeIdentity,
) -> RecipeFiles:
    """Rewrite an in-memory Recipe tree to a new identity, without filesystem access."""
    return cast(
        RecipeFiles,
        json.loads(
            _native.format_recipe_files_json(
                json.dumps(snapshot, separators=(",", ":")),
                json.dumps(asdict(identity), separators=(",", ":")),
            )
        ),
    )


def load_recipe_dir(location: str | os.PathLike[str]) -> RecipeFiles:
    """Read a local Recipe directory into a snapshot.

    Accepts a plain path (`./template`, `/srv/x`) or a `file://` URL. It never
    fetches: a remote template is the caller's to clone, so the library holds no
    network surface and cannot be pointed at one by a value from a request.
    """
    root = Path(_local_path(location))
    if not root.is_dir():
        raise ValueError(f"{root} is not a directory")
    files: list[RecipeFile] = []
    directories: list[str] = []
    for entry in sorted(root.rglob("*")):
        relative = entry.relative_to(root).as_posix()
        if _ignored(relative):
            continue
        if entry.is_dir():
            directories.append(relative)
        elif entry.is_file():
            files.append({"path": relative, "content": _read_text(entry)})
    return {"files": files, "directories": directories}


def _local_path(location: str | os.PathLike[str]) -> Path:
    text = os.fspath(location)
    parsed = urlparse(text)
    if parsed.scheme in ("", "file"):
        if parsed.scheme == "file":
            if parsed.netloc not in ("", "localhost"):
                raise ValueError(f"{text} names a remote host; only local templates are read")
            return Path(unquote(parsed.path))
        return Path(text)
    raise ValueError(f"{text} is not a local path; only local templates are read")


def _ignored(relative: str) -> bool:
    """Skip a template's own history and build output, never its content."""
    head = relative.split("/", 1)[0]
    return head in (".git", "node_modules", "target", "__pycache__")


def _read_text(path: Path) -> str | None:
    """Binary files are reported as present but unread, matching `RecipeFile`."""
    try:
        return path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None


class JudgeSource(TypedDict):
    path: str
    content: str


@dataclass(frozen=True, slots=True)
class JudgeDefinition:
    value: dict[str, object]

    def to_dict(self) -> dict[str, object]:
        return self.value.copy()


@dataclass(frozen=True, slots=True)
class ParsedJudgeDefinition:
    source_path: str
    definition: JudgeDefinition


def parse_judge_definitions(
    sources: list[JudgeSource],
) -> tuple[ParsedJudgeDefinition, ...]:
    raw = cast(
        list[dict[str, object]],
        json.loads(
            _native.parse_judge_definitions_json(
                json.dumps(sources, separators=(",", ":")),
            )
        ),
    )
    return tuple(
        ParsedJudgeDefinition(
            source_path=cast(str, item["source_path"]),
            definition=JudgeDefinition(cast(dict[str, object], item["definition"])),
        )
        for item in raw
    )


def judge_definition_schema() -> dict[str, object]:
    return cast(
        dict[str, object],
        json.loads(_native.judge_definition_schema_json()),
    )


def _diagnostic(raw: dict[str, object]) -> Diagnostic:
    raw_span = cast(dict[str, object] | None, raw.get("span"))
    return Diagnostic(
        code=cast(str, raw["code"]),
        path=cast(str, raw["path"]),
        message=cast(str, raw["message"]),
        span=(
            Span(
                line=cast(int, raw_span["line"]),
                column=cast(int, raw_span["column"]),
            )
            if raw_span is not None
            else None
        ),
        help=cast(str | None, raw.get("help")),
    )
