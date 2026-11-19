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
//!
//! It also types the front matter of an eval case file, `evals/cases/<id>.md`
//! ([`EvalCase`], [`parse_eval_case`]) and the hash its approval records
//! ([`case_approval_hash`], [`eval_case_body`]). That parse is lenient where the
//! judge parse is strict: unknown keys are allowed, because the other
//! front-matter fields and the body are for people.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fmt;

use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// The default `llm.transport.timeout_ms` of the older `llm:` block.
const LLM_TIMEOUT_MS: u64 = 60_000;
/// The default `llm.transport.max_retry_delay_ms` of the older `llm:` block.
const LLM_MAX_RETRY_DELAY_MS: u64 = 5_000;
/// The most output tokens `llm.request.max_tokens` asks for.
pub(crate) const LLM_MAX_OUTPUT_TOKENS: u64 = 131_072;
/// The `llm.provider` an `llm:` block that names none runs on.
const LLM_DEFAULT_PROVIDER: &str = "openai";

/// The most questions one classifier judge asks.
pub const MAX_JUDGE_QUESTIONS: usize = 8;
/// The probability of `true` at which a classifier question passes, unless it
/// declares its own `threshold`.
pub const DEFAULT_JUDGE_QUESTION_THRESHOLD: f64 = 0.5;

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
    /// `online` (the default) judges every runtime conversation when it ends.
    /// A judge that grades only eval trials belongs to its eval suite, not to
    /// `judges/`.
    #[serde(rename = "type", default, skip_serializing_if = "JudgeType::is_online")]
    pub kind: JudgeType,
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
    /// The model that answers, declared as an agent's `ai:` block. An authored
    /// judge may declare the older `llm:` instead, which parsing maps to this.
    pub ai: JudgeAiConfig,
    /// The grading rubric of a judge a chat model answers. A judge declares
    /// this or `questions`, never both.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "schema", schemars(schema_with = "instructions_schema"))]
    pub instructions: Option<String>,
    /// The yes-or-no questions of a judge a classifier answers, by name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "classifier_questions_schema")
    )]
    pub questions: Option<BTreeMap<String, JudgeClassifierQuestion>>,
    /// How the judge's input is built: `builder: trajectory@1` with optional
    /// steps, template and options, as an agent's `input:`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
}

/// A judge's `ai:` block, with the keys of an agent's.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct JudgeAiConfig {
    /// `<provider>/<model_id>`.
    #[cfg_attr(feature = "schema", schemars(pattern(r"^[^\s:/]+/\S(.*\S)?$")))]
    pub model: String,
    /// Models tried in order when `model` fails, each `<provider>/<model_id>`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "schema", schemars(inner(pattern(r"^[^\s:/]+/\S(.*\S)?$"))))]
    pub fallbacks: Vec<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(
        feature = "schema",
        schemars(with = "String", pattern(r"^(off|minimal|low|medium|high|xhigh|max)$"))
    )]
    pub thinking_level: Option<String>,
    /// Provider options, in snake_case; host-owned ones are refused.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "Map<String, Value>"))]
    pub options: Option<Map<String, Value>>,
    /// Per-provider settings.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "Map<String, Value>"))]
    pub providers: Option<Value>,
}

/// A judge as authored: [`JudgeDefinition`] plus the older `llm:` model
/// block, which [`parse_judge_definitions`] maps to `ai:`. It is read only
/// here, and it is what the authored schema describes.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "JudgeDefinition")
)]
struct AuthoredJudgeDefinition {
    /// `online` (the default) judges every runtime conversation when it ends.
    /// A judge that grades only eval trials belongs to its eval suite, not to
    /// `judges/`.
    #[serde(rename = "type", default)]
    kind: JudgeType,
    /// Unique judge name within the recipe (at most 255 characters).
    #[serde(alias = "judge")]
    #[cfg_attr(feature = "schema", schemars(length(max = 255), pattern(r"\S")))]
    name: String,
    /// Optional human description (at most 2000 characters).
    #[serde(default)]
    #[cfg_attr(feature = "schema", schemars(length(max = 2000)))]
    description: Option<String>,
    /// Applicability gate: `{}` (always) or a list of
    /// `{ event, match? }` matchers where `event` is one of
    /// `message`, `tool`, or `feedback`.
    #[serde(default)]
    #[cfg_attr(feature = "schema", schemars(schema_with = "gate_schema"))]
    on: Value,
    /// The model that answers, declared as an agent's `ai:` block. A judge
    /// declares this or the older `llm:`, never both.
    #[serde(default, deserialize_with = "present")]
    #[cfg_attr(feature = "schema", schemars(with = "JudgeAiConfig"))]
    ai: Option<JudgeAiConfig>,
    /// The older model block, still read and mapped to `ai`. Prefer `ai`.
    #[serde(default)]
    #[cfg_attr(feature = "schema", schemars(with = "LlmBlock"))]
    llm: Option<LlmBlock>,
    /// The grading rubric of a judge a chat model answers. A judge declares
    /// this or `questions`, never both.
    #[serde(default)]
    #[cfg_attr(feature = "schema", schemars(schema_with = "instructions_schema"))]
    instructions: Option<String>,
    /// The yes-or-no questions of a judge a classifier answers, by name.
    #[serde(default)]
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "classifier_questions_schema")
    )]
    questions: Option<BTreeMap<String, JudgeClassifierQuestion>>,
    /// How the judge's input is built: `builder: trajectory@1` with optional
    /// steps, template and options, as an agent's `input:`.
    #[serde(default)]
    input: Option<Value>,
}

/// The older model block of a judge, mapped to [`JudgeAiConfig`] when a
/// judge is parsed.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
struct LlmBlock {
    /// Provider slug (lowercase ASCII, digits, and `-`). Defaults to `openai`.
    #[serde(default = "default_provider")]
    #[cfg_attr(feature = "schema", schemars(pattern(r"^[a-z0-9-]{1,64}$")))]
    provider: String,
    /// Model name. Required and non-empty (at most 255 bytes), with no
    /// surrounding whitespace.
    #[cfg_attr(
        feature = "schema",
        schemars(length(min = 1, max = 255), pattern(r"^\S([\s\S]*\S)?$"))
    )]
    model: String,
    #[serde(default)]
    request: LlmRequest,
    /// Read and dropped: the host owns timeouts and retries.
    #[serde(default)]
    transport: LlmTransport,
    /// An OpenAI-compatible local endpoint, which `ai:` cannot express: it is
    /// dropped with a warning.
    #[serde(default)]
    local: Option<LlmLocal>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
struct LlmRequest {
    /// Sampling temperature between 0 and 2. Defaults to 0, which leaves the
    /// model its own default.
    #[serde(default)]
    #[cfg_attr(feature = "schema", schemars(range(min = 0.0, max = 2.0)))]
    temperature: f64,
    /// Maximum output tokens (1..=131072).
    #[serde(default)]
    #[cfg_attr(feature = "schema", schemars(range(min = 1, max = 131_072)))]
    max_tokens: Option<u64>,
    /// Reasoning effort, read as `ai.thinking_level` (`none` is `off`).
    #[serde(default)]
    #[cfg_attr(
        feature = "schema",
        schemars(pattern(r"^(none|off|minimal|low|medium|high|xhigh|max)$"))
    )]
    reasoning_effort: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
struct LlmTransport {
    /// Request timeout in milliseconds (1..=600000). Defaults to 60000.
    #[serde(default = "default_timeout_ms")]
    #[cfg_attr(feature = "schema", schemars(range(min = 1, max = 600_000)))]
    timeout_ms: u64,
    /// Retry attempts (0..=10). Defaults to 0.
    #[serde(default)]
    #[cfg_attr(feature = "schema", schemars(range(max = 10)))]
    max_retries: u64,
    /// Exponential backoff cap in milliseconds (..=60000). Defaults to 5000.
    #[serde(default = "default_max_retry_delay_ms")]
    #[cfg_attr(feature = "schema", schemars(range(max = 60_000)))]
    max_retry_delay_ms: u64,
}

