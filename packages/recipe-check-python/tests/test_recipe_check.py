from __future__ import annotations

import re
from pathlib import Path
from typing import cast

import introspection_recipe_check
import pytest
from introspection_recipe_check._api import _normalize_file_url_path


def test_accepts_portable_runtime_requirements() -> None:
    report = introspection_recipe_check.check_recipe_files(
        {
            "files": [
                {
                    "path": "package.json",
                    "content": (
                        '{"name":"demo","pi":{"agents":["agents/*.yaml"],'
                        '"runtime":{"python":{"version":">=3.14,<3.15",'
                        '"imports":["demo"]}}}}'
                    ),
                },
                {
                    "path": "agents/agent.yaml",
                    "content": "name: agent\nmodel:\n  name: test/model\n",
                },
                {"path": "pyproject.toml"},
                {"path": "uv.lock"},
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
                    "ai:\n"
                    "  model: openai/gpt-5\n"
                ),
            }
        ]
    )

    assert parsed[0].source_path == "judges/helpful.yaml"
    assert parsed[0].definition.to_dict() == {
        "name": "helpful",
        "on": {},
        "ai": {"model": "openai/gpt-5"},
        "instructions": "Grade the answer.",
    }

    legacy = introspection_recipe_check.parse_judge_definitions(
        [
            {
                "path": "judges/legacy.yaml",
                "content": (
                    "judge: legacy\n"
                    "instructions: Grade the answer.\n"
                    "ai:\n"
                    "  model: openai/gpt-5\n"
                ),
            }
        ]
    )
    assert legacy[0].definition.to_dict()["name"] == "legacy"


def test_judge_parser_reads_a_classifier_judge() -> None:
    parsed = introspection_recipe_check.parse_judge_definitions(
        [
            {
                "path": "judges/polite.yaml",
                "content": (
                    "name: polite\n"
                    "ai:\n"
                    "  model: acme/classifier-1\n"
                    "  fallbacks: [acme/classifier-2]\n"
                    "questions:\n"
                    "  polite:\n"
                    "    instructions: Is the reply polite?\n"
                    "    criteria:\n"
                    '      "true": Courteous throughout.\n'
                    '      "false": Rude or dismissive.\n'
                ),
            }
        ]
    )

    definition = parsed[0].definition.to_dict()
    assert definition["ai"] == {
        "model": "acme/classifier-1",
        "fallbacks": ["acme/classifier-2"],
    }
    assert definition["questions"] == {
        "polite": {
            "instructions": "Is the reply polite?",
            "criteria": {
                "true": "Courteous throughout.",
                "false": "Rude or dismissive.",
            },
            "threshold": 0.5,
        }
    }
    assert "instructions" not in definition


def test_judge_parser_maps_the_older_llm_block_to_ai() -> None:
    parsed = introspection_recipe_check.parse_judge_definitions(
        [
            {
                "path": "judges/legacy.yaml",
                "content": (
                    "name: legacy\n"
                    "instructions: Grade the answer.\n"
                    "llm:\n"
                    "  provider: anthropic\n"
                    "  model: claude-sonnet-5-5\n"
                    "  request:\n"
                    "    max_tokens: 512\n"
                    "    reasoning_effort: low\n"
                    "  transport:\n"
                    "    timeout_ms: 30000\n"
                ),
            },
            {
                "path": "judges/local.yaml",
                "content": (
                    "name: local\n"
                    "instructions: Grade the answer.\n"
                    "llm:\n"
                    "  model: gpt-5\n"
                    "  local:\n"
                    "    base_url: http://localhost:8080\n"
                    "    api_key_env: LOCAL_KEY\n"
                ),
            },
        ]
    )

    assert parsed[0].definition.to_dict() == {
        "name": "legacy",
        "on": {},
        "ai": {
            "model": "anthropic/claude-sonnet-5-5",
            "thinking_level": "low",
            "options": {"max_tokens": 512},
        },
        "instructions": "Grade the answer.",
    }
    assert parsed[0].warnings == ()
    assert parsed[1].definition.to_dict()["ai"] == {"model": "openai/gpt-5"}
    # A parsed definition carries only `ai`: the `llm:` block is gone.
    assert all("llm" not in judge.definition.to_dict() for judge in parsed)
    assert len(parsed[1].warnings) == 1
    assert "llm.local" in parsed[1].warnings[0]


def test_judge_parser_rejects_both_ai_and_llm() -> None:
    with pytest.raises(ValueError, match=re.escape("declares both `ai` and `llm`")):
        introspection_recipe_check.parse_judge_definitions(
            [
                {
                    "path": "judges/both.yaml",
                    "content": (
                        "name: both\n"
                        "instructions: Grade the answer.\n"
                        "ai:\n"
                        "  model: openai/gpt-5\n"
                        "llm:\n"
                        "  model: gpt-5\n"
                    ),
                }
            ]
        )


