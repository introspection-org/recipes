//! Prompt templates marked `suggest` are a Recipe's suggestions: hosts show
//! them in a first-run picker or as chips, for every agent (`true`) or the
//! agents a `suggest` list names. Both read the template's
//! `description`, and a host fills a fixed set of `{{name}}` placeholders, so
//! warn when either would show up wrong.

use std::collections::BTreeSet;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use super::CheckContext;

/// The placeholders a host fills. Keep in step with `SUGGESTION_PLACEHOLDERS`
/// in `src/recipe/suggestions.ts`.
pub const SUGGESTION_PLACEHOLDERS: [&str; 4] = ["member.name", "member.email", "org.name", "today"];

/// Template files selected by resolved `pi.prompts` paths: a directory
/// contributes its direct `.md` children, as Pi loads them.
fn template_files(paths: &[String], ctx: &CheckContext) -> Vec<String> {
    let mut files = Vec::new();
    for path in paths {
        if ctx.has_dir(path) {
            files.extend(
                ctx.child_files(path)
                    .into_iter()
                    .filter(|file| file.ends_with(".md"))
                    .map(str::to_owned),
            );
        } else if path.ends_with(".md") {
            files.push(path.clone());
        }
    }
    files
}

/// Frontmatter YAML read as YAML 1.2, as Pi's `yaml` package reads it: only
/// `true` and `false` are booleans, so `suggest: yes` is not a mark.
fn parse_yaml(yaml: &str) -> Result<JsonValue, serde_saphyr::Error> {
    serde_saphyr::from_str_with_options(yaml, serde_saphyr::options! { strict_booleans: true })
}

/// The longest suggestion description, in words, that reads well as a chip.
const MAX_DESCRIPTION_WORDS: usize = 10;

/// The template's parsed frontmatter, or an empty object when it has none.
fn frontmatter(content: &str) -> JsonValue {
    let normalized = content.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    normalized
        .strip_prefix("---")
        .and_then(|rest| rest.find("\n---").map(|end| rest[..end].to_owned()))
        .and_then(|yaml| parse_yaml(&yaml).ok())
        .filter(JsonValue::is_object)
        .unwrap_or_else(|| JsonValue::Object(Default::default()))
}

/// One suggestion: a prompt template marked `suggest`, read the way
/// `listRecipeSuggestions` in `src/recipe/suggestions.ts` reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Suggestion {
    /// The command name: the file name without `.md`. Invoked as `/name`.
    pub name: String,
    /// The frontmatter `description`, or Pi's fallback (the body's first
    /// non-empty line, cut at 60 characters) when it has none.
    pub description: String,
    /// Frontmatter `argument-hint`, such as `<file>` or `[focus]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
    /// The template body, with Pi arguments and placeholders unexpanded.
    pub text: String,
    /// The `{{name}}` placeholders the body uses, in order, without duplicates.
    pub placeholders: Vec<String>,
    /// The agents that offer it, from `suggest`; `None` when every agent does.
    pub agents: Option<Vec<String>>,
}

impl Suggestion {
    /// Whether the agent named `agent` offers this suggestion.
    pub fn offered_to(&self, agent: &str) -> bool {
        self.agents
            .as_ref()
            .is_none_or(|agents| agents.iter().any(|name| name == agent))
    }
}

/// What a `suggest` value marks: every agent for `true`, the names for a
/// non-empty list of non-empty strings, and nothing otherwise.
enum Mark {
    None,
    Every,
    Agents(Vec<String>),
    Invalid,
}

fn mark(value: Option<&JsonValue>) -> Mark {
    match value {
        None | Some(JsonValue::Bool(false)) => Mark::None,
        Some(JsonValue::Bool(true)) => Mark::Every,
        Some(JsonValue::Array(items)) if !items.is_empty() => items
            .iter()
            .map(|item| {
                item.as_str()
                    .filter(|name| !name.is_empty())
                    .map(str::to_owned)
            })
            .collect::<Option<Vec<_>>>()
            .map_or(Mark::Invalid, Mark::Agents),
        Some(_) => Mark::Invalid,
    }
}

