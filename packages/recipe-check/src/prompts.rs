//! Prompt templates marked `suggest: true` are a Recipe's suggestions: hosts
//! show them in a first-run picker or as chips. Both read the template's
//! `description`, and a host fills a fixed set of `{{name}}` placeholders, so
//! warn when either would show up wrong.

use regex::Regex;
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

/// The longest suggestion description, in words, that reads well as a chip.
const MAX_DESCRIPTION_WORDS: usize = 10;

/// The template's parsed frontmatter, or an empty object when it has none.
fn frontmatter(content: &str) -> JsonValue {
    let normalized = content.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    normalized
        .strip_prefix("---")
        .and_then(|rest| rest.find("\n---").map(|end| rest[..end].to_owned()))
        .and_then(|yaml| serde_saphyr::from_str::<JsonValue>(&yaml).ok())
        .filter(JsonValue::is_object)
        .unwrap_or_else(|| JsonValue::Object(Default::default()))
}

/// Templates marked `suggest: true` are suggestions. Check what hosts show
/// for those, and that `suggest` itself is a boolean wherever it appears.
pub(crate) fn validate_prompt_templates(paths: &[String], ctx: &mut CheckContext) {
    let placeholder = Regex::new(r"\{\{([A-Za-z][\w.-]*)\}\}").expect("placeholder pattern");
    for file in template_files(paths, ctx) {
        let Some(content) = ctx.content(&file).map(str::to_owned) else {
            continue;
        };
        let frontmatter = frontmatter(&content);
        match frontmatter.get("suggest") {
            None | Some(JsonValue::Bool(false)) => continue,
            Some(JsonValue::Bool(true)) => {}
            Some(_) => {
                ctx.warning(
                    "prompts.suggest_invalid",
                    file.clone(),
                    format!("Prompt template '{file}' has a `suggest` value that is not a boolean"),
                    Some("set `suggest: true` to offer the template as a suggestion, or remove it"),
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
    fn warns_when_suggest_is_not_a_boolean() {
        let report = check(&[
            ("package.json", PACKAGE),
            ("agents/agent.yaml", AGENT),
            (
                "prompts/yes.md",
                "---\nsuggest: \"yes\"\ndescription: Go\n---\nGo.",
            ),
            (
                "prompts/one.md",
                "---\nsuggest: 1\ndescription: Go\n---\nGo.",
            ),
            (
                "prompts/good.md",
                "---\nsuggest: true\ndescription: Go\n---\nGo.",
            ),
        ]);
        assert!(report.valid, "{:?}", report.diagnostics);
        assert_eq!(
            codes(&report, "prompts.suggest_invalid"),
            vec!["prompts/one.md", "prompts/yes.md"]
        );
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
}
