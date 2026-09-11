from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
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
class TemplateVariable:
    name: str
    kind: str = "string"
    default: str | None = None
    prompt: str | None = None
    choices: tuple[str, ...] = ()
    when: str | None = None


@dataclass(frozen=True, slots=True)
class TemplateManifest:
    """What a template repository declares about itself, from `template.yaml`."""

    version: int
    name: str | None
    description: str | None
    variables: tuple[TemplateVariable, ...]


def parse_template_manifest(manifest_yaml: str) -> TemplateManifest:
    """Parse a `template.yaml`."""
    raw = cast(
        dict[str, object],
        json.loads(_native.parse_template_manifest_json(manifest_yaml)),
    )
    return TemplateManifest(
        version=cast(int, raw["version"]),
        name=cast("str | None", raw.get("name")),
        description=cast("str | None", raw.get("description")),
        variables=tuple(
            TemplateVariable(
                name=cast(str, item["name"]),
                kind=cast(str, item.get("type", "string")),
                default=cast("str | None", item.get("default")),
                prompt=cast("str | None", item.get("prompt")),
                choices=tuple(cast(list[str], item.get("choices", []))),
                when=cast("str | None", item.get("when")),
            )
            for item in cast(list[dict[str, object]], raw.get("variables", []))
        ),
    )


def resolve_template_variables(
    manifest_yaml: str, supplied: dict[str, str]
) -> dict[str, object]:
    """Fill defaults and validate supplied values against the manifest."""
    return cast(
        dict[str, object],
        json.loads(
            _native.resolve_template_variables_json(
                manifest_yaml, json.dumps(supplied, separators=(",", ":"))
            )
        ),
    )


def render_template(snapshot: RecipeFiles, variables: dict[str, object]) -> RecipeFiles:
    """Render a template repository's `template/` payload into a Recipe."""
    return cast(
        RecipeFiles,
        json.loads(
            _native.render_template_json(
                json.dumps(snapshot, separators=(",", ":")),
                json.dumps(variables, separators=(",", ":")),
            )
        ),
    )


def ensure_identity(
    snapshot: RecipeFiles, slug: str, name: str | None = None
) -> RecipeFiles:
    """Make a rendered Recipe answer to `slug`, whatever the template did.

    A template that declares `slug` and names its manifest for it has already
    done this and the call changes nothing. One that does not — an ordinary
    Recipe repository someone chose as a starting point — is corrected, because
    the platform reads a Runtime group's identity off the manifest filename and
    a mismatch versions nothing on first push.
    """
    return cast(
        RecipeFiles,
        json.loads(
            _native.ensure_identity_json(
                json.dumps(snapshot, separators=(",", ":")), slug, name
            )
        ),
    )


@dataclass(frozen=True, slots=True)
class TemplateCaseResult:
    """One `tests/cases.yaml` case: what it rendered, and whether it checks."""

    name: str
    report: Report
    rendered: RecipeFiles

    @property
    def valid(self) -> bool:
        return self.report.valid


def check_template_cases(
    snapshot: RecipeFiles, cases: list[dict[str, object]]
) -> tuple[TemplateCaseResult, ...]:
    """Render each declared case and validate the Recipe it produces.

    This is the whole point of a template repository being separate from a
    Recipe: the template itself is never a valid Recipe, so what CI has to
    prove is that its *output* is — for every combination of variables anyone
    declared, not just the one a maintainer happened to try.
    """
    manifest_yaml = _manifest_source(snapshot)
    results: list[TemplateCaseResult] = []
    for index, case in enumerate(cases):
        name = cast(str, case.get("name", f"case {index + 1}"))
        supplied = {
            key: str(value)
            for key, value in cast(dict[str, object], case.get("variables", {})).items()
        }
        variables = resolve_template_variables(manifest_yaml, supplied)
        rendered = render_template(snapshot, variables)
        results.append(
            TemplateCaseResult(
                name=name, report=check_recipe_files(rendered), rendered=rendered
            )
        )
    return tuple(results)


def load_recipe_dir(location: str | os.PathLike[str]) -> RecipeFiles:
    """Read a local template repository or Recipe directory into a snapshot.

    Accepts a plain path (`./template-starter`, `/srv/x`, `C:\\templates\\x`) or a
    `file://` URL. It never fetches: a remote template is the caller's to clone,
    so the library holds no network surface and cannot be pointed at one by a
    value off a request.
    """
    root = Path(_local_path(location))
    if not root.is_dir():
        raise ValueError(f"{root} is not a directory")
    files: list[RecipeFile] = []
    directories: list[str] = []
    for parent, dirnames, filenames in os.walk(root):
        # Pruned in place rather than filtered afterwards, so a template with a
        # populated node_modules below a package is never walked at all.
        dirnames[:] = sorted(
            name
            for name in dirnames
            if name not in _IGNORED_DIRS and not Path(parent, name).is_symlink()
        )
        base = Path(parent)
        for name in dirnames:
            directories.append((base / name).relative_to(root).as_posix())
        for name in sorted(filenames):
            entry = base / name
            # A symlink is never followed. `is_file()` and `read_text()` both
            # resolve one, so a template carrying `secret -> /etc/passwd` would
            # otherwise read outside its own root and land that content in the
            # commit the caller writes. A template has no use for one.
            if name == ".git" or entry.is_symlink() or not entry.is_file():
                continue
            files.append(
                {
                    "path": entry.relative_to(root).as_posix(),
                    "content": _read_text(entry),
                }
            )
    files.sort(key=lambda entry: entry["path"])
    directories.sort()
    return {"files": files, "directories": directories}


"""Directories that are never a template's content, at any depth."""
_IGNORED_DIRS = frozenset({".git", "node_modules", "target", "__pycache__"})


def _local_path(location: str | os.PathLike[str]) -> Path:
    text = os.fspath(location)
    if text.replace("\\", "/").startswith("//"):
        raise ValueError("UNC and device paths are not local template locations")
    # A Windows drive letter parses as a URL scheme, so `C:\\x` would otherwise
    # be rejected as a remote location on the Windows wheel. Recognise a native
    # path before treating the string as a URL at all.
    if os.path.isabs(text) or _has_drive_letter(text):
        return Path(text)
    parsed = urlparse(text)
    if parsed.scheme in ("", "file"):
        if parsed.scheme == "file":
            if parsed.netloc not in ("", "localhost"):
                raise ValueError(
                    f"{text} names a remote host; only local templates are read"
                )
            decoded = unquote(parsed.path)
            if decoded.replace("\\", "/").startswith("//"):
                raise ValueError(
                    "UNC and device paths are not local template locations"
                )
            return Path(_normalize_file_url_path(decoded, windows=os.name == "nt"))
        return Path(text)
    raise ValueError(f"{text} is not a local path; only local templates are read")


def _normalize_file_url_path(path: str, *, windows: bool) -> str:
    if windows and path.startswith("/") and _has_drive_letter(path[1:]):
        return path[1:]
    return path


def _has_drive_letter(text: str) -> bool:
    return len(text) > 1 and text[0].isalpha() and text[1] == ":"


def _read_text(path: Path) -> str | None:
    """Binary files are reported as present but unread, matching `RecipeFile`."""
    try:
        return path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None


def _manifest_source(snapshot: RecipeFiles) -> str:
    for entry in snapshot["files"]:
        if entry["path"] == "template.yaml":
            content = entry.get("content")
            if content is None:
                raise ValueError("template.yaml was not read")
            return content
    raise ValueError("the template repository has no template.yaml")


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
