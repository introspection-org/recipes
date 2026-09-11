//! Render a template repository into a Recipe.
//!
//! I/O-free like the rest of this crate: a [`RecipeFiles`] snapshot of the
//! template repository in, the rendered snapshot out. Hosts own discovery and
//! writeback — the CLI writes a checkout, the control plane writes a first
//! commit.
//!
//! A template repository is **not** a Recipe, and says so by its shape:
//!
//! ```text
//! template.yaml          the variables, their types, defaults and prompts
//! template/              the payload, and the only thing rendered
//!   .introspection/{{ slug }}.yaml.tmpl
//!   package.json.tmpl
//!   SYSTEM.md            no suffix: copied byte for byte
//! tests/cases.yaml       render these, then check the output
//! ```
//!
//! Two rules carry the design. **`.tmpl` opts a file in**, so a prompt full of
//! `{{ }}` — which is most of what a Recipe is — survives untouched unless its
//! author asked for rendering. And **paths render too**, so `{{ slug }}` names
//! a file or a directory as readily as it fills one.
//!
//! Substitution only, deliberately: no conditionals, no loops, no engine. What
//! a template has to produce is a working starting point that an agent then
//! edits, and every feature beyond `{{ name }}` is one the generated Recipe
//! carries no trace of. Double braces rather than single because a template's
//! files are mostly JSON, and `{` would have to be escaped in every one of
//! them.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::{RecipeFile, RecipeFiles};

/// The template repository's own manifest.
pub const MANIFEST_PATH: &str = "template.yaml";

/// The only directory that is rendered. Everything outside it is the template
/// repository's own machinery — its tests, its CI, its README.
pub const PAYLOAD_DIR: &str = "template/";

/// Suffix marking a file as rendered. Dropped from the output path.
pub const RENDER_SUFFIX: &str = ".tmpl";

/// What a template declares about itself.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TemplateManifest {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Declaration order is preserved, because it is the order a host prompts in.
    #[serde(default)]
    pub variables: Vec<TemplateVariable>,
}

