//! Rewrite a Recipe's identity so a template becomes its own Recipe.
//!
//! I/O-free like the rest of this crate: a [`RecipeFiles`] snapshot in, a
//! rewritten snapshot out. Hosts own discovery and writeback — the CLI writes
//! a checkout, the control plane writes a first commit.
//!
//! Templates carry real values, not placeholders. A template that validates is
//! a template that runs, which is why instantiating one is a *rewrite of the
//! identity* rather than a substitution pass: there is nothing to expand, and a
//! `{{...}}` a prompt writes deliberately survives untouched.
//!
//! Three things have to agree and are rewritten together: the Runtime
//! manifest's filename stem (the platform derives the Runtime group slug from
//! it, not from `name:` inside), that manifest's `name:`, and the package's
//! `"name"`.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::{RecipeFile, RecipeFiles};

/// Where a Recipe keeps its Runtime manifest, relative to the repository root.
const MANIFEST_DIR: &str = ".introspection";

/// Longest slug. The manifest filename stem is the Runtime identity, so this
/// tracks what the platform accepts.
const MAX_SLUG: usize = 63;

/// The identity a template is being rewritten to.
///
/// `slug`, `name` and `description` are named as the platform's own Runtime
/// resource names them, and unknown fields are ignored, so a caller holding a
/// `GET /runtimes/{id}` payload passes it straight in rather than mapping it.
/// `recipe_path` is the one field that is not a Runtime property: it is where
/// the host is placing the Recipe in the destination repository.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeIdentity {
    /// The Runtime group slug: the manifest filename stem and the package name.
    pub slug: String,
    /// Display name for the manifest's `name:`. Defaults to the slug.
    #[serde(default)]
    pub name: Option<String>,
    /// One line for the manifest's `description:`. Left alone when absent, so a
    /// template's own wording survives a caller that has nothing better.
    #[serde(default)]
    pub description: Option<String>,
    /// Where the Recipe sits in the destination repository. Defaults to `"."`.
    #[serde(default)]
    pub recipe_path: Option<String>,
    /// Values for the `{{placeholder}}` tokens a template declares — an MCP
    /// backend URL, a service endpoint, a model name.
    ///
    /// These are what identity cannot be: a placeholder is legal here because
    /// the checker does not constrain these values, whereas a slug or a
    /// manifest filename has a grammar a placeholder would violate. `slug`,
    /// `name` and `description` are filled in automatically, so a template may
    /// also reference those by name in free text.
    ///
    /// ⚠️ Only declared keys are substituted. An unknown `{{...}}` is left
    /// exactly as written, so braces a prompt uses deliberately survive.
    #[serde(default)]
    pub variables: BTreeMap<String, String>,
}

/// Raised for the whole snapshot when it cannot be rewritten.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatError(String);

impl FormatError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for FormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for FormatError {}

/// Rewrite `files` to `identity`, returning a new snapshot.
///
/// A snapshot with no Runtime manifest is not an error: a template may be a
/// bare package, and inventing a manifest for it is the host's decision, not
/// this function's.
pub fn format_recipe_files(
    files: &RecipeFiles,
    identity: &RecipeIdentity,
) -> Result<RecipeFiles, FormatError> {
    validate_slug(&identity.slug)?;
    let recipe_path = identity.recipe_path.as_deref().unwrap_or(".");
    let display_name = identity.name.as_deref().unwrap_or(&identity.slug);

    let manifest = sole_manifest(files)?;
    let mut package_dir = ".".to_string();
    let mut out = RecipeFiles {
        files: Vec::with_capacity(files.files.len()),
        directories: files.directories.clone(),
    };

    for file in &files.files {
        if Some(file.path.as_str()) == manifest {
            let content = file.content.as_deref().ok_or_else(|| {
                FormatError::new(format!(
                    "{} was not read, so it cannot be rewritten",
                    file.path
                ))
            })?;
            let (rewritten, existing_path) = rewrite_manifest(
                content,
                display_name,
                identity.description.as_deref(),
                recipe_path,
            )?;
            package_dir = existing_path;
            out.files.push(RecipeFile {
                path: format!("{MANIFEST_DIR}/{}.yaml", identity.slug),
                content: Some(rewritten),
            });
        } else {
            out.files.push(file.clone());
        }
    }

    // Contents and paths alike: a template names a service or an MCP backend in
    // a directory as readily as in a file, so a token that only worked in
    // contents would be a trap rather than a simplification.
    let values = substitutions(identity, display_name);
    for file in &mut out.files {
        file.path = substitute(&file.path, &values);
        if let Some(content) = file.content.as_deref() {
            file.content = Some(substitute(content, &values));
        }
    }
    for directory in &mut out.directories {
        *directory = substitute(directory, &values);
    }

    let package_path = join(&substitute(&package_dir, &values), "package.json");
    for file in &mut out.files {
        if file.path == package_path {
            if let Some(content) = file.content.as_deref() {
                file.content = Some(rename_package(content, &identity.slug)?);
            }
        }
    }
    Ok(out)
}

