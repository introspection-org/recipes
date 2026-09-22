//! Typed specification for authored Recipe judges.
//!
//! This module is the exported, typed form of the portable `judges/*.yaml`
//! contract that [`crate::check_recipe_files`] validates diagnostically. It
//! owns the spec and nothing else: strict parsing, the authored validation
//! rules, and spec-level normalization (defaults applied, `on: null`
//! canonicalized to `{}`).
//!
//! Platform concerns deliberately live elsewhere: project-scoped identity,
//! registry hashing, transcript assembly, gate evaluation, and model calls
//! belong to the Introspection runtime judge engine, which consumes and
//! extends these types.
//!
//! Unlike recipe checking, parsing is strict: any invalid definition fails
//! the whole batch with a [`JudgeSpecError`] instead of a diagnostic report.

use std::collections::{BTreeSet, HashSet};
use std::fmt;

use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const DEFAULT_JUDGE_TIMEOUT_MS: u64 = 60_000;
pub const DEFAULT_MAX_RETRY_DELAY_MS: u64 = 5_000;
pub const MAX_JUDGE_OUTPUT_TOKENS: u64 = 131_072;

/// Error raised for the whole batch when any judge source is invalid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JudgeSpecError(String);

impl JudgeSpecError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for JudgeSpecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for JudgeSpecError {}

macro_rules! spec_bail {
    ($($arg:tt)*) => {
        return Err(JudgeSpecError::new(format!($($arg)*)))
    };
}

/// One authored judge definition, in its normalized spec form.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct JudgeDefinition {
    /// Unique judge name within the recipe (at most 255 characters).
    #[serde(alias = "judge")]
    #[cfg_attr(feature = "schema", schemars(length(max = 255), pattern(r"\S")))]
    pub name: String,
    /// Optional human description (at most 2000 characters).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "schema", schemars(length(max = 2000)))]
    pub description: Option<String>,
    /// Applicability gate: `{}` (always) or a list of
    /// `{ event, match? }` matchers where `event` is one of
    /// `message`, `tool`, or `feedback`.
    #[serde(default)]
    #[cfg_attr(feature = "schema", schemars(schema_with = "gate_schema"))]
    pub on: Value,
    /// Model configuration used to run the judge.
    pub llm: JudgeLlmConfig,
    /// The grading rubric. Required and non-empty.
    // `Option` only so strict parsing can report a spec-level "empty
    // instructions" error instead of a serde missing-field error; the
    // exported schema requires a non-empty string (see
    // `judge_definition_json_schema`), and normalized definitions always
    // carry one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "schema", schemars(schema_with = "instructions_schema"))]
    pub instructions: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct JudgeLlmConfig {
    /// Provider slug (lowercase ASCII, digits, and `-`). Defaults to `openai`.
    #[serde(default = "default_provider")]
    #[cfg_attr(feature = "schema", schemars(pattern(r"^[a-z0-9-]{1,64}$")))]
    pub provider: String,
    /// Model name. Required and non-empty (at most 255 bytes), with no
    /// surrounding whitespace.
    #[cfg_attr(
        feature = "schema",
        schemars(length(min = 1, max = 255), pattern(r"^\S([\s\S]*\S)?$"))
    )]
    pub model: String,
    #[serde(default)]
    pub request: JudgeLlmRequest,
    #[serde(default)]
    pub transport: JudgeLlmTransport,
    /// Optional OpenAI-compatible local/self-hosted endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<JudgeLlmLocal>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct JudgeLlmRequest {
    /// Sampling temperature between 0 and 2. Defaults to 0.
    #[serde(default)]
    #[cfg_attr(feature = "schema", schemars(range(min = 0.0, max = 2.0)))]
    pub temperature: f64,
    /// Maximum output tokens (1..=131072).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "schema", schemars(range(min = 1, max = 131_072)))]
    pub max_tokens: Option<u64>,
    /// Reasoning effort hint (lowercase ASCII and `-`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "schema", schemars(pattern(r"^[a-z-]{1,64}$")))]
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct JudgeLlmTransport {
    /// Request timeout in milliseconds (1..=600000). Defaults to 60000.
    #[serde(default = "default_timeout_ms")]
    #[cfg_attr(feature = "schema", schemars(range(min = 1, max = 600_000)))]
    pub timeout_ms: u64,
    /// Retry attempts (0..=10). Defaults to 0.
    #[serde(default)]
    #[cfg_attr(feature = "schema", schemars(range(max = 10)))]
    pub max_retries: u64,
    /// Exponential backoff cap in milliseconds (..=60000). Defaults to 5000.
    #[serde(default = "default_max_retry_delay_ms")]
    #[cfg_attr(feature = "schema", schemars(range(max = 60_000)))]
    pub max_retry_delay_ms: u64,
}

