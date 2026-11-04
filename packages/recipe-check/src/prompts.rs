//! Prompt templates double as a Recipe's suggestions: Pi offers them as `/`
//! commands, and hosts show them in a first-run picker or as chips. Both read
//! the template's `description`, and a host fills a fixed set of `{{name}}`
//! placeholders, so warn when either would show up wrong.

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

/// The template's frontmatter `description`, when it has a non-empty one.
fn has_description(content: &str) -> bool {
    let normalized = content.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---") else {
        return false;
    };
    let Some(end) = rest.find("\n---") else {
        return false;
    };
    let Ok(parsed) = serde_saphyr::from_str::<JsonValue>(&rest[..end]) else {
        return false;
    };
    parsed
        .get("description")
        .and_then(JsonValue::as_str)
        .is_some_and(|description| !description.trim().is_empty())
}

pub(crate) fn validate_prompt_templates(paths: &[String], ctx: &mut CheckContext) {
    let placeholder = Regex::new(r"\{\{([A-Za-z][\w.-]*)\}\}").expect("placeholder pattern");
    for file in template_files(paths, ctx) {
        let Some(content) = ctx.content(&file).map(str::to_owned) else {
            continue;
        };
        if !has_description(&content) {
            ctx.warning(
                "prompts.description_missing",
                file.clone(),
                format!("Prompt template '{file}' has no description"),
                Some("add a `description` to the frontmatter; Pi and hosts show it when suggesting the template"),
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
                format!("Prompt template '{file}' uses unknown placeholder '{{{{{name}}}}}'"),
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
    fn warns_on_a_template_without_a_description() {
        let report = check(&[
            ("package.json", PACKAGE),
            ("agents/agent.yaml", AGENT),
            (
                "prompts/good.md",
                "---\ndescription: Review a draft\n---\nReview it.",
            ),
            ("prompts/bare.md", "Review it."),
            (
                "prompts/empty.md",
                "---\ndescription: \"  \"\n---\nReview it.",
            ),
        ]);
        assert!(report.valid, "{:?}", report.diagnostics);
        assert_eq!(
            codes(&report, "prompts.description_missing"),
            vec!["prompts/bare.md", "prompts/empty.md"]
        );
    }

    #[test]
    fn warns_once_per_unknown_placeholder() {
        let report = check(&[
            ("package.json", PACKAGE),
            ("agents/agent.yaml", AGENT),
            (
                "prompts/brief.md",
                "---\ndescription: Brief\n---\nFor {{member.name}} at {{org.name}} on {{today}}: {{deal.id}} and {{deal.id}}, {{ spaced }}.",
            ),
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
            vec!["Prompt template 'prompts/brief.md' uses unknown placeholder '{{deal.id}}'"]
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
            ("prompts/bare.md", "Review it."),
        ]);
        assert_eq!(
            codes(&report, "prompts.description_missing"),
            vec!["prompts/bare.md"]
        );
    }
}