impl Default for LlmTransport {
    fn default() -> Self {
        Self {
            timeout_ms: LLM_TIMEOUT_MS,
            max_retries: 0,
            max_retry_delay_ms: LLM_MAX_RETRY_DELAY_MS,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
// Read only so a malformed endpoint is refused; `ai:` cannot express it.
#[allow(dead_code)]
struct LlmLocal {
    /// HTTP(S) base URL; HTTPS required outside loopback. No credentials,
    /// query, or fragment.
    #[cfg_attr(feature = "schema", schemars(pattern(r"^https?://\S+$")))]
    base_url: String,
    /// Environment variable naming the API key (identifier characters only).
    #[cfg_attr(feature = "schema", schemars(pattern(r"^[A-Za-z_][A-Za-z0-9_]*$")))]
    api_key_env: String,
}

fn default_provider() -> String {
    LLM_DEFAULT_PROVIDER.to_owned()
}

fn default_timeout_ms() -> u64 {
    LLM_TIMEOUT_MS
}

fn default_max_retry_delay_ms() -> u64 {
    LLM_MAX_RETRY_DELAY_MS
}

/// The `ai.thinking_level` an `llm.request.reasoning_effort` reads as, or
/// `None` when it names no thinking level.
pub(crate) fn thinking_level_for_effort(effort: &str) -> Option<&'static str> {
    Some(match effort {
        "none" | "off" => "off",
        "minimal" => "minimal",
        "low" => "low",
        "medium" => "medium",
        "high" => "high",
        "xhigh" => "xhigh",
        "max" => "max",
        _ => return None,
    })
}

/// The warning an `llm.local` endpoint draws: `ai:` has no way to say it.
pub(crate) fn llm_local_warning(context: &str) -> String {
    format!(
        "{context} declares llm.local, which ai: cannot express, so it is ignored and the judge runs on its provider's hosted model"
    )
}

/// The `ai:` block an `llm:` block reads as: `provider/model`, the request's
/// `max_tokens` and a non-zero `temperature` as options, `reasoning_effort` as
/// the thinking level. `transport` is the host's, and `local` cannot be
/// expressed; both are dropped.
fn judge_llm_to_ai(llm: &LlmBlock) -> Result<JudgeAiConfig, JudgeSpecError> {
    let mut options = Map::new();
    if llm.request.temperature != 0.0 {
        options.insert("temperature".to_owned(), json!(llm.request.temperature));
    }
    if let Some(max_tokens) = llm.request.max_tokens {
        options.insert("max_tokens".to_owned(), json!(max_tokens));
    }
    let thinking_level = match llm.request.reasoning_effort.as_deref() {
        None => None,
        Some(effort) => match thinking_level_for_effort(effort) {
            Some(level) => Some(level.to_owned()),
            None => spec_bail!(
                "llm.request.reasoning_effort {effort:?} names no thinking level; use none, minimal, low, medium, high, xhigh, or max"
            ),
        },
    };
    Ok(JudgeAiConfig {
        model: format!("{}/{}", llm.provider.trim(), llm.model.trim()),
        fallbacks: Vec::new(),
        thinking_level,
        options: (!options.is_empty()).then_some(options),
        providers: None,
    })
}

/// The errors of an `llm:` block's own bounds, which `ai:` does not check.
fn llm_errors(llm: &LlmBlock) -> Option<String> {
    let provider = &llm.provider;
    if provider.is_empty()
        || provider.len() > 64
        || !provider
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return Some("llm.provider must be a lowercase provider slug".to_owned());
    }
    if llm.model.trim().is_empty() || llm.model.len() > 255 || llm.model != llm.model.trim() {
        return Some(
            "llm.model must be a non-empty string without surrounding whitespace".to_owned(),
        );
    }
    let request = &llm.request;
    if !(request.temperature.is_finite() && (0.0..=2.0).contains(&request.temperature)) {
        return Some("llm.request.temperature must be a number between 0 and 2".to_owned());
    }
    if request
        .max_tokens
        .is_some_and(|tokens| !(1..=LLM_MAX_OUTPUT_TOKENS).contains(&tokens))
    {
        return Some(format!(
            "llm.request.max_tokens must be an integer between 1 and {LLM_MAX_OUTPUT_TOKENS}"
        ));
    }
    let transport = &llm.transport;
    if !(1..=600_000).contains(&transport.timeout_ms)
        || transport.max_retries > 10
        || transport.max_retry_delay_ms > 60_000
    {
        return Some("llm.transport is out of bounds".to_owned());
    }
    None
}

/// An optional field that, as in an agent's `ai:` block, may be left out but
/// not written as null.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// One yes-or-no question of a classifier judge. Its answer is the
/// probability of `true`, which passes at `threshold`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct JudgeClassifierQuestion {
    /// What is asked, and how to judge it.
    #[serde(deserialize_with = "strict_string")]
    #[cfg_attr(feature = "schema", schemars(length(min = 1), pattern(r"\S")))]
    pub instructions: String,
    pub criteria: JudgeQuestionCriteria,
    /// Greater than 0 and at most 1. Defaults to 0.5.
    #[serde(
        default = "default_question_threshold",
        deserialize_with = "strict_number"
    )]
    #[cfg_attr(
        feature = "schema",
        schemars(range(max = 1.0), extend("exclusiveMinimum" = 0.0))
    )]
    pub threshold: f64,
}

/// What a `true` and a `false` answer to a classifier question mean.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct JudgeQuestionCriteria {
    #[serde(deserialize_with = "strict_string")]
    #[cfg_attr(feature = "schema", schemars(length(min = 1), pattern(r"\S")))]
    pub r#true: String,
    #[serde(deserialize_with = "strict_string")]
    #[cfg_attr(feature = "schema", schemars(length(min = 1), pattern(r"\S")))]
    pub r#false: String,
}

// YAML reads a bare scalar into whichever type is asked for; these keep a
// number from passing as text, and text from passing as a number.
fn strict_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    match Value::deserialize(deserializer)? {
        Value::String(text) => Ok(text),
        other => Err(D::Error::custom(format!(
            "expected a string, found {other}"
        ))),
    }
}

fn strict_number<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    let value = Value::deserialize(deserializer)?;
    value
        .as_f64()
        .ok_or_else(|| D::Error::custom(format!("expected a number, found {value}")))
}

/// The `type` of a judge a recipe's `policies/routes.yaml` names. A judge with
/// no `type` is an online eval ([`JudgeDefinition`]).
pub const MISSION_JUDGE_TYPE: &str = "mission";
/// The `type` values of a [`JudgeDefinition`].
pub const ONLINE_JUDGE_TYPE: &str = "online";
/// The most questions one mission judge asks.
pub const MAX_MISSION_JUDGE_QUESTIONS: usize = 8;

/// A mission judge: yes-or-no questions the platform asks Jev about a request
/// leaving the sandbox, against the person's own words, before the recipe's
/// Cedar policy decides. Each answer is the probability of `true`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct MissionJudgeDefinition {
    /// Unique judge name within the recipe, which a policy route names.
    #[cfg_attr(
        feature = "schema",
        schemars(length(max = 255), pattern(r"^[a-z0-9]+(-[a-z0-9]+)*$"))
    )]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "schema", schemars(length(max = 2000)))]
    pub description: Option<String>,
    /// Always `mission`.
    #[serde(rename = "type")]
    pub kind: MissionJudgeKind,
    /// The request attributes Jev sees; empty shows them all.
    #[serde(default)]
    #[cfg_attr(feature = "schema", schemars(schema_with = "attributes_schema"))]
    pub attributes: Vec<String>,
    /// Questions by name; each name is the field its answer is read as.
    #[cfg_attr(feature = "schema", schemars(schema_with = "questions_schema"))]
    pub questions: BTreeMap<String, JudgeQuestion>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum JudgeType {
    #[default]
    Online,
}

impl JudgeType {
    pub fn is_online(&self) -> bool {
        *self == Self::Online
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum MissionJudgeKind {
    Mission,
}

/// One yes-or-no question.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct JudgeQuestion {
    /// What is asked, and how to judge it.
    #[cfg_attr(feature = "schema", schemars(length(min = 1), pattern(r"\S")))]
    pub instructions: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub criteria: Option<NoulCriteria>,
}

/// What a `true` and a `false` answer mean.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct NoulCriteria {
    #[serde(rename = "true")]
    #[cfg_attr(feature = "schema", schemars(length(min = 1), pattern(r"\S")))]
    pub yes: String,
    #[serde(rename = "false")]
    #[cfg_attr(feature = "schema", schemars(length(min = 1), pattern(r"\S")))]
    pub no: String,
}

/// Each strict parser returns one type of judge but answers for the whole
/// batch: every source must be YAML, and names are unique across types.
fn check_batch(sources: &[JudgeSource]) -> Result<(), JudgeSpecError> {
    let mut seen = HashSet::new();
    for source in sources {
        let value = match serde_saphyr::from_str::<Value>(&source.content) {
            Ok(value) => value,
            Err(err) => spec_bail!("parsing judge YAML {}: {err}", source.path),
        };
        let name = value.get("name").or_else(|| value.get("judge"));
        if let Some(name) = name.and_then(Value::as_str) {
            if !seen.insert(name.to_owned()) {
                spec_bail!("duplicate judge name {name:?}");
            }
        }
    }
    Ok(())
}