def test_judge_parser_rejects_a_gate_regex_javascript_cannot_compile() -> None:
    with pytest.raises(ValueError, match=re.escape("JavaScript regex")):
        introspection_recipe_check.parse_judge_definitions(
            [
                {
                    "path": "judges/gate.yaml",
                    "content": (
                        "name: gate\n"
                        "instructions: Grade the answer.\n"
                        "on:\n"
                        "  - event: message\n"
                        "    match:\n"
                        "      text: '/(?P<word>a)/'\n"
                        "ai:\n"
                        "  model: openai/gpt-5\n"
                    ),
                }
            ]
        )


def test_judge_parser_accepts_a_gate_regex_only_one_javascript_flag_compiles() -> None:
    # The first compiles under the u flag only, the second under the v flag only.
    for pattern in (r"/[\w-]+@acme/", r"/[\w--\d]+/"):
        introspection_recipe_check.parse_judge_definitions(
            [
                {
                    "path": "judges/gate.yaml",
                    "content": (
                        "name: gate\n"
                        "instructions: Grade the answer.\n"
                        "on:\n"
                        "  - event: message\n"
                        "    match:\n"
                        f"      text: '{pattern}'\n"
                        "ai:\n"
                        "  model: openai/gpt-5\n"
                    ),
                }
            ]
        )


def test_judge_schema_describes_ai_and_both_judge_kinds() -> None:
    schema = introspection_recipe_check.judge_definition_schema()
    properties = cast(dict[str, dict[str, object]], schema["properties"])

    # `llm:` is still authored, so the schema describes it, as a deprecated
    # block of its own rather than a field of the parsed definition.
    assert properties["llm"]["deprecated"] is True
    assert properties["llm"]["$ref"] == "#/$defs/LlmBlock"
    assert {"ai", "instructions", "questions"} <= properties.keys()
    assert schema["oneOf"] == [
        {"required": ["instructions"]},
        {"required": ["questions"]},
    ]


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


@pytest.mark.parametrize(
    "location",
    [
        r"\\server\share\repo",
        "//server/share/repo",
        r"\\?\C:\repo",
        r"\\.\C:\repo",
        "file:////server/share/repo",
        "file:///%2Fserver/share/repo",
        "file://server/share/repo",
    ],
)
def test_rejects_network_and_device_locations(location: str) -> None:
    with pytest.raises(ValueError, match="UNC|remote host"):
        introspection_recipe_check.load_recipe_dir(location)


def test_excludes_worktree_git_files_at_every_depth(tmp_path: Path) -> None:
    (tmp_path / ".git").write_text("gitdir: /elsewhere")
    nested = tmp_path / "packages" / "app"
    nested.mkdir(parents=True)
    (nested / ".git").write_text("gitdir: /elsewhere/submodule")
    (nested / "keep.txt").write_text("content")
    snapshot = introspection_recipe_check.load_recipe_dir(tmp_path)
    assert _paths(snapshot) == {"packages/app/keep.txt"}


def test_render_rejects_unsafe_and_colliding_paths() -> None:
    for paths in [("../outside",), ("a.tmpl", "a/child"), ("a", "a.tmpl")]:
        snapshot: introspection_recipe_check.RecipeFiles = {
            "files": [{"path": f"template/{path}", "content": "x"} for path in paths],
            "directories": [],
        }
        with pytest.raises(ValueError):
            introspection_recipe_check.render_template(snapshot, {})


@pytest.mark.parametrize(
    "path,windows,expected",
    [
        ("/C:/templates/x", True, "C:/templates/x"),
        ("/c:/templates/my repo", True, "c:/templates/my repo"),
        ("/C:/templates/x", False, "/C:/templates/x"),
        ("/tmp/templates", False, "/tmp/templates"),
        ("/tmp/templates", True, "/tmp/templates"),
    ],
)
def test_file_url_path_normalization(path: str, windows: bool, expected: str) -> None:
    assert _normalize_file_url_path(path, windows=windows) == expected


def test_local_file_url_with_spaces(tmp_path: Path) -> None:
    root = tmp_path / "my templates"
    root.mkdir()
    (root / "keep.txt").write_text("content")
    assert _paths(introspection_recipe_check.load_recipe_dir(root.as_uri())) == {
        "keep.txt"
    }


def test_a_committed_evaluation_binding_is_accepted() -> None:
    def report(binding: str) -> introspection_recipe_check.Report:
        return introspection_recipe_check.check_recipe_files(
            {
                "files": [
                    {
                        "path": "package.json",
                        "content": (
                            '{"name":"demo","pi":{"agents":["agents/*.yaml"],'
                            '"mcp":{"servers":[{"id":"attio"}]}}}'
                        ),
                    },
                    {
                        "path": "agents/agent.yaml",
                        "content": "name: agent\nmodel:\n  name: test/model\n",
                    },
                    {"path": ".pi/mcp.local.json", "content": binding},
                ]
            }
        )

    fake = (
        '{"servers":[{"id":"attio","transport":"streamable_http",'
        '"url":"http://localhost:4318/attio/mcp"}]}'
    )
    assert report(fake).valid

    compose = '{"servers":[{"id":"attio","url":"http://fakes:7353/attio/mcp"}]}'
    assert report(compose).valid

    live = '{"servers":[{"id":"attio","url":"https://mcp.attio.com/mcp"}]}'
    codes = [diagnostic.code for diagnostic in report(live).diagnostics]
    assert codes == ["package.local_config_present"]


