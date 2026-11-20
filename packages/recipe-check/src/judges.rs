//! Portable validation for authored Recipe `judges/*.yaml` definitions.
//!
//! This module deliberately stops at the recipe boundary. It validates the
//! authored, platform-neutral contract but does not calculate project-scoped
//! identities, normalize registry rows, assemble transcripts, call models, or
//! evaluate applicability gates. Those operations belong to the evaluator.
//! The typed, exported form of the same contract lives in
//! [`crate::spec`]; the two are held in agreement by tests there.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::spec::{
    gate_regex_error, is_classifier_question_name, llm_local_warning, thinking_level_for_effort,
    validate_mission_judge as validate_mission_judge_spec, MissionJudgeDefinition,
    LLM_MAX_OUTPUT_TOKENS, MAX_JUDGE_QUESTIONS, MISSION_JUDGE_TYPE, ONLINE_JUDGE_TYPE,
};
use crate::{span_from_message, validate_ai_block, AiOwner, CheckContext};

const JUDGES_DIR: &str = "judges";
const TOP_LEVEL_FIELDS: &[&str] = &[
    "ai",
    "description",
    "instructions",
    "judge",
    "llm",
    "name",
    "on",
    "questions",
    "sample",
    "type",
];
const QUESTION_FIELDS: &[&str] = &["criteria", "instructions", "threshold"];
const CRITERIA_FIELDS: &[&str] = &["false", "true"];
const MATCHER_FIELDS: &[&str] = &["event", "match"];
const LLM_FIELDS: &[&str] = &["local", "model", "provider", "request", "transport"];
const REQUEST_FIELDS: &[&str] = &["max_tokens", "reasoning_effort", "temperature"];
const TRANSPORT_FIELDS: &[&str] = &["max_retries", "max_retry_delay_ms", "timeout_ms"];
const LOCAL_FIELDS: &[&str] = &["api_key_env", "base_url"];

const MAX_PROVIDER_BYTES: usize = 64;
const MAX_MODEL_BYTES: usize = 255;
const MAX_TIMEOUT_MS: u64 = 600_000;
const MAX_RETRIES: u64 = 10;
const MAX_RETRY_DELAY_MS: u64 = 60_000;

const MAX_JUDGE_NAME_CHARS: usize = 255;
const MAX_DESCRIPTION_CHARS: usize = 2_000;

#[derive(Debug)]
struct ValidatedJudge {
    path: String,
    name: Option<String>,
}

/// Discover and validate direct-child `judges/*.yaml` and `judges/*.yml`.
///
/// Returns the number of discovered judge sources for the report's resource
/// inventory. Nested paths are intentionally ignored by the authored contract.
pub(super) fn validate_judges(ctx: &mut CheckContext) -> usize {
    let paths = ctx
        .child_files(JUDGES_DIR)
        .into_iter()
        .filter(|path| crate::is_yaml_path(path))
        .map(str::to_owned)
        .collect::<Vec<_>>();

    let mut judges = Vec::with_capacity(paths.len());
    for path in &paths {
        judges.push(validate_judge(path, ctx));
    }
    validate_unique_names(&judges, ctx);
    paths.len()
}

fn validate_judge(path: &str, ctx: &mut CheckContext) -> ValidatedJudge {
    let Some(content) = ctx.content(path).map(str::to_owned) else {
        ctx.error(
            "judge.unreadable",
            path,
            "Judge YAML content was not provided",
            Some("supply judge YAML content to the validator"),
        );
        return ValidatedJudge {
            path: path.to_owned(),
            name: None,
        };
    };

    let parsed: Value = match serde_saphyr::from_str(&content) {
        Ok(value) => value,
        Err(err) => {
            let message = err.to_string();
            ctx.error_at(
                "judge.yaml_malformed",
                path,
                span_from_message(&message),
                format!("Judge file is not valid YAML: {message}"),
                Some("fix the YAML syntax"),
            );
            return ValidatedJudge {
                path: path.to_owned(),
                name: None,
            };
        }
    };

    let Some(map) = parsed.as_object() else {
        ctx.error(
            "judge.invalid",
            path,
            "Judge file must contain a YAML mapping",
            Some("make the top-level YAML value a mapping"),
        );
        return ValidatedJudge {
            path: path.to_owned(),
            name: None,
        };
    };

    match map.get("type") {
        None => {}
        Some(kind) if kind == ONLINE_JUDGE_TYPE => {}
        Some(kind) if kind == MISSION_JUDGE_TYPE => {
            return validate_mission_judge(path, &content, ctx)
        }
        Some(kind) => {
            let hint = if kind == "offline" {
                "`offline` is not a judge type: a judge that grades only eval trials belongs to its eval suite (a Vitest `createJudge`, a judge YAML under `evals/vitest/judges/` loaded by path through `recipeJudge`, or a Harbor RewardKit `[judge]` TOML in the task's `tests/`), so move it there"
            } else {
                "`online` judges every runtime conversation, `mission` a request a policy route names"
            };
            ctx.error(
                "judge.type_invalid",
                path,
                "Judge type must be `online` (the default) or `mission`",
                Some(hint),
            );
            return ValidatedJudge {
                path: path.to_owned(),
                name: None,
            };
        }
    }

    reject_unknown_fields(
        map,
        TOP_LEVEL_FIELDS,
        "judge.unknown_field",
        "judge definition",
        path,
        ctx,
    );
    let name = validate_name(map, path, ctx);
    validate_description(map, path, ctx);
    validate_kind(map, path, ctx);
    validate_on(map.get("on"), path, ctx);
    validate_sample(map, path, ctx);
    validate_model(map, path, ctx);

    ValidatedJudge {
        path: path.to_owned(),
        name,
    }
}

/// A `type: mission` judge, checked against the typed spec.
fn validate_mission_judge(path: &str, content: &str, ctx: &mut CheckContext) -> ValidatedJudge {
    let checked = serde_saphyr::from_str::<MissionJudgeDefinition>(content)
        .map_err(|err| err.to_string())
        .and_then(|definition| {
            validate_mission_judge_spec(&definition, &format!("judge {path}"))
                .map(|()| definition)
                .map_err(|err| err.to_string())
        });
    match checked {
        Ok(definition) => ValidatedJudge {
            path: path.to_owned(),
            name: Some(definition.name),
        },
        Err(message) => {
            ctx.error(
                "judge.mission_invalid",
                path,
                format!("Mission judge is invalid: {message}"),
                Some("a mission judge declares name, type: mission, optional description and attributes, and questions of instructions with optional true/false criteria"),
            );
            ValidatedJudge {
                path: path.to_owned(),
                name: None,
            }
        }
    }
}

