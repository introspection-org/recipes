from __future__ import annotations

import introspection_recipe_check


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


def _template() -> introspection_recipe_check.RecipeFiles:
    return {
        "files": [
            {
                "path": ".introspection/coding-agent.yaml",
                "content": "name: coding-agent\npath: .\ndescription: Customizable Pi coding agent\n",
            },
            {"path": "package.json", "content": '{"name": "coding-agent"}'},
            {"path": "SYSTEM.md", "content": "You are {{slug}}, talking to {{mcp_backend_url}}.\n"},
        ],
        "directories": [],
    }


def _paths(files: introspection_recipe_check.RecipeFiles) -> set[str]:
    return {entry["path"] for entry in files["files"]}


def _content(files: introspection_recipe_check.RecipeFiles, path: str) -> str | None:
    return next(entry["content"] for entry in files["files"] if entry["path"] == path)


def test_format_rewrites_identity_and_fills_declared_values() -> None:
    formatted = introspection_recipe_check.format_recipe_files(
        _template(),
        introspection_recipe_check.RecipeIdentity(
            slug="my-agent",
            name="My Agent",
            variables={"mcp_backend_url": "https://mcp.example.com"},
        ),
    )
    assert ".introspection/my-agent.yaml" in _paths(formatted)
    assert ".introspection/coding-agent.yaml" not in _paths(formatted)
    assert "name: My Agent" in (_content(formatted, ".introspection/my-agent.yaml") or "")
    assert _content(formatted, "package.json") == '{"name": "my-agent"}'
    assert _content(formatted, "SYSTEM.md") == "You are my-agent, talking to https://mcp.example.com.\n"


def test_format_leaves_an_undeclared_token_alone() -> None:
    formatted = introspection_recipe_check.format_recipe_files(
        _template(),
        introspection_recipe_check.RecipeIdentity(slug="my-agent"),
    )
    assert "{{mcp_backend_url}}" in (_content(formatted, "SYSTEM.md") or "")


def test_identity_reads_a_runtime_payload() -> None:
    identity = introspection_recipe_check.RecipeIdentity.from_runtime(
        {
            "id": "0199-runtime",
            "slug": "my-agent",
            "name": "My Agent",
            "description": "Reviews pull requests",
            "kind": "byor",
        }
    )
    assert (identity.slug, identity.name) == ("my-agent", "My Agent")
    formatted = introspection_recipe_check.format_recipe_files(_template(), identity)
    assert "description: Reviews pull requests" in (
        _content(formatted, ".introspection/my-agent.yaml") or ""
    )


def test_format_refuses_a_slug_the_platform_would_not_accept() -> None:
    import pytest

    with pytest.raises(ValueError):
        introspection_recipe_check.format_recipe_files(
            _template(), introspection_recipe_check.RecipeIdentity(slug="My Agent")
        )


def test_load_recipe_dir_reads_a_local_path(tmp_path) -> None:
    (tmp_path / ".introspection").mkdir()
    (tmp_path / ".introspection" / "coding-agent.yaml").write_text("name: coding-agent\npath: .\n")
    (tmp_path / "package.json").write_text('{"name": "coding-agent"}')
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "HEAD").write_text("ref: refs/heads/main")

    for location in (str(tmp_path), f"file://{tmp_path}"):
        snapshot = introspection_recipe_check.load_recipe_dir(location)
        assert ".introspection/coding-agent.yaml" in _paths(snapshot)
        assert not any(path.startswith(".git") for path in _paths(snapshot))


def test_load_recipe_dir_refuses_a_remote_location() -> None:
    import pytest

    with pytest.raises(ValueError):
        introspection_recipe_check.load_recipe_dir("https://github.com/introspection-recipes/template-starter")