/// Whether a judge source declares `type: mission`, without validating it.
pub fn is_mission_judge(content: &str) -> bool {
    serde_saphyr::from_str::<Value>(content)
        .ok()
        .and_then(|value| value.get("type").cloned())
        .is_some_and(|kind| kind == MISSION_JUDGE_TYPE)
}

/// One parsed mission judge source.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ParsedMissionJudgeDefinition {
    pub source_path: String,
    pub definition: MissionJudgeDefinition,
}

/// Strictly parse the `type: mission` judges among `sources`; any invalid one
/// fails the batch. Online judges are skipped.
pub fn parse_mission_judge_definitions(
    sources: &[JudgeSource],
) -> Result<Vec<ParsedMissionJudgeDefinition>, JudgeSpecError> {
    check_batch(sources)?;
    let mut ordered = sources
        .iter()
        .filter(|source| is_mission_judge(&source.content))
        .cloned()
        .collect::<Vec<_>>();
    ordered.sort_by(|a, b| a.path.cmp(&b.path));
    let mut seen = HashSet::new();
    let mut parsed = Vec::with_capacity(ordered.len());
    for source in ordered {
        let definition: MissionJudgeDefinition = match serde_saphyr::from_str(&source.content) {
            Ok(definition) => definition,
            Err(err) => spec_bail!("parsing judge YAML {}: {err}", source.path),
        };
        validate_mission_judge(&definition, &format!("judge YAML {}", source.path))?;
        if !seen.insert(definition.name.clone()) {
            spec_bail!("duplicate judge name {:?}", definition.name);
        }
        parsed.push(ParsedMissionJudgeDefinition {
            source_path: source.path,
            definition,
        });
    }
    Ok(parsed)
}

/// Validate one mission judge against the authored contract.
pub fn validate_mission_judge(
    definition: &MissionJudgeDefinition,
    context: &str,
) -> Result<(), JudgeSpecError> {
    if !is_portable_name(&definition.name) || definition.name.chars().count() > 255 {
        spec_bail!("{context} judge name must use lowercase kebab-case, at most 255 characters");
    }
    if definition
        .description
        .as_deref()
        .is_some_and(|description| description.chars().count() > 2_000)
    {
        spec_bail!("{context} has a description longer than 2000 characters");
    }
    let mut attributes = HashSet::new();
    for attribute in &definition.attributes {
        if attribute.trim().is_empty() || !attributes.insert(attribute) {
            spec_bail!("{context} attributes must be distinct, non-empty attribute names");
        }
    }
    if definition.questions.is_empty() || definition.questions.len() > MAX_MISSION_JUDGE_QUESTIONS {
        spec_bail!("{context} must ask between 1 and {MAX_MISSION_JUDGE_QUESTIONS} questions");
    }
    for (name, question) in &definition.questions {
        if !is_question_name(name) {
            spec_bail!("{context} question {name:?} must be a lowercase identifier");
        }
        if question.instructions.trim().is_empty() {
            spec_bail!("{context} question {name:?} has empty instructions");
        }
        if let Some(criteria) = &question.criteria {
            if criteria.yes.trim().is_empty() || criteria.no.trim().is_empty() {
                spec_bail!(
                    "{context} question {name:?} criteria `true` and `false` must be non-empty"
                );
            }
        }
    }
    Ok(())
}

fn is_question_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|ch| ch.is_ascii_lowercase() || ch == '_')
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
}

fn default_question_threshold() -> f64 {
    DEFAULT_JUDGE_QUESTION_THRESHOLD
}

pub(crate) fn is_classifier_question_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|ch| ch.is_ascii_lowercase())
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
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
    /// What the definition declares that normalization had to ignore, such as
    /// an `llm.local` endpoint `ai:` cannot express.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Strictly parse authored judge YAML sources into normalized definitions.
///
/// Sources are processed in path order. Any invalid definition (malformed
/// YAML, unknown fields, both or neither of `ai` and `llm`, an invalid model block,
/// instructions, questions or gate, duplicate names across the batch) fails
/// the whole batch. `type: mission`
/// judges are not online evals and are skipped; see
/// [`parse_mission_judge_definitions`].
pub fn parse_judge_definitions(
    sources: &[JudgeSource],
) -> Result<Vec<ParsedJudgeDefinition>, JudgeSpecError> {
    check_batch(sources)?;
    let mut ordered = sources
        .iter()
        .filter(|source| !is_mission_judge(&source.content))
        .cloned()
        .collect::<Vec<_>>();
    ordered.sort_by(|a, b| a.path.cmp(&b.path));
    let mut seen = HashSet::new();
    let mut parsed = Vec::with_capacity(ordered.len());
    for source in ordered {
        let context = format!("judge YAML {}", source.path);
        if declares_both_models(&source.content) {
            spec_bail!(
                "{context} declares both `ai` and `llm`: declare the model once, as `ai: {{ model: <provider>/<model> }}`"
            );
        }
        let authored: AuthoredJudgeDefinition = match serde_saphyr::from_str(&source.content) {
            Ok(authored) => authored,
            Err(err) => spec_bail!("parsing judge YAML {}: {err}", source.path),
        };
        let warnings = authored_judge_warnings(&authored, &context);
        let definition = normalize_judge_definition(authored_judge(authored, &context)?, &context)?;
        if !seen.insert(definition.name.clone()) {
            spec_bail!("duplicate judge name {:?}", definition.name);
        }
        parsed.push(ParsedJudgeDefinition {
            source_path: source.path,
            definition,
            warnings,
        });
    }
    Ok(parsed)
}

fn declares_both_models(content: &str) -> bool {
    serde_saphyr::from_str::<Value>(content)
        .ok()
        .is_some_and(|value| value.get("llm").is_some() && value.get("ai").is_some())
}

/// What mapping `authored` to a [`JudgeDefinition`] ignores, as warnings.
fn authored_judge_warnings(authored: &AuthoredJudgeDefinition, context: &str) -> Vec<String> {
    authored
        .llm
        .as_ref()
        .filter(|llm| llm.local.is_some())
        .map(|_| vec![llm_local_warning(context)])
        .unwrap_or_default()
}

/// The definition an authored judge declares: its `ai:` block, or the `ai:`
/// block its older `llm:` block reads as ([`judge_llm_to_ai`]), never both
/// and never neither.
fn authored_judge(
    authored: AuthoredJudgeDefinition,
    context: &str,
) -> Result<JudgeDefinition, JudgeSpecError> {
    let ai = match (authored.ai, authored.llm) {
        (Some(_), Some(_)) => spec_bail!(
            "{context} declares both `ai` and `llm`: declare the model once, as `ai: {{ model: <provider>/<model> }}`"
        ),
        (Some(ai), None) => ai,
        (None, Some(llm)) => {
            if let Some(message) = llm_errors(&llm) {
                spec_bail!("{context} has an invalid llm block: {message}");
            }
            judge_llm_to_ai(&llm).map_err(|err| {
                JudgeSpecError::new(format!("{context} has an invalid llm block: {err}"))
            })?
        }
        (None, None) => spec_bail!(
            "{context} declares its model as either `ai: {{ model: <provider>/<model> }}` or the older `llm:`"
        ),
    };
    Ok(JudgeDefinition {
        kind: authored.kind,
        name: authored.name,
        description: authored.description,
        on: authored.on,
        ai,
        instructions: authored.instructions,
        questions: authored.questions,
        input: authored.input,
    })
}

/// Validate one definition against the authored contract and apply spec
/// normalization: `on: null` becomes `{}` and model names are trimmed.
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
    definition.ai.model = definition.ai.model.trim().to_owned();
    for fallback in &mut definition.ai.fallbacks {
        *fallback = fallback.trim().to_owned();
    }
    let ai = match serde_json::to_value(&definition.ai) {
        Ok(ai) => ai,
        Err(err) => spec_bail!("{context} has an invalid ai block: {err}"),
    };
    if let Some(message) = crate::judge_ai_errors(&ai).into_iter().next() {
        spec_bail!("{context} has an invalid ai block: {message}");
    }
    match (&definition.instructions, &definition.questions) {
        (Some(instructions), None) => {
            if instructions.trim().is_empty() {
                spec_bail!("{context} has empty instructions");
            }
        }
        (None, Some(questions)) => validate_classifier_questions(context, questions)?,
        _ => spec_bail!(
            "{context} declares either `instructions`, answered by a chat model, or `questions`, answered by a classifier"
        ),
    }
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

