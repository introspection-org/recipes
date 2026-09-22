//! Portable validation for Kubernetes-style Recipe compute resource overrides.
//!
//! Recipes may declare sandbox CPU/memory/storage overrides (for example
//! under an Introspection manifest's `runtime.resources`):
//!
//! ```yaml
//! resources:
//!   requests:
//!     cpu: 500m
//!     memory: 1.5Gi
//!     storage: 10Gi
//!   limits:
//!     cpu: 1500m
//!     memory: 1.5Gi
//! ```
//!
//! This module is pure: [`validate_resources`] takes the already-parsed value
//! and returns diagnostics, so any host (the Introspection CLI,
//! `introspection-cli`'s manifest validator) applies the
//! same rules. Quantity grammar is the practical subset of Kubernetes
//! quantities: `500m` millicores or decimal cores for CPU; bytes with binary
//! (`Ki`/`Mi`/`Gi`/`Ti`) or decimal (`k`/`M`/`G`/`T`) suffixes for memory and
//! storage. `storage` is the sandbox scratch-volume size, request-only like
//! a PVC (`spec.resources.requests.storage`).
//! Enforcement of platform ceilings (tier clamps) is the server's job — this
//! module checks shape, quantity grammar, and internal consistency only.

use serde_json::Value as JsonValue;

use crate::Diagnostic;

const KNOWN_SECTIONS: [&str; 2] = ["requests", "limits"];
const KNOWN_REQUEST_QUANTITIES: [&str; 3] = ["cpu", "memory", "storage"];
const KNOWN_LIMIT_QUANTITIES: [&str; 2] = ["cpu", "memory"];

#[derive(Debug, Clone, Copy, Default)]
struct ResourceSection {
    cpu_millis: Option<u64>,
    memory_bytes: Option<u128>,
}

/// Validate a `resources` object (`requests`/`limits` with `cpu`/`memory`
/// quantities). `path` anchors the returned diagnostics to the file the value
/// came from.
pub fn validate_resources(value: &JsonValue, path: &str) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    let Some(map) = value.as_object() else {
        push(
            &mut diagnostics,
            "resources.invalid",
            path,
            "resources must be an object with requests and/or limits",
            Some("declare resources.requests and/or resources.limits with cpu/memory quantities"),
        );
        return diagnostics;
    };

    for key in map.keys() {
        if !KNOWN_SECTIONS.contains(&key.as_str()) {
            push(
                &mut diagnostics,
                "resources.unknown_key",
                path,
                format!("resources contains unknown key '{key}'"),
                Some("only requests and limits are supported"),
            );
        }
    }
    if !map.contains_key("requests") && !map.contains_key("limits") {
        push(
            &mut diagnostics,
            "resources.empty",
            path,
            "resources must declare requests and/or limits",
            Some("add resources.requests and/or resources.limits, or omit resources"),
        );
        return diagnostics;
    }

    let requests = validate_section(map.get("requests"), "requests", path, &mut diagnostics);
    let limits = validate_section(map.get("limits"), "limits", path, &mut diagnostics);

    if let (Some(request), Some(limit)) = (requests.cpu_millis, limits.cpu_millis) {
        if request > limit {
            push(
                &mut diagnostics,
                "resources.request_exceeds_limit",
                path,
                format!(
                    "resources.requests.cpu ({request}m) exceeds resources.limits.cpu ({limit}m)"
                ),
                Some("lower the request or raise the limit"),
            );
        }
    }
    if let (Some(request), Some(limit)) = (requests.memory_bytes, limits.memory_bytes) {
        if request > limit {
            push(
                &mut diagnostics,
                "resources.request_exceeds_limit",
                path,
                format!(
                    "resources.requests.memory ({request} bytes) exceeds resources.limits.memory ({limit} bytes)"
                ),
                Some("lower the request or raise the limit"),
            );
        }
    }

    diagnostics
}