fn default_version() -> u32 {
    1
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TemplateVariable {
    pub name: String,
    #[serde(default, rename = "type")]
    pub kind: VariableKind,
    /// May reference variables declared before it (`default: "{{ slug }}"`).
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub choices: Vec<String>,
    /// Names an earlier boolean; the variable applies only when it is true. A
    /// variable that does not apply is neither prompted for nor required.
    #[serde(default)]
    pub when: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VariableKind {
    #[default]
    String,
    Boolean,
    Integer,
    Choice,
}

impl VariableKind {
    /// What an inapplicable variable renders as, so the off branch of an
    /// optional feature still produces a file.
    fn empty(self) -> VariableValue {
        match self {
            Self::Boolean => VariableValue::Boolean(false),
            Self::Integer => VariableValue::Integer(0),
            Self::String | Self::Choice => VariableValue::String(String::new()),
        }
    }
}

/// A resolved value. Everything renders as text; only `when` reads truth.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum VariableValue {
    Boolean(bool),
    Integer(i64),
    String(String),
}

impl VariableValue {
    pub fn as_text(&self) -> String {
        match self {
            Self::Boolean(value) => value.to_string(),
            Self::Integer(value) => value.to_string(),
            Self::String(value) => value.clone(),
        }
    }

    fn is_true(&self) -> bool {
        match self {
            Self::Boolean(value) => *value,
            Self::Integer(value) => *value != 0,
            Self::String(value) => !value.is_empty(),
        }
    }
}

/// Raised for the whole template when it cannot be rendered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateError(String);

impl TemplateError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TemplateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TemplateError {}

/// Parse `template.yaml`.
pub fn parse_template_manifest(text: &str) -> Result<TemplateManifest, TemplateError> {
    let manifest: TemplateManifest = serde_saphyr::from_str(text)
        .map_err(|error| TemplateError::new(format!("parsing {MANIFEST_PATH}: {error}")))?;
    if manifest.version != 1 {
        return Err(TemplateError::new(format!(
            "{MANIFEST_PATH} declares version {}, which this renderer does not understand",
            manifest.version
        )));
    }
    let mut seen: BTreeMap<&str, VariableKind> = BTreeMap::new();
    for variable in &manifest.variables {
        if variable.name.is_empty() {
            return Err(TemplateError::new("a template variable needs a name"));
        }
        if seen.insert(variable.name.as_str(), variable.kind).is_some() {
            return Err(TemplateError::new(format!(
                "{MANIFEST_PATH} declares '{}' twice",
                variable.name
            )));
        }
        if variable.kind == VariableKind::Choice && variable.choices.is_empty() {
            return Err(TemplateError::new(format!(
                "'{}' is a choice with no choices",
                variable.name
            )));
        }
        if let Some(when) = variable.when.as_deref() {
            match seen.get(when) {
                None => {
                    return Err(TemplateError::new(format!(
                        "'{}' is conditional on '{when}', which is not declared before it",
                        variable.name
                    )))
                }
                // Refused rather than coerced, because the failure is silent
                // and inverted: a missing `type: boolean` leaves the default
                // string "false", which is non-empty and therefore true, so
                // the feature turns itself on and then demands its values.
                Some(kind) if *kind != VariableKind::Boolean => {
                    return Err(TemplateError::new(format!(
                        "'{}' is conditional on '{when}', which is not a boolean",
                        variable.name
                    )))
                }
                Some(_) => {}
            }
        }
    }
    Ok(manifest)
}

/// Resolve caller-supplied values against the manifest, filling defaults.
pub fn resolve_variables(
    manifest: &TemplateManifest,
    supplied: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, VariableValue>, TemplateError> {
    let mut resolved: BTreeMap<String, VariableValue> = BTreeMap::new();
    for variable in &manifest.variables {
        let applies = match variable.when.as_deref() {
            Some(when) => resolved
                .get(when)
                .map(VariableValue::is_true)
                .unwrap_or(false),
            None => true,
        };
        let raw = match supplied.get(&variable.name) {
            Some(value) => Some(value.clone()),
            None => match &variable.default {
                // A default may reference the values already resolved.
                Some(default) => Some(substitute(default, &resolved)?),
                None => None,
            },
        };
        let value = match (raw, applies) {
            (Some(raw), _) => coerce(variable, &raw)?,
            // `when` suppresses the *requirement*, never the binding. The
            // payload has no conditionals, so a file naming an optional
            // variable must still render when the feature is off — leaving it
            // unbound would make the off branch unrenderable, which is the
            // common case rather than the exotic one.
            (None, false) => variable.kind.empty(),
            (None, true) => {
                return Err(TemplateError::new(format!(
                    "'{}' has no value and no default",
                    variable.name
                )))
            }
        };
        resolved.insert(variable.name.clone(), value);
    }
    for name in supplied.keys() {
        if !manifest.variables.iter().any(|v| &v.name == name) {
            return Err(TemplateError::new(format!(
                "'{name}' is not declared by {MANIFEST_PATH}"
            )));
        }
    }
    Ok(resolved)
}

/// Render the template repository's payload with `variables` already resolved.
pub fn render_template(
    files: &RecipeFiles,
    variables: &BTreeMap<String, VariableValue>,
) -> Result<RecipeFiles, TemplateError> {
    let payload = payload_prefix(files)?;
    let mut out = RecipeFiles {
        files: Vec::new(),
        directories: Vec::new(),
    };

    for file in &files.files {
        let Some(relative) = file.path.strip_prefix(payload) else {
            continue;
        };
        let path = substitute(relative, variables)?;
        match relative.ends_with(RENDER_SUFFIX) {
            true => {
                let content = file.content.as_deref().ok_or_else(|| {
                    TemplateError::new(format!(
                        "{} was not read, so it cannot be rendered",
                        file.path
                    ))
                })?;
                out.files.push(RecipeFile {
                    path: path
                        .strip_suffix(RENDER_SUFFIX)
                        .unwrap_or(&path)
                        .to_string(),
                    content: Some(substitute(content, variables)?),
                });
            }
            // Copied byte for byte: whatever braces it holds are its own.
            false => out.files.push(RecipeFile {
                path,
                content: file.content.clone(),
            }),
        }
    }

    for directory in &files.directories {
        let Some(relative) = directory.strip_prefix(payload) else {
            continue;
        };
        out.directories.push(substitute(relative, variables)?);
    }

    if out.files.is_empty() {
        return Err(TemplateError::new("the template has no files"));
    }
    Ok(out)
}

/// Which part of the repository is the payload.
///
/// A repository that declares nothing is its own payload, copied whole. That
/// is what lets an ordinary Recipe repository serve as a starting point with
/// no ceremony at all: `template.yaml` and `template/` are what you add when
/// you want variables, not a toll for being cloned.
///
/// Declaring `template.yaml` without a `template/` is the one shape that is
/// refused, because it can only be a half-finished template repository — and
/// treating it as its own payload would copy the manifest and the tests into
/// somebody's Recipe.
fn payload_prefix(files: &RecipeFiles) -> Result<&'static str, TemplateError> {
    let has_payload = files
        .files
        .iter()
        .any(|file| file.path.starts_with(PAYLOAD_DIR));
    if has_payload {
        return Ok(PAYLOAD_DIR);
    }
    if files.files.iter().any(|file| file.path == MANIFEST_PATH) {
        return Err(TemplateError::new(format!(
            "{MANIFEST_PATH} declares a template but there is no {PAYLOAD_DIR} directory"
        )));
    }
    Ok("")
}

/// Replace every `{{ key }}` with its value.
///
/// An undeclared token is an error rather than an empty string or a
/// pass-through: the file opted in by carrying `.tmpl`, so a token it does not
/// declare is a typo, and the alternative is a Recipe that renders, validates,
/// and is quietly missing the value someone chose.
fn substitute(
    text: &str,
    variables: &BTreeMap<String, VariableValue>,
) -> Result<String, TemplateError> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find("{{") {
        let (head, tail) = rest.split_at(open);
        out.push_str(head);
        let Some(close) = tail.find("}}") else {
            return Err(TemplateError::new(format!(
                "an unclosed '{{{{' in {}",
                snippet(text)
            )));
        };
        let key = tail[2..close].trim();
        match variables.get(key) {
            Some(value) => out.push_str(&value.as_text()),
            None => {
                return Err(TemplateError::new(format!(
                    "'{key}' is not a declared variable, in {}",
                    snippet(text)
                )))
            }
        }
        rest = &tail[close + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

/// A short, safe excerpt naming where a bad token was found.
///
/// Truncated by characters: template contents are arbitrary UTF-8, and slicing
/// at a byte offset panics when a multibyte character straddles it — turning a
/// reportable template error into a crash.
fn snippet(text: &str) -> String {
    let first = text.lines().next().unwrap_or_default();
    let mut taken: String = first.chars().take(60).collect();
    if taken.chars().count() < first.chars().count() {
        taken.push('…');
    }
    format!("'{taken}'")
}

fn coerce(variable: &TemplateVariable, raw: &str) -> Result<VariableValue, TemplateError> {
    match variable.kind {
        VariableKind::String => Ok(VariableValue::String(raw.to_string())),
        VariableKind::Boolean => match raw {
            "true" | "True" | "yes" | "1" => Ok(VariableValue::Boolean(true)),
            "false" | "False" | "no" | "0" | "" => Ok(VariableValue::Boolean(false)),
            other => Err(TemplateError::new(format!(
                "'{other}' is not a boolean for '{}'",
                variable.name
            ))),
        },
        VariableKind::Integer => raw.parse::<i64>().map(VariableValue::Integer).map_err(|_| {
            TemplateError::new(format!("'{raw}' is not an integer for '{}'", variable.name))
        }),
        VariableKind::Choice => {
            if variable.choices.iter().any(|choice| choice == raw) {
                Ok(VariableValue::String(raw.to_string()))
            } else {
                Err(TemplateError::new(format!(
                    "'{raw}' is not one of the choices for '{}': {}",
                    variable.name,
                    variable.choices.join(", ")
                )))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &str = r#"
version: 1
name: Coding agent
variables:
  - name: slug
    type: string
    prompt: Runtime slug
  - name: name
    type: string
    default: "{{ slug }}"
  - name: model
    type: choice
    choices: [claude-opus-5, claude-sonnet-5]
    default: claude-opus-5
  - name: use_mcp
    type: boolean
    default: "false"
  - name: mcp_backend_url
    type: string
    when: use_mcp
    default: ""
"#;

    fn template() -> RecipeFiles {
        RecipeFiles {
            files: vec![
                RecipeFile::new("template.yaml", MANIFEST),
                RecipeFile::new(
                    "template/.introspection/{{ slug }}.yaml.tmpl",
                    "name: {{ name }}\npath: .\n",
                ),
                RecipeFile::new(
                    "template/package.json.tmpl",
                    "{\n  \"name\": \"{{ slug }}\",\n  \"model\": \"{{ model }}\"\n}\n",
                ),
                // No suffix: a prompt keeps its own braces.
                RecipeFile::new("template/SYSTEM.md", "Answer with {{ user_input }}.\n"),
                RecipeFile::new("tests/cases.yaml", "cases: []\n"),
                RecipeFile::new("README.md", "# the template repository itself\n"),
            ],
            directories: vec![],
        }
    }

    fn supplied(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    fn render(pairs: &[(&str, &str)]) -> Result<RecipeFiles, TemplateError> {
        let manifest = parse_template_manifest(MANIFEST)?;
        let values = resolve_variables(&manifest, &supplied(pairs))?;
        render_template(&template(), &values)
    }

    fn paths(files: &RecipeFiles) -> Vec<&str> {
        files.files.iter().map(|f| f.path.as_str()).collect()
    }

    fn content<'a>(files: &'a RecipeFiles, path: &str) -> &'a str {
        files
            .files
            .iter()
            .find(|f| f.path == path)
            .and_then(|f| f.content.as_deref())
            .unwrap_or_else(|| panic!("{path} missing from {:?}", paths(files)))
    }

    #[test]
    fn renders_paths_and_drops_the_suffix() {
        let out = render(&[("slug", "my-agent")]).expect("render");
        assert!(paths(&out).contains(&".introspection/my-agent.yaml"));
        assert!(paths(&out).contains(&"package.json"));
    }

    #[test]
    fn only_the_payload_is_rendered() {
        let out = render(&[("slug", "my-agent")]).expect("render");
        // The template repository's own machinery never reaches the Recipe.
        assert!(!paths(&out).iter().any(|p| p.contains("cases.yaml")));
        assert!(!paths(&out).contains(&"README.md"));
        assert!(!paths(&out).contains(&"template.yaml"));
    }

    #[test]
    fn a_file_without_the_suffix_keeps_its_own_braces() {
        let out = render(&[("slug", "my-agent")]).expect("render");
        assert_eq!(
            content(&out, "SYSTEM.md"),
            "Answer with {{ user_input }}.\n"
        );
    }

    #[test]
    fn a_default_may_reference_an_earlier_variable() {
        let out = render(&[("slug", "my-agent")]).expect("render");
        assert!(content(&out, ".introspection/my-agent.yaml").contains("name: my-agent"));
    }

    #[test]
    fn a_supplied_value_wins_over_the_default() {
        let out = render(&[("slug", "my-agent"), ("name", "My Agent")]).expect("render");
        assert!(content(&out, ".introspection/my-agent.yaml").contains("name: My Agent"));
        assert!(paths(&out).contains(&".introspection/my-agent.yaml"));
    }

    #[test]
    fn a_choice_outside_its_choices_is_refused() {
        let error = render(&[("slug", "my-agent"), ("model", "gpt-4")]).expect_err("refused");
        assert!(error.message().contains("not one of the choices"));
    }

    #[test]
    fn an_undeclared_variable_is_refused_rather_than_ignored() {
        let error = render(&[("slug", "my-agent"), ("mdoel", "x")]).expect_err("refused");
        assert!(error.message().contains("not declared"));
    }

    #[test]
    fn a_typo_in_a_rendered_file_is_an_error_not_an_empty_string() {
        let manifest = parse_template_manifest(MANIFEST).expect("manifest");
        let values =
            resolve_variables(&manifest, &supplied(&[("slug", "my-agent")])).expect("values");
        let mut files = template();
        files.files.push(RecipeFile::new(
            "template/AGENTS.md.tmpl",
            "I am {{ slgu }}.\n",
        ));
        let error = render_template(&files, &values).expect_err("refused");
        assert!(error
            .message()
            .contains("'slgu' is not a declared variable"));
    }

    #[test]
    fn a_conditional_variable_binds_empty_rather_than_going_unbound() {
        let manifest = parse_template_manifest(MANIFEST).expect("manifest");
        let values =
            resolve_variables(&manifest, &supplied(&[("slug", "my-agent")])).expect("values");
        // Bound, not absent: a payload naming it must still render with the
        // feature off, and there are no conditionals to guard the reference.
        assert_eq!(
            values.get("mcp_backend_url"),
            Some(&VariableValue::String(String::new()))
        );

        let enabled = resolve_variables(
            &manifest,
            &supplied(&[
                ("slug", "my-agent"),
                ("use_mcp", "true"),
                ("mcp_backend_url", "https://x"),
            ]),
        )
        .expect("values");
        assert_eq!(
            enabled.get("mcp_backend_url").map(VariableValue::as_text),
            Some("https://x".to_string())
        );
    }

    #[test]
    fn a_missing_value_with_no_default_is_refused() {
        let manifest =
            parse_template_manifest("version: 1\nvariables:\n  - name: slug\n").expect("manifest");
        let error = resolve_variables(&manifest, &BTreeMap::new()).expect_err("refused");
        assert!(error.message().contains("no value and no default"));
    }

    #[test]
    fn a_manifest_declaring_a_variable_twice_is_refused() {
        let error = parse_template_manifest(
            "version: 1\nvariables:\n  - name: slug\n    default: a\n  - name: slug\n    default: b\n",
        )
        .expect_err("refused");
        assert!(error.message().contains("twice"));
    }

    #[test]
    fn a_when_naming_a_non_boolean_is_refused() {
        let error = parse_template_manifest(
            "version: 1\nvariables:\n  - name: mode\n    default: \"false\"\n  - name: url\n    when: mode\n    default: x\n",
        )
        .expect_err("refused");
        assert!(
            error.message().contains("not a boolean"),
            "{}",
            error.message()
        );
    }

    #[test]
    fn a_future_manifest_version_is_refused() {
        let error = parse_template_manifest("version: 2\n").expect_err("refused");
        assert!(error.message().contains("does not understand"));
    }

    #[test]
    fn an_unclosed_token_is_refused() {
        let values = BTreeMap::new();
        let error = substitute("{{ unclosed", &values).expect_err("refused");
        assert!(error.message().contains("unclosed"));
    }
}

/// Make the rendered Recipe answer to `slug`, whatever the template did.
///
/// The platform derives a Runtime group's identity from the manifest's
/// filename, so a Recipe seeded for a group named `x` must carry
/// `.introspection/x.yaml` or its first push matches no row and versions
/// nothing — silently, because nothing is wrong with either side on its own.
///
/// A template that declares `slug` and names its manifest for it has already
/// done this, and the call is a no-op. One that does not — an ordinary Recipe
/// repository someone chose as a starting point — is corrected here. That is
/// the whole reason both mechanisms exist: rendering is what a template opts
/// into, and identity is what the caller is owed regardless.
pub fn ensure_identity(
    files: &RecipeFiles,
    slug: &str,
    name: Option<&str>,
) -> Result<RecipeFiles, TemplateError> {
    let prefix = ".introspection/";
    let wanted = format!("{prefix}{slug}.yaml");
    let mut manifests = files.files.iter().filter(|file| {
        file.path.strip_prefix(prefix).is_some_and(|rest| {
            !rest.contains('/') && (rest.ends_with(".yaml") || rest.ends_with(".yml"))
        })
    });
    let Some(manifest) = manifests.next() else {
        return Ok(files.clone());
    };
    if manifests.next().is_some() {
        return Err(TemplateError::new(
            "the Recipe declares more than one Runtime manifest, so which one names it is ambiguous",
        ));
    }
    let display = name.unwrap_or(slug);
    // The manifest's own `path:` says where the package sits beside it.
    let package_dir = manifest
        .content
        .as_deref()
        .and_then(manifest_path_value)
        .unwrap_or_else(|| ".".to_string());
    let package_path = if package_dir == "." || package_dir.is_empty() {
        "package.json".to_string()
    } else {
        format!("{}/package.json", package_dir.trim_end_matches('/'))
    };

    let mut out = files.clone();
    for file in &mut out.files {
        if file.path == manifest.path {
            if let Some(content) = file.content.as_deref() {
                file.content = Some(rename_in_manifest(content, display));
            }
            file.path = wanted.clone();
        } else if file.path == package_path {
            if let Some(content) = file.content.as_deref() {
                file.content = Some(rename_package(content, slug));
            }
        }
    }
    Ok(out)
}

/// The manifest's `path:` scalar, ignoring quotes and any trailing comment.
fn manifest_path_value(text: &str) -> Option<String> {
    let raw = text.lines().find_map(|line| line.strip_prefix("path:"))?;
    let trimmed = raw.trim();
    for quote in ['\'', '"'] {
        if let Some(rest) = trimmed.strip_prefix(quote) {
            if let Some(end) = rest.find(quote) {
                return Some(rest[..end].to_string());
            }
        }
    }
    Some(match trimmed.find(" #") {
        Some(at) => trimmed[..at].trim_end().to_string(),
        None => trimmed.to_string(),
    })
}

/// Point `package.json` at the new Recipe.
///
/// Rewrites the value in place rather than reserialising: a JSON round trip
/// reorders keys and reflows the file, so the first diff an author saw of
/// their own Recipe would be noise they did not write.
fn rename_package(contents: &str, slug: &str) -> String {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(contents) else {
        return contents.to_string();
    };
    let Some(current) = parsed.get("name").and_then(serde_json::Value::as_str) else {
        return contents.to_string();
    };
    let Some(value_at) = root_name_key_end(contents) else {
        return contents.to_string();
    };
    let (head, tail) = contents.split_at(value_at);
    format!(
        "{head}{}",
        tail.replacen(&format!("\"{current}\""), &format!("\"{slug}\""), 1)
    )
}

/// Byte offset just past the *root* object's `"name"` key.
///
/// Depth-tracking rather than the first `"name"` token: a Recipe that
/// describes itself in a nested object can hold an earlier one, and rewriting
/// from there renames something that is not the package while leaving the
/// package itself untouched — a silent wrong answer.
fn root_name_key_end(contents: &str) -> Option<usize> {
    let bytes = contents.as_bytes();
    let (mut depth, mut index) = (0usize, 0usize);
    while index < bytes.len() {
        match bytes[index] {
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth = depth.saturating_sub(1),
            b'"' => {
                let start = index + 1;
                let mut end = start;
                while end < bytes.len() && bytes[end] != b'"' {
                    end += if bytes[end] == b'\\' { 2 } else { 1 };
                }
                if end >= bytes.len() {
                    return None;
                }
                if depth == 1 && &contents[start..end] == "name" {
                    return Some(end + 1);
                }
                index = end;
            }
            _ => {}
        }
        index += 1;
    }
    None
}

/// Rewrite the manifest's `name:`, leaving every other line as written.
fn rename_in_manifest(text: &str, name: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut renamed = false;
    for line in text.lines() {
        if !renamed && line.starts_with("name:") {
            out.push_str(&format!("name: {name}\n"));
            renamed = true;
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !renamed {
        out.push_str(&format!("name: {name}\n"));
    }
    out
}

#[cfg(test)]
mod identity_tests {
    use super::*;

    fn recipe(manifest_path: &str, manifest: &str) -> RecipeFiles {
        RecipeFiles {
            files: vec![
                RecipeFile::new(manifest_path, manifest),
                RecipeFile::new("package.json", "{\"name\":\"x\"}"),
            ],
            directories: vec![],
        }
    }

    fn paths(files: &RecipeFiles) -> Vec<&str> {
        files.files.iter().map(|f| f.path.as_str()).collect()
    }

    #[test]
    fn renames_a_manifest_a_template_did_not_template() {
        let out = ensure_identity(
            &recipe(
                ".introspection/coding-agent.yaml",
                "name: coding-agent\npath: .\n",
            ),
            "my-agent",
            None,
        )
        .expect("identity");
        assert!(paths(&out).contains(&".introspection/my-agent.yaml"));
        let manifest = out.files[0].content.clone().unwrap();
        assert!(manifest.contains("name: my-agent"));
    }

    #[test]
    fn is_a_no_op_when_the_template_already_named_it() {
        // A template that declared `slug` and named both its manifest and its
        // package for it is already correct, and nothing is rewritten.
        let already = RecipeFiles {
            files: vec![
                RecipeFile::new(".introspection/my-agent.yaml", "name: my-agent\npath: .\n"),
                RecipeFile::new("package.json", "{\"name\":\"my-agent\"}"),
            ],
            directories: vec![],
        };
        let out = ensure_identity(&already, "my-agent", None).expect("identity");
        assert_eq!(out, already);
    }

    #[test]
    fn keeps_a_display_name_distinct_from_the_slug() {
        let out = ensure_identity(
            &recipe(
                ".introspection/coding-agent.yaml",
                "name: coding-agent\npath: .\n",
            ),
            "my-agent",
            Some("My Agent"),
        )
        .expect("identity");
        assert!(paths(&out).contains(&".introspection/my-agent.yaml"));
        assert!(out.files[0]
            .content
            .as_deref()
            .unwrap()
            .contains("name: My Agent"));
    }

    #[test]
    fn renames_the_package_beside_the_manifest() {
        let out = ensure_identity(
            &recipe(
                ".introspection/coding-agent.yaml",
                "name: coding-agent\npath: .\n",
            ),
            "my-agent",
            None,
        )
        .expect("identity");
        let package = out
            .files
            .iter()
            .find(|f| f.path == "package.json")
            .and_then(|f| f.content.as_deref())
            .expect("package");
        assert!(package.contains("\"my-agent\""), "{package}");
    }

    #[test]
    fn finds_the_package_through_the_manifest_path() {
        let mut files = recipe(
            ".introspection/coding-agent.yaml",
            "name: coding-agent\npath: 'packages/app' # where it lives\n",
        );
        files.files[1] =
            RecipeFile::new("packages/app/package.json", "{\"name\":\"coding-agent\"}");
        let out = ensure_identity(&files, "my-agent", None).expect("identity");
        let package = out
            .files
            .iter()
            .find(|f| f.path == "packages/app/package.json")
            .and_then(|f| f.content.as_deref())
            .expect("package");
        assert_eq!(package, "{\"name\":\"my-agent\"}");
    }

    #[test]
    fn renames_the_root_package_not_an_earlier_nested_one() {
        let mut files = recipe(
            ".introspection/coding-agent.yaml",
            "name: coding-agent\npath: .\n",
        );
        files.files[1] = RecipeFile::new(
            "package.json",
            "{\n  \"scripts\": {\"name\": \"coding-agent-build\"},\n  \"name\": \"coding-agent\"\n}",
        );
        let out = ensure_identity(&files, "my-agent", None).expect("identity");
        let package: serde_json::Value = serde_json::from_str(
            out.files
                .iter()
                .find(|f| f.path == "package.json")
                .and_then(|f| f.content.as_deref())
                .expect("package"),
        )
        .expect("valid json");
        assert_eq!(
            package.get("name").and_then(|v| v.as_str()),
            Some("my-agent")
        );
        assert_eq!(
            package.pointer("/scripts/name").and_then(|v| v.as_str()),
            Some("coding-agent-build"),
            "the nested value is not the package name"
        );
    }

    #[test]
    fn a_recipe_with_no_manifest_is_left_alone() {
        let bare = RecipeFiles {
            files: vec![RecipeFile::new("package.json", "{}")],
            directories: vec![],
        };
        assert_eq!(
            ensure_identity(&bare, "my-agent", None).expect("identity"),
            bare
        );
    }

    #[test]
    fn two_manifests_are_refused_rather_than_guessed() {
        let mut files = recipe(".introspection/a.yaml", "name: a\npath: .\n");
        files.files.push(RecipeFile::new(
            ".introspection/b.yaml",
            "name: b\npath: .\n",
        ));
        assert!(ensure_identity(&files, "my-agent", None).is_err());
    }
}

#[cfg(test)]
mod review_tests {
    use super::*;

    const OPTIONAL: &str = r#"
version: 1
variables:
  - name: slug
    type: string
  - name: use_mcp
    type: boolean
    default: "false"
  - name: mcp_backend_url
    type: string
    when: use_mcp
    default: ""
  - name: mcp_port
    type: integer
    when: use_mcp
"#;

    fn repo(content: &str) -> RecipeFiles {
        RecipeFiles {
            files: vec![
                RecipeFile::new("template.yaml", OPTIONAL),
                RecipeFile::new("template/mcp.json.tmpl", content),
            ],
            directories: vec![],
        }
    }

    fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn the_off_branch_of_an_optional_feature_still_renders() {
        let manifest = parse_template_manifest(OPTIONAL).expect("manifest");
        let resolved =
            resolve_variables(&manifest, &values(&[("slug", "my-agent")])).expect("resolve");
        let out = render_template(
            &repo("{\"url\":\"{{ mcp_backend_url }}\",\"port\":{{ mcp_port }}}"),
            &resolved,
        )
        .expect("an inactive variable still binds");
        assert_eq!(
            out.files[0].content.as_deref(),
            Some("{\"url\":\"\",\"port\":0}")
        );
    }

    #[test]
    fn an_inactive_variable_needs_no_default() {
        let manifest = parse_template_manifest(OPTIONAL).expect("manifest");
        // `mcp_port` declares no default and is not supplied; it is only
        // required when the feature it belongs to is on.
        let resolved =
            resolve_variables(&manifest, &values(&[("slug", "my-agent")])).expect("resolve");
        assert_eq!(resolved.get("mcp_port"), Some(&VariableValue::Integer(0)));
    }

    #[test]
    fn an_active_variable_with_no_default_is_still_required() {
        let manifest = parse_template_manifest(OPTIONAL).expect("manifest");
        let error = resolve_variables(&manifest, &values(&[("slug", "x"), ("use_mcp", "true")]))
            .expect_err("mcp_port is required once the feature is on");
        assert!(error.message().contains("no value and no default"));
    }

    #[test]
    fn a_multibyte_character_at_the_snippet_boundary_does_not_panic() {
        // 59 ASCII bytes, then a character that straddles byte offset 60.
        let line = format!("{}é {{{{ nope }}}}", "x".repeat(59));
        let error = substitute(&line, &BTreeMap::new()).expect_err("undeclared");
        assert!(error.message().contains("nope"));
    }
}