fn validate_classifier_questions(
    context: &str,
    questions: &BTreeMap<String, JudgeClassifierQuestion>,
) -> Result<(), JudgeSpecError> {
    if questions.is_empty() || questions.len() > MAX_JUDGE_QUESTIONS {
        spec_bail!("{context} must ask between 1 and {MAX_JUDGE_QUESTIONS} questions");
    }
    for (name, question) in questions {
        if !is_classifier_question_name(name) {
            spec_bail!("{context} question {name:?} must be a lowercase identifier");
        }
        if question.instructions.trim().is_empty() {
            spec_bail!("{context} question {name:?} has empty instructions");
        }
        if question.criteria.r#true.trim().is_empty() || question.criteria.r#false.trim().is_empty()
        {
            spec_bail!("{context} question {name:?} criteria `true` and `false` must be non-empty");
        }
        if !(question.threshold > 0.0 && question.threshold <= 1.0) {
            spec_bail!(
                "{context} question {name:?} threshold must be greater than 0 and at most 1"
            );
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
                if let Some(err) = gate_regex_error(pattern, flags) {
                    spec_bail!("invalid regex {value:?}: {err}");
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// Why a gate's `/pattern/flags` does not compile in both engines that read
/// it, or `None` when it does: Rust's `regex` here and in the platform's
/// evaluator, and JavaScript's `RegExp` in the Recipes judge runner, which
/// tries the `v` flag and falls back to `u`. `regress` stands in for the
/// runner's engine and is not identical to it, so the runner can still refuse
/// a pattern this accepts.
pub(crate) fn gate_regex_error(pattern: &str, flags: &str) -> Option<String> {
    let mut builder = RegexBuilder::new(pattern);
    builder.case_insensitive(flags.contains('i'));
    builder.multi_line(flags.contains('m'));
    builder.dot_matches_new_line(flags.contains('s'));
    if let Err(err) = builder.build() {
        return Some(format!("Rust regex: {err}"));
    }
    // The runner adds the mode itself, and JavaScript refuses `u` with `v`.
    let own = flags.chars().filter(|flag| *flag != 'u');
    let compile = |mode: char| {
        let js_flags = own.clone().chain([mode]).collect::<String>();
        regress::Regex::with_flags(pattern, js_flags.as_str()).err()
    };
    let unicode_sets = compile('v')?;
    let unicode = compile('u')?;
    Some(format!(
        "JavaScript regex: {unicode_sets} (v flag); {unicode} (u flag)"
    ))
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
/// The schema encodes every authored constraint JSON Schema can express,
/// including that a judge declares exactly one of `instructions` and
/// `questions`, so schema-valid definitions parse strictly. A few rules
/// remain parser-only because a per-document schema cannot express them:
/// batch-level judge-name uniqueness, regex-literal flag validity in gate
/// `match` values, and the `ai.options` and `ai.providers` rules an agent's
/// `ai:` block shares.
#[cfg(feature = "schema")]
pub fn judge_definition_json_schema() -> String {
    let schema = schemars::schema_for!(AuthoredJudgeDefinition);
    let mut value = serde_json::to_value(&schema).expect("judge schema serializes");
    value["oneOf"] = json!([
        { "required": ["instructions"] },
        { "required": ["questions"] }
    ]);
    // The model is `ai`, or the older `llm` normalization maps to it.
    value["anyOf"] = json!([
        { "required": ["ai"], "not": { "required": ["llm"] } },
        { "required": ["llm"], "not": { "required": ["ai"] } }
    ]);
    // Each is a block when present: strict parsing reads `llm: null` as no
    // `llm` and `ai: null` as an error, so neither may be null, and `ai` has
    // no default for a client to fill in.
    let properties = &mut value["properties"];
    properties["llm"] = json!({
        "$ref": "#/$defs/LlmBlock",
        "deprecated": true,
        "description": properties["llm"]["description"].clone(),
    });
    if let Some(ai) = properties["ai"].as_object_mut() {
        ai.remove("default");
    }
    serde_json::to_string_pretty(&value).expect("judge schema serializes")
}

/// JSON Schema for a `type: mission` judge.
#[cfg(feature = "schema")]
pub fn mission_judge_definition_json_schema() -> String {
    let schema = schemars::schema_for!(MissionJudgeDefinition);
    serde_json::to_string_pretty(&schema).expect("mission judge schema serializes")
}

#[cfg(feature = "schema")]
fn attributes_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({
        "description": "The request attributes Jev sees; empty shows them all.",
        "type": "array",
        "uniqueItems": true,
        "items": { "type": "string", "minLength": 1, "pattern": r"\S" }
    })
}

#[cfg(feature = "schema")]
fn questions_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    let question = generator.subschema_for::<JudgeQuestion>();
    schemars::json_schema!({
        "description": "Questions by name; each name is the field its answer is read as.",
        "type": "object",
        "minProperties": 1,
        "maxProperties": MAX_MISSION_JUDGE_QUESTIONS,
        "propertyNames": { "pattern": "^[a-z_][a-z0-9_]*$" },
        "additionalProperties": question
    })
}

#[cfg(feature = "schema")]
fn classifier_questions_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    let question = generator.subschema_for::<JudgeClassifierQuestion>();
    schemars::json_schema!({
        "description": "The yes-or-no questions of a judge a classifier answers, by name.",
        "type": "object",
        "minProperties": 1,
        "maxProperties": MAX_JUDGE_QUESTIONS,
        "propertyNames": { "pattern": "^[a-z][a-z0-9_]*$" },
        "additionalProperties": question
    })
}

#[cfg(feature = "schema")]
fn instructions_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({
        "description": "The grading rubric of a judge a chat model answers. A judge declares this or `questions`, never both.",
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

/// How a case is checked, from a case file's `check`.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum EvalCaseCheck {
    /// A verifier scores it; only these cases get an implementation.
    Code,
    /// The owner or a reviewer checks it.
    Person,
    /// Left for the improve loop.
    Later,
}

/// The real conversation a case came from. Provenance only: a run never
/// fetches it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct EvalCaseConversation {
    #[serde(deserialize_with = "required_scalar")]
    pub id: String,
    /// Set only when the conversation ran as a platform task.
    #[serde(
        default,
        deserialize_with = "optional_scalar",
        skip_serializing_if = "Option::is_none"
    )]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<u64>,
}

/// The front matter of a case file, `evals/cases/<id>.md`: the fields
/// evaluation tooling reads. Every other key, and the body, is for people, so
/// unknown keys are allowed. A blank scalar (`approved_by:`) reads as `None`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct EvalCase {
    /// The file name without `.md`, when written.
    #[serde(
        default,
        deserialize_with = "optional_scalar",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<EvalCaseCheck>,
    /// Who approved the case. With `approved_at` and `approved_in` empty too,
    /// the case is a draft.
    #[serde(
        default,
        deserialize_with = "optional_scalar",
        skip_serializing_if = "Option::is_none"
    )]
    pub approved_by: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_scalar",
        skip_serializing_if = "Option::is_none"
    )]
    pub approved_at: Option<String>,
    /// The message the approval was given in.
    #[serde(
        default,
        deserialize_with = "optional_scalar",
        skip_serializing_if = "Option::is_none"
    )]
    pub approved_in: Option<String>,
    /// `sha256:<hex>` of the body when the case was approved, from
    /// [`case_approval_hash`]. A case whose body no longer matches is
    /// unapproved; one approved before the hash existed has none and stays
    /// approved.
    #[serde(
        default,
        deserialize_with = "optional_scalar",
        skip_serializing_if = "Option::is_none"
    )]
    pub approved_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<EvalCaseConversation>,
    /// The `/v1/issues` id of the hypothesis the case tests: a UUID.
    #[serde(
        default,
        deserialize_with = "optional_scalar",
        skip_serializing_if = "Option::is_none"
    )]
    pub issue: Option<String>,
}

impl EvalCase {
    /// The approval fields that are empty, in declaration order.
    pub fn missing_approval(&self) -> Vec<&'static str> {
        [
            ("approved_by", &self.approved_by),
            ("approved_at", &self.approved_at),
            ("approved_in", &self.approved_in),
        ]
        .into_iter()
        .filter(|(_, value)| value.is_none())
        .map(|(name, _)| name)
        .collect()
    }

    /// Whether every approval field is filled in.
    pub fn is_approved(&self) -> bool {
        self.missing_approval().is_empty()
    }

    /// Whether `approved_hash` matches the case file's `body` (as
    /// [`eval_case_body`] returns it): `None` without an `approved_hash`.
    pub fn approved_hash_matches(&self, body: &str) -> Option<bool> {
        let written = self.approved_hash.as_deref()?;
        Some(written.eq_ignore_ascii_case(&case_approval_hash(body)))
    }
}