fn validate_section(
    value: Option<&JsonValue>,
    section: &str,
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> ResourceSection {
    let mut parsed = ResourceSection::default();
    let Some(value) = value else {
        return parsed;
    };
    let Some(map) = value.as_object() else {
        push(
            diagnostics,
            "resources.invalid",
            path,
            format!("resources.{section} must be an object with cpu/memory quantities"),
            Some("declare quantities under the section or omit it"),
        );
        return parsed;
    };
    if map.is_empty() {
        push(
            diagnostics,
            "resources.empty",
            path,
            format!("resources.{section} must declare cpu and/or memory"),
            Some("add a cpu or memory quantity, or omit the section"),
        );
    }
    let known: &[&str] = if section == "requests" {
        &KNOWN_REQUEST_QUANTITIES
    } else {
        &KNOWN_LIMIT_QUANTITIES
    };
    for key in map.keys() {
        if !known.contains(&key.as_str()) {
            let help = if section == "requests" {
                "only cpu, memory, and storage are supported"
            } else {
                "only cpu and memory are supported (storage is request-only, like a PVC)"
            };
            push(
                diagnostics,
                "resources.unknown_key",
                path,
                format!("resources.{section} contains unknown key '{key}'"),
                Some(help),
            );
        }
    }

    if let Some(cpu) = map.get("cpu") {
        match cpu_quantity_from_value(cpu) {
            Ok(millis) => parsed.cpu_millis = Some(millis),
            Err(message) => push(
                diagnostics,
                "resources.cpu_invalid",
                path,
                format!("resources.{section}.cpu {message}"),
                Some("use millicores like '500m' or cores like '1.5'"),
            ),
        }
    }
    if let Some(memory) = map.get("memory") {
        match memory_quantity_from_value(memory) {
            Ok(bytes) => parsed.memory_bytes = Some(bytes),
            Err(message) => push(
                diagnostics,
                "resources.memory_invalid",
                path,
                format!("resources.{section}.memory {message}"),
                Some("use quantities like '512Mi', '1.5Gi', or plain bytes"),
            ),
        }
    }
    if section == "requests" {
        if let Some(storage) = map.get("storage") {
            match memory_quantity_from_value(storage) {
                Ok(bytes) if bytes < 1 << 30 => push(
                    diagnostics,
                    "resources.storage_invalid",
                    path,
                    format!("resources.{section}.storage is below the 1Gi minimum"),
                    Some("request at least 1Gi of scratch storage"),
                ),
                Ok(_) => {}
                Err(message) => push(
                    diagnostics,
                    "resources.storage_invalid",
                    path,
                    format!("resources.{section}.storage {message}"),
                    Some("use quantities like '10Gi', '0.1T', or plain bytes"),
                ),
            }
        }
    }
    parsed
}

/// Parse a CPU quantity into millicores: `500m` (integer millicores) or a
/// decimal number of cores (`1`, `1.5`, `0.25`).
pub fn parse_cpu_quantity(value: &str) -> Result<u64, String> {
    let trimmed = value.trim();
    if let Some(millis) = trimmed.strip_suffix('m') {
        let millis: u64 = millis
            .parse()
            .map_err(|_| format!("'{value}' is not a valid CPU quantity"))?;
        if millis == 0 {
            return Err(format!("'{value}' must be greater than zero"));
        }
        return Ok(millis);
    }
    let cores = parse_decimal(trimmed).ok_or(format!("'{value}' is not a valid CPU quantity"))?;
    let millis = (cores * 1000.0).round();
    if !(millis >= 1.0 && millis <= u64::MAX as f64) {
        return Err(format!("'{value}' must be greater than zero"));
    }
    Ok(millis as u64)
}

/// Parse a memory quantity into bytes: plain integer bytes, binary suffixes
/// (`Ki`, `Mi`, `Gi`, `Ti`), or decimal suffixes (`k`, `M`, `G`, `T`).
/// Decimal numbers are allowed with a suffix (`1.5Gi`).
pub fn parse_memory_quantity(value: &str) -> Result<u128, String> {
    const SUFFIXES: [(&str, u128); 8] = [
        ("Ki", 1 << 10),
        ("Mi", 1 << 20),
        ("Gi", 1 << 30),
        ("Ti", 1 << 40),
        ("k", 1_000),
        ("M", 1_000_000),
        ("G", 1_000_000_000),
        ("T", 1_000_000_000_000),
    ];
    let trimmed = value.trim();
    for (suffix, factor) in SUFFIXES {
        if let Some(number) = trimmed.strip_suffix(suffix) {
            let number =
                parse_decimal(number).ok_or(format!("'{value}' is not a valid quantity"))?;
            let bytes = (number * factor as f64).round();
            if !(bytes >= 1.0 && bytes <= u128::MAX as f64) {
                return Err(format!("'{value}' must be greater than zero"));
            }
            return Ok(bytes as u128);
        }
    }
    let bytes: u128 = trimmed
        .parse()
        .map_err(|_| format!("'{value}' is not a valid quantity"))?;
    if bytes == 0 {
        return Err(format!("'{value}' must be greater than zero"));
    }
    Ok(bytes)
}

fn cpu_quantity_from_value(value: &JsonValue) -> Result<u64, String> {
    match value {
        JsonValue::String(value) => parse_cpu_quantity(value),
        JsonValue::Number(number) => {
            let cores = number
                .as_f64()
                .filter(|cores| cores.is_finite() && *cores > 0.0)
                .ok_or(format!("'{number}' must be greater than zero"))?;
            Ok((cores * 1000.0).round().max(1.0) as u64)
        }
        _ => Err("must be a string or number quantity".to_owned()),
    }
}

fn memory_quantity_from_value(value: &JsonValue) -> Result<u128, String> {
    match value {
        JsonValue::String(value) => parse_memory_quantity(value),
        JsonValue::Number(number) => number
            .as_u64()
            .filter(|bytes| *bytes > 0)
            .map(u128::from)
            .ok_or(format!("'{number}' must be a positive number of bytes")),
        _ => Err("must be a string or number quantity".to_owned()),
    }
}

/// Strict decimal: digits with at most one fractional part (`1`, `1.5`).
fn parse_decimal(value: &str) -> Option<f64> {
    let mut parts = value.split('.');
    let integer = parts.next()?;
    let fraction = parts.next();
    if parts.next().is_some()
        || integer.is_empty()
        || !integer.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    if let Some(fraction) = fraction {
        if fraction.is_empty() || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
    }
    value.parse().ok().filter(|number: &f64| number.is_finite())
}

fn push(
    diagnostics: &mut Vec<Diagnostic>,
    code: &str,
    path: &str,
    message: impl Into<String>,
    help: Option<&str>,
) {
    diagnostics.push(Diagnostic {
        code: code.to_owned(),
        path: path.to_owned(),
        span: None,
        message: message.into(),
        help: help.map(str::to_owned),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn codes(value: &JsonValue) -> Vec<String> {
        validate_resources(value, "manifest.yaml")
            .into_iter()
            .map(|diagnostic| diagnostic.code)
            .collect()
    }

    #[test]
    fn accepts_the_documented_example() {
        let value = json!({
            "requests": { "cpu": "500m", "memory": "1.5Gi" },
            "limits": { "cpu": "1500m", "memory": "1.5Gi" }
        });
        assert!(codes(&value).is_empty(), "{:?}", codes(&value));
    }

    #[test]
    fn accepts_partial_sections_and_numeric_quantities() {
        assert!(codes(&json!({ "requests": { "cpu": 1.5 } })).is_empty());
        assert!(codes(&json!({ "limits": { "memory": 1073741824u64 } })).is_empty());
        assert!(codes(&json!({ "limits": { "memory": "512M" } })).is_empty());
    }

    #[test]
    fn rejects_non_object_and_empty_shapes() {
        assert_eq!(codes(&json!("1Gi")), ["resources.invalid"]);
        assert_eq!(codes(&json!({})), ["resources.empty"]);
        assert_eq!(
            codes(&json!({ "requests": {} })),
            ["resources.empty"],
            "empty section"
        );
        assert_eq!(
            codes(&json!({ "requests": "1Gi" })),
            ["resources.invalid"],
            "section must be an object"
        );
    }

    #[test]
    fn rejects_unknown_keys() {
        assert_eq!(
            codes(&json!({ "requests": { "cpu": "1" }, "disk": {} })),
            ["resources.unknown_key"],
            "the retired disk block stays rejected"
        );
        assert_eq!(
            codes(&json!({ "requests": { "cpu": "1", "gpu": "1" } })),
            ["resources.unknown_key"]
        );
    }

    #[test]
    fn storage_is_request_only_like_a_pvc() {
        assert!(codes(&json!({ "requests": { "storage": "10Gi" } })).is_empty());
        assert!(codes(&json!({ "requests": { "storage": "0.1T" } })).is_empty());
        assert_eq!(
            codes(&json!({ "limits": { "storage": "10Gi" } })),
            ["resources.unknown_key"]
        );
        assert_eq!(
            codes(&json!({ "requests": { "storage": "big" } })),
            ["resources.storage_invalid"]
        );
        assert_eq!(
            codes(&json!({ "requests": { "storage": "0Gi" } })),
            ["resources.storage_invalid"]
        );
        assert_eq!(
            codes(&json!({ "requests": { "storage": "512Mi" } })),
            ["resources.storage_invalid"],
            "1Gi is the validated minimum"
        );
        assert!(codes(&json!({ "requests": { "storage": "1Gi" } })).is_empty());
    }

    #[test]
    fn rejects_invalid_quantities() {
        assert_eq!(
            codes(&json!({ "requests": { "cpu": "fast" } })),
            ["resources.cpu_invalid"]
        );
        assert_eq!(
            codes(&json!({ "requests": { "cpu": "0" } })),
            ["resources.cpu_invalid"]
        );
        assert_eq!(
            codes(&json!({ "requests": { "memory": "1.5.0Gi" } })),
            ["resources.memory_invalid"]
        );
        assert_eq!(
            codes(&json!({ "requests": { "memory": "-1Gi" } })),
            ["resources.memory_invalid"]
        );
        assert_eq!(
            codes(&json!({ "limits": { "memory": true } })),
            ["resources.memory_invalid"]
        );
    }

    #[test]
    fn rejects_request_exceeding_limit() {
        let value = json!({
            "requests": { "cpu": "2", "memory": "2Gi" },
            "limits": { "cpu": "1500m", "memory": "1.5Gi" }
        });
        assert_eq!(
            codes(&value),
            [
                "resources.request_exceeds_limit",
                "resources.request_exceeds_limit"
            ]
        );
    }

    #[test]
    fn parses_cpu_quantities() {
        assert_eq!(parse_cpu_quantity("500m"), Ok(500));
        assert_eq!(parse_cpu_quantity("1"), Ok(1000));
        assert_eq!(parse_cpu_quantity("1.5"), Ok(1500));
        assert_eq!(parse_cpu_quantity("0.25"), Ok(250));
        assert!(parse_cpu_quantity("0").is_err());
        assert!(parse_cpu_quantity("0m").is_err());
        assert!(parse_cpu_quantity("1.5m").is_err());
        assert!(parse_cpu_quantity("m").is_err());
        assert!(parse_cpu_quantity("-1").is_err());
    }

    #[test]
    fn parses_memory_quantities() {
        assert_eq!(parse_memory_quantity("1Ki"), Ok(1024));
        assert_eq!(parse_memory_quantity("1.5Gi"), Ok(1_610_612_736));
        assert_eq!(parse_memory_quantity("512Mi"), Ok(536_870_912));
        assert_eq!(parse_memory_quantity("1k"), Ok(1000));
        assert_eq!(parse_memory_quantity("2G"), Ok(2_000_000_000));
        assert_eq!(parse_memory_quantity("1024"), Ok(1024));
        assert!(
            parse_memory_quantity("1.5").is_err(),
            "bare bytes must be integral"
        );
        assert!(parse_memory_quantity("0Gi").is_err());
        assert!(parse_memory_quantity("Gi").is_err());
        assert!(parse_memory_quantity("1gi").is_err());
    }
}
