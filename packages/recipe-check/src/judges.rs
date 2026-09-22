//! Portable validation for authored Recipe `judges/*.yaml` definitions.
//!
//! This module deliberately stops at the recipe boundary. It validates the
//! authored, platform-neutral contract but does not calculate project-scoped
//! identities, normalize registry rows, assemble transcripts, call models, or
//! evaluate applicability gates. Those operations belong to the evaluator.
//! The typed, exported form of the same contract lives in
//! [`crate::spec`]; the two are held in agreement by tests there.

use std::collections::BTreeMap;

use regex::RegexBuilder;
use serde_json::{Map, Value};
use url::{Host, Url};

use crate::{span_from_message, CheckContext};

const JUDGES_DIR: &str = "judges";
const TOP_LEVEL_FIELDS: &[&str] = &["description", "instructions", "judge", "llm", "name", "on"];
const LLM_FIELDS: &[&str] = &["local", "model", "provider", "request", "transport"];
const REQUEST_FIELDS: &[&str] = &["max_tokens", "reasoning_effort", "temperature"];
const TRANSPORT_FIELDS: &[&str] = &["max_retries", "max_retry_delay_ms", "timeout_ms"];
const LOCAL_FIELDS: &[&str] = &["api_key_env", "base_url"];
const MATCHER_FIELDS: &[&str] = &["event", "match"];

