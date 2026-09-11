from __future__ import annotations

from pathlib import Path

import introspection_recipe_check
import pytest


def test_accepts_portable_runtime_requirements() -> None:
    report = introspection_recipe_check.check_recipe_files(
        {
            "files": [
                {
                    "path": "package.json",
                    "content": (
                        '{"name":"demo","pi":{"agents":["agents/*.yaml"],'
                        '"runtime":{"python":{"project":"python",'
                        '"lockfile":"python/uv.lock","version":">=3.14,<3.15",'
                        '"imports":["demo"]}}}}'
                    ),
                },
                {
                    "path": "agents/agent.yaml",
                    "content": "name: agent\nmodel:\n  name: test/model\n",
                },
                {"path": "python/pyproject.toml"},
                {"path": "python/uv.lock"},
            ]
        }
    )

    assert report.valid
    assert report.diagnostics == ()


def test_invalid_recipe_returns_typed_diagnostics() -> None:
    report = introspection_recipe_check.check_recipe_files({"files": []})

    assert not report.valid
    assert report.diagnostics[0].code == "package.manifest_missing"
    assert report.to_dict()["valid"] is False


def test_judge_parser_preserves_cloud_compatibility_surface() -> None:
    parsed = introspection_recipe_check.parse_judge_definitions(
        [
            {
                "path": "judges/helpful.yaml",
                "content": (
                    "name: helpful\n"
                    "instructions: Grade the answer.\n"
                    "llm:\n"
                    "  model: gpt-5\n"
                ),
            }
        ]
    )

    assert parsed[0].source_path == "judges/helpful.yaml"
    assert parsed[0].definition.to_dict()["name"] == "helpful"

    legacy = introspection_recipe_check.parse_judge_definitions(
        [
            {
                "path": "judges/legacy.yaml",
                "content": (
                    "judge: legacy\n"
                    "instructions: Grade the answer.\n"
                    "llm:\n"
                    "  model: gpt-5\n"
                ),
            }
        ]
    )
    assert legacy[0].definition.to_dict()["name"] == "legacy"


TEMPLATE_MANIFEST = """
version: 1
name: Coding agent
variables:
  - name: slug
    type: string
  - name: name
    type: string
    default: "{{ slug }}"
"""


def _template_repo() -> introspection_recipe_check.RecipeFiles:
    return {
        "files": [
            {"path": "template.yaml", "content": TEMPLATE_MANIFEST},
            {
                "path": "template/.introspection/{{ slug }}.yaml.tmpl",
                "content": "name: {{ name }}\npath: .\n",
            },
            {
                "path": "template/package.json.tmpl",
                "content": '{"name":"{{ slug }}","pi":{"agents":["agents/*.yaml"]}}',
            },
            {
                "path": "template/agents/agent.yaml",
                "content": "name: agent\nmodel:\n  name: test/model\n",
            },
            {
                "path": "template/SYSTEM.md",
                "content": "Answer with {{ user_input }}.\n",
            },
            {"path": "README.md", "content": "# the template repository\n"},
        ],
        "directories": [],
    }


def _paths(files: introspection_recipe_check.RecipeFiles) -> set[str]:
    return {entry["path"] for entry in files["files"]}


def _content(files: introspection_recipe_check.RecipeFiles, path: str) -> str | None:
    return next(entry["content"] for entry in files["files"] if entry["path"] == path)


def test_parse_template_manifest_keeps_declaration_order() -> None:
    manifest = introspection_recipe_check.parse_template_manifest(TEMPLATE_MANIFEST)
    assert [variable.name for variable in manifest.variables] == ["slug", "name"]
    assert manifest.version == 1


def test_render_template_renders_paths_and_drops_the_suffix() -> None:
    variables = introspection_recipe_check.resolve_template_variables(
        TEMPLATE_MANIFEST, {"slug": "my-agent"}
    )
    rendered = introspection_recipe_check.render_template(_template_repo(), variables)
    assert ".introspection/my-agent.yaml" in _paths(rendered)
    assert "package.json" in _paths(rendered)
    # the template repository's own files never reach the Recipe
    assert "README.md" not in _paths(rendered)
    assert "template.yaml" not in _paths(rendered)