/// The hash `approved_hash` records: `sha256:` and the lowercase hex SHA-256
/// of the case file's body, everything after the front matter's closing
/// `---` line. Before hashing, CRLF becomes LF, trailing whitespace is removed
/// from every line, and trailing whitespace at the end of the body is
/// removed, so line endings, stray spaces and front-matter edits (the
/// approval itself included) leave it unchanged.
pub fn case_approval_hash(body: &str) -> String {
    let normalized = body.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').map(str::trim_end).collect();
    let canonical = lines.join("\n");
    let digest = Sha256::digest(canonical.trim_end().as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("sha256:{hex}")
}

/// A case file's body: everything after the line that closes its front
/// matter, with CRLF read as LF. `None` when it has no front matter.
pub fn eval_case_body(content: &str) -> Option<String> {
    let normalized = content.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    split_front_matter(&normalized).map(|(_, body)| body.to_owned())
}

/// The YAML between the `---` lines at the top, and the body after the
/// closing line. `content` has LF line endings.
fn split_front_matter(content: &str) -> Option<(&str, &str)> {
    let rest = content.strip_prefix("---\n")?;
    let (yaml, closing) = if rest.starts_with("---") {
        ("", rest)
    } else {
        let end = rest.find("\n---")?;
        (&rest[..end], &rest[end + 1..])
    };
    let body = closing
        .find('\n')
        .map_or("", |newline| &closing[newline + 1..]);
    Some((yaml, body))
}

/// Error from [`parse_eval_case`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvalCaseError(String);

impl fmt::Display for EvalCaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EvalCaseError {}

/// Parse a case file's YAML front matter (between `---` lines at the top),
/// read as YAML 1.2. A file without front matter is an error: a case's
/// approval lives there.
pub fn parse_eval_case(content: &str) -> Result<EvalCase, EvalCaseError> {
    let normalized = content.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let (yaml, _) = split_front_matter(&normalized)
        .ok_or_else(|| EvalCaseError("has no YAML front matter between '---' lines".into()))?;
    if yaml.trim().is_empty() {
        return Ok(EvalCase::default());
    }
    serde_saphyr::from_str_with_options(yaml, serde_saphyr::options! { strict_booleans: true })
        .map_err(|err| EvalCaseError(format!("front matter is not a valid case: {err}")))
}

/// A YAML scalar read as text, so `approved_at: 2026-11-04` and
/// `approved_in: 1234` both read; blank reads as `None`.
fn optional_scalar<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    let text = match Value::deserialize(deserializer)? {
        Value::Null => return Ok(None),
        Value::String(text) => text,
        Value::Number(number) => number.to_string(),
        Value::Bool(value) => value.to_string(),
        other => {
            return Err(D::Error::custom(format!(
                "expected a scalar, found {other}"
            )))
        }
    };
    let text = text.trim();
    Ok((!text.is_empty()).then(|| text.to_owned()))
}

fn required_scalar<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    optional_scalar(deserializer)?.ok_or_else(|| D::Error::custom("must not be empty"))
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
ai:
  model: openai/gpt-5
";

    const CLASSIFIER_JUDGE: &str = "\
name: on-topic
ai:
  model: acme/classifier-1
questions:
  on_topic:
    instructions: Does the reply address what the user asked?
    criteria:
      \"true\": The reply answers the question asked.
      \"false\": The reply answers something else.
  polite:
    instructions: Is the reply polite?
    criteria:
      \"true\": Courteous throughout.
      \"false\": Rude or dismissive.
    threshold: 0.8