fn validate_name(map: &Map<String, Value>, path: &str, ctx: &mut CheckContext) -> Option<String> {
    if map.contains_key("name") && map.contains_key("judge") {
        ctx.error(
            "judge.name_conflict",
            path,
            "Judge definition cannot declare both name and legacy judge",
            Some("keep `name:` and remove the deprecated `judge:` field"),
        );
        return None;
    }

    match map.get("name").or_else(|| map.get("judge")) {
        None | Some(Value::Null) => {
            ctx.error(
                "judge.name_missing",
                path,
                "Judge definition must declare a non-empty judge name",
                Some("add `name: <unique-name>`"),
            );
            None
        }
        Some(Value::String(name)) if name.trim().is_empty() => {
            ctx.error(
                "judge.name_invalid",
                path,
                "Judge name must be a non-empty string",
                Some("set name to a unique value containing at most 255 characters"),
            );
            None
        }
        Some(Value::String(name)) if name.chars().count() > MAX_JUDGE_NAME_CHARS => {
            ctx.error(
                "judge.name_invalid",
                path,
                "Judge name must contain at most 255 characters",
                Some("shorten the judge name"),
            );
            None
        }
        Some(Value::String(name)) if is_portable_name(name) => Some(name.clone()),
        Some(Value::String(_)) => {
            ctx.error(
                "judge.name_invalid",
                path,
                "Judge name must use lowercase kebab-case",
                Some("use lowercase ASCII letters, digits, and single hyphens"),
            );
            None
        }
        Some(_) => {
            ctx.error(
                "judge.name_invalid",
                path,
                "Judge name must be a non-empty string",
                Some("set name to a unique string value"),
            );
            None
        }
    }
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

fn validate_description(map: &Map<String, Value>, path: &str, ctx: &mut CheckContext) {
    match map.get("description") {
        None | Some(Value::Null) => {}
        Some(Value::String(value)) if value.chars().count() <= MAX_DESCRIPTION_CHARS => {}
        Some(Value::String(_)) => ctx.error(
            "judge.description_invalid",
            path,
            "Judge description must contain at most 2000 characters",
            Some("shorten the optional description"),
        ),
        Some(_) => ctx.error(
            "judge.description_invalid",
            path,
            "Judge description must be a string",
            Some("remove description or provide a string"),
        ),
    }
}

fn validate_sample(map: &Map<String, Value>, path: &str, ctx: &mut CheckContext) {
    let Some(sample) = map.get("sample") else {
        return;
    };
    if !sample
        .as_f64()
        .is_some_and(|sample| sample > 0.0 && sample <= 1.0)
    {
        ctx.error(
            "judge.sample_invalid",
            path,
            "Judge sample must be a number greater than 0 and at most 1",
            Some("remove sample to judge every conversation `on` selects"),
        );
    }
}

fn validate_kind(map: &Map<String, Value>, path: &str, ctx: &mut CheckContext) {
    let instructions = map.get("instructions").filter(|value| !value.is_null());
    let questions = map.get("questions").filter(|value| !value.is_null());
    match (instructions, questions) {
        (Some(instructions), None) => validate_instructions(instructions, path, ctx),
        (None, Some(questions)) => validate_questions(questions, path, ctx),
        _ => ctx.error(
            "judge.kind_invalid",
            path,
            "Judge declares either `instructions`, answered by a chat model, or `questions`, answered by a classifier",
            Some("declare exactly one of `instructions` and `questions`"),
        ),
    }
}

fn validate_instructions(value: &Value, path: &str, ctx: &mut CheckContext) {
    match value {
        Value::String(value) if !value.trim().is_empty() => {}
        Value::String(_) => ctx.error(
            "judge.instructions_invalid",
            path,
            "Judge instructions must be non-empty",
            Some("write the grading rubric under `instructions`"),
        ),
        _ => ctx.error(
            "judge.instructions_invalid",
            path,
            "Judge instructions must be a non-empty string",
            Some("use a YAML string or block scalar for the grading rubric"),
        ),
    }
}

fn validate_questions(value: &Value, path: &str, ctx: &mut CheckContext) {
    let Some(questions) = value.as_object() else {
        ctx.error(
            "judge.questions_invalid",
            path,
            "Judge questions must be a mapping of question names to questions",
            Some("declare each question as `<name>: { instructions, criteria, threshold? }`"),
        );
        return;
    };
    if questions.is_empty() || questions.len() > MAX_JUDGE_QUESTIONS {
        ctx.error(
            "judge.questions_invalid",
            path,
            format!("Judge must ask between 1 and {MAX_JUDGE_QUESTIONS} questions"),
            Some("split a longer rubric across judges"),
        );
    }
    for (name, question) in questions {
        if !is_classifier_question_name(name) {
            ctx.error(
                "judge.question.name_invalid",
                path,
                format!("Judge question name '{name}' must be a lowercase identifier"),
                Some("start with a lowercase letter, then lowercase letters, digits, and underscores"),
            );
        }
        let Some(question) = question.as_object() else {
            ctx.error(
                "judge.question.invalid",
                path,
                format!("Judge question '{name}' must be a mapping"),
                Some("declare instructions, criteria, and an optional threshold"),
            );
            continue;
        };
        validate_question(name, question, path, ctx);
    }
}

fn validate_question(
    name: &str,
    question: &Map<String, Value>,
    path: &str,
    ctx: &mut CheckContext,
) {
    reject_unknown_fields(
        question,
        QUESTION_FIELDS,
        "judge.question.unknown_field",
        &format!("judge question '{name}'"),
        path,
        ctx,
    );
    if !question
        .get("instructions")
        .is_some_and(is_non_empty_string)
    {
        ctx.error(
            "judge.question.instructions_invalid",
            path,
            format!("Judge question '{name}' must declare non-empty instructions"),
            Some("write what is asked, and how to judge it, under `instructions`"),
        );
    }
    match question.get("criteria") {
        None | Some(Value::Null) => ctx.error(
            "judge.question.criteria_missing",
            path,
            format!("Judge question '{name}' must declare criteria"),
            Some("say what a `true` and a `false` answer mean under `criteria`"),
        ),
        Some(Value::Object(criteria))
            if criteria.len() == CRITERIA_FIELDS.len()
                && CRITERIA_FIELDS
                    .iter()
                    .all(|field| criteria.get(*field).is_some_and(is_non_empty_string)) => {}
        Some(_) => ctx.error(
            "judge.question.criteria_invalid",
            path,
            format!(
                "Judge question '{name}' criteria must be a mapping of `true` and `false` to non-empty strings"
            ),
            Some("quote the keys: `\"true\": ...` and `\"false\": ...`"),
        ),
    }
    if let Some(threshold) = question.get("threshold") {
        if !threshold
            .as_f64()
            .is_some_and(|threshold| threshold > 0.0 && threshold <= 1.0)
        {
            ctx.error(
                "judge.question.threshold_invalid",
                path,
                format!(
                    "Judge question '{name}' threshold must be a number greater than 0 and at most 1"
                ),
                Some("remove threshold for the default 0.5"),
            );
        }
    }
}

fn is_non_empty_string(value: &Value) -> bool {
    value.as_str().is_some_and(|text| !text.trim().is_empty())
}

/// A judge declares its model once: as `ai:`, or as the older `llm:`, which
/// the strict parser maps to `ai:`.
/// Declaring both keys is refused even when one is null, as the strict parser
/// refuses it.
fn validate_model(map: &Map<String, Value>, path: &str, ctx: &mut CheckContext) {
    let both = map.contains_key("ai") && map.contains_key("llm");
    let ai = map.get("ai").filter(|value| !value.is_null());
    let llm = map.get("llm").filter(|value| !value.is_null());
    match (ai, llm) {
        _ if both => ctx.error(
            "judge.kind_invalid",
            path,
            "Judge declares its model as either `ai:` or the older `llm:`, not both",
            Some("keep `ai: { model: <provider>/<model> }` and remove `llm:`"),
        ),
        (Some(ai), None) => validate_ai(ai, path, ctx),
        (None, Some(llm)) => validate_llm(llm, path, ctx),
        (Some(_), Some(_)) | (None, None) => ctx.error(
            "judge.kind_invalid",
            path,
            "Judge declares its model as either `ai:` or the older `llm:`",
            Some("add `ai: { model: <provider>/<model> }`, as an agent does"),
        ),
    }
}

fn validate_ai(ai: &Value, path: &str, ctx: &mut CheckContext) {
    validate_ai_block(ai, path, &AiOwner::judge(), ctx);
    if ai.as_object().is_some_and(|ai| !ai.contains_key("model")) {
        ctx.error(
            "judge.ai.model_missing",
            path,
            "Judge ai.model is required",
            Some("set ai.model to `<provider>/<model_id>`"),
        );
    }
}

fn validate_llm(value: &Value, path: &str, ctx: &mut CheckContext) {
    let Some(llm) = value.as_object() else {
        ctx.error(
            "judge.llm_invalid",
            path,
            "Judge llm must be a mapping",
            Some("declare the model as `ai: { model: <provider>/<model> }`, as an agent does"),
        );
        return;
    };
    reject_unknown_fields(
        llm,
        LLM_FIELDS,
        "judge.llm.unknown_field",
        "judge llm",
        path,
        ctx,
    );
    validate_llm_provider(llm.get("provider"), path, ctx);
    validate_llm_model(llm.get("model"), path, ctx);
    validate_request(llm.get("request"), path, ctx);
    validate_transport(llm.get("transport"), path, ctx);
    validate_local(llm.get("local"), path, ctx);
}

fn validate_llm_provider(value: Option<&Value>, path: &str, ctx: &mut CheckContext) {
    // Omission defaults to openai.
    let Some(value) = value else { return };
    let valid = value.as_str().is_some_and(|provider| {
        !provider.is_empty()
            && provider.len() <= MAX_PROVIDER_BYTES
            && provider
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    });
    if !valid {
        ctx.error(
            "judge.llm.provider_invalid",
            path,
            "Judge llm.provider must be a lowercase provider slug",
            Some("use 1-64 lowercase ASCII letters, digits, or hyphens, or omit it for openai"),
        );
    }
}

fn validate_llm_model(value: Option<&Value>, path: &str, ctx: &mut CheckContext) {
    match value {
        None | Some(Value::Null) => ctx.error(
            "judge.llm.model_missing",
            path,
            "Judge llm.model is required",
            Some("set llm.model to the provider's model identifier"),
        ),
        Some(Value::String(model))
            if !model.trim().is_empty()
                && model.len() <= MAX_MODEL_BYTES
                && model == model.trim() => {}
        Some(_) => ctx.error(
            "judge.llm.model_invalid",
            path,
            "Judge llm.model must be a non-empty string without surrounding whitespace",
            Some("set llm.model to a model identifier containing at most 255 bytes"),
        ),
    }
}

fn validate_request(value: Option<&Value>, path: &str, ctx: &mut CheckContext) {
    let Some(value) = value else { return };
    let Some(request) = value.as_object() else {
        ctx.error(
            "judge.llm.request_invalid",
            path,
            "Judge llm.request must be a mapping",
            Some("declare only temperature, max_tokens, and reasoning_effort overrides"),
        );
        return;
    };
    reject_unknown_fields(
        request,
        REQUEST_FIELDS,
        "judge.llm.request.unknown_field",
        "judge llm.request",
        path,
        ctx,
    );
    if let Some(value) = request.get("temperature") {
        let valid = value.as_f64().is_some_and(|temperature| {
            temperature.is_finite() && (0.0..=2.0).contains(&temperature)
        });
        if !valid {
            ctx.error(
                "judge.llm.request.temperature_invalid",
                path,
                "Judge llm.request.temperature must be a number between 0 and 2",
                Some("remove the override, or use a value from 0 through 2"),
            );
        }
    }
    if let Some(value) = request.get("max_tokens").filter(|value| !value.is_null()) {
        let valid = value
            .as_u64()
            .is_some_and(|tokens| (1..=LLM_MAX_OUTPUT_TOKENS).contains(&tokens));
        if !valid {
            ctx.error(
                "judge.llm.request.max_tokens_invalid",
                path,
                format!("Judge llm.request.max_tokens must be an integer between 1 and {LLM_MAX_OUTPUT_TOKENS}"),
                Some("choose a bounded maximum output token count"),
            );
        }
    }
    if let Some(value) = request
        .get("reasoning_effort")
        .filter(|value| !value.is_null())
    {
        if value.as_str().and_then(thinking_level_for_effort).is_none() {
            ctx.error(
                "judge.llm.request.reasoning_effort_invalid",
                path,
                "Judge llm.request.reasoning_effort must name a thinking level",
                Some("use none, minimal, low, medium, high, xhigh, or max; it is read as ai.thinking_level"),
            );
        }
    }
}

fn validate_transport(value: Option<&Value>, path: &str, ctx: &mut CheckContext) {
    let Some(value) = value else { return };
    let Some(transport) = value.as_object() else {
        ctx.error(
            "judge.llm.transport_invalid",
            path,
            "Judge llm.transport must be a mapping",
            Some("remove llm.transport: the host owns timeouts and retries"),
        );
        return;
    };
    reject_unknown_fields(
        transport,
        TRANSPORT_FIELDS,
        "judge.llm.transport.unknown_field",
        "judge llm.transport",
        path,
        ctx,
    );
    for (field, min, max) in [
        ("timeout_ms", 1, MAX_TIMEOUT_MS),
        ("max_retries", 0, MAX_RETRIES),
        ("max_retry_delay_ms", 0, MAX_RETRY_DELAY_MS),
    ] {
        let Some(value) = transport.get(field) else {
            continue;
        };
        if !value
            .as_u64()
            .is_some_and(|value| (min..=max).contains(&value))
        {
            ctx.error(
                format!("judge.llm.transport.{field}_invalid"),
                path,
                format!("Judge llm.transport.{field} must be an integer between {min} and {max}"),
                Some("remove llm.transport: the host owns timeouts and retries"),
            );
        }
    }
}

fn validate_local(value: Option<&Value>, path: &str, ctx: &mut CheckContext) {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return;
    };
    let valid = value.as_object().is_some_and(|local| {
        local.keys().all(|key| LOCAL_FIELDS.contains(&key.as_str()))
            && LOCAL_FIELDS
                .iter()
                .all(|field| local.get(*field).is_some_and(Value::is_string))
    });
    if !valid {
        ctx.error(
            "judge.llm.local_invalid",
            path,
            "Judge llm.local must be a mapping of base_url and api_key_env",
            Some("remove llm.local: `ai:` cannot express a local endpoint"),
        );
        return;
    }
    ctx.warning(
        "judge.llm.local_ignored",
        path,
        llm_local_warning("Judge"),
        Some("remove llm.local, and name a hosted model in `ai: { model: <provider>/<model> }`"),
    );
}