/// Split frontmatter from the body as Pi's `parseFrontmatter` does. `None`
/// when the frontmatter is not valid YAML: Pi skips such a template.
fn split_template(content: &str) -> Option<(JsonValue, String)> {
    let normalized = content
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let end = normalized
        .strip_prefix("---")
        .and_then(|rest| rest.find("\n---"))
        .map(|index| index + 3);
    let Some(end) = end else {
        return Some((JsonValue::Object(Default::default()), normalized));
    };
    let yaml = normalized.get(4..end).unwrap_or_default();
    let parsed = if yaml.trim().is_empty() {
        JsonValue::Null
    } else {
        parse_yaml(yaml).ok()?
    };
    let frontmatter = if parsed.is_object() {
        parsed
    } else {
        JsonValue::Object(Default::default())
    };
    Some((frontmatter, normalized[end + 4..].trim().to_owned()))
}

/// The suggestions among the templates that resolved `pi.prompts` paths
/// select, in file order. As in Pi, the first template with a name wins,
/// marked or not, so an unmarked template hides a later marked one.
pub(crate) fn read_suggestions(paths: &[String], ctx: &CheckContext) -> Vec<Suggestion> {
    let placeholder = Regex::new(r"\{\{([A-Za-z][\w.-]*)\}\}").expect("placeholder pattern");
    let mut seen = std::collections::HashSet::new();
    let mut suggestions = Vec::new();
    for file in template_files(paths, ctx) {
        let Some((frontmatter, body)) = ctx.content(&file).and_then(split_template) else {
            continue;
        };
        let name = file
            .rsplit('/')
            .next()
            .unwrap_or(&file)
            .trim_end_matches(".md")
            .to_owned();
        if !seen.insert(name.clone()) {
            continue;
        }
        let agents = match mark(frontmatter.get("suggest")) {
            Mark::Every => None,
            Mark::Agents(agents) => Some(agents),
            Mark::None | Mark::Invalid => continue,
        };
        let mut description = frontmatter
            .get("description")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_owned();
        if description.is_empty() {
            let first = body
                .lines()
                .find(|line| !line.trim().is_empty())
                .unwrap_or_default();
            description = if first.chars().count() > 60 {
                format!("{}...", first.chars().take(60).collect::<String>())
            } else {
                first.to_owned()
            };
        }
        let argument_hint = frontmatter
            .get("argument-hint")
            .and_then(JsonValue::as_str)
            .filter(|hint| !hint.is_empty())
            .map(str::to_owned);
        let mut placeholders: Vec<String> = Vec::new();
        for captures in placeholder.captures_iter(&body) {
            let found = &captures[1];
            if !placeholders.iter().any(|seen| seen == found) {
                placeholders.push(found.to_owned());
            }
        }
        suggestions.push(Suggestion {
            name,
            description,
            argument_hint,
            text: body,
            placeholders,
            agents,
        });
    }
    suggestions
}