/// The tokens a template may reference, identity included.
fn substitutions(identity: &RecipeIdentity, display_name: &str) -> BTreeMap<String, String> {
    let mut values = identity.variables.clone();
    values.insert("slug".to_string(), identity.slug.clone());
    values.insert("name".to_string(), display_name.to_string());
    if let Some(description) = identity.description.as_deref() {
        values.insert("description".to_string(), description.to_string());
    }
    values
}

/// Replace `{{key}}` for every declared key, and nothing else.
///
/// Scanning for the delimiters rather than looping over the keys means an
/// unknown token is passed through untouched instead of being partially
/// rewritten, and a substituted value can never itself be re-substituted.
fn substitute(text: &str, values: &BTreeMap<String, String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find("{{") {
        let (head, tail) = rest.split_at(open);
        out.push_str(head);
        let Some(close) = tail.find("}}") else {
            out.push_str(tail);
            return out;
        };
        let key = &tail[2..close];
        match values.get(key.trim()) {
            Some(value) => out.push_str(value),
            None => out.push_str(&tail[..close + 2]),
        }
        rest = &tail[close + 2..];
    }
    out.push_str(rest);
    out
}

/// The Recipe's sole Runtime manifest, or `None` when it has none.
fn sole_manifest(files: &RecipeFiles) -> Result<Option<&str>, FormatError> {
    let prefix = format!("{MANIFEST_DIR}/");
    let mut found: Option<&str> = None;
    for file in &files.files {
        let Some(rest) = file.path.strip_prefix(&prefix) else {
            continue;
        };
        // Only the directory's own files: a manifest never sits in a subdirectory.
        if rest.contains('/') || !(rest.ends_with(".yaml") || rest.ends_with(".yml")) {
            continue;
        }
        if found.is_some() {
            return Err(FormatError::new(
                "a template declares more than one Runtime manifest, so which identity to rewrite is ambiguous",
            ));
        }
        found = Some(file.path.as_str());
    }
    Ok(found)
}