fn validate_on(value: Option<&Value>, path: &str, ctx: &mut CheckContext) {
    let Some(value) = value else { return };
    if value.is_null() || value.as_object().is_some_and(Map::is_empty) {
        return;
    }
    let Some(matchers) = value.as_array() else {
        ctx.error(
            "judge.on_invalid",
            path,
            "Judge on must be a list of event matchers",
            Some("use entries shaped as `{ event: message|tool|feedback, match: {...} }`"),
        );
        return;
    };

    for (index, matcher) in matchers.iter().enumerate() {
        let Some(matcher) = matcher.as_object() else {
            ctx.error(
                "judge.on.matcher_invalid",
                path,
                format!("Judge on[{index}] must be a mapping with event and optional match"),
                Some("replace the entry with an event matcher mapping"),
            );
            continue;
        };
        reject_unknown_fields(
            matcher,
            MATCHER_FIELDS,
            "judge.on.matcher_unknown_field",
            &format!("judge on[{index}]"),
            path,
            ctx,
        );
        match matcher.get("event") {
            Some(Value::String(event))
                if matches!(event.as_str(), "message" | "tool" | "feedback") => {}
            Some(Value::String(event)) => ctx.error(
                "judge.on.event_invalid",
                path,
                format!("Judge on[{index}] uses unsupported event kind '{event}'"),
                Some("use message, tool, or feedback"),
            ),
            _ => ctx.error(
                "judge.on.event_invalid",
                path,
                format!("Judge on[{index}] must declare event as message, tool, or feedback"),
                Some("add a supported event kind"),
            ),
        }
        let Some(targets) = matcher.get("match") else {
            continue;
        };
        let Some(targets) = targets.as_object() else {
            ctx.error(
                "judge.on.match_invalid",
                path,
                format!("Judge on[{index}].match must be a mapping of field paths to values"),
                Some("remove match to match every event of this kind, or provide a mapping"),
            );
            continue;
        };
        for (field, target) in targets {
            validate_match_field(field, index, path, ctx);
            validate_match_target(target, field, index, path, ctx);
        }
    }
}

