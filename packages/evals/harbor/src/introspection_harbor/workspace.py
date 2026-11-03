"""Stage a Recipe workspace from the host for upload into a foreign trial image.

Copies the working tree as it is, uncommitted changes included, and leaves
behind what must never enter a trial: VCS internals, dependency trees, eval
output, generated Pi state and anything that looks like a credential.
"""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Iterable
from pathlib import Path, PurePosixPath

EXCLUDED_DIRECTORY_NAMES = {
    ".git",
    ".hg",
    ".svn",
    ".aws",
    ".ssh",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
}
EXCLUDED_EVAL_DIRECTORIES = {".evalite", "eval-runs", "eval-artifacts"}
EXCLUDED_GENERATED_PI_DIRECTORIES = {Path(".pi/bin"), Path(".pi/mcp-catalogs")}
EXCLUDED_GENERATED_PI_FILES = {Path(".pi/mcp-session.json"), Path(".pi/mcporter.json")}
EXCLUDED_SECRET_FILES = {
    ".npmrc",
    ".pypirc",
    "credentials.json",
    "service-account.json",
    "service_account.json",
}
SECRET_SUFFIXES = {".key", ".pem", ".p12", ".pfx"}
SAFE_ENV_SUFFIXES = {".example", ".sample", ".template"}
DEFAULT_EVAL_LIB = "evals/lib"


def recipe_eval_lib(recipe: Path) -> Path:
    """The Recipe's shared eval code: ``pi.evals.lib``, else ``evals/lib``.

    It holds graders and judge code, which an agent must never read. A
    deployed version leaves it out through ``.recipeignore``; this upload
    doesn't read that file, so it skips this path instead.
    """

    try:
        manifest = json.loads((recipe / "package.json").read_text(encoding="utf-8"))
        declared = manifest["pi"]["evals"]["lib"]
    except (OSError, ValueError, KeyError, TypeError):
        declared = DEFAULT_EVAL_LIB
    if not isinstance(declared, str) or not declared:
        declared = DEFAULT_EVAL_LIB
    path = PurePosixPath(declared)
    if path.is_absolute() or ".." in path.parts:
        path = PurePosixPath(DEFAULT_EVAL_LIB)
    return Path(*path.parts)


def materialize_workspace(
    source: Path, destination: Path, excluded_paths: Iterable[Path] = ()
) -> None:
    """Copy the uploadable part of ``source`` into a fresh ``destination``.

    ``excluded_paths`` are ``source``-relative directories or files left out
    as well, such as a Recipe's ``evals/lib``.
    """

    excluded = tuple(excluded_paths)
    destination.mkdir()
    for relative in sorted(
        workspace_paths(source, excluded), key=lambda path: path.as_posix()
    ):
        if excluded_workspace_path(relative) or under_any(relative, excluded):
            continue
        source_path = source / relative
        if not source_path.exists() and not source_path.is_symlink():
            continue
        target_path = destination / relative
        target_path.parent.mkdir(parents=True, exist_ok=True)
        if source_path.is_symlink():
            target_path.symlink_to(
                os.readlink(source_path), target_is_directory=source_path.is_dir()
            )
        elif source_path.is_file():
            shutil.copy2(source_path, target_path)


def under_any(path: Path, roots: Iterable[Path]) -> bool:
    return any(path == root or root in path.parents for root in roots)


def workspace_paths(source: Path, excluded_paths: Iterable[Path] = ()) -> list[Path]:
    excluded = tuple(excluded_paths)
    paths: list[Path] = []
    for current, directories, files in os.walk(source, followlinks=False):
        current_path = Path(current)
        kept_directories: list[str] = []
        for name in directories:
            relative = (current_path / name).relative_to(source)
            if excluded_workspace_path(relative) or under_any(relative, excluded):
                continue
            if (current_path / name).is_symlink():
                paths.append(relative)
            else:
                kept_directories.append(name)
        directories[:] = kept_directories
        paths.extend((current_path / name).relative_to(source) for name in files)
    return paths


def excluded_workspace_path(path: Path) -> bool:
    if path.is_absolute() or ".." in path.parts:
        return True
    if any(part in EXCLUDED_DIRECTORY_NAMES for part in path.parts):
        return True
    if any(part in EXCLUDED_EVAL_DIRECTORIES for part in path.parts):
        return True
    if path in EXCLUDED_GENERATED_PI_FILES:
        return True
    if any(
        path == directory or directory in path.parents
        for directory in EXCLUDED_GENERATED_PI_DIRECTORIES
    ):
        return True
    name = path.name
    if name == ".DS_Store" or name in EXCLUDED_SECRET_FILES:
        return True
    if name == ".env":
        return True
    if name.startswith(".env.") and Path(name).suffix not in SAFE_ENV_SUFFIXES:
        return True
    return path.suffix.lower() in SECRET_SUFFIXES