def test_a_file_without_the_suffix_keeps_its_braces() -> None:
    variables = introspection_recipe_check.resolve_template_variables(
        TEMPLATE_MANIFEST, {"slug": "my-agent"}
    )
    rendered = introspection_recipe_check.render_template(_template_repo(), variables)
    assert _content(rendered, "SYSTEM.md") == "Answer with {{ user_input }}.\n"


def test_check_template_cases_validates_the_rendered_recipe() -> None:
    results = introspection_recipe_check.check_template_cases(
        _template_repo(),
        [{"name": "defaults", "variables": {"slug": "my-agent"}}],
    )
    assert len(results) == 1
    assert results[0].name == "defaults"
    assert results[0].valid, results[0].report.diagnostics
    assert ".introspection/my-agent.yaml" in _paths(results[0].rendered)


def test_an_undeclared_variable_is_refused() -> None:
    with pytest.raises(ValueError):
        introspection_recipe_check.resolve_template_variables(
            TEMPLATE_MANIFEST, {"slug": "my-agent", "mdoel": "x"}
        )


def test_load_recipe_dir_reads_a_local_path(tmp_path: Path) -> None:
    (tmp_path / "template").mkdir()
    (tmp_path / "template.yaml").write_text(TEMPLATE_MANIFEST)
    (tmp_path / "template" / "package.json.tmpl").write_text('{"name":"{{ slug }}"}')
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "HEAD").write_text("ref: refs/heads/main")

    for location in (str(tmp_path), f"file://{tmp_path}"):
        snapshot = introspection_recipe_check.load_recipe_dir(location)
        assert "template.yaml" in _paths(snapshot)
        assert not any(path.startswith(".git") for path in _paths(snapshot))


def test_load_recipe_dir_refuses_a_remote_location() -> None:
    with pytest.raises(ValueError):
        introspection_recipe_check.load_recipe_dir(
            "https://github.com/introspection-recipes/template-starter"
        )


def test_an_ordinary_recipe_repo_works_as_a_template() -> None:
    """No template.yaml, no template/, not one .tmpl file.

    This is the "start from this repo" path: nothing renders, but the caller
    still gets a Recipe named for the Runtime they asked for, because identity
    is owed whether the template declared it or not.
    """
    plain: introspection_recipe_check.RecipeFiles = {
        "files": [
            {
                "path": ".introspection/coding-agent.yaml",
                "content": "# a comment\nname: coding-agent\npath: .\n",
            },
            {
                "path": "package.json",
                "content": '{"name":"coding-agent","pi":{"agents":["agents/*.yaml"]}}',
            },
            {
                "path": "agents/agent.yaml",
                "content": "name: agent\nmodel:\n  name: test/model\n",
            },
            {"path": "SYSTEM.md", "content": "Use {{ braces }} freely.\n"},
        ],
        "directories": [],
    }

    rendered = introspection_recipe_check.render_template(plain, {})
    final = introspection_recipe_check.ensure_identity(rendered, "my-agent")

    assert ".introspection/my-agent.yaml" in _paths(final)
    assert ".introspection/coding-agent.yaml" not in _paths(final)
    manifest = _content(final, ".introspection/my-agent.yaml") or ""
    assert "name: my-agent" in manifest
    assert manifest.startswith("# a comment\n")
    assert '"my-agent"' in (_content(final, "package.json") or "")
    # a prompt's braces are never touched, because nothing opted it in
    assert _content(final, "SYSTEM.md") == "Use {{ braces }} freely.\n"
    assert introspection_recipe_check.check_recipe_files(final).valid


def test_identity_is_a_no_op_on_a_template_that_named_itself() -> None:
    already: introspection_recipe_check.RecipeFiles = {
        "files": [
            {
                "path": ".introspection/my-agent.yaml",
                "content": "name: my-agent\npath: .\n",
            },
            {"path": "package.json", "content": '{"name":"my-agent"}'},
        ],
        "directories": [],
    }
    assert introspection_recipe_check.ensure_identity(already, "my-agent") == already