/// Templates marked `suggest` are suggestions. Check what hosts show for
/// those, that `suggest` is `true` or a list of agent names wherever it
/// appears, and
/// that each name is one of `agents`, the Recipe's declared agent names.
pub(crate) fn validate_prompt_templates(
    paths: &[String],
    agents: &BTreeSet<String>,
    ctx: &mut CheckContext,
) {
    let placeholder = Regex::new(r"\{\{([A-Za-z][\w.-]*)\}\}").expect("placeholder pattern");
    for file in template_files(paths, ctx) {
        let Some(content) = ctx.content(&file).map(str::to_owned) else {
            continue;
        };
        let frontmatter = frontmatter(&content);
        match mark(frontmatter.get("suggest")) {
            Mark::None => continue,
            Mark::Every => {}
            Mark::Agents(names) => {
                for name in names.iter().filter(|name| !agents.contains(*name)) {
                    ctx.warning(
                        "prompts.suggest_agent_unknown",
                        file.clone(),
                        format!(
                            "Prompt template '{file}' is suggested for agent '{name}', which the Recipe does not declare"
                        ),
                        Some("list agents from agents/ by name, or set `suggest: true` to offer it from every agent"),
                    );
                }
            }
            Mark::Invalid => {
                ctx.warning(
                    "prompts.suggest_invalid",
                    file.clone(),
                    format!(
                        "Prompt template '{file}' has a `suggest` value that is not `true` or a list of agent names"
                    ),
                    Some("set `suggest: true` for every agent, or list the agents that offer it, such as `suggest: [cli]`; remove it otherwise"),
                );
                continue;
            }
        }
        let description = frontmatter
            .get("description")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if description.is_empty() {
            ctx.warning(
                "prompts.description_missing",
                file.clone(),
                format!("Suggested prompt template '{file}' has no description"),
                Some("add a `description` to the frontmatter; hosts show it when suggesting the template"),
            );
        } else if description.split_whitespace().count() > MAX_DESCRIPTION_WORDS {
            ctx.warning(
                "prompts.description_long",
                file.clone(),
                format!(
                    "Suggested prompt template '{file}' has a description over {MAX_DESCRIPTION_WORDS} words"
                ),
                Some("shorten the description; hosts show it as a one-line suggestion"),
            );
        }
        let mut reported = Vec::new();
        for captures in placeholder.captures_iter(&content) {
            let name = &captures[1];
            if SUGGESTION_PLACEHOLDERS.contains(&name) || reported.iter().any(|seen| seen == name) {
                continue;
            }
            reported.push(name.to_owned());
            ctx.warning(
                "prompts.placeholder_unknown",
                file.clone(),
                format!(
                    "Suggested prompt template '{file}' uses unknown placeholder '{{{{{name}}}}}'"
                ),
                Some(format!(
                    "hosts fill only {}; other placeholders are sent as written",
                    SUGGESTION_PLACEHOLDERS
                        .iter()
                        .map(|name| format!("{{{{{name}}}}}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                )),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{check_recipe_files, RecipeFile, RecipeFiles};

    fn check(files: &[(&str, &str)]) -> crate::Report {
        check_recipe_files(&RecipeFiles {
            files: files
                .iter()
                .map(|(path, content)| RecipeFile::new(*path, *content))
                .collect(),
            directories: Vec::new(),
        })
    }

    const PACKAGE: &str = r#"{"name":"suggest","version":"0.1.0","pi":{"agents":["agents/*.yaml"],"prompts":["./prompts/*.md"]}}"#;
    const AGENT: &str = "name: agent\nmodel:\n  name: test/provider-model\n";

    fn codes(report: &crate::Report, code: &str) -> Vec<String> {
        report
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == code)
            .map(|diagnostic| diagnostic.path.clone())
            .collect()
    }

    #[test]
    fn warns_on_a_suggested_template_without_a_description() {
        let report = check(&[
            ("package.json", PACKAGE),
            ("agents/agent.yaml", AGENT),
            (
                "prompts/good.md",
                "---\nsuggest: true\ndescription: Review a draft\n---\nReview it.",
            ),
            ("prompts/bare.md", "---\nsuggest: true\n---\nReview it."),
            (
                "prompts/empty.md",
                "---\nsuggest: true\ndescription: \"  \"\n---\nReview it.",
            ),
            ("prompts/unmarked.md", "Review it."),
            ("prompts/off.md", "---\nsuggest: false\n---\nReview it."),
        ]);
        assert!(report.valid, "{:?}", report.diagnostics);
        assert_eq!(
            codes(&report, "prompts.description_missing"),
            vec!["prompts/bare.md", "prompts/empty.md"]
        );
    }

    #[test]
    fn warns_on_a_long_suggested_description() {
        let report = check(&[
            ("package.json", PACKAGE),
            ("agents/agent.yaml", AGENT),
            (
                "prompts/ten.md",
                "---\nsuggest: true\ndescription: one two three four five six seven eight nine ten\n---\nGo.",
            ),
            (
                "prompts/eleven.md",
                "---\nsuggest: true\ndescription: one two three four five six seven eight nine ten eleven\n---\nGo.",
            ),
            (
                "prompts/unmarked.md",
                "---\ndescription: one two three four five six seven eight nine ten eleven\n---\nGo.",
            ),
        ]);
        assert!(report.valid, "{:?}", report.diagnostics);
        assert_eq!(
            codes(&report, "prompts.description_long"),
            vec!["prompts/eleven.md"]
        );
    }

    #[test]
    fn warns_when_suggest_is_not_true_or_agent_names() {
        let report = check(&[
            ("package.json", PACKAGE),
            ("agents/agent.yaml", AGENT),
            (
                "prompts/one.md",
                "---\nsuggest: 1\ndescription: Go\n---\nGo.",
            ),
            (
                "prompts/empty.md",
                "---\nsuggest: []\ndescription: Go\n---\nGo.",
            ),
            (
                "prompts/mixed.md",
                "---\nsuggest: [agent, 1]\ndescription: Go\n---\nGo.",
            ),
            (
                "prompts/blank.md",
                "---\nsuggest: [agent, \"\"]\ndescription: Go\n---\nGo.",
            ),
            // A plain string is not a list, even an agent's name.
            (
                "prompts/name.md",
                "---\nsuggest: agent\ndescription: Go\n---\nGo.",
            ),
            // YAML 1.1 booleans are strings to Pi, which reads YAML 1.2.
            (
                "prompts/on.md",
                "---\nsuggest: on\ndescription: Go\n---\nGo.",
            ),
            (
                "prompts/quoted.md",
                "---\nsuggest: \"true\"\ndescription: Go\n---\nGo.",
            ),
            (
                "prompts/good.md",
                "---\nsuggest: true\ndescription: Go\n---\nGo.",
            ),
            (
                "prompts/named.md",
                "---\nsuggest: [agent]\ndescription: Go\n---\nGo.",
            ),
        ]);
        assert!(report.valid, "{:?}", report.diagnostics);
        assert_eq!(
            codes(&report, "prompts.suggest_invalid"),
            vec![
                "prompts/blank.md",
                "prompts/empty.md",
                "prompts/mixed.md",
                "prompts/name.md",
                "prompts/on.md",
                "prompts/one.md",
                "prompts/quoted.md"
            ]
        );
        assert!(codes(&report, "prompts.suggest_agent_unknown").is_empty());
    }

    #[test]
    fn warns_when_suggest_names_an_agent_the_recipe_does_not_declare() {
        let report = check(&[
            ("package.json", PACKAGE),
            ("agents/agent.yaml", AGENT),
            // The agent's declared name, not its file name, is its identity.
            (
                "agents/review.yaml",
                "name: reviewer\nmodel:\n  name: test/provider-model\n",
            ),
            (
                "prompts/known.md",
                "---\nsuggest: [agent, reviewer]\ndescription: Go\n---\nGo.",
            ),
            (
                "prompts/file.md",
                "---\nsuggest: [review]\ndescription: Go\n---\nGo.",
            ),
            (
                "prompts/list.md",
                "---\nsuggest: [agent, drafter]\ndescription: Go\n---\nGo.",
            ),
        ]);
        assert!(report.valid, "{:?}", report.diagnostics);
        assert_eq!(
            codes(&report, "prompts.suggest_agent_unknown"),
            vec!["prompts/file.md", "prompts/list.md"]
        );
        assert!(codes(&report, "prompts.suggest_invalid").is_empty());
    }

    #[test]
    fn a_suggestion_is_offered_to_the_agents_it_names() {
        let listed = suggestions(&[
            ("package.json", PACKAGE),
            ("agents/agent.yaml", AGENT),
            ("prompts/all.md", "---\nsuggest: true\n---\nAll."),
            ("prompts/one.md", "---\nsuggest: [reviewer]\n---\nOne."),
        ]);
        let offered = |agent: &str| {
            listed
                .iter()
                .filter(|suggestion| suggestion.offered_to(agent))
                .map(|suggestion| suggestion.name.as_str())
                .collect::<Vec<_>>()
        };
        assert_eq!(offered("agent"), vec!["all"]);
        assert_eq!(offered("reviewer"), vec!["all", "one"]);
    }

    #[test]
    fn warns_once_per_unknown_placeholder_in_suggested_templates() {
        let report = check(&[
            ("package.json", PACKAGE),
            ("agents/agent.yaml", AGENT),
            (
                "prompts/brief.md",
                "---\nsuggest: true\ndescription: Brief\n---\nFor {{member.name}} at {{org.name}} on {{today}}: {{deal.id}} and {{deal.id}}, {{ spaced }}.",
            ),
            ("prompts/unmarked.md", "Use {{deal.id}}."),
        ]);
        assert!(report.valid, "{:?}", report.diagnostics);
        let unknown: Vec<_> = report
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == "prompts.placeholder_unknown")
            .map(|diagnostic| diagnostic.message.clone())
            .collect();
        assert_eq!(
            unknown,
            vec!["Suggested prompt template 'prompts/brief.md' uses unknown placeholder '{{deal.id}}'"]
        );
    }

    #[test]
    fn reads_the_conventional_prompts_directory() {
        let report = check(&[
            (
                "package.json",
                r#"{"name":"suggest","version":"0.1.0","pi":{"agents":["agents/*.yaml"]}}"#,
            ),
            ("agents/agent.yaml", AGENT),
            ("prompts/bare.md", "---\nsuggest: true\n---\nReview it."),
        ]);
        assert_eq!(
            codes(&report, "prompts.description_missing"),
            vec!["prompts/bare.md"]
        );
    }

    fn suggestions(files: &[(&str, &str)]) -> Vec<crate::Suggestion> {
        crate::list_recipe_suggestions(&RecipeFiles {
            files: files
                .iter()
                .map(|(path, content)| RecipeFile::new(*path, *content))
                .collect(),
            directories: Vec::new(),
        })
    }

    /// The cases `test/recipe-suggestions.test.ts` also runs against
    /// `listRecipeSuggestions`, so both readers agree.
    #[test]
    fn shared_suggestions_conformance_fixtures() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Expected {
            name: String,
            description: String,
            argument_hint: Option<String>,
            text: String,
            placeholders: Vec<String>,
            agents: Option<Vec<String>>,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            files: std::collections::BTreeMap<String, String>,
            suggestions: Vec<Expected>,
        }
        let cases: Vec<Case> = serde_json::from_str(include_str!(
            "../../../test/fixtures/suggestions-conformance.json"
        ))
        .expect("shared suggestions fixtures must parse");
        for case in cases {
            let files: Vec<(&str, &str)> = case
                .files
                .iter()
                .map(|(path, content)| (path.as_str(), content.as_str()))
                .collect();
            let expected: Vec<crate::Suggestion> = case
                .suggestions
                .into_iter()
                .map(|e| crate::Suggestion {
                    name: e.name,
                    description: e.description,
                    argument_hint: e.argument_hint,
                    text: e.text,
                    placeholders: e.placeholders,
                    agents: e.agents,
                })
                .collect();
            assert_eq!(suggestions(&files), expected, "{}", case.name);
        }
    }

    #[test]
    fn lists_nothing_without_a_package() {
        assert!(suggestions(&[("prompts/go.md", "---\nsuggest: true\n---\nGo.")]).is_empty());
    }
}