fn validate_match_field(field: &str, index: usize, path: &str, ctx: &mut CheckContext) {
    if field.is_empty() {
        ctx.error(
            "judge.on.match_field_invalid",
            path,
            format!("Judge on[{index}].match contains an empty field path"),
            Some("use a non-empty field or dotted field path"),
        );
    } else if matches!(field, "environment" | "runtime_group")
        || field.split('.').next_back() == Some("pattern_id")
    {
        ctx.error(
            "judge.on.match_field_prohibited",
            path,
            format!(
                "Judge on[{index}].match field '{field}' is platform-owned and cannot be authored"
            ),
            Some("gate on normalized conversation content instead"),
        );
    }
}

fn validate_match_target(
    target: &Value,
    field: &str,
    index: usize,
    path: &str,
    ctx: &mut CheckContext,
) {
    match target {
        Value::Array(values) => {
            for value in values {
                validate_match_target(value, field, index, path, ctx);
            }
        }
        Value::String(value) => match regex_literal(value) {
            Ok(Some((pattern, flags))) => {
                if let Some(err) = gate_regex_error(pattern, flags) {
                    ctx.error(
                        "judge.on.regex_invalid",
                        path,
                        format!("Judge on[{index}].match.{field} contains invalid regex '{value}': {err}"),
                        Some("write a pattern that both Rust's regex and JavaScript's RegExp (with the v flag, or failing that the u flag) compile"),
                    );
                }
            }
            Ok(None) => {}
            Err(message) => ctx.error(
                "judge.on.regex_invalid",
                path,
                format!("Judge on[{index}].match.{field} {message}"),
                Some("use unique regex flags from i, m, s, and u"),
            ),
        },
        _ => {}
    }
}

fn regex_literal(value: &str) -> Result<Option<(&str, &str)>, String> {
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
        return Err(format!(
            "uses unsupported regex flags in '{value}'; supported flags are i, m, s, and u"
        ));
    }
    let mut seen = BTreeMap::new();
    for flag in flags.chars() {
        if seen.insert(flag, ()).is_some() {
            return Err(format!("uses duplicate regex flag in '{value}'"));
        }
    }
    Ok(Some((&value[1..index], flags)))
}

fn reject_unknown_fields(
    map: &Map<String, Value>,
    known: &[&str],
    code: &str,
    label: &str,
    path: &str,
    ctx: &mut CheckContext,
) {
    for key in map.keys().filter(|key| !known.contains(&key.as_str())) {
        ctx.error(
            code,
            path,
            format!("{label} contains unknown field '{key}'"),
            Some(format!("supported fields: {}", known.join(", "))),
        );
    }
}