def test_a_committed_api_binding_is_accepted_only_for_evaluation() -> None:
    def report(binding: str) -> introspection_recipe_check.Report:
        return introspection_recipe_check.check_recipe_files(
            {
                "files": [
                    {
                        "path": "package.json",
                        "content": '{"name":"demo","pi":{"agents":["agents/*.yaml"]}}',
                    },
                    {
                        "path": "agents/agent.yaml",
                        "content": "name: agent\nmodel:\n  name: test/model\n",
                    },
                    {"path": ".pi/api.local.json", "content": binding},
                ]
            }
        )

    fake = '{"apis":[{"host":"api.example.com","url":"http://fakes:7353/example"}]}'
    assert report(fake).valid

    live = '{"apis":[{"host":"api.example.com","url":"https://staging.example.com"}]}'
    codes = [diagnostic.code for diagnostic in report(live).diagnostics]
    assert codes == ["package.local_config_present"]


MISSION_JUDGE = (
    "name: booking\n"
    "type: mission\n"
    "attributes: [city]\n"
    "questions:\n"
    "  requested:\n"
    "    instructions: Is this what the traveller asked for?\n"
    "    criteria:\n"
    '      "true": The same trip.\n'
    '      "false": Anything else.\n'
)


def test_mission_judges_are_parsed_apart_from_online_ones() -> None:
    sources: list[introspection_recipe_check.JudgeSource] = [
        {
            "path": "judges/helpful.yaml",
            "content": "name: helpful\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n",
        },
        {"path": "judges/booking.yaml", "content": MISSION_JUDGE},
    ]

    online = introspection_recipe_check.parse_judge_definitions(sources)
    mission = introspection_recipe_check.parse_mission_judge_definitions(sources)

    assert [item.definition.to_dict()["name"] for item in online] == ["helpful"]
    booking = mission[0].definition.to_dict()
    assert booking["type"] == "mission"
    assert booking["questions"] == {
        "requested": {
            "instructions": "Is this what the traveller asked for?",
            "criteria": {"true": "The same trip.", "false": "Anything else."},
        }
    }


def test_lists_suggestions() -> None:
    snapshot: introspection_recipe_check.RecipeFiles = {
        "files": [
            {
                "path": "package.json",
                "content": '{"name":"s","version":"0.1.0","pi":{"agents":["agents/*.yaml"],"prompts":["./prompts/*.md"]}}',
            },
            {"path": "agents/main.yaml", "content": "name: main\n"},
            {
                "path": "prompts/redline.md",
                "content": '---\nsuggest: true\ndescription: Redline a contract\nargument-hint: "[contract]"\n---\nRedline it for {{member.name}}.',
            },
            {
                "path": "prompts/plain.md",
                "content": "---\ndescription: Not offered\n---\nNo.",
            },
        ]
    }
    assert introspection_recipe_check.list_recipe_suggestions(snapshot) == (
        introspection_recipe_check.Suggestion(
            name="redline",
            description="Redline a contract",
            text="Redline it for {{member.name}}.",
            placeholders=("member.name",),
            argument_hint="[contract]",
        ),
    )


def test_lists_suggestions_for_an_agent() -> None:
    snapshot: introspection_recipe_check.RecipeFiles = {
        "files": [
            {
                "path": "package.json",
                "content": '{"name":"s","version":"0.1.0","pi":{"agents":["agents/*.yaml"],"prompts":["./prompts/*.md"]}}',
            },
            {"path": "agents/agent.yaml", "content": "name: agent\n"},
            {"path": "agents/reviewer.yaml", "content": "name: reviewer\n"},
            {"path": "prompts/all.md", "content": "---\nsuggest: true\n---\nAll."},
            {
                "path": "prompts/review.md",
                "content": "---\nsuggest: [reviewer]\n---\nReview.",
            },
        ]
    }
    listed = introspection_recipe_check.list_recipe_suggestions(snapshot)
    assert [(s.name, s.agents) for s in listed] == [
        ("all", None),
        ("review", ("reviewer",)),
    ]
    assert [
        s.name
        for s in introspection_recipe_check.list_recipe_suggestions(
            snapshot, agent="agent"
        )
    ] == ["all"]
    assert [
        s.name
        for s in introspection_recipe_check.list_recipe_suggestions(
            snapshot, agent="reviewer"
        )
    ] == ["all", "review"]