const MAX_JUDGE_NAME_CHARS: usize = 255;
const MAX_DESCRIPTION_CHARS: usize = 2_000;
const MAX_PROVIDER_BYTES: usize = 64;
const MAX_MODEL_BYTES: usize = 255;
const MAX_REASONING_EFFORT_BYTES: usize = 64;
const MAX_OUTPUT_TOKENS: u64 = 131_072;
const MAX_TIMEOUT_MS: u64 = 600_000;
const MAX_RETRIES: u64 = 10;
const MAX_RETRY_DELAY_MS: u64 = 60_000;

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
    validate_instructions(map, path, ctx);
    validate_on(map.get("on"), path, ctx);
    validate_llm(map.get("llm"), path, ctx);

    ValidatedJudge {
        path: path.to_owned(),
        name,
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

fn validate_instructions(map: &Map<String, Value>, path: &str, ctx: &mut CheckContext) {
    match map.get("instructions") {
        None | Some(Value::Null) => ctx.error(
            "judge.instructions_missing",
            path,
            "Judge definition must declare non-empty instructions",
            Some("add the grading rubric under `instructions`"),
        ),
        Some(Value::String(value)) if !value.trim().is_empty() => {}
        Some(Value::String(_)) => ctx.error(
            "judge.instructions_invalid",
            path,
            "Judge instructions must be non-empty",
            Some("write the grading rubric under `instructions`"),
        ),
        Some(_) => ctx.error(
            "judge.instructions_invalid",
            path,
            "Judge instructions must be a non-empty string",
            Some("use a YAML string or block scalar for the grading rubric"),
        ),
    }
}

fn validate_llm(value: Option<&Value>, path: &str, ctx: &mut CheckContext) {
    let Some(value) = value else {
        ctx.error(
            "judge.llm_missing",
            path,
            "Judge definition must declare llm.model",
            Some("add `llm:` with a non-empty `model`"),
        );
        return;
    };
    let Some(llm) = value.as_object() else {
        ctx.error(
            "judge.llm_invalid",
            path,
            "Judge llm must be a mapping",
            Some("declare provider/model and optional request, transport, and local mappings"),
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
    validate_provider(llm.get("provider"), path, ctx);
    validate_model(llm.get("model"), path, ctx);
    validate_request(llm.get("request"), path, ctx);
    validate_transport(llm.get("transport"), path, ctx);
    validate_local(llm.get("local"), path, ctx);
}

fn validate_provider(value: Option<&Value>, path: &str, ctx: &mut CheckContext) {
    // Omission is canonical and defaults to openai at runtime.
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

fn validate_model(value: Option<&Value>, path: &str, ctx: &mut CheckContext) {
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
                Some("remove the override for the default 0, or use a value from 0 through 2"),
            );
        }
    }
    if let Some(value) = request.get("max_tokens").filter(|value| !value.is_null()) {
        let valid = value
            .as_u64()
            .is_some_and(|tokens| (1..=MAX_OUTPUT_TOKENS).contains(&tokens));
        if !valid {
            ctx.error(
                "judge.llm.request.max_tokens_invalid",
                path,
                format!("Judge llm.request.max_tokens must be an integer between 1 and {MAX_OUTPUT_TOKENS}"),
                Some("choose a bounded maximum output token count"),
            );
        }
    }
    if let Some(value) = request
        .get("reasoning_effort")
        .filter(|value| !value.is_null())
    {
        let valid = value.as_str().is_some_and(|effort| {
            !effort.is_empty()
                && effort.len() <= MAX_REASONING_EFFORT_BYTES
                && effort
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch == '-')
        });
        if !valid {
            ctx.error(
                "judge.llm.request.reasoning_effort_invalid",
                path,
                "Judge llm.request.reasoning_effort must be a lowercase slug",
                Some("use 1-64 lowercase ASCII letters or hyphens"),
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
            Some("declare timeout_ms, max_retries, and/or max_retry_delay_ms"),
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

    validate_u64_bound(
        transport.get("timeout_ms"),
        1,
        MAX_TIMEOUT_MS,
        "judge.llm.transport.timeout_ms_invalid",
        "Judge llm.transport.timeout_ms must be an integer between 1 and 600000",
        "use a timeout from 1 ms through 10 minutes",
        path,
        ctx,
    );
    validate_u64_bound(
        transport.get("max_retries"),
        0,
        MAX_RETRIES,
        "judge.llm.transport.max_retries_invalid",
        "Judge llm.transport.max_retries must be an integer between 0 and 10",
        "use at most 10 transport retries",
        path,
        ctx,
    );
    validate_u64_bound(
        transport.get("max_retry_delay_ms"),
        0,
        MAX_RETRY_DELAY_MS,
        "judge.llm.transport.max_retry_delay_ms_invalid",
        "Judge llm.transport.max_retry_delay_ms must be an integer between 0 and 60000",
        "use a retry delay cap no greater than 60 seconds",
        path,
        ctx,
    );
}

#[allow(clippy::too_many_arguments)]
fn validate_u64_bound(
    value: Option<&Value>,
    min: u64,
    max: u64,
    code: &str,
    message: &str,
    help: &str,
    path: &str,
    ctx: &mut CheckContext,
) {
    let Some(value) = value else { return };
    if !value
        .as_u64()
        .is_some_and(|number| (min..=max).contains(&number))
    {
        ctx.error(code, path, message, Some(help));
    }
}

fn validate_local(value: Option<&Value>, path: &str, ctx: &mut CheckContext) {
    let Some(value) = value else { return };
    if value.is_null() {
        return;
    }
    let Some(local) = value.as_object() else {
        ctx.error(
            "judge.llm.local_invalid",
            path,
            "Judge llm.local must be a mapping",
            Some("declare base_url and api_key_env, or omit local"),
        );
        return;
    };
    reject_unknown_fields(
        local,
        LOCAL_FIELDS,
        "judge.llm.local.unknown_field",
        "judge llm.local",
        path,
        ctx,
    );
    validate_base_url(local.get("base_url"), path, ctx);
    validate_api_key_env(local.get("api_key_env"), path, ctx);
}

fn validate_base_url(value: Option<&Value>, path: &str, ctx: &mut CheckContext) {
    let Some(raw) = value.and_then(Value::as_str) else {
        ctx.error(
            "judge.llm.local.base_url_invalid",
            path,
            "Judge llm.local.base_url must be an HTTP(S) URL with a host",
            Some("set an OpenAI-compatible endpoint URL"),
        );
        return;
    };
    let Ok(url) = Url::parse(raw) else {
        ctx.error(
            "judge.llm.local.base_url_invalid",
            path,
            "Judge llm.local.base_url is not a valid URL",
            Some("set an absolute HTTP(S) URL with a host"),
        );
        return;
    };
    let loopback = match url.host() {
        Some(Host::Domain(host)) => host == "localhost",
        Some(Host::Ipv4(host)) => host == std::net::Ipv4Addr::LOCALHOST,
        Some(Host::Ipv6(host)) => host == std::net::Ipv6Addr::LOCALHOST,
        None => false,
    };
    let valid = url.host().is_some()
        && matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && (url.scheme() == "https" || loopback);
    if !valid {
        ctx.error(
            "judge.llm.local.base_url_invalid",
            path,
            "Judge llm.local.base_url must use HTTP(S), contain no credentials/query/fragment, and use HTTPS outside localhost",
            Some("use an HTTPS OpenAI-compatible endpoint or an HTTP loopback URL"),
        );
    }
}

fn validate_api_key_env(value: Option<&Value>, path: &str, ctx: &mut CheckContext) {
    let valid = value.and_then(Value::as_str).is_some_and(|name| {
        let mut chars = name.chars();
        chars
            .next()
            .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
            && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    });
    if !valid {
        ctx.error(
            "judge.llm.local.api_key_env_invalid",
            path,
            "Judge llm.local.api_key_env must be an environment variable name",
            Some(
                "use ASCII letters, digits, and underscores, starting with a letter or underscore",
            ),
        );
    }
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
                let mut builder = RegexBuilder::new(pattern);
                builder.case_insensitive(flags.contains('i'));
                builder.multi_line(flags.contains('m'));
                builder.dot_matches_new_line(flags.contains('s'));
                if let Err(err) = builder.build() {
                    ctx.error(
                        "judge.on.regex_invalid",
                        path,
                        format!("Judge on[{index}].match.{field} contains invalid regex '{value}': {err}"),
                        Some("fix the Rust-compatible regex syntax"),
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
llm:
  model: gpt-5
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
llm:
  provider: openai
  model: gpt-5
  request:
    temperature: 0
    max_tokens: 1024
    reasoning_effort: medium
  transport:
    timeout_ms: 60000
    max_retries: 2
    max_retry_delay_ms: 5000
  local:
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
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
                "name: helpful\njudge: legacy\ninstructions: Grade.\nllm:\n  model: gpt-5\n",
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
llm:
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
                "judge.llm.unknown_field",
                "judge.llm.model_invalid",
            ]
        );
        assert!(diagnostics.iter().all(|item| item.help.is_some()));
    }

    #[test]
    fn rejects_noncanonical_judge_names() {
        for name in ["DeepWiki", "deep_wiki", "deep--wiki", " deepwiki"] {
            let diagnostics = judge_diagnostics(&[(
                "judges/invalid-name.yaml",
                Some(&format!(
                    "name: {name:?}\ninstructions: Grade.\nllm:\n  model: gpt-5\n"
                )),
            )]);
            assert!(diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "judge.name_invalid"));
        }
    }

    #[test]
    fn rejects_invalid_llm_shapes_overrides_and_bounds() {
        let diagnostics = judge_diagnostics(&[(
            "judges/invalid.yaml",
            Some(
                r#"name: invalid
instructions: Grade it.
llm:
  provider: OpenAI
  model: " gpt-5"
  request:
    temperature: 2.1
    max_tokens: 131073
    reasoning_effort: MEDIUM
    seed: 1
  transport:
    timeout_ms: 0
    max_retries: 11
    max_retry_delay_ms: 60001
    jitter: true
  local:
    base_url: http://remote.example/v1?token=x
    api_key_env: 1BAD
    token: secret
"#,
            ),
        )]);
        let codes = diagnostics
            .iter()
            .map(|item| item.code.as_str())
            .collect::<Vec<_>>();
        for code in [
            "judge.llm.provider_invalid",
            "judge.llm.model_invalid",
            "judge.llm.request.unknown_field",
            "judge.llm.request.temperature_invalid",
            "judge.llm.request.max_tokens_invalid",
            "judge.llm.request.reasoning_effort_invalid",
            "judge.llm.transport.unknown_field",
            "judge.llm.transport.timeout_ms_invalid",
            "judge.llm.transport.max_retries_invalid",
            "judge.llm.transport.max_retry_delay_ms_invalid",
            "judge.llm.local.unknown_field",
            "judge.llm.local.base_url_invalid",
            "judge.llm.local.api_key_env_invalid",
        ] {
            assert!(codes.contains(&code), "missing {code}: {codes:?}");
        }
    }

    #[test]
    fn accepts_request_and_transport_boundary_values_and_local_loopback() {
        let report = check_recipe_files(&snapshot(&[(
            "judges/bounds.yaml",
            Some(
                r#"name: bounds
instructions: Grade it.
on: {}
llm:
  provider: openai
  model: gpt-5
  request:
    temperature: 2
    max_tokens: 131072
    reasoning_effort: high
  transport:
    timeout_ms: 600000
    max_retries: 10
    max_retry_delay_ms: 0
  local:
    base_url: http://127.0.0.1:4000/v1
    api_key_env: _MODEL_KEY
"#,
            ),
        )]));
        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn accepts_ipv6_loopback_local_url() {
        let report = check_recipe_files(&snapshot(&[(
            "judges/ipv6-loopback.yaml",
            Some(
                r#"name: ipv6-loopback
instructions: Grade it.
llm:
  model: gpt-5
  local:
    base_url: http://[::1]:4000/v1
    api_key_env: MODEL_KEY
"#,
            ),
        )]));
        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn accepts_explicit_null_request_options_and_event_match_field_for_engine_parity() {
        let report = check_recipe_files(&snapshot(&[(
            "judges/parser-parity.yaml",
            Some(
                r#"name: parser-parity
instructions: Grade it.
on:
  - event: message
    match:
      event: message
llm:
  model: gpt-5
  request:
    max_tokens: null
    reasoning_effort: null
"#,
            ),
        )]));
        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn rejects_zero_max_tokens_and_missing_model() {
        let diagnostics = judge_diagnostics(&[(
            "judges/missing-model.yaml",
            Some(
                r#"name: missing-model
instructions: Grade it.
llm:
  request:
    max_tokens: 0
"#,
            ),
        )]);
        assert_eq!(
            diagnostics
                .iter()
                .map(|item| item.code.as_str())
                .collect::<Vec<_>>(),
            [
                "judge.llm.model_missing",
                "judge.llm.request.max_tokens_invalid"
            ]
        );
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
llm:
  model: gpt-5
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
                    &"judge.instructions_missing".to_owned()
                ),
                (&"judges/a.yaml".to_owned(), &"judge.llm_missing".to_owned()),
                (
                    &"judges/z.yml".to_owned(),
                    &"judge.instructions_missing".to_owned()
                ),
                (&"judges/z.yml".to_owned(), &"judge.llm_missing".to_owned()),
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
                "judge.instructions_missing",
                "judge.llm_missing"
            ]
        );
    }

    #[test]
    fn malformed_yaml_span_is_one_based_when_available() {
        let diagnostics = judge_diagnostics(&[(
            "judges/span.yaml",
            Some("name: okay\nllm:\n  model: [broken\n"),
        )]);
        let span = diagnostics[0].span.expect("parser source span");
        assert!(span.line >= 1);
        assert!(span.column >= 1);
    }
}