impl Default for JudgeLlmTransport {
    fn default() -> Self {
        Self {
            timeout_ms: DEFAULT_JUDGE_TIMEOUT_MS,
            max_retries: 0,
            max_retry_delay_ms: DEFAULT_MAX_RETRY_DELAY_MS,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct JudgeLlmLocal {
    /// HTTP(S) base URL; HTTPS required outside loopback. No credentials,
    /// query, or fragment.
    #[cfg_attr(feature = "schema", schemars(pattern(r"^https?://\S+$")))]
    pub base_url: String,
    /// Environment variable naming the API key (identifier characters only).
    #[cfg_attr(feature = "schema", schemars(pattern(r"^[A-Za-z_][A-Za-z0-9_]*$")))]
    pub api_key_env: String,
}

fn default_provider() -> String {
    "openai".to_string()
}

fn default_timeout_ms() -> u64 {
    DEFAULT_JUDGE_TIMEOUT_MS
}

fn default_max_retry_delay_ms() -> u64 {
    DEFAULT_MAX_RETRY_DELAY_MS
}

/// One raw judge YAML source to parse.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct JudgeSource {
    pub path: String,
    pub content: String,
}

/// One parsed source: its path and the normalized definition.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ParsedJudgeDefinition {
    pub source_path: String,
    pub definition: JudgeDefinition,
}

/// Strictly parse authored judge YAML sources into normalized definitions.
///
/// Sources are processed in path order. Any invalid definition (malformed
/// YAML, unknown fields, empty instructions, duplicate names across the
/// batch, invalid llm config or gate) fails the whole batch.
pub fn parse_judge_definitions(
    sources: &[JudgeSource],
) -> Result<Vec<ParsedJudgeDefinition>, JudgeSpecError> {
    let mut ordered = sources.to_vec();
    ordered.sort_by(|a, b| a.path.cmp(&b.path));
    let mut seen = HashSet::new();
    let mut parsed = Vec::with_capacity(ordered.len());
    for source in ordered {
        let definition: JudgeDefinition = match serde_saphyr::from_str(&source.content) {
            Ok(definition) => definition,
            Err(err) => spec_bail!("parsing judge YAML {}: {err}", source.path),
        };
        let definition =
            normalize_judge_definition(definition, &format!("judge YAML {}", source.path))?;
        if !seen.insert(definition.name.clone()) {
            spec_bail!("duplicate judge name {:?}", definition.name);
        }
        parsed.push(ParsedJudgeDefinition {
            source_path: source.path,
            definition,
        });
    }
    Ok(parsed)
}

/// Validate one definition against the authored contract and apply spec
/// normalization (`on: null` becomes `{}`).
pub fn normalize_judge_definition(
    mut definition: JudgeDefinition,
    context: &str,
) -> Result<JudgeDefinition, JudgeSpecError> {
    if definition.on.is_null() {
        definition.on = json!({});
    }
    if definition.name.trim().is_empty() {
        spec_bail!("{context} has an empty judge name");
    }
    if !is_portable_name(&definition.name) {
        spec_bail!("{context} judge name must use lowercase kebab-case");
    }
    if definition.name.chars().count() > 255 {
        spec_bail!("{context} has a judge name longer than 255 characters");
    }
    if definition
        .description
        .as_deref()
        .is_some_and(|description| description.chars().count() > 2_000)
    {
        spec_bail!("{context} has a description longer than 2000 characters");
    }
    if definition
        .instructions
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        spec_bail!("{context} has empty instructions");
    }
    validate_llm_config(context, &definition.llm)?;
    validate_gate(&definition.on)?;
    Ok(definition)
}