fn validate_unique_names(judges: &[ValidatedJudge], ctx: &mut CheckContext) {
    let mut first_path_by_name = BTreeMap::<&str, &str>::new();
    for judge in judges {
        let Some(name) = judge.name.as_deref() else {
            continue;
        };
        if let Some(first_path) = first_path_by_name.get(name) {
            ctx.error(
                "judge.name_duplicate",
                judge.path.clone(),
                format!("Judge name '{name}' is already declared in {first_path}"),
                Some("give every judge in the recipe a unique name"),
            );
        } else {
            first_path_by_name.insert(name, &judge.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{check_recipe_files, RecipeFile, RecipeFiles};

    const PACKAGE: &str = r#"{
      "name": "judge-test",
      "description": "Judge validation test",
      "pi": { "agents": ["agents/*.yaml"] }
    }"#;
    const AGENT: &str = r#"name: agent
description: Test agent
model:
  name: test/provider-model
  thinking_level: low
tools: []
skills: []
subagents: []
system_instructions:
  content: Test instructions
"#;
    const MINIMAL: &str = r#"name: helpful
instructions: Determine whether the assistant answered correctly.
ai:
  model: openai/gpt-5
"#;
    const CLASSIFIER: &str = r#"name: on-topic
description: Did the assistant stay on topic?
ai:
  model: acme/classifier-1
questions:
  on_topic:
    instructions: Does the reply address what the user asked?
    criteria:
      "true": The reply answers the question asked.
      "false": The reply answers something else.
  polite:
    instructions: Is the reply polite?
    criteria:
      "true": Courteous throughout.
      "false": Rude or dismissive.
    threshold: 0.8
"#;
    const EXPANDED: &str = r#"name: helpful
description: Did the assistant answer correctly?
on:
  - event: message
    match:
      role: assistant
      text: /correct|helpful/imsu
instructions: |
  Determine whether the assistant answered the user correctly.
ai:
  model: openai/gpt-5
  fallbacks: [anthropic/claude-sonnet-5-5, openrouter/acme/model-1]
  thinking_level: medium
  options:
    max_tokens: 1024
  providers:
    openrouter:
      routing:
        only: [acme]
"#;

    fn snapshot(judges: &[(&str, Option<&str>)]) -> RecipeFiles {
        let mut files = vec![
            RecipeFile::new("package.json", PACKAGE),
            RecipeFile::new("agents/agent.yaml", AGENT),
        ];
        files.extend(judges.iter().map(|(path, content)| match content {
            Some(content) => RecipeFile::new(*path, *content),
            None => RecipeFile::unread(*path),
        }));
        RecipeFiles {
            files,
            directories: Vec::new(),
        }
    }

    fn judge_diagnostics(judges: &[(&str, Option<&str>)]) -> Vec<crate::Diagnostic> {
        check_recipe_files(&snapshot(judges))
            .diagnostics
            .into_iter()
            .filter(|diagnostic| diagnostic.code.starts_with("judge."))
            .collect()
    }

    #[test]
    fn accepts_optional_absence_minimal_expanded_yaml_and_yml() {
        let none = check_recipe_files(&snapshot(&[]));
        assert!(none.valid, "{:?}", none.diagnostics);
        assert!(!none.resources.contains_key("judges"));

        let report = check_recipe_files(&snapshot(&[
            ("judges/minimal.yaml", Some(MINIMAL)),
            (
                "judges/expanded.yml",
                Some(&EXPANDED.replace("name: helpful", "name: expanded")),
            ),
        ]));
        assert!(report.valid, "{:?}", report.diagnostics);
        assert_eq!(report.resources.get("judges"), Some(&2));
    }

    #[test]
    fn accepts_legacy_judge_name_alias_but_rejects_both_fields() {
        let legacy = check_recipe_files(&snapshot(&[(
            "judges/legacy.yaml",
            Some(&MINIMAL.replace("name: helpful", "judge: helpful")),
        )]));
        assert!(legacy.valid, "{:?}", legacy.diagnostics);

        let diagnostics = judge_diagnostics(&[(
            "judges/conflict.yaml",
            Some(
                "name: helpful\njudge: legacy\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n",
            ),
        )]);
        assert_eq!(diagnostics[0].code, "judge.name_conflict");
    }

    #[test]
    fn ignores_nested_judge_yaml() {
        let report = check_recipe_files(&snapshot(&[(
            "judges/nested/foo.yaml",
            Some("not: a judge\n"),
        )]));
        assert!(report.valid, "{:?}", report.diagnostics);
        assert!(!report.resources.contains_key("judges"));
    }

    #[test]
    fn reports_malformed_unreadable_and_non_mapping_sources() {
        let diagnostics = judge_diagnostics(&[
            ("judges/a.yaml", Some("name: [unterminated\n")),
            ("judges/b.yml", None),
            ("judges/c.yaml", Some("- a\n- list\n")),
        ]);
        assert_eq!(
            diagnostics
                .iter()
                .map(|item| item.code.as_str())
                .collect::<Vec<_>>(),
            ["judge.yaml_malformed", "judge.unreadable", "judge.invalid"]
        );
        assert!(diagnostics[0].span.is_some());
        assert_eq!(diagnostics[0].path, "judges/a.yaml");
    }

    #[test]
    fn rejects_unknown_fields_and_required_strings() {
        let diagnostics = judge_diagnostics(&[(
            "judges/invalid.yaml",
            Some(
                r#"name: ""
instructions: "  "
unexpected: true
ai:
  model: ""
  surprise: true
"#,
            ),
        )]);
        let codes = diagnostics
            .iter()
            .map(|item| item.code.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            codes,
            [
                "judge.unknown_field",
                "judge.name_invalid",
                "judge.instructions_invalid",
                "judge.ai_key_unknown",
                "judge.ai.model_invalid",
            ]
        );
    }

    #[test]
    fn rejects_noncanonical_judge_names() {
        for name in ["DeepWiki", "deep_wiki", "deep--wiki", " deepwiki"] {
            let diagnostics = judge_diagnostics(&[(
                "judges/invalid-name.yaml",
                Some(&format!(
                    "name: {name:?}\ninstructions: Grade.\nai:\n  model: openai/gpt-5\n"
                )),
            )]);
            assert!(diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "judge.name_invalid"));
        }
    }

    fn codes(judge: &str) -> Vec<String> {
        judge_diagnostics(&[("judges/probe.yaml", Some(judge))])
            .into_iter()
            .map(|item| item.code)
            .collect()
    }

    const LLM: &str = "name: legacy\ninstructions: Grade it.\nllm:\n  provider: anthropic\n  model: claude-sonnet-5-5\n  request:\n    temperature: 0.2\n    max_tokens: 512\n    reasoning_effort: none\n  transport:\n    timeout_ms: 30000\n    max_retries: 2\n";

    #[test]
    fn accepts_the_older_llm_block() {
        let report = check_recipe_files(&snapshot(&[
            ("judges/legacy.yaml", Some(LLM)),
            (
                "judges/bare.yaml",
                Some("name: bare\ninstructions: Grade it.\nllm:\n  model: gpt-5\n"),
            ),
        ]));
        assert!(report.valid, "{:?}", report.diagnostics);
        assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);
    }

    #[test]
    fn a_judge_declares_ai_or_llm_never_both_or_neither() {
        let both = format!("{MINIMAL}llm:\n  model: gpt-5\n");
        let neither = "name: probe\ninstructions: Grade it.\n";
        for judge in [both.as_str(), neither] {
            assert_eq!(codes(judge), ["judge.kind_invalid"], "{judge}");
        }
        assert_eq!(
            codes(&MINIMAL.replace(
                "instructions:",
                "on:\n  - event: message\n    llm: x\ninstructions:"
            )),
            ["judge.on.matcher_unknown_field"]
        );
    }

    #[test]
    fn validates_the_llm_block() {
        for (llm, code) in [
            ("llm: gpt-5", "judge.llm_invalid"),
            ("llm:\n  provider: openai", "judge.llm.model_missing"),
            ("llm:\n  model: ' gpt-5'", "judge.llm.model_invalid"),
            (
                "llm:\n  provider: OpenAI\n  model: gpt-5",
                "judge.llm.provider_invalid",
            ),
            ("llm:\n  model: gpt-5\n  seed: 1", "judge.llm.unknown_field"),
            (
                "llm:\n  model: gpt-5\n  request:\n    temperature: 3",
                "judge.llm.request.temperature_invalid",
            ),
            (
                "llm:\n  model: gpt-5\n  request:\n    max_tokens: 0",
                "judge.llm.request.max_tokens_invalid",
            ),
            (
                "llm:\n  model: gpt-5\n  request:\n    reasoning_effort: extreme",
                "judge.llm.request.reasoning_effort_invalid",
            ),
            (
                "llm:\n  model: gpt-5\n  transport:\n    timeout_ms: 0",
                "judge.llm.transport.timeout_ms_invalid",
            ),
            (
                "llm:\n  model: gpt-5\n  local:\n    base_url: http://localhost:8080",
                "judge.llm.local_invalid",
            ),
        ] {
            assert_eq!(
                codes(&format!("name: probe\ninstructions: Grade it.\n{llm}\n")),
                [code],
                "{llm}"
            );
        }
    }

    #[test]
    fn an_llm_local_endpoint_is_a_warning() {
        let report = check_recipe_files(&snapshot(&[(
            "judges/local.yaml",
            Some("name: local\ninstructions: Grade it.\nllm:\n  model: gpt-5\n  local:\n    base_url: http://localhost:8080\n    api_key_env: LOCAL_KEY\n"),
        )]));
        assert!(report.valid, "{:?}", report.diagnostics);
        let warning = &report.diagnostics[0];
        assert_eq!(warning.code, "judge.llm.local_ignored");
        assert_eq!(warning.severity, crate::Severity::Warning);
    }

    #[test]
    fn a_gate_regex_must_compile_in_rust_and_javascript() {
        let gate = |pattern: &str| {
            MINIMAL.replace(
                "instructions:",
                &format!(
                    "on:\n  - event: message\n    match:\n      text: '{pattern}'\ninstructions:"
                ),
            )
        };
        assert_eq!(codes(&gate(r"/[\w&&[^_]]+/i")), [] as [&str; 0]);
        // Lookahead: JavaScript compiles it, Rust's regex refuses it.
        let rust = judge_diagnostics(&[("judges/probe.yaml", Some(&gate("/foo(?=bar)/")))]);
        assert_eq!(rust.len(), 1);
        assert_eq!(rust[0].code, "judge.on.regex_invalid");
        assert!(
            rust[0].message.contains("Rust regex"),
            "{}",
            rust[0].message
        );
        // A Rust named group: JavaScript refuses it under both flags.
        let js = judge_diagnostics(&[("judges/probe.yaml", Some(&gate("/(?P<word>a)/")))]);
        assert_eq!(js.len(), 1);
        assert_eq!(js[0].code, "judge.on.regex_invalid");
        assert!(
            js[0].message.contains("JavaScript regex"),
            "{}",
            js[0].message
        );
        assert_eq!(codes(&gate("/(abc/i")), ["judge.on.regex_invalid"]);
    }

    #[test]
    fn a_gate_regex_compiles_under_the_v_flag_or_failing_that_the_u_flag() {
        let gate = |pattern: &str| {
            MINIMAL.replace(
                "instructions:",
                &format!(
                    "on:\n  - event: message\n    match:\n      text: '{pattern}'\ninstructions:"
                ),
            )
        };
        for pattern in [
            r"/[\w-]+@acme/",
            "/[a-z-]/",
            "/[^/]+/",
            "/[|]/",
            "/[(]/",
            r"/[\w-]+@acme/imsu",
            r"/[\w--\d]+/",
            "/[[a-z_]&&[^0-9]]/",
            r"/[\w--\d]+/iu",
        ] {
            assert_eq!(codes(&gate(pattern)), [] as [&str; 0], "{pattern}");
        }
    }

    #[test]
    fn requires_an_ai_block_naming_a_model() {
        for (ai, code) in [
            ("", "judge.kind_invalid"),
            ("ai: null\n", "judge.kind_invalid"),
            (
                "ai:\n  model: openai/gpt-5\nllm: null\n",
                "judge.kind_invalid",
            ),
            ("llm:\n  model: gpt-5\nai: null\n", "judge.kind_invalid"),
            ("llm: null\n", "judge.kind_invalid"),
            ("ai: openai/gpt-5\n", "judge.ai_invalid"),
            ("ai: {}\n", "judge.ai.model_missing"),
            ("ai:\n  thinking_level: low\n", "judge.ai.model_missing"),
            ("ai:\n  model: gpt-5\n", "judge.ai.model_invalid"),
            (
                "ai:\n  model: \"openai:x/gpt-5\"\n",
                "judge.ai.model_invalid",
            ),
            ("ai:\n  model: 5\n", "judge.ai.model_invalid"),
            ("ai:\n  model: null\n", "judge.ai.model_invalid"),
        ] {
            assert_eq!(
                codes(&format!("name: probe\ninstructions: Grade it.\n{ai}")),
                [code],
                "{ai}"
            );
        }
    }

    #[test]
    fn validates_the_ai_block_as_an_agents() {
        for (ai, code) in [
            (
                "fallbacks: anthropic/claude-sonnet-5-5",
                "judge.ai.fallbacks_invalid",
            ),
            (
                "fallbacks: [anthropic/claude-sonnet-5-5, 3]",
                "judge.ai.fallbacks_invalid",
            ),
            (
                "fallbacks: [claude-sonnet-5-5]",
                "judge.ai.fallback_invalid",
            ),
            ("thinking_level: extreme", "judge.ai.thinking_level_invalid"),
            ("options: none", "judge.ai.options_invalid"),
            ("options: { maxTokens: 1 }", "judge.ai.options_key_invalid"),
            (
                "options: { api_key: secret }",
                "judge.ai.options_key_blocked",
            ),
            ("providers: none", "judge.ai.providers_invalid"),
            ("providers: { acme: {} }", "judge.ai.providers_key_unknown"),
            (
                "providers: { vercel_ai_gateway: { routing: { byok: {} } } }",
                "judge.ai.providers.vercel_ai_gateway.routing_key_blocked",
            ),
            ("temperature: 0", "judge.ai_key_unknown"),
        ] {
            let diagnostics = judge_diagnostics(&[(
                "judges/probe.yaml",
                Some(&format!(
                    "name: probe\ninstructions: Grade it.\nai:\n  model: openai/gpt-5\n  {ai}\n"
                )),
            )]);
            assert_eq!(
                diagnostics
                    .iter()
                    .map(|item| item.code.as_str())
                    .collect::<Vec<_>>(),
                [code],
                "{ai}"
            );
            assert!(
                diagnostics[0].message.starts_with("Judge "),
                "{}",
                diagnostics[0].message
            );
        }
    }

    #[test]
    fn accepts_a_classifier_judge() {
        let report = check_recipe_files(&snapshot(&[
            ("judges/minimal.yaml", Some(MINIMAL)),
            ("judges/on-topic.yaml", Some(CLASSIFIER)),
        ]));
        assert!(report.valid, "{:?}", report.diagnostics);
        assert_eq!(report.resources.get("judges"), Some(&2));

        for threshold in ["1", "1.0", "0.01"] {
            let judge = CLASSIFIER.replace("threshold: 0.8", &format!("threshold: {threshold}"));
            assert_eq!(codes(&judge), [] as [&str; 0], "{threshold}");
        }
    }

    #[test]
    fn a_judge_declares_instructions_or_questions_never_both_or_neither() {
        let both = CLASSIFIER.replace("questions:", "instructions: Grade it.\nquestions:");
        let neither = "name: probe\nai:\n  model: openai/gpt-5\n";
        let nulls =
            "name: probe\ninstructions: null\nquestions: null\nai:\n  model: openai/gpt-5\n";
        for judge in [both.as_str(), neither, nulls] {
            let diagnostics = judge_diagnostics(&[("judges/probe.yaml", Some(judge))]);
            assert_eq!(
                diagnostics
                    .iter()
                    .map(|item| item.code.as_str())
                    .collect::<Vec<_>>(),
                ["judge.kind_invalid"],
                "{judge}"
            );
            assert_eq!(
                diagnostics[0].message,
                "Judge declares either `instructions`, answered by a chat model, or `questions`, answered by a classifier"
            );
        }
    }

    #[test]
    fn rejects_invalid_classifier_questions() {
        let many = (0..9).fold(String::new(), |mut questions, index| {
            questions.push_str(&format!(
                "  q{index}:\n    instructions: Is it?\n    criteria:\n      \"true\": \"Yes.\"\n      \"false\": \"No.\"\n"
            ));
            questions
        });
        let criteria = "    criteria:\n      \"true\": Courteous throughout.\n      \"false\": Rude or dismissive.\n";
        let cases: &[(String, &str)] = &[
            (
                CLASSIFIER.replace("  polite:", "  Polite:"),
                "judge.question.name_invalid",
            ),
            (
                CLASSIFIER.replace("  polite:", "  _polite:"),
                "judge.question.name_invalid",
            ),
            (
                CLASSIFIER.replace("  polite:", "  2polite:"),
                "judge.question.name_invalid",
            ),
            (
                CLASSIFIER.replace("  polite:", "  is-polite:"),
                "judge.question.name_invalid",
            ),
            (
                CLASSIFIER.replace(criteria, ""),
                "judge.question.criteria_missing",
            ),
            (
                CLASSIFIER.replace(criteria, "    criteria: null\n"),
                "judge.question.criteria_missing",
            ),
            (
                CLASSIFIER.replace("      \"false\": Rude or dismissive.\n", ""),
                "judge.question.criteria_invalid",
            ),
            (
                CLASSIFIER.replace("\"false\": Rude or dismissive.", "\"false\": 0"),
                "judge.question.criteria_invalid",
            ),
            (
                CLASSIFIER.replace("\"false\": Rude", "maybe: Unclear.\n      \"false\": Rude"),
                "judge.question.criteria_invalid",
            ),
            (
                CLASSIFIER.replace(criteria, "    criteria: Courteous throughout.\n"),
                "judge.question.criteria_invalid",
            ),
            (
                CLASSIFIER.replace("0.8", "0"),
                "judge.question.threshold_invalid",
            ),
            (
                CLASSIFIER.replace("0.8", "1.5"),
                "judge.question.threshold_invalid",
            ),
            (
                CLASSIFIER.replace("0.8", "-0.5"),
                "judge.question.threshold_invalid",
            ),
            (
                CLASSIFIER.replace("0.8", "high"),
                "judge.question.threshold_invalid",
            ),
            (
                CLASSIFIER.replace("0.8", "\"0.8\""),
                "judge.question.threshold_invalid",
            ),
            (
                CLASSIFIER.replace("0.8", "null"),
                "judge.question.threshold_invalid",
            ),
            (
                CLASSIFIER.replace("instructions: Is the reply polite?", "instructions: \"\""),
                "judge.question.instructions_invalid",
            ),
            (
                CLASSIFIER.replace("    instructions: Is the reply polite?\n", ""),
                "judge.question.instructions_invalid",
            ),
            (
                CLASSIFIER.replace("    threshold: 0.8", "    weight: 2"),
                "judge.question.unknown_field",
            ),
            (
                CLASSIFIER.replace("  polite:\n", "  polite: Is the reply polite?\n  other:\n"),
                "judge.question.invalid",
            ),
            (
                format!("name: probe\nai:\n  model: acme/classifier-1\nquestions:\n{many}"),
                "judge.questions_invalid",
            ),
            (
                "name: probe\nai:\n  model: acme/classifier-1\nquestions: {}\n".to_owned(),
                "judge.questions_invalid",
            ),
            (
                "name: probe\nai:\n  model: acme/classifier-1\nquestions: [polite]\n".to_owned(),
                "judge.questions_invalid",
            ),
        ];
        for (judge, code) in cases {
            assert_eq!(codes(judge), [*code], "{judge}");
        }
    }

    #[test]
    fn accepts_an_event_match_field_for_engine_parity() {
        let report = check_recipe_files(&snapshot(&[(
            "judges/parser-parity.yaml",
            Some(
                r#"name: parser-parity
instructions: Grade it.
on:
  - event: message
    match:
      event: message
ai:
  model: openai/gpt-5
"#,
            ),
        )]));
        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn rejects_bad_event_matcher_regex_and_platform_fields() {
        let diagnostics = judge_diagnostics(&[(
            "judges/gates.yaml",
            Some(
                r#"name: gates
instructions: Grade it.
on:
  - event: span
    extra: true
    match:
      environment: prod
      metadata.pattern_id: 1
      text: /unterminated(/i
  - event: message
    match:
      text: /hello/gg
  - event: tool
    match: anything
ai:
  model: openai/gpt-5
"#,
            ),
        )]);
        let codes = diagnostics
            .iter()
            .map(|item| item.code.as_str())
            .collect::<Vec<_>>();
        assert!(codes.contains(&"judge.on.matcher_unknown_field"));
        assert!(codes.contains(&"judge.on.event_invalid"));
        assert_eq!(
            codes
                .iter()
                .filter(|code| **code == "judge.on.match_field_prohibited")
                .count(),
            2
        );
        assert_eq!(
            codes
                .iter()
                .filter(|code| **code == "judge.on.regex_invalid")
                .count(),
            2
        );
        assert!(codes.contains(&"judge.on.match_invalid"));
    }

    #[test]
    fn reports_duplicate_names_on_later_recipe_relative_path() {
        let diagnostics = judge_diagnostics(&[
            ("judges/a.yaml", Some(MINIMAL)),
            ("judges/b.yml", Some(MINIMAL)),
        ]);
        let duplicate = diagnostics
            .iter()
            .find(|item| item.code == "judge.name_duplicate")
            .expect("duplicate diagnostic");
        assert_eq!(duplicate.path, "judges/b.yml");
        assert!(duplicate.message.contains("judges/a.yaml"));
    }

    #[test]
    fn diagnostics_are_deterministic_for_unsorted_snapshots() {
        let report = check_recipe_files(&snapshot(&[
            ("judges/z.yml", Some("name: z\n")),
            ("judges/a.yaml", Some("name: a\n")),
        ]));
        let paths = report
            .diagnostics
            .iter()
            .filter(|item| item.code.starts_with("judge."))
            .map(|item| (&item.path, &item.code))
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            [
                (
                    &"judges/a.yaml".to_owned(),
                    &"judge.kind_invalid".to_owned()
                ),
                (
                    &"judges/a.yaml".to_owned(),
                    &"judge.kind_invalid".to_owned()
                ),
                (&"judges/z.yml".to_owned(), &"judge.kind_invalid".to_owned()),
                (&"judges/z.yml".to_owned(), &"judge.kind_invalid".to_owned()),
            ]
        );
    }

    #[test]
    fn missing_required_fields_have_stable_codes() {
        let diagnostics = judge_diagnostics(&[("judges/missing.yaml", Some("description: x\n"))]);
        assert_eq!(
            diagnostics
                .iter()
                .map(|item| item.code.as_str())
                .collect::<Vec<_>>(),
            [
                "judge.name_missing",
                "judge.kind_invalid",
                "judge.kind_invalid"
            ]
        );
    }

    #[test]
    fn malformed_yaml_span_is_one_based_when_available() {
        let diagnostics = judge_diagnostics(&[(
            "judges/span.yaml",
            Some("name: okay\nai:\n  model: [broken\n"),
        )]);
        let span = diagnostics[0].span.expect("parser source span");
        assert!(span.line >= 1);
        assert!(span.column >= 1);
    }

    const MISSION: &str = r#"name: booking
type: mission
description: Is this booking what the traveller asked for?
attributes: [city, check_in]
questions:
  requested:
    instructions: >
      Is the booking something the traveller asked for, or a natural part of that trip?
    criteria:
      "true": The same destination and dates.
      "false": Another place, other dates, or something they never asked for.
  personal:
    instructions: Did the traveller describe this part of the trip as personal?
"#;

    #[test]
    fn sample_is_a_fraction_above_zero_and_at_most_one() {
        for sample in ["1", "1.0", "0.25", "0.001"] {
            let judge = format!("{MINIMAL}sample: {sample}\n");
            assert_eq!(codes(&judge), [] as [&str; 0], "{sample}");
        }
        for sample in ["0", "-0.5", "1.5", "\"0.5\"", "null", "half"] {
            let judge = format!("{MINIMAL}sample: {sample}\n");
            assert_eq!(codes(&judge), ["judge.sample_invalid"], "{sample}");
        }
    }

    #[test]
    fn accepts_a_mission_judge_beside_an_online_one() {
        let report = check_recipe_files(&snapshot(&[
            ("judges/minimal.yaml", Some(MINIMAL)),
            (
                "judges/explicit.yaml",
                Some(&MINIMAL.replace("name: helpful", "type: online\nname: explicit")),
            ),
            ("judges/booking.yaml", Some(MISSION)),
        ]));
        assert!(report.valid, "{:?}", report.diagnostics);
        assert_eq!(report.resources.get("judges"), Some(&3));
    }

    #[test]
    fn rejects_an_invalid_mission_judge_or_an_unknown_type() {
        for broken in [
            MISSION.replace(
                "  personal:\n    instructions: Did",
                "  personal:\n    instructions: \"\"\n    note: Did",
            ),
            MISSION.replace("      \"true\": The same destination and dates.\n", ""),
            MISSION.replace("attributes: [city, check_in]", "attributes: [city, city]"),
            MISSION.replace(
                "instructions: Did the traveller",
                "instructions:\n      question: Did the traveller",
            ),
            MISSION.replace("description:", "llm: { model: gpt-5 }\ndescription:"),
            MISSION.replace("description:", "ai: { model: openai/gpt-5 }\ndescription:"),
            MISSION.replace(
                "  personal:\n    instructions: Did",
                "  personal:\n    threshold: 0.5\n    instructions: Did",
            ),
            MISSION.replace("  personal:", "  Personal:"),
            MISSION.replace("description:", "sample: 0.5\ndescription:"),
        ] {
            let diagnostics = judge_diagnostics(&[("judges/booking.yaml", Some(&broken))]);
            assert_eq!(
                diagnostics
                    .iter()
                    .map(|d| d.code.as_str())
                    .collect::<Vec<_>>(),
                ["judge.mission_invalid"],
                "{broken}"
            );
        }
        let diagnostics = judge_diagnostics(&[(
            "judges/booking.yaml",
            Some(&MISSION.replace("type: mission", "type: gate")),
        )]);
        assert_eq!(diagnostics[0].code, "judge.type_invalid");
    }

    #[test]
    fn rejects_an_offline_judge_and_points_to_its_eval_suite() {
        let diagnostics = judge_diagnostics(&[(
            "judges/explicit.yaml",
            Some(&MINIMAL.replace("name: helpful", "type: offline\nname: explicit")),
        )]);
        assert_eq!(
            diagnostics
                .iter()
                .map(|d| d.code.as_str())
                .collect::<Vec<_>>(),
            ["judge.type_invalid"]
        );
        let hint = diagnostics[0].help.as_deref().unwrap_or_default();
        assert!(hint.contains("eval suite"), "{hint}");
    }

    #[test]
    fn names_are_unique_across_online_and_mission_judges() {
        let diagnostics = judge_diagnostics(&[
            ("judges/a.yaml", Some(MINIMAL)),
            (
                "judges/b.yaml",
                Some(&MISSION.replace("name: booking", "name: helpful")),
            ),
        ]);
        assert_eq!(diagnostics[0].code, "judge.name_duplicate");
    }
}