/// Rewrite the manifest's `name:`, `description:` and `path:`, preserving
/// every other line.
///
/// Line-oriented rather than a YAML round trip: reserialising reorders keys and
/// drops comments, so the first diff an author saw of their own Recipe would be
/// noise they did not write. Returns the rewritten text and the template's own
/// `path:`, which is where its package sits inside the checkout.
fn rewrite_manifest(
    text: &str,
    name: &str,
    description: Option<&str>,
    recipe_path: &str,
) -> Result<(String, String), FormatError> {
    let mut package_dir = ".".to_string();
    let (mut named, mut pathed) = (false, false);
    let mut out = String::with_capacity(text.len());

    for line in text.lines() {
        if line.starts_with("name:") {
            out.push_str(&format!("name: {name}\n"));
            named = true;
        } else if let Some(value) = line.strip_prefix("path:") {
            package_dir = value.trim().trim_matches('"').to_string();
            out.push_str(&format!("path: {}\n", rebase(recipe_path, &package_dir)));
            pathed = true;
        } else if line.starts_with("description:") && description.is_some() {
            out.push_str(&format!(
                "description: {}\n",
                description.unwrap_or_default()
            ));
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }

    if !named || !pathed {
        return Err(FormatError::new(
            "a Recipe manifest needs both `name:` and `path:`",
        ));
    }
    Ok((out, package_dir))
}

/// Compose where the Recipe sits in the repository with where the package sits
/// inside the template checkout.
fn rebase(recipe_path: &str, package_dir: &str) -> String {
    match (recipe_path, package_dir) {
        (".", inner) => inner.to_string(),
        (outer, ".") => outer.to_string(),
        (outer, inner) => format!("{}/{}", outer.trim_end_matches('/'), inner),
    }
}

fn join(dir: &str, file: &str) -> String {
    if dir == "." || dir.is_empty() {
        file.to_string()
    } else {
        format!("{}/{file}", dir.trim_end_matches('/'))
    }
}

/// Point `package.json` at the new Recipe.
///
/// Rewrites the value in place rather than reserialising, for the same reason
/// the manifest is line-oriented. Anchoring to the `"name"` key keeps a
/// template whose name collides with some other string literal from having the
/// wrong occurrence rewritten.
fn rename_package(contents: &str, slug: &str) -> Result<String, FormatError> {
    let parsed: serde_json::Value = serde_json::from_str(contents)
        .map_err(|error| FormatError::new(format!("parsing package.json: {error}")))?;
    let Some(current) = parsed.get("name").and_then(serde_json::Value::as_str) else {
        return Ok(contents.to_string());
    };
    const KEY: &str = "\"name\"";
    let Some(key_at) = contents.find(KEY) else {
        return Ok(contents.to_string());
    };
    let (head, tail) = contents.split_at(key_at + KEY.len());
    Ok(format!(
        "{head}{}",
        tail.replacen(&format!("\"{current}\""), &format!("\"{slug}\""), 1)
    ))
}

/// The slug is three things that must agree: the manifest filename stem, the
/// manifest `name:`, and the package name.
fn validate_slug(value: &str) -> Result<(), FormatError> {
    if value.is_empty() {
        return Err(FormatError::new("a Recipe slug cannot be empty"));
    }
    if value.len() > MAX_SLUG {
        return Err(FormatError::new(format!(
            "a Recipe slug is at most {MAX_SLUG} characters"
        )));
    }
    let valid = value.split('-').all(|part| {
        !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    });
    if !valid {
        return Err(FormatError::new(format!(
            "'{value}' is not a Recipe slug: use lowercase letters and digits separated by single hyphens"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn template() -> RecipeFiles {
        RecipeFiles {
            files: vec![
                RecipeFile::new(
                    ".introspection/coding-agent.yaml",
                    "# the Runtime this repo serves\nname: coding-agent\npath: .\ndescription: Customizable Pi coding agent\n",
                ),
                RecipeFile::new("package.json", "{\n  \"name\": \"coding-agent\",\n  \"version\": \"0.1.0\"\n}\n"),
                RecipeFile::new("agents/agent.yaml", "model: claude-opus-5\n"),
            ],
            directories: vec![],
        }
    }

    fn identity(slug: &str) -> RecipeIdentity {
        RecipeIdentity {
            slug: slug.to_string(),
            ..Default::default()
        }
    }

    fn file<'a>(files: &'a RecipeFiles, path: &str) -> &'a RecipeFile {
        files
            .files
            .iter()
            .find(|file| file.path == path)
            .unwrap_or_else(|| panic!("{path} missing from {:?}", files.files))
    }

    #[test]
    fn renames_the_manifest_to_the_slug() {
        let out = format_recipe_files(&template(), &identity("my-agent")).expect("format");
        assert!(out
            .files
            .iter()
            .all(|f| f.path != ".introspection/coding-agent.yaml"));
        let manifest = file(&out, ".introspection/my-agent.yaml");
        assert!(manifest
            .content
            .as_deref()
            .unwrap()
            .contains("name: my-agent"));
    }

    #[test]
    fn renames_the_package() {
        let out = format_recipe_files(&template(), &identity("my-agent")).expect("format");
        assert!(file(&out, "package.json")
            .content
            .as_deref()
            .unwrap()
            .contains("\"name\": \"my-agent\""));
    }

    #[test]
    fn preserves_comments_and_untouched_files() {
        let out = format_recipe_files(&template(), &identity("my-agent")).expect("format");
        let manifest = file(&out, ".introspection/my-agent.yaml")
            .content
            .clone()
            .unwrap();
        assert!(manifest.starts_with("# the Runtime this repo serves\n"));
        assert_eq!(
            file(&out, "agents/agent.yaml").content.as_deref(),
            Some("model: claude-opus-5\n")
        );
    }

    #[test]
    fn leaves_the_description_alone_when_the_caller_has_none() {
        let out = format_recipe_files(&template(), &identity("my-agent")).expect("format");
        let manifest = file(&out, ".introspection/my-agent.yaml")
            .content
            .clone()
            .unwrap();
        assert!(manifest.contains("description: Customizable Pi coding agent"));
    }

    #[test]
    fn rewrites_the_description_when_given_one() {
        let mut want = identity("my-agent");
        want.description = Some("Reviews pull requests".to_string());
        let out = format_recipe_files(&template(), &want).expect("format");
        let manifest = file(&out, ".introspection/my-agent.yaml")
            .content
            .clone()
            .unwrap();
        assert!(manifest.contains("description: Reviews pull requests"));
        assert!(!manifest.contains("Customizable"));
    }

    #[test]
    fn display_name_defaults_to_the_slug_but_can_differ() {
        let mut want = identity("my-agent");
        want.name = Some("My Agent".to_string());
        let out = format_recipe_files(&template(), &want).expect("format");
        let manifest = file(&out, ".introspection/my-agent.yaml")
            .content
            .clone()
            .unwrap();
        assert!(manifest.contains("name: My Agent"));
        // The slug still names the file, because that is what the platform reads.
        assert_eq!(
            file(&out, ".introspection/my-agent.yaml").path,
            ".introspection/my-agent.yaml"
        );
    }

    #[test]
    fn rebases_the_path_onto_the_destination() {
        let mut want = identity("my-agent");
        want.recipe_path = Some("recipes/mine".to_string());
        let out = format_recipe_files(&template(), &want).expect("format");
        let manifest = file(&out, ".introspection/my-agent.yaml")
            .content
            .clone()
            .unwrap();
        assert!(manifest.contains("path: recipes/mine"));
    }

    #[test]
    fn a_package_only_template_needs_no_manifest() {
        let files = RecipeFiles {
            files: vec![RecipeFile::new("package.json", "{\"name\": \"starter\"}")],
            directories: vec![],
        };
        let out = format_recipe_files(&files, &identity("my-agent")).expect("format");
        assert!(file(&out, "package.json")
            .content
            .as_deref()
            .unwrap()
            .contains("\"my-agent\""));
    }

    #[test]
    fn refuses_two_manifests() {
        let mut files = template();
        files.files.push(RecipeFile::new(
            ".introspection/other.yaml",
            "name: other\npath: .\n",
        ));
        let error = format_recipe_files(&files, &identity("my-agent")).expect_err("ambiguous");
        assert!(error.message().contains("more than one"));
    }

    #[test]
    fn refuses_a_manifest_missing_name_or_path() {
        let files = RecipeFiles {
            files: vec![RecipeFile::new(
                ".introspection/coding-agent.yaml",
                "name: coding-agent\n",
            )],
            directories: vec![],
        };
        let error = format_recipe_files(&files, &identity("my-agent")).expect_err("incomplete");
        assert!(error.message().contains("`name:` and `path:`"));
    }

    #[test]
    fn refuses_a_slug_the_platform_would_not_accept() {
        for bad in [
            "",
            "My-Agent",
            "my_agent",
            "-leading",
            "trailing-",
            "double--hyphen",
        ] {
            format_recipe_files(&template(), &identity(bad))
                .expect_err(&format!("{bad} should be refused"));
        }
    }

    #[test]
    fn accepts_a_runtime_payload_with_fields_it_does_not_know() {
        let want: RecipeIdentity = serde_json::from_str(
            r#"{"id":"018f...","slug":"my-agent","name":"My Agent","description":"d","kind":"byor","created_at":"2026-01-01T00:00:00Z"}"#,
        )
        .expect("a Runtime payload deserializes as an identity");
        assert_eq!(want.slug, "my-agent");
        assert_eq!(want.name.as_deref(), Some("My Agent"));
    }
}

#[cfg(test)]
mod substitution_tests {
    use super::*;

    fn identity_with(slug: &str, pairs: &[(&str, &str)]) -> RecipeIdentity {
        RecipeIdentity {
            slug: slug.to_string(),
            variables: pairs
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
            ..Default::default()
        }
    }

    fn manifest_only(extra: Vec<RecipeFile>) -> RecipeFiles {
        let mut files = vec![RecipeFile::new(
            ".introspection/coding-agent.yaml",
            "name: coding-agent\npath: .\n",
        )];
        files.extend(extra);
        RecipeFiles {
            files,
            directories: vec![],
        }
    }

    fn find<'a>(files: &'a RecipeFiles, path: &str) -> &'a RecipeFile {
        files
            .files
            .iter()
            .find(|file| file.path == path)
            .unwrap_or_else(|| panic!("{path} missing from {:?}", files.files))
    }

    #[test]
    fn fills_declared_values_in_contents() {
        let files = manifest_only(vec![RecipeFile::new(
            "servers/mcp.json",
            "{\"url\": \"{{mcp_backend_url}}\"}",
        )]);
        let out = format_recipe_files(
            &files,
            &identity_with(
                "my-agent",
                &[("mcp_backend_url", "https://mcp.example.com")],
            ),
        )
        .expect("format");
        assert_eq!(
            find(&out, "servers/mcp.json").content.as_deref(),
            Some("{\"url\": \"https://mcp.example.com\"}")
        );
    }

    #[test]
    fn fills_declared_values_in_paths_and_directories() {
        let mut files = manifest_only(vec![RecipeFile::new(
            "services/{{service}}/main.py",
            "print()\n",
        )]);
        files
            .directories
            .push("services/{{service}}/logs".to_string());
        let out = format_recipe_files(
            &files,
            &identity_with("my-agent", &[("service", "billing")]),
        )
        .expect("format");
        find(&out, "services/billing/main.py");
        assert!(out
            .directories
            .contains(&"services/billing/logs".to_string()));
    }

    #[test]
    fn identity_is_available_as_a_token() {
        let files = manifest_only(vec![RecipeFile::new("SYSTEM.md", "You are {{slug}}.\n")]);
        let out = format_recipe_files(&files, &identity_with("my-agent", &[])).expect("format");
        assert_eq!(
            find(&out, "SYSTEM.md").content.as_deref(),
            Some("You are my-agent.\n")
        );
    }

    #[test]
    fn an_undeclared_token_survives_verbatim() {
        let files = manifest_only(vec![RecipeFile::new(
            "SYSTEM.md",
            "Answer with {{user_input}} and {{ unclosed\n",
        )]);
        let out = format_recipe_files(&files, &identity_with("my-agent", &[])).expect("format");
        assert_eq!(
            find(&out, "SYSTEM.md").content.as_deref(),
            Some("Answer with {{user_input}} and {{ unclosed\n")
        );
    }

    #[test]
    fn a_filled_value_is_not_itself_substituted() {
        let files = manifest_only(vec![RecipeFile::new("SYSTEM.md", "{{echo}}\n")]);
        let out = format_recipe_files(&files, &identity_with("my-agent", &[("echo", "{{slug}}")]))
            .expect("format");
        assert_eq!(
            find(&out, "SYSTEM.md").content.as_deref(),
            Some("{{slug}}\n")
        );
    }

    #[test]
    fn the_package_is_found_through_a_templated_path() {
        let mut files = manifest_only(vec![RecipeFile::new(
            "{{service}}/package.json",
            "{\"name\": \"coding-agent\"}",
        )]);
        files.files[0] = RecipeFile::new(
            ".introspection/coding-agent.yaml",
            "name: coding-agent\npath: {{service}}\n",
        );
        let out = format_recipe_files(
            &files,
            &identity_with("my-agent", &[("service", "billing")]),
        )
        .expect("format");
        assert_eq!(
            find(&out, "billing/package.json").content.as_deref(),
            Some("{\"name\": \"my-agent\"}")
        );
    }
}