fn is_portable_name(name: &str) -> bool {
    !name.is_empty()
        && name.split('-').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        })
}

fn validate_llm_config(context: &str, llm: &JudgeLlmConfig) -> Result<(), JudgeSpecError> {
    let provider = llm.provider.trim();
    if provider.is_empty()
        || provider.len() > 64
        || provider
            .chars()
            .any(|ch| !(ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-'))
    {
        spec_bail!("{context} has invalid llm.provider");
    }
    if llm.model.trim().is_empty() || llm.model.len() > 255 || llm.model != llm.model.trim() {
        spec_bail!("{context} has invalid llm.model");
    }
    if !llm.request.temperature.is_finite() || !(0.0..=2.0).contains(&llm.request.temperature) {
        spec_bail!("{context} llm.request.temperature must be between 0 and 2");
    }
    if llm
        .request
        .max_tokens
        .is_some_and(|value| !(1..=MAX_JUDGE_OUTPUT_TOKENS).contains(&value))
    {
        spec_bail!(
            "{context} llm.request.max_tokens must be between 1 and {MAX_JUDGE_OUTPUT_TOKENS}"
        );
    }
    if llm
        .request
        .reasoning_effort
        .as_deref()
        .is_some_and(|value| {
            value.is_empty()
                || value.len() > 64
                || value
                    .chars()
                    .any(|ch| !(ch.is_ascii_lowercase() || ch == '-'))
        })
    {
        spec_bail!("{context} has invalid llm.request.reasoning_effort");
    }
    if !(1..=600_000).contains(&llm.transport.timeout_ms) {
        spec_bail!("{context} llm.transport.timeout_ms must be between 1 and 600000");
    }
    if llm.transport.max_retries > 10 {
        spec_bail!("{context} llm.transport.max_retries exceeds the limit of 10");
    }
    if llm.transport.max_retry_delay_ms > 60_000 {
        spec_bail!(
            "{context} llm.transport.max_retry_delay_ms exceeds the 60000 millisecond limit"
        );
    }
    if let Some(local) = &llm.local {
        let url = match url::Url::parse(&local.base_url) {
            Ok(url) => url,
            Err(err) => spec_bail!("{context} has invalid llm.local.base_url: {err}"),
        };
        if url.host_str().is_none() || !matches!(url.scheme(), "http" | "https") {
            spec_bail!("{context} llm.local.base_url must be an HTTP(S) URL with a host");
        }
        if !url.username().is_empty() || url.password().is_some() {
            spec_bail!("{context} llm.local.base_url must not contain credentials");
        }
        if url.query().is_some() || url.fragment().is_some() {
            spec_bail!("{context} llm.local.base_url must not contain a query or fragment");
        }
        let loopback = match url.host() {
            Some(url::Host::Domain(host)) => host == "localhost",
            Some(url::Host::Ipv4(host)) => host == std::net::Ipv4Addr::LOCALHOST,
            Some(url::Host::Ipv6(host)) => host == std::net::Ipv6Addr::LOCALHOST,
            None => false,
        };
        if url.scheme() != "https" && !loopback {
            spec_bail!("{context} llm.local.base_url must use HTTPS outside localhost");
        }
        let mut chars = local.api_key_env.chars();
        if !chars
            .next()
            .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
            || chars.any(|ch| !(ch.is_ascii_alphanumeric() || ch == '_'))
        {
            spec_bail!("{context} has invalid llm.local.api_key_env");
        }
    }
    Ok(())
}

fn validate_gate(on: &Value) -> Result<(), JudgeSpecError> {
    if on.is_null() || on.as_object().is_some_and(Map::is_empty) {
        return Ok(());
    }
    let Some(matchers) = on.as_array() else {
        spec_bail!("judge `on` must be a list of event matchers");
    };
    for matcher in matchers {
        let Some(object) = matcher.as_object() else {
            spec_bail!("each `on` entry must be `{{ event, match? }}`");
        };
        let Some(event) = object.get("event").and_then(Value::as_str) else {
            spec_bail!("each `on` entry must be `{{ event, match? }}`");
        };
        if !matches!(event, "message" | "tool" | "feedback") {
            spec_bail!("unknown judge gate event {event:?}");
        }
        if object.keys().any(|key| key != "event" && key != "match") {
            spec_bail!("unknown key in judge gate event matcher");
        }
        if object.get("match").is_some_and(|value| !value.is_object()) {
            spec_bail!("`match` must be a mapping of field paths to values");
        }
        if let Some(spec) = object.get("match").and_then(Value::as_object) {
            for (path, target) in spec {
                if path.is_empty() {
                    spec_bail!("judge gate match field paths must not be empty");
                }
                if matches!(path.as_str(), "environment" | "runtime_group") {
                    spec_bail!(
                        "judge gate field {path:?} is automatic platform context; gate on conversation content"
                    );
                }
                if path.split('.').next_back() == Some("pattern_id") {
                    spec_bail!("judge gate must not reference pattern_id");
                }
                validate_match_target(target)?;
            }
        }
    }
    Ok(())
}

fn validate_match_target(target: &Value) -> Result<(), JudgeSpecError> {
    match target {
        Value::Array(values) => {
            for value in values {
                validate_match_target(value)?;
            }
        }
        Value::String(value) => {
            if let Some((pattern, flags)) = regex_literal(value)? {
                let mut builder = RegexBuilder::new(pattern);
                builder.case_insensitive(flags.contains('i'));
                builder.multi_line(flags.contains('m'));
                builder.dot_matches_new_line(flags.contains('s'));
                if let Err(err) = builder.build() {
                    spec_bail!("invalid regex {value:?}: {err}");
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn regex_literal(value: &str) -> Result<Option<(&str, &str)>, JudgeSpecError> {
    if !value.starts_with('/') {
        return Ok(None);
    }
    let Some(index) = value.rfind('/') else {
        return Ok(None);
    };
    if index == 0 {
        return Ok(None);
    }
    let flags = &value[index + 1..];
    if !flags
        .chars()
        .all(|flag| matches!(flag, 'i' | 'm' | 's' | 'u'))
    {
        spec_bail!("unsupported regex flags in {value:?}; contract 1 supports i, m, s, and u");
    }
    let mut seen = BTreeSet::new();
    if !flags.chars().all(|flag| seen.insert(flag)) {
        spec_bail!("duplicate regex flag in {value:?}");
    }
    Ok(Some((&value[1..index], flags)))
}

/// JSON Schema for the authored judge definition, for authoring tools and
/// agents discovering how to write `judges/*.yaml`.
///
/// The schema encodes every authored constraint JSON Schema can express —
/// required non-blank `instructions` (its `Option` is internal, for
/// friendlier parse errors), name/description lengths, provider/model/effort
/// shapes, and numeric ranges — so schema-valid definitions parse strictly.
/// A few rules remain parser-only because a per-document schema cannot
/// express them: batch-level judge-name uniqueness; the semantic
/// `llm.local.base_url` rules (no credentials, query, or fragment; HTTPS
/// outside loopback) beyond the basic `http(s)://` pattern; regex-literal
/// flag validity in gate `match` values; and `llm.model`'s 255 limit, which
/// the parser counts in UTF-8 bytes while `maxLength` counts characters.
#[cfg(feature = "schema")]
pub fn judge_definition_json_schema() -> String {
    let schema = schemars::schema_for!(JudgeDefinition);
    let mut value = serde_json::to_value(&schema).expect("judge schema serializes");
    let required = value["required"]
        .as_array_mut()
        .expect("judge schema has required fields");
    let instructions = serde_json::json!("instructions");
    if !required.contains(&instructions) {
        required.push(instructions);
    }
    serde_json::to_string_pretty(&value).expect("judge schema serializes")
}

#[cfg(feature = "schema")]
fn instructions_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({
        "description": "The grading rubric. Required and non-empty.",
        "type": "string",
        "minLength": 1,
        "pattern": r"\S"
    })
}

#[cfg(feature = "schema")]
fn gate_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({
        "description": "Applicability gate: {} (always) or a list of { event, match? } matchers; event is one of message, tool, feedback",
        "anyOf": [
            { "type": "object", "maxProperties": 0 },
            { "type": "null" },
            {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["event"],
                    "additionalProperties": false,
                    "properties": {
                        "event": { "type": "string", "enum": ["message", "tool", "feedback"] },
                        "match": {
                            "type": "object",
                            "additionalProperties": true,
                            "propertyNames": {
                                "allOf": [
                                    { "minLength": 1 },
                                    { "not": { "enum": ["environment", "runtime_group"] } },
                                    { "not": { "pattern": "(?:^|\\.)pattern_id$" } }
                                ]
                            }
                        }
                    }
                }
            }
        ]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{check_recipe_files, RecipeFile, RecipeFiles};

    fn source(path: &str, content: &str) -> JudgeSource {
        JudgeSource {
            path: path.into(),
            content: content.into(),
        }
    }

    const HELPFUL_JUDGE: &str = "\
name: helpful
description: Scores whether the assistant actually helped.
instructions: |
  Judge whether the assistant resolved the user's request.
llm:
  model: gpt-5
";

    #[test]
    fn parses_sorted_and_applies_spec_defaults() {
        let sources = [
            source(
                "judges/b.yaml",
                "name: b\ninstructions: Grade b.\nllm:\n  model: gpt-5\n",
            ),
            source(
                "judges/a.yaml",
                "name: a\ninstructions: Grade a.\nllm:\n  model: gpt-5\n",
            ),
        ];
        let parsed = parse_judge_definitions(&sources).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].source_path, "judges/a.yaml");
        assert_eq!(parsed[1].source_path, "judges/b.yaml");

        let definition = &parsed[0].definition;
        assert_eq!(definition.llm.provider, "openai");
        assert_eq!(definition.llm.request.temperature, 0.0);
        assert_eq!(
            definition.llm.transport.timeout_ms,
            DEFAULT_JUDGE_TIMEOUT_MS
        );
        assert_eq!(definition.on, json!({}));
    }

    #[test]
    fn normalized_definition_serializes_without_absent_options() {
        let parsed = parse_judge_definitions(&[source(
            "judges/a.yaml",
            "name: a\ninstructions: Grade a.\nllm:\n  model: gpt-5\n",
        )])
        .unwrap();
        let value = serde_json::to_value(&parsed[0].definition).unwrap();
        assert_eq!(
            value,
            json!({
                "name": "a",
                "on": {},
                "llm": {
                    "provider": "openai",
                    "model": "gpt-5",
                    "request": { "temperature": 0.0 },
                    "transport": {
                        "timeout_ms": 60000,
                        "max_retries": 0,
                        "max_retry_delay_ms": 5000
                    }
                },
                "instructions": "Grade a.",
            })
        );
    }

    #[test]
    fn legacy_judge_field_normalizes_to_name_and_conflicts_fail() {
        let parsed = parse_judge_definitions(&[source(
            "judges/legacy.yaml",
            "judge: legacy\ninstructions: Grade.\nllm:\n  model: gpt-5\n",
        )])
        .unwrap();
        assert_eq!(parsed[0].definition.name, "legacy");
        assert_eq!(
            serde_json::to_value(&parsed[0].definition).unwrap()["name"],
            "legacy"
        );

        let conflict = parse_judge_definitions(&[source(
            "judges/conflict.yaml",
            "name: current\njudge: legacy\ninstructions: Grade.\nllm:\n  model: gpt-5\n",
        )])
        .unwrap_err()
        .to_string();
        assert!(conflict.contains("duplicate field"), "{conflict}");
    }

    #[test]
    fn accepts_explicit_null_optional_request_fields_and_gate_events() {
        let content = "\
name: g
instructions: Grade.
on:
  - event: tool
    match:
      name: apply_discount
      text: /AssertionError/i
llm:
  model: gpt-5
  request:
    max_tokens: null
    reasoning_effort: null
";
        parse_judge_definitions(&[source("judges/g.yaml", content)]).unwrap();
    }

    #[test]
    fn rejects_duplicates_unknown_fields_and_empty_instructions() {
        let duplicate = [
            source("judges/a.yaml", HELPFUL_JUDGE),
            source("judges/b.yaml", HELPFUL_JUDGE),
        ];
        let error = parse_judge_definitions(&duplicate).unwrap_err().to_string();
        assert!(error.contains("duplicate judge name"), "{error}");

        for invalid_name in ["DeepWiki", "deep_wiki", "deep--wiki", " deepwiki"] {
            let invalid = [source(
                "judges/invalid-name.yaml",
                &format!(
                    "name: {invalid_name:?}\ninstructions: Grade.\nllm:\n  model: gpt-5\n"
                ),
            )];
            let error = parse_judge_definitions(&invalid).unwrap_err().to_string();
            assert!(error.contains("lowercase kebab-case"), "{error}");
        }

        let unknown = [source(
            "judges/typo.yaml",
            &format!("{HELPFUL_JUDGE}surprise: true\n"),
        )];
        let error = parse_judge_definitions(&unknown).unwrap_err().to_string();
        assert!(error.contains("judges/typo.yaml"), "{error}");

        let empty = [source(
            "judges/empty.yaml",
            "name: empty\nllm:\n  model: gpt-5\n",
        )];
        let error = parse_judge_definitions(&empty).unwrap_err().to_string();
        assert!(error.contains("empty instructions"), "{error}");
    }

    #[test]
    fn rejects_invalid_gates_and_llm_config() {
        let cases: &[(&str, &str)] = &[
            (
                "name: g\ninstructions: Grade.\non:\n  - event: deploy\nllm:\n  model: gpt-5\n",
                "unknown judge gate event",
            ),
            (
                "name: g\ninstructions: Grade.\non:\n  - event: message\n    match:\n      pattern_id: p\nllm:\n  model: gpt-5\n",
                "must not reference pattern_id",
            ),
            (
                "name: g\ninstructions: Grade.\non:\n  - event: message\n    match:\n      environment: prod\nllm:\n  model: gpt-5\n",
                "automatic platform context",
            ),
            (
                "name: g\ninstructions: Grade.\non:\n  - event: message\n    match:\n      text: /hello/g\nllm:\n  model: gpt-5\n",
                "unsupported regex flags",
            ),
            (
                "name: g\ninstructions: Grade.\nllm:\n  model: ''\n",
                "invalid llm.model",
            ),
            (
                "name: g\ninstructions: Grade.\nllm:\n  model: gpt-5\n  request:\n    temperature: 3\n",
                "temperature must be between 0 and 2",
            ),
            (
                "name: g\ninstructions: Grade.\nllm:\n  model: gpt-5\n  transport:\n    timeout_ms: 900000\n",
                "timeout_ms must be between 1 and 600000",
            ),
            (
                "name: g\ninstructions: Grade.\nllm:\n  model: gpt-5\n  local:\n    base_url: http://remote.example/v1\n    api_key_env: KEY\n",
                "must use HTTPS outside localhost",
            ),
            (
                "name: g\ninstructions: Grade.\nllm:\n  model: gpt-5\n  local:\n    base_url: https://remote.example/v1?key=x\n    api_key_env: KEY\n",
                "must not contain a query or fragment",
            ),
        ];
        for (content, expected) in cases {
            let error = parse_judge_definitions(&[source("judges/g.yaml", content)])
                .unwrap_err()
                .to_string();
            assert!(error.contains(expected), "{expected}: {error}");
        }
    }

    #[test]
    fn accepts_loopback_local_base_urls_including_bracketed_ipv6() {
        for base_url in [
            "http://localhost:4000/v1",
            "http://127.0.0.1:4000/v1",
            "http://[::1]:4000/v1",
            "https://api.example.com/v1",
        ] {
            let content = format!(
                "name: g\ninstructions: Grade.\nllm:\n  model: gpt-5\n  local:\n    base_url: {base_url}\n    api_key_env: MODEL_API_KEY\n"
            );
            parse_judge_definitions(&[source("judges/g.yaml", &content)])
                .unwrap_or_else(|error| panic!("{base_url}: {error}"));
        }
    }

    // The diagnostic validator and the strict spec parser accept the same
    // authored contract: a source producing judge error diagnostics must
    // fail spec parsing, and a diagnostics-clean source must parse.
    #[test]
    fn agrees_with_diagnostic_judge_validation() {
        let cases: &[&str] = &[
            HELPFUL_JUDGE,
            "name: g\ninstructions: Grade.\nllm:\n  model: gpt-5\n  request:\n    max_tokens: null\n",
            "name: g\ninstructions: Grade.\nllm:\n  model: gpt-5\n  local:\n    base_url: http://[::1]:4000/v1\n    api_key_env: MODEL_API_KEY\n",
            "name: g\nllm:\n  model: gpt-5\n",
            "name: g\ninstructions: Grade.\nllm:\n  model: ''\n",
            "name: g\ninstructions: Grade.\non:\n  - event: deploy\nllm:\n  model: gpt-5\n",
            &format!("{HELPFUL_JUDGE}surprise: true\n"),
        ];
        for content in cases {
            let report = check_recipe_files(&RecipeFiles {
                files: vec![
                    RecipeFile::new("package.json", "{\"name\":\"probe\",\"pi\":{}}"),
                    RecipeFile::new("judges/probe.yaml", *content),
                ],
                directories: vec![],
            });
            let diagnostics_reject = report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.starts_with("judge."));
            let spec_rejects =
                parse_judge_definitions(&[source("judges/probe.yaml", content)]).is_err();
            assert_eq!(
                diagnostics_reject, spec_rejects,
                "diagnostics and spec parse disagree on:\n{content}"
            );
        }
    }

    #[cfg(feature = "schema")]
    #[test]
    fn judge_schema_names_the_authored_fields() {
        let schema: Value = serde_json::from_str(&judge_definition_json_schema()).unwrap();
        let properties = schema["properties"].as_object().unwrap();
        for field in ["judge", "description", "on", "llm", "instructions"] {
            assert!(properties.contains_key(field), "missing {field}");
        }
        assert_eq!(schema["additionalProperties"], json!(false));
        let required = schema["required"].as_array().unwrap();
        for field in ["judge", "llm", "instructions"] {
            assert!(required.contains(&json!(field)), "{field} must be required");
        }
        // A schema-guided client must not be able to produce a definition
        // the strict parser rejects: instructions is a non-null, non-blank
        // string, and the scalar constraints mirror the parser's bounds.
        assert_eq!(properties["instructions"]["type"], json!("string"));
        assert_eq!(properties["instructions"]["minLength"], json!(1));
        assert_eq!(properties["instructions"]["pattern"], json!(r"\S"));
        assert_eq!(properties["name"]["maxLength"], json!(255));
        assert_eq!(properties["name"]["pattern"], json!(r"\S"));
        assert_eq!(properties["description"]["maxLength"], json!(2000));

        let llm = schema["$defs"]["JudgeLlmConfig"].as_object().unwrap();
        let model = &llm["properties"]["model"];
        assert_eq!(model["minLength"], json!(1));
        assert_eq!(model["maxLength"], json!(255));
        assert!(model["pattern"].is_string());
        assert_eq!(
            llm["properties"]["provider"]["pattern"],
            json!(r"^[a-z0-9-]{1,64}$")
        );

        let request = schema["$defs"]["JudgeLlmRequest"].as_object().unwrap();
        assert_eq!(request["properties"]["temperature"]["minimum"], json!(0.0));
        assert_eq!(request["properties"]["temperature"]["maximum"], json!(2.0));
        assert_eq!(
            request["properties"]["max_tokens"]["maximum"],
            json!(131_072)
        );

        let transport = schema["$defs"]["JudgeLlmTransport"].as_object().unwrap();
        assert_eq!(
            transport["properties"]["timeout_ms"]["maximum"],
            json!(600_000)
        );
        assert_eq!(transport["properties"]["max_retries"]["maximum"], json!(10));

        // Gate match property names mirror validate_gate's path rules.
        let matcher_names =
            &properties["on"]["anyOf"][2]["items"]["properties"]["match"]["propertyNames"]["allOf"];
        let constraints = matcher_names.as_array().unwrap();
        assert_eq!(constraints[0], json!({ "minLength": 1 }));
        assert_eq!(
            constraints[1],
            json!({ "not": { "enum": ["environment", "runtime_group"] } })
        );
        assert_eq!(
            constraints[2],
            json!({ "not": { "pattern": "(?:^|\\.)pattern_id$" } })
        );
    }
}