";

    #[test]
    fn parses_sorted_and_applies_spec_defaults() {
        let sources = [
            source(
                "judges/b.yaml",
                "name: b\ninstructions: Grade b.\nai:\n  model: openai/gpt-5\n",
            ),
            source(
                "judges/a.yaml",
                "name: a\ninstructions: Grade a.\nai:\n  model: openai/gpt-5\n",
            ),
        ];
        let parsed = parse_judge_definitions(&sources).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].source_path, "judges/a.yaml");
        assert_eq!(parsed[1].source_path, "judges/b.yaml");

        let definition = &parsed[0].definition;
        assert_eq!(definition.ai.model, "openai/gpt-5");
        assert!(definition.ai.fallbacks.is_empty());
        assert_eq!(definition.questions, None);
        assert_eq!(definition.on, json!({}));
    }

    #[test]
    fn normalized_definition_serializes_without_absent_options() {
        let parsed = parse_judge_definitions(&[source(
            "judges/a.yaml",
            "name: a\ninstructions: Grade a.\nai:\n  model: openai/gpt-5\n",
        )])
        .unwrap();
        let value = serde_json::to_value(&parsed[0].definition).unwrap();
        assert_eq!(
            value,
            json!({
                "name": "a",
                "on": {},
                "ai": { "model": "openai/gpt-5" },
                "instructions": "Grade a.",
            })
        );
    }

    #[test]
    fn legacy_judge_field_normalizes_to_name_and_conflicts_fail() {
        let parsed = parse_judge_definitions(&[source(
            "judges/legacy.yaml",
            "judge: legacy\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n",
        )])
        .unwrap();
        assert_eq!(parsed[0].definition.name, "legacy");
        assert_eq!(
            serde_json::to_value(&parsed[0].definition).unwrap()["name"],
            "legacy"
        );

        let conflict = parse_judge_definitions(&[source(
            "judges/conflict.yaml",
            "name: current\njudge: legacy\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n",
        )])
        .unwrap_err()
        .to_string();
        assert!(conflict.contains("duplicate field"), "{conflict}");
    }

    #[test]
    fn accepts_the_ai_block_of_an_agent_and_gate_events() {
        let content = "\
name: g
instructions: Grade.
on:
  - event: tool
    match:
      name: apply_discount
      text: /AssertionError/i
ai:
  model: \" openai/gpt-5 \"
  fallbacks: [anthropic/claude-sonnet-5-5, \" openrouter/acme/model-1\"]
  thinking_level: low
  options:
    max_tokens: 1024
  providers:
    openrouter:
      routing:
        only: [acme]
";
        let parsed = parse_judge_definitions(&[source("judges/g.yaml", content)]).unwrap();
        let ai = &parsed[0].definition.ai;
        assert_eq!(ai.model, "openai/gpt-5");
        assert_eq!(
            ai.fallbacks,
            ["anthropic/claude-sonnet-5-5", "openrouter/acme/model-1"]
        );
        assert_eq!(ai.thinking_level.as_deref(), Some("low"));
        assert_eq!(ai.options.as_ref().unwrap()["max_tokens"], json!(1024));
        assert_eq!(
            ai.providers.as_ref().unwrap()["openrouter"]["routing"]["only"],
            json!(["acme"])
        );
    }

    #[test]
    fn parses_a_classifier_judge_and_defaults_its_thresholds() {
        let parsed =
            parse_judge_definitions(&[source("judges/on-topic.yaml", CLASSIFIER_JUDGE)]).unwrap();
        let definition = &parsed[0].definition;
        assert_eq!(definition.instructions, None);
        let questions = definition.questions.as_ref().unwrap();
        assert_eq!(questions.len(), 2);
        assert_eq!(
            questions["on_topic"].threshold,
            DEFAULT_JUDGE_QUESTION_THRESHOLD
        );
        assert_eq!(questions["polite"].threshold, 0.8);
        assert_eq!(questions["polite"].criteria.r#false, "Rude or dismissive.");
        assert_eq!(
            serde_json::to_value(definition).unwrap()["questions"]["on_topic"],
            json!({
                "instructions": "Does the reply address what the user asked?",
                "criteria": {
                    "true": "The reply answers the question asked.",
                    "false": "The reply answers something else."
                },
                "threshold": 0.5
            })
        );
    }

    #[test]
    fn normalizes_the_older_llm_block_to_ai() {
        let parsed = parse_judge_definitions(&[source(
            "judges/legacy.yaml",
            "name: legacy\ninstructions: Grade.\nllm:\n  provider: anthropic\n  model: claude-sonnet-5-5\n  request:\n    temperature: 0.2\n    max_tokens: 512\n    reasoning_effort: none\n  transport:\n    timeout_ms: 30000\n",
        )])
        .unwrap();
        assert!(parsed[0].warnings.is_empty());
        assert_eq!(
            serde_json::to_value(&parsed[0].definition).unwrap(),
            json!({
                "name": "legacy",
                "on": {},
                "ai": {
                    "model": "anthropic/claude-sonnet-5-5",
                    "thinking_level": "off",
                    "options": { "temperature": 0.2, "max_tokens": 512 },
                },
                "instructions": "Grade.",
            })
        );

        // The provider defaults to openai, and a temperature of 0 is the
        // model's own default.
        let bare = parse_judge_definitions(&[source(
            "judges/bare.yaml",
            "name: bare\ninstructions: Grade.\nllm:\n  model: gpt-5\n  request:\n    reasoning_effort: high\n",
        )])
        .unwrap();
        let definition = &bare[0].definition;
        assert_eq!(definition.ai.model, "openai/gpt-5");
        assert_eq!(definition.ai.thinking_level.as_deref(), Some("high"));
        assert_eq!(definition.ai.options, None);
        let value = serde_json::to_value(definition).unwrap();
        assert!(value.get("llm").is_none(), "{value}");
    }

    #[test]
    fn an_llm_local_endpoint_is_dropped_with_a_warning() {
        let parsed = parse_judge_definitions(&[source(
            "judges/local.yaml",
            "name: local\ninstructions: Grade.\nllm:\n  model: gpt-5\n  local:\n    base_url: http://localhost:8080\n    api_key_env: LOCAL_KEY\n",
        )])
        .unwrap();
        assert_eq!(parsed[0].definition.ai.model, "openai/gpt-5");
        assert_eq!(parsed[0].definition.ai.providers, None);
        assert_eq!(parsed[0].warnings.len(), 1);
        assert!(
            parsed[0].warnings[0].contains("judges/local.yaml")
                && parsed[0].warnings[0].contains("llm.local"),
            "{:?}",
            parsed[0].warnings
        );
        let value = serde_json::to_value(&parsed[0]).unwrap();
        assert!(value["warnings"].is_array());
    }

    #[test]
    fn a_judge_declares_ai_or_llm_never_both_or_neither() {
        for (content, expected) in [
            (
                "name: g\ninstructions: Grade.\nllm:\n  model: gpt-5\nai:\n  model: openai/gpt-5\n",
                "declares both `ai` and `llm`",
            ),
            (
                "name: g\ninstructions: Grade.\n",
                "declares its model as either",
            ),
            (
                "name: g\ninstructions: Grade.\nllm:\n  model: gpt-5\n  request:\n    reasoning_effort: extreme\n",
                "names no thinking level",
            ),
        ] {
            let error = parse_judge_definitions(&[source("judges/g.yaml", content)])
                .unwrap_err()
                .to_string();
            assert!(error.contains(expected), "{expected}: {error}");
        }
    }

    #[test]
    fn normalizing_a_definition_built_in_code_fills_its_gate() {
        let definition = JudgeDefinition {
            kind: JudgeType::Online,
            name: "coded".to_owned(),
            description: None,
            on: Value::Null,
            ai: serde_json::from_value(json!({ "model": " openai/gpt-5 " })).unwrap(),
            instructions: Some("Grade.".to_owned()),
            questions: None,
            input: None,
        };
        let normalized = normalize_judge_definition(definition, "coded").unwrap();
        assert_eq!(normalized.ai.model, "openai/gpt-5");
        assert_eq!(normalized.on, json!({}));
    }

    fn gate_regex_result(pattern: &str) -> Result<(), String> {
        let yaml = format!("name: g\ninstructions: Grade.\non:\n  - event: message\n    match:\n      text: '{pattern}'\nai:\n  model: openai/gpt-5\n");
        parse_judge_definitions(&[source("judges/g.yaml", &yaml)])
            .map(|_| ())
            .map_err(|err| err.to_string())
    }

    #[test]
    fn a_gate_regex_must_compile_in_rust_and_javascript() {
        assert_eq!(gate_regex_result(r"/[\w&&[^_]]+/iu"), Ok(()));
        let rust = gate_regex_result("/foo(?=bar)/").unwrap_err();
        assert!(rust.contains("Rust regex"), "{rust}");
        let js = gate_regex_result("/(?P<word>a)/").unwrap_err();
        assert!(js.contains("JavaScript regex"), "{js}");
        assert!(js.contains("(v flag)") && js.contains("(u flag)"), "{js}");
        let neither = gate_regex_result("/(abc/i").unwrap_err();
        assert!(neither.contains("invalid regex"), "{neither}");
    }

    #[test]
    fn a_gate_regex_compiles_under_the_v_flag_or_failing_that_the_u_flag() {
        // The v flag refuses these (an unescaped `-`, `/`, `|` or `(` in a class).
        for pattern in [
            r"/[\w-]+@acme/",
            "/[a-z-]/",
            "/[^/]+/",
            "/[|]/",
            "/[(]/",
            r"/[\w-]+@acme/imsu",
        ] {
            assert_eq!(gate_regex_result(pattern), Ok(()), "{pattern}");
        }
        // Class set operations, which the u flag refuses.
        for pattern in [r"/[\w--\d]+/", "/[[a-z_]&&[^0-9]]/", r"/[\w--\d]+/iu"] {
            assert_eq!(gate_regex_result(pattern), Ok(()), "{pattern}");
        }
    }

    // Known gaps between `regress` and the runner's engine: the checker
    // accepts these and the runner refuses them (`[[:alpha:]]` it reads as a
    // nested class, not a POSIX one).
    #[test]
    fn a_gate_regex_the_runner_refuses_can_pass_the_checker() {
        for pattern in [r"/\Afoo\z/", r"/\-/", r"/\#/", "/[[:alpha:]]/"] {
            assert_eq!(gate_regex_result(pattern), Ok(()), "{pattern}");
        }
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
                    "name: {invalid_name:?}\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n"
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
            "name: empty\ninstructions: '  '\nai:\n  model: openai/gpt-5\n",
        )];
        let error = parse_judge_definitions(&empty).unwrap_err().to_string();
        assert!(error.contains("empty instructions"), "{error}");

        let both = CLASSIFIER_JUDGE.replace("questions:", "instructions: Grade.\nquestions:");
        for kind in ["name: empty\nai:\n  model: openai/gpt-5\n", both.as_str()] {
            let error = parse_judge_definitions(&[source("judges/kind.yaml", kind)])
                .unwrap_err()
                .to_string();
            assert!(
                error.contains(
                    "declares either `instructions`, answered by a chat model, or `questions`, answered by a classifier"
                ),
                "{error}"
            );
        }
    }

    #[test]
    fn rejects_invalid_gates_ai_blocks_and_questions() {
        let cases: &[(&str, &str)] = &[
            (
                "name: g\ninstructions: Grade.\non:\n  - event: deploy\nai:\n  model: openai/gpt-5\n",
                "unknown judge gate event",
            ),
            (
                "name: g\ninstructions: Grade.\non:\n  - event: message\n    match:\n      pattern_id: p\nai:\n  model: openai/gpt-5\n",
                "must not reference pattern_id",
            ),
            (
                "name: g\ninstructions: Grade.\non:\n  - event: message\n    match:\n      environment: prod\nai:\n  model: openai/gpt-5\n",
                "automatic platform context",
            ),
            (
                "name: g\ninstructions: Grade.\non:\n  - event: message\n    match:\n      text: /hello/g\nai:\n  model: openai/gpt-5\n",
                "unsupported regex flags",
            ),
            (
                "name: g\ninstructions: Grade.\nai:\n  model: ''\n",
                "ai.model must be a non-empty string",
            ),
            (
                "name: g\ninstructions: Grade.\nai:\n  model: gpt-5\n",
                "invalid ai.model 'gpt-5'",
            ),
            (
                "name: g\ninstructions: Grade.\nai:\n  thinking_level: low\n",
                "missing field `model`",
            ),
            (
                "name: g\ninstructions: Grade.\n",
                "declares its model as either",
            ),
            (
                "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  fallbacks: [gpt-5]\n",
                "invalid ai.fallbacks entry 'gpt-5'",
            ),
            (
                "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  thinking_level: extreme\n",
                "ai.thinking_level is unsupported",
            ),
            (
                "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  options:\n    api_key: secret\n",
                "host-owned option 'api_key'",
            ),
            (
                "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  providers:\n    acme: {}\n",
                "ai.providers contains unknown field 'acme'",
            ),
            (
                "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  temperature: 0\n",
                "unknown field `temperature`",
            ),
            (
                "name: g\nai:\n  model: acme/classifier-1\nquestions: {}\n",
                "between 1 and 8 questions",
            ),
            (
                "name: g\nai:\n  model: acme/classifier-1\nquestions:\n  Polite:\n    instructions: Is it?\n    criteria: { 'true': Yes., 'false': No. }\n",
                "must be a lowercase identifier",
            ),
            (
                "name: g\nai:\n  model: acme/classifier-1\nquestions:\n  polite:\n    instructions: Is it?\n",
                "missing field `criteria`",
            ),
            (
                "name: g\nai:\n  model: acme/classifier-1\nquestions:\n  polite:\n    instructions: Is it?\n    criteria: { 'true': Yes., 'false': No. }\n    threshold: 0\n",
                "threshold must be greater than 0 and at most 1",
            ),
            (
                "name: g\nai:\n  model: acme/classifier-1\nquestions:\n  polite:\n    instructions: Is it?\n    criteria: { 'true': Yes., 'false': No. }\n    threshold: 1.5\n",
                "threshold must be greater than 0 and at most 1",
            ),
        ];
        for (content, expected) in cases {
            let error = parse_judge_definitions(&[source("judges/g.yaml", content)])
                .unwrap_err()
                .to_string();
            assert!(error.contains(expected), "{expected}: {error}");
        }
    }

    // The diagnostic validator and the strict spec parser accept the same
    // authored contract: a source producing judge error diagnostics must
    // fail spec parsing, and a diagnostics-clean source must parse.
    #[test]
    fn agrees_with_diagnostic_judge_validation() {
        let cases: &[&str] = &[
            HELPFUL_JUDGE,
            CLASSIFIER_JUDGE,
            "name: g\ninstructions: Grade.\nai:\n  model: ' openai/gpt-5 '\n  fallbacks: [' acme/model-1']\n  thinking_level: max\n  options: { max_tokens: 5 }\n  providers: { anthropic: { betas: [a] } }\n",
            "name: g\nai:\n  model: openai/gpt-5\n",
            "name: g\ninstructions: Grade.\nai:\n  model: ''\n",
            "name: g\ninstructions: Grade.\nai:\n  model: gpt-5\n",
            "name: g\ninstructions: Grade.\nai:\n  model: null\n",
            "name: g\ninstructions: Grade.\nai: {}\n",
            "name: g\ninstructions: Grade.\nai: null\n",
            "name: g\ninstructions: Grade.\n",
            "name: g\ninstructions: Grade.\nllm:\n  model: gpt-5\n",
            "name: g\ninstructions: Grade.\nllm:\n  model: gpt-5\nai:\n  model: openai/gpt-5\n",
            "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\nllm: null\n",
            "name: g\ninstructions: Grade.\nllm:\n  model: gpt-5\nai: null\n",
            "name: g\ninstructions: Grade.\nllm: null\n",
            "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  fallbacks: openai/gpt-5\n",
            "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  fallbacks: [gpt-5]\n",
            "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  fallbacks: [3]\n",
            "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  fallbacks: []\n",
            "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  thinking_level: extreme\n",
            "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  thinking_level: null\n",
            "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  options: none\n",
            "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  options: null\n",
            "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  options: { maxTokens: 5 }\n",
            "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  options: { headers: {} }\n",
            "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  providers: none\n",
            "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  providers: null\n",
            "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  providers: { acme: {} }\n",
            "name: g\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n  temperature: 0\n",
            &CLASSIFIER_JUDGE.replace("questions:", "instructions: Grade.\nquestions:"),
            &CLASSIFIER_JUDGE.replace("questions:", "instructions: null\nquestions:"),
            &CLASSIFIER_JUDGE.replace("  polite:", "  _polite:"),
            &CLASSIFIER_JUDGE.replace("  polite:", "  Polite:"),
            &CLASSIFIER_JUDGE.replace("      \"false\": Rude or dismissive.\n", ""),
            &CLASSIFIER_JUDGE.replace("\"false\": Rude or dismissive.", "\"false\": ''"),
            &CLASSIFIER_JUDGE.replace("\"false\": Rude or dismissive.", "\"false\": 0"),
            &CLASSIFIER_JUDGE.replace("\"false\": Rude", "maybe: Unclear.\n      \"false\": Rude"),
            &CLASSIFIER_JUDGE.replace("\"true\"", "true").replace("\"false\"", "false"),
            &CLASSIFIER_JUDGE.replace("0.8", "0"),
            &CLASSIFIER_JUDGE.replace("0.8", "1"),
            &CLASSIFIER_JUDGE.replace("0.8", "1.5"),
            &CLASSIFIER_JUDGE.replace("0.8", "high"),
            &CLASSIFIER_JUDGE.replace("0.8", "\"0.8\""),
            &CLASSIFIER_JUDGE.replace("0.8", "null"),
            &CLASSIFIER_JUDGE.replace("0.8", ".nan"),
            &CLASSIFIER_JUDGE.replace("0.8", "true"),
            &CLASSIFIER_JUDGE.replace("    threshold: 0.8", "    weight: 2"),
            &CLASSIFIER_JUDGE.replace("instructions: Is the reply polite?", "instructions: ''"),
            &CLASSIFIER_JUDGE.replace("    instructions: Is the reply polite?\n", ""),
            &CLASSIFIER_JUDGE.replace("  polite:\n", "  polite: Is it polite?\n  other:\n"),
            "name: g\nai:\n  model: acme/classifier-1\nquestions: {}\n",
            "name: g\nai:\n  model: acme/classifier-1\nquestions: [polite]\n",
            "name: g\nai:\n  model: acme/classifier-1\nquestions: null\n",
            "name: g\ninstructions: Grade.\non:\n  - event: deploy\nai:\n  model: openai/gpt-5\n",
            &format!("{HELPFUL_JUDGE}surprise: true\n"),
        ];
        let many = (0..9).fold(String::new(), |mut questions, index| {
            questions.push_str(&format!(
                "  q{index}:\n    instructions: Is it?\n    criteria: {{ 'true': Yes., 'false': No. }}\n"
            ));
            questions
        });
        let many = format!("name: g\nai:\n  model: acme/classifier-1\nquestions:\n{many}");
        for content in cases.iter().copied().chain([many.as_str()]) {
            let report = check_recipe_files(&RecipeFiles {
                files: vec![
                    RecipeFile::new("package.json", "{\"name\":\"probe\",\"pi\":{}}"),
                    RecipeFile::new("judges/probe.yaml", content),
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
        for field in [
            "name",
            "description",
            "on",
            "ai",
            "instructions",
            "questions",
        ] {
            assert!(properties.contains_key(field), "missing {field}");
        }
        assert_eq!(properties["llm"]["deprecated"], json!(true));
        // Neither model block may be null or defaulted: strict parsing would
        // read either as no model.
        for field in ["ai", "llm"] {
            assert!(
                properties[field].get("anyOf").is_none(),
                "{field} is nullable"
            );
            assert!(
                properties[field].get("default").is_none(),
                "{field} has a default"
            );
            assert!(properties[field]["$ref"].is_string(), "{field}");
        }
        for null_model in [
            "name: g\ninstructions: Grade.\nllm: null\n",
            "name: g\ninstructions: Grade.\nai: null\n",
        ] {
            assert!(
                parse_judge_definitions(&[source("judges/g.yaml", null_model)]).is_err(),
                "{null_model}"
            );
        }
        assert_eq!(schema["additionalProperties"], json!(false));
        let required = schema["required"].as_array().unwrap();
        assert!(required.contains(&json!("name")), "name must be required");
        assert_eq!(
            schema["oneOf"],
            json!([{ "required": ["instructions"] }, { "required": ["questions"] }])
        );
        assert_eq!(
            schema["anyOf"],
            json!([
                { "required": ["ai"], "not": { "required": ["llm"] } },
                { "required": ["llm"], "not": { "required": ["ai"] } }
            ])
        );
        // A schema-guided client must not be able to produce a definition
        // the strict parser rejects: instructions is a non-null, non-blank
        // string, and the scalar constraints mirror the parser's bounds.
        assert_eq!(properties["instructions"]["type"], json!("string"));
        assert_eq!(properties["instructions"]["minLength"], json!(1));
        assert_eq!(properties["instructions"]["pattern"], json!(r"\S"));
        assert_eq!(properties["name"]["maxLength"], json!(255));
        assert_eq!(properties["name"]["pattern"], json!(r"\S"));
        assert_eq!(properties["description"]["maxLength"], json!(2000));

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

    #[cfg(feature = "schema")]
    #[test]
    fn judge_schema_mirrors_the_ai_block_and_questions() {
        let schema: Value = serde_json::from_str(&judge_definition_json_schema()).unwrap();
        let properties = schema["properties"].as_object().unwrap();
        let ai = schema["$defs"]["JudgeAiConfig"].as_object().unwrap();
        assert_eq!(ai["required"], json!(["model"]));
        assert_eq!(ai["additionalProperties"], json!(false));
        assert!(ai["properties"]["model"]["pattern"].is_string());
        assert_eq!(
            ai["properties"]["fallbacks"]["items"]["pattern"],
            ai["properties"]["model"]["pattern"]
        );
        for field in ["thinking_level", "options", "providers"] {
            assert!(ai["properties"].get(field).is_some(), "missing {field}");
        }

        let questions = &properties["questions"];
        assert_eq!(questions["minProperties"], json!(1));
        assert_eq!(questions["maxProperties"], json!(8));
        assert_eq!(
            questions["propertyNames"]["pattern"],
            json!("^[a-z][a-z0-9_]*$")
        );
        let question = schema["$defs"]["JudgeClassifierQuestion"]
            .as_object()
            .unwrap();
        assert_eq!(question["required"], json!(["instructions", "criteria"]));
        assert_eq!(
            question["properties"]["threshold"]["exclusiveMinimum"],
            json!(0.0)
        );
        assert_eq!(question["properties"]["threshold"]["maximum"], json!(1.0));
        assert_eq!(question["properties"]["threshold"]["default"], json!(0.5));
    }

    const BOOKING_JUDGE: &str = "\
name: booking
type: mission
attributes: [city]
questions:
  requested:
    instructions: Is this what the traveller asked for?
    criteria:
      \"true\": The same trip.
      \"false\": Anything else.
";

    #[test]
    fn each_parser_reads_only_its_own_judges() {
        let sources = [
            source("judges/helpful.yaml", HELPFUL_JUDGE),
            source("judges/booking.yaml", BOOKING_JUDGE),
        ];
        let explicit = HELPFUL_JUDGE.replace("name: helpful", "type: online\nname: explicit");
        let online_only = HELPFUL_JUDGE.replace("name: helpful", "type: online\nname: helpful");
        assert_eq!(
            parse_judge_definitions(&[source("judges/helpful.yaml", &online_only)]).unwrap()[0]
                .definition
                .kind,
            JudgeType::Online
        );
        let sources = [
            sources[0].clone(),
            sources[1].clone(),
            source("judges/explicit.yaml", &explicit),
        ];
        let online = parse_judge_definitions(&sources).unwrap();
        assert_eq!(online.len(), 2);
        assert_eq!(online[0].definition.kind, JudgeType::Online);
        for parsed in &online {
            assert!(serde_json::to_value(&parsed.definition)
                .unwrap()
                .get("type")
                .is_none());
        }
        let offline = HELPFUL_JUDGE.replace("name: helpful", "type: offline\nname: helpful");
        assert!(parse_judge_definitions(&[source("judges/helpful.yaml", &offline)]).is_err());
        let online = &online[1..];
        assert_eq!(online.len(), 1);
        assert_eq!(online[0].definition.name, "helpful");
        let mission = parse_mission_judge_definitions(&sources).unwrap();
        assert_eq!(mission.len(), 1);
        let booking = &mission[0].definition;
        assert_eq!(booking.attributes, ["city"]);
        let requested = &booking.questions["requested"];
        assert_eq!(
            requested.instructions,
            "Is this what the traveller asked for?"
        );
        assert_eq!(requested.criteria.as_ref().unwrap().no, "Anything else.");
    }

    #[test]
    fn a_malformed_source_fails_either_parser() {
        let sources = [
            source("judges/helpful.yaml", HELPFUL_JUDGE),
            source("judges/broken.yaml", "type: mission\nquestions: ["),
        ];
        assert!(parse_judge_definitions(&sources).is_err());
        assert!(parse_mission_judge_definitions(&sources).is_err());
    }

    #[cfg(feature = "schema")]
    #[test]
    fn mission_schema_mirrors_the_parser() {
        let schema: Value = serde_json::from_str(&mission_judge_definition_json_schema()).unwrap();
        let properties = &schema["properties"];
        assert_eq!(properties["attributes"]["uniqueItems"], json!(true));
        assert_eq!(
            properties["questions"]["propertyNames"]["pattern"],
            json!("^[a-z_][a-z0-9_]*$")
        );
        assert_eq!(properties["questions"]["maxProperties"], json!(8));
    }

    #[test]
    fn names_are_unique_across_judge_types() {
        let sources = [
            source("judges/helpful.yaml", HELPFUL_JUDGE),
            source(
                "judges/booking.yaml",
                &BOOKING_JUDGE.replace("name: booking", "name: helpful"),
            ),
        ];
        assert!(parse_judge_definitions(&sources).is_err());
        assert!(parse_mission_judge_definitions(&sources).is_err());
    }

    #[test]
    fn a_mission_question_is_text_with_true_and_false_criteria() {
        for broken in [
            BOOKING_JUDGE.replace(
                "    criteria:\n      \"true\": The same trip.\n",
                "    criteria:\n",
            ),
            BOOKING_JUDGE.replace("\"true\"", "maybe"),
            BOOKING_JUDGE.replace(
                "instructions: Is this",
                "instructions: \"\"\n    rules: Is this",
            ),
        ] {
            assert!(
                parse_mission_judge_definitions(&[source("judges/booking.yaml", &broken)]).is_err(),
                "{broken}"
            );
        }
    }

    #[test]
    fn eval_case_reads_its_front_matter() {
        let case = parse_eval_case(
            "\u{feff}---\r\nid: C3\r\ntitle: The owner's words\r\ncheck: code\r\n\
             inputs:\r\n  - { name: a.docx, sha256: abc, location: here }\r\n\
             sources: [documents]\r\napproved_by: owner@example.com\r\n\
             approved_at: 2026-11-04\r\napproved_in: 1234\r\n\
             conversation: { id: conv_1, turn: 3, extra: kept out }\r\n\
             issue: 0b6f2c1e-5a4d-4c3b-9a8e-7f6d5c4b3a21\r\n---\r\n\r\n## Situation\r\n",
        )
        .unwrap();
        assert_eq!(
            case,
            EvalCase {
                id: Some("C3".into()),
                check: Some(EvalCaseCheck::Code),
                approved_by: Some("owner@example.com".into()),
                approved_at: Some("2026-11-04".into()),
                approved_in: Some("1234".into()),
                approved_hash: None,
                conversation: Some(EvalCaseConversation {
                    id: "conv_1".into(),
                    task_id: None,
                    turn: Some(3),
                }),
                issue: Some("0b6f2c1e-5a4d-4c3b-9a8e-7f6d5c4b3a21".into()),
            }
        );
        assert!(case.is_approved());
    }

    #[test]
    fn case_approval_hash_is_the_sha256_of_the_trimmed_body() {
        // printf '## Situation\nHello.' | shasum -a 256
        let hash = "sha256:1ec2603d45fdf6f26035f147fefedcb238336e6ff14f44e11eb146a5c256617b";
        assert_eq!(case_approval_hash("## Situation\nHello."), hash);
        for same in [
            "## Situation\r\nHello.\r\n",
            "## Situation   \nHello.\t\n\n  \n",
        ] {
            assert_eq!(case_approval_hash(same), hash, "{same:?}");
        }
        assert_ne!(case_approval_hash("## Situation\nHello!"), hash);
        assert_ne!(case_approval_hash("## Situation\n\nHello."), hash);
    }

    #[test]
    fn eval_case_body_is_what_follows_the_front_matter() {
        assert_eq!(
            eval_case_body("\u{feff}---\r\nid: C1\r\n---\r\n\r\n## Situation\r\n").as_deref(),
            Some("\n## Situation\n")
        );
        assert_eq!(eval_case_body("---\n---\nbody").as_deref(), Some("body"));
        assert_eq!(eval_case_body("---\nid: C1\n---").as_deref(), Some(""));
        assert_eq!(eval_case_body("no front matter"), None);
        let draft = "---\nid: C1\n---\n## Situation\nHello.\n";
        let approved =
            "---\nid: C1\napproved_by: owner\napproved_hash: x\n---\n## Situation\nHello.\n";
        assert_eq!(
            case_approval_hash(&eval_case_body(draft).unwrap()),
            case_approval_hash(&eval_case_body(approved).unwrap())
        );
    }

    #[test]
    fn eval_case_approved_hash_matches_its_body() {
        let body = "## Situation\nHello.\n";
        let case = EvalCase {
            approved_hash: Some(
                case_approval_hash(body)
                    .to_uppercase()
                    .replace("SHA256", "sha256"),
            ),
            ..EvalCase::default()
        };
        assert_eq!(case.approved_hash_matches(body), Some(true));
        assert_eq!(
            case.approved_hash_matches("## Situation\nBye.\n"),
            Some(false)
        );
        assert_eq!(EvalCase::default().approved_hash_matches(body), None);
    }

    #[test]
    fn eval_case_blank_fields_are_a_draft() {
        let case = parse_eval_case(
            "---\nid: C1\ncheck: later\napproved_by:\napproved_at: ''\napproved_in: '  '\n---\n",
        )
        .unwrap();
        assert_eq!(case.check, Some(EvalCaseCheck::Later));
        assert_eq!(
            case.missing_approval(),
            ["approved_by", "approved_at", "approved_in"]
        );
        assert!(!case.is_approved());
        assert_eq!(
            parse_eval_case("---\n---\nbody\n").unwrap(),
            EvalCase::default()
        );
    }

    #[test]
    fn eval_case_errors() {
        for (content, needle) in [
            ("# just a body\n", "has no YAML front matter"),
            ("---\nid: C1\n", "has no YAML front matter"),
            ("---\ncheck: maybe\n---\n", "not a valid case"),
            ("---\nconversation: { turn: 1 }\n---\n", "not a valid case"),
            ("---\napproved_by: [a, b]\n---\n", "expected a scalar"),
            ("---\n- a list\n---\n", "not a valid case"),
        ] {
            let err = parse_eval_case(content).unwrap_err().to_string();
            assert!(err.contains(needle), "{content:?}: {err}");
        }
    }
}
