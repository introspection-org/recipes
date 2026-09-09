//! Pure validation library for Introspection Recipe packages.
//!
//! The core API is I/O-free: [`check_recipe_files`] takes an in-memory
//! [`RecipeFiles`] snapshot of a recipe directory and returns a [`Report`].
//! Hosts own filesystem discovery and any environment-specific policy.

mod judges;
pub mod resources;
pub mod spec;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// In-memory snapshot of a recipe directory.
///
/// Paths are relative to the recipe root and use `/` separators. Every
/// ancestor of a file path is implicitly a directory; `directories` only
/// needs entries for directories that contain no files.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeFiles {
    pub files: Vec<RecipeFile>,
    #[serde(default)]
    pub directories: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeFile {
    pub path: String,
    /// File content, when the host chose to read it. `None` means the file
    /// exists but its content was not supplied; checks that need the content
    /// report it as unreadable.
    pub content: Option<String>,
}

impl RecipeFile {
    pub fn new(path: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            content: Some(content.into()),
        }
    }

    pub fn unread(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            content: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    pub valid: bool,
    pub diagnostics: Vec<Diagnostic>,
    /// Discovered portable Recipe resources, keyed by resource kind.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub resources: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<Span>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
}

/// 1-based source location of a diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub line: usize,
    pub column: usize,
}

type JsonMap = serde_json::Map<String, JsonValue>;

#[derive(Debug, Clone)]
struct Package {
    name: Option<String>,
    version: Option<String>,
    pi: Option<JsonValue>,
    dependencies: BTreeSet<String>,
    runtime_dependencies: bool,
}

#[derive(Debug, Clone)]
struct ResourcePatterns {
    explicit: bool,
    patterns: Vec<String>,
}

#[derive(Debug, Clone)]
struct RawAgent {
    name: String,
    path: String,
    from: Option<String>,
    fields: HashSet<AgentField>,
    skills: Option<Vec<String>>,
    subagents: Option<Vec<String>>,
    mcp: Option<AgentMcpConfig>,
}

#[derive(Debug, Clone, Default)]
struct McpToolSelectors {
    include: Option<BTreeSet<String>>,
    exclude: Option<BTreeSet<String>>,
    defer: Option<BTreeSet<String>>,
    eager: Option<BTreeSet<String>>,
}

type McpToolPolicy = BTreeMap<String, McpToolSelectors>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentMcpMode {
    Cli,
    Tools,
}

#[derive(Debug, Clone, Default)]
struct AgentMcpConfig {
    mode: Option<AgentMcpMode>,
    servers: BTreeMap<String, McpToolSelectors>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum AgentField {
    ModelName,
}

impl AgentField {
    const REQUIRED: [Self; 1] = [Self::ModelName];

    const fn label(self) -> &'static str {
        match self {
            Self::ModelName => "model.name",
        }
    }

    const fn help(self) -> Option<&'static str> {
        match self {
            Self::ModelName => Some("set a model or inherit one from a base agent"),
        }
    }
}

struct CheckContext {
    files: BTreeMap<String, Option<String>>,
    directories: BTreeSet<String>,
    diagnostics: Vec<Diagnostic>,
}

impl CheckContext {
    fn new(input: &RecipeFiles) -> Self {
        let mut files = BTreeMap::new();
        let mut directories = BTreeSet::new();
        for file in &input.files {
            let path = normalize_relative(&file.path);
            if path.is_empty() {
                continue;
            }
            for ancestor in ancestor_dirs(&path) {
                directories.insert(ancestor);
            }
            files.insert(path, file.content.clone());
        }
        for directory in &input.directories {
            let path = normalize_relative(directory);
            if path.is_empty() {
                continue;
            }
            for ancestor in ancestor_dirs(&path) {
                directories.insert(ancestor);
            }
            directories.insert(path);
        }
        Self {
            files,
            directories,
            diagnostics: Vec::new(),
        }
    }

    fn has_file(&self, path: &str) -> bool {
        self.files.contains_key(path)
    }

    fn has_dir(&self, path: &str) -> bool {
        self.directories.contains(path)
    }

    fn path_exists(&self, path: &str) -> bool {
        self.has_file(path) || self.has_dir(path)
    }

    fn content(&self, path: &str) -> Option<&str> {
        self.files.get(path).and_then(Option::as_deref)
    }

    /// Files that are direct children of `dir`.
    fn child_files(&self, dir: &str) -> Vec<&str> {
        let prefix = format!("{dir}/");
        self.files
            .range(prefix.clone()..)
            .take_while(|(path, _)| path.starts_with(&prefix))
            .filter(|(path, _)| !path[prefix.len()..].contains('/'))
            .map(|(path, _)| path.as_str())
            .collect()
    }

    fn push(
        &mut self,
        code: impl Into<String>,
        path: impl Into<String>,
        span: Option<Span>,
        message: impl Into<String>,
        help: Option<impl Into<String>>,
    ) {
        self.diagnostics.push(Diagnostic {
            code: code.into(),
            path: path.into(),
            span,
            message: message.into(),
            help: help.map(Into::into),
        });
    }

    fn error(
        &mut self,
        code: impl Into<String>,
        path: impl Into<String>,
        message: impl Into<String>,
        help: Option<impl Into<String>>,
    ) {
        self.push(code, path, None, message, help);
    }

    fn error_at(
        &mut self,
        code: impl Into<String>,
        path: impl Into<String>,
        span: Option<Span>,
        message: impl Into<String>,
        help: Option<impl Into<String>>,
    ) {
        self.push(code, path, span, message, help);
    }
}

/// Validate the portable structure of an in-memory Recipe snapshot.
///
/// This function does not apply host, deployment, package-manager, or
/// publication policy.
pub fn check_recipe_files(input: &RecipeFiles) -> Report {
    let mut ctx = CheckContext::new(input);
    let mut resource_counts = BTreeMap::new();

    let package = read_package(&mut ctx);
    if let Some(package) = package {
        validate_package_identity(&package, &mut ctx);
        validate_dependency_package(&package, &mut ctx);
        let resources = validate_pi_config(&package, &mut ctx);
        validate_mcp_local_example(&mut ctx);

        let mcp_tool_policy = package
            .pi
            .as_ref()
            .and_then(JsonValue::as_object)
            .and_then(|pi| mcp_tool_policy(pi.get("mcp")));
        let agent_paths = resolve_agents(&resources, &ctx);
        resource_counts.insert("agents".to_owned(), agent_paths.len());
        for key in ["extensions", "skills", "prompts"] {
            if let Some(paths) = resources.get(key) {
                resource_counts.insert(key.to_owned(), paths.len());
            }
        }
        validate_agents(&agent_paths, &resources, mcp_tool_policy.as_ref(), &mut ctx);
    }

    let judge_count = judges::validate_judges(&mut ctx);
    if judge_count > 0 {
        resource_counts.insert("judges".to_owned(), judge_count);
    }

    let valid = ctx.diagnostics.is_empty();
    Report {
        valid,
        diagnostics: ctx.diagnostics,
        resources: resource_counts,
    }
}

const PACKAGE_JSON: &str = "package.json";
const MAX_INHERITANCE_DEPTH: usize = 128;

fn read_package(ctx: &mut CheckContext) -> Option<Package> {
    if !ctx.has_file(PACKAGE_JSON) {
        ctx.error(
            "package.manifest_missing",
            PACKAGE_JSON,
            "Recipe is missing package.json",
            Some("add package.json with a pi object"),
        );
        return None;
    }
    let Some(content) = ctx.content(PACKAGE_JSON).map(str::to_owned) else {
        ctx.error(
            "package.manifest_unreadable",
            PACKAGE_JSON,
            "package.json content was not provided",
            Some("supply package.json content to the validator"),
        );
        return None;
    };

    let parsed: JsonValue = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(err) => {
            let span = Some(Span {
                line: err.line(),
                column: err.column(),
            });
            ctx.error_at(
                "package.manifest_malformed",
                PACKAGE_JSON,
                span,
                format!("package.json is not valid JSON: {err}"),
                Some("fix package.json syntax"),
            );
            return None;
        }
    };

    let Some(object) = parsed.as_object() else {
        ctx.error(
            "package.manifest_invalid",
            PACKAGE_JSON,
            "package.json must be an object",
            Some("make the top-level JSON value an object"),
        );
        return None;
    };

    let pi = object.get("pi").cloned();
    if !matches!(pi.as_ref(), Some(JsonValue::Object(_))) {
        ctx.error(
            "package.pi_missing",
            PACKAGE_JSON,
            "package.json is missing a pi object",
            Some(
                "add package.json#pi; it may be empty when using conventional resource directories",
            ),
        );
    }

    Some(Package {
        name: string_value(object.get("name")),
        version: string_value(object.get("version")),
        pi,
        dependencies: object
            .get("dependencies")
            .and_then(JsonValue::as_object)
            .map(|dependencies| {
                dependencies
                    .iter()
                    .filter_map(|(name, version)| {
                        string_value(Some(version)).map(|_| name.to_owned())
                    })
                    .collect()
            })
            .unwrap_or_default(),
        runtime_dependencies: has_non_empty_object(object.get("dependencies"))
            || has_non_empty_object(object.get("optionalDependencies")),
    })
}

fn validate_package_identity(package: &Package, ctx: &mut CheckContext) {
    if package.name.is_none() {
        ctx.error(
            "package.name_missing",
            PACKAGE_JSON,
            "Package is missing name",
            Some("set package.json#name to the recipe identifier"),
        );
    }
}

fn validate_dependency_package(package: &Package, ctx: &mut CheckContext) {
    if package.runtime_dependencies && !has_dependency_lockfile(ctx) {
        ctx.error(
            "package.lockfile_missing",
            PACKAGE_JSON,
            "Recipe declares runtime dependencies but has no lockfile",
            Some("commit package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, or yarn.lock"),
        );
    }

    if ctx.has_file(".pi/mcp.local.json") {
        ctx.error(
            "package.local_config_present",
            ".pi/mcp.local.json",
            "Local capability configuration must not be distributed with a Recipe",
            Some("remove .pi/mcp.local.json and keep only a redacted example when needed"),
        );
    }

    for lockfile in ["package-lock.json", "npm-shrinkwrap.json"] {
        let Some(content) = ctx.content(lockfile).map(str::to_owned) else {
            continue;
        };
        let parsed: JsonValue = match serde_json::from_str(&content) {
            Ok(value) => value,
            Err(err) => {
                ctx.error(
                    "package.lockfile_malformed",
                    lockfile,
                    format!("{lockfile} is not valid JSON: {err}"),
                    Some("regenerate the lockfile from the current package.json"),
                );
                continue;
            }
        };
        let Some(root) = parsed.as_object() else {
            continue;
        };
        let package_root = root
            .get("packages")
            .and_then(JsonValue::as_object)
            .and_then(|packages| packages.get(""))
            .and_then(JsonValue::as_object);
        for (location, entry) in [("top-level", Some(root)), ("packages[\"\"]", package_root)] {
            let Some(entry) = entry else {
                continue;
            };
            for (field, expected) in [
                ("name", package.name.as_deref()),
                ("version", package.version.as_deref()),
            ] {
                if let (Some(expected), Some(actual)) = (expected, string_value(entry.get(field))) {
                    if expected != actual {
                        ctx.error(
                            format!("package.lockfile_{field}_mismatch"),
                            lockfile,
                            format!(
                                "{lockfile} {location} {field} '{actual}' does not match package.json '{expected}'"
                            ),
                            Some("regenerate the lockfile after changing Recipe identity"),
                        );
                    }
                }
            }
        }
    }
}

const MCP_LOCAL_EXAMPLE: &str = ".pi/mcp.local.example.json";

fn validate_mcp_local_example(ctx: &mut CheckContext) {
    if !ctx.has_file(MCP_LOCAL_EXAMPLE) {
        return;
    }
    let Some(content) = ctx.content(MCP_LOCAL_EXAMPLE).map(str::to_owned) else {
        ctx.error(
            "mcp.local_example_unreadable",
            MCP_LOCAL_EXAMPLE,
            "MCP local example content was not provided",
            Some("supply .pi/mcp.local.example.json content to the validator"),
        );
        return;
    };
    let parsed: JsonValue = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(err) => {
            ctx.error_at(
                "mcp.local_example_malformed",
                MCP_LOCAL_EXAMPLE,
                Some(Span {
                    line: err.line(),
                    column: err.column(),
                }),
                format!(".pi/mcp.local.example.json is not valid JSON: {err}"),
                Some("fix the local MCP config template JSON"),
            );
            return;
        }
    };
    let JsonValue::Object(map) = parsed else {
        ctx.error(
            "mcp.local_example_invalid",
            MCP_LOCAL_EXAMPLE,
            ".pi/mcp.local.example.json must be an object",
            Some("fix the file structure or remove the optional example"),
        );
        return;
    };
    let Some(servers) = map.get("servers") else {
        return;
    };
    let JsonValue::Array(servers) = servers else {
        ctx.error(
            "mcp.local_example_invalid",
            MCP_LOCAL_EXAMPLE,
            ".pi/mcp.local.example.json servers must be an array",
            Some("fix the server list or remove the optional example"),
        );
        return;
    };
    for (index, server) in servers.iter().enumerate() {
        let JsonValue::Object(server) = server else {
            ctx.error(
                "mcp.local_example_invalid",
                MCP_LOCAL_EXAMPLE,
                format!("servers[{index}] must be an object"),
                Some("fix the server entry or remove it"),
            );
            continue;
        };
        for key in ["id", "name", "transport", "url"] {
            if let Some(value) = server.get(key) {
                if string_value(Some(value)).is_none() {
                    ctx.error(
                        "mcp.local_example_invalid",
                        MCP_LOCAL_EXAMPLE,
                        format!("servers[{index}].{key} must be a non-empty string"),
                        Some("remove the field or provide a non-empty value"),
                    );
                }
            }
        }
        if let Some(headers) = server.get("headers") {
            let JsonValue::Object(headers) = headers else {
                ctx.error(
                    "mcp.local_example_invalid",
                    MCP_LOCAL_EXAMPLE,
                    format!("servers[{index}].headers must be an object"),
                    Some("remove headers or make it a string-valued mapping"),
                );
                continue;
            };
            for (key, value) in headers {
                if !matches!(value, JsonValue::String(_)) {
                    ctx.error(
                        "mcp.local_example_invalid",
                        MCP_LOCAL_EXAMPLE,
                        format!("servers[{index}].headers.{key} must be a string"),
                        Some("remove the header or provide a string value"),
                    );
                }
            }
        }
    }
}

fn validate_pi_config(
    package: &Package,
    ctx: &mut CheckContext,
) -> HashMap<&'static str, Vec<String>> {
    let mut resolved = HashMap::new();
    let Some(JsonValue::Object(pi)) = package.pi.as_ref() else {
        return resolved;
    };
    let known: HashSet<&str> = [
        "agents",
        "extensions",
        "skills",
        "prompts",
        "channels",
        "mcp",
        "runtime",
    ]
    .into_iter()
    .collect();
    for key in pi.keys() {
        if !known.contains(key.as_str()) {
            ctx.error(
                "pi.unknown_key",
                PACKAGE_JSON,
                format!("package.json#pi contains unknown key '{key}'"),
                Some(
                    "remove unknown pi keys or update introspection-recipe-check if this is a new recipe field",
                ),
            );
        }
    }

    let agents = resource_patterns("agents", pi.get("agents"), true, ctx);
    let extensions = resource_patterns("extensions", pi.get("extensions"), false, ctx);
    let skills = resource_patterns("skills", pi.get("skills"), false, ctx);
    let prompts = resource_patterns("prompts", pi.get("prompts"), false, ctx);

    for (key, patterns, required) in [
        ("agents", agents, true),
        ("extensions", extensions, false),
        ("skills", skills, false),
        ("prompts", prompts, false),
    ] {
        let paths = resolve_resource_patterns(key, &patterns, required, ctx);
        if required && paths.is_empty() {
            ctx.error(
                "package.agents_missing",
                PACKAGE_JSON,
                "Recipe declares no loadable agents",
                Some("add agents/*.yaml or configure package.json#pi.agents"),
            );
        }
        resolved.insert(key, paths);
    }

    if let Some(channels) = pi.get("channels") {
        validate_channel_config(channels, &package.dependencies, ctx);
    }
    validate_mcp_config(pi.get("mcp"), ctx);
    validate_runtime_config(pi.get("runtime"), ctx);

    resolved
}

fn validate_channel_config(
    value: &JsonValue,
    dependencies: &BTreeSet<String>,
    ctx: &mut CheckContext,
) {
    let JsonValue::Array(connectors) = value else {
        ctx.error(
            "pi.channels_invalid",
            PACKAGE_JSON,
            "package.json#pi.channels must be an array",
            Some("use a list of channel declarations"),
        );
        return;
    };

    let mut providers = BTreeSet::new();
    for (index, connector) in connectors.iter().enumerate() {
        let JsonValue::Object(connector) = connector else {
            ctx.error(
                "pi.channels_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.channels[{index}] must be an object"),
                Some("remove the entry or make it a channel declaration"),
            );
            continue;
        };
        for key in connector.keys().filter(|key| !matches!(key.as_str(), "provider" | "commands" | "requireReply")) {
            ctx.error(
                "pi.channels_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.channels[{index}] contains unknown field '{key}'"),
                Some("use provider, optional commands, and optional requireReply"),
            );
        }

        if connector.get("requireReply").is_some_and(|value| !value.is_boolean()) {
            ctx.error("pi.channels_invalid", PACKAGE_JSON,
                format!("package.json#pi.channels[{index}].requireReply must be a boolean"), Some("use true or false"));
        }
        if let Some(commands) = connector.get("commands") {
            let valid = commands.as_array().is_some_and(|values| {
                let mut seen = BTreeSet::new();
                values.iter().all(|value| value.as_str().is_some_and(|value| !value.trim().is_empty() && seen.insert(value)))
            });
            if !valid {
                ctx.error("pi.channels_invalid", PACKAGE_JSON,
                    format!("package.json#pi.channels[{index}].commands must be an array of unique non-empty strings"), Some("use a list of unique command names"));
            }
        }

        let provider = string_value(connector.get("provider"));
        match provider.as_deref() {
            Some(provider) if !providers.insert(provider.to_owned()) => ctx.error(
                "pi.channels_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.channels contains duplicate provider '{provider}'"),
                Some("declare each channel provider once"),
            ),
            Some(_) => {}
            None => ctx.error(
                "pi.channels_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.channels[{index}].provider must be non-empty"),
                Some("name the channel provider"),
            ),
        }

        if let Some(provider) = provider.as_deref() {
            let package = format!("@introspection-ai/recipe-channel-{provider}");
            if !dependencies.contains(&package) {
                ctx.error(
                    "pi.channels_invalid",
                    PACKAGE_JSON,
                    format!("package.json#pi.channels provider '{provider}' requires dependency '{package}'"),
                    Some("add the channel package to package.json#dependencies and commit the lockfile"),
                );
            }
        }
    }
}

fn validate_runtime_config(value: Option<&JsonValue>, ctx: &mut CheckContext) {
    let Some(value) = value else { return };
    let Some(runtime) = value.as_object() else {
        ctx.error(
            "pi.runtime_invalid",
            PACKAGE_JSON,
            "package.json#pi.runtime must be an object",
            None::<String>,
        );
        return;
    };
    for key in runtime.keys() {
        if !matches!(key.as_str(), "python" | "system") {
            ctx.error(
                "pi.runtime_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.runtime contains unknown field '{key}'"),
                None::<String>,
            );
        }
    }
    if let Some(python_value) = runtime.get("python") {
        let Some(python) = python_value.as_object() else {
            ctx.error(
                "pi.runtime_invalid",
                PACKAGE_JSON,
                "package.json#pi.runtime.python must be an object",
                None::<String>,
            );
            return;
        };
        for key in python.keys() {
            if !matches!(key.as_str(), "project" | "lockfile" | "version" | "imports") {
                ctx.error(
                    "pi.runtime_invalid",
                    PACKAGE_JSON,
                    format!("package.json#pi.runtime.python contains unknown field '{key}'"),
                    None::<String>,
                );
            }
        }
        for key in ["project", "lockfile"] {
            let Some(path) = string_value(python.get(key)) else {
                ctx.error(
                    "pi.runtime_invalid",
                    PACKAGE_JSON,
                    format!(
                        "package.json#pi.runtime.python.{key} must be a non-empty relative path"
                    ),
                    None::<String>,
                );
                continue;
            };
            let normalized = normalize_relative(&path);
            if normalized.is_empty()
                || normalized != path
                || (!ctx.has_file(&normalized) && key == "lockfile")
                || (!ctx.has_dir(&normalized) && key == "project")
            {
                ctx.error("pi.runtime_path_invalid", PACKAGE_JSON, format!("package.json#pi.runtime.python.{key} must resolve inside the recipe: {path}"), None::<String>);
            }
        }
        if let Some(imports) = python.get("imports") {
            let valid = imports
                .as_array()
                .is_some_and(|items| items.iter().all(|item| string_value(Some(item)).is_some()));
            if !valid {
                ctx.error("pi.runtime_invalid", PACKAGE_JSON, "package.json#pi.runtime.python.imports must be an array of non-empty module names", None::<String>);
            }
        }
    }
    if let Some(system_value) = runtime.get("system") {
        let Some(system) = system_value.as_object() else {
            ctx.error(
                "pi.runtime_invalid",
                PACKAGE_JSON,
                "package.json#pi.runtime.system must be an object",
                None::<String>,
            );
            return;
        };
        for key in system.keys() {
            if key != "packages" {
                ctx.error(
                    "pi.runtime_invalid",
                    PACKAGE_JSON,
                    format!("package.json#pi.runtime.system contains unknown field '{key}'"),
                    None::<String>,
                );
            }
        }
        let valid = system
            .get("packages")
            .and_then(JsonValue::as_array)
            .is_some_and(|items| {
                items.iter().all(|item| {
                    item.as_object().is_some_and(|entry| {
                        entry
                            .keys()
                            .all(|key| matches!(key.as_str(), "id" | "version"))
                            && string_value(entry.get("id")).is_some()
                            && string_value(entry.get("version")).is_some()
                    })
                })
            });
        if !valid {
            ctx.error(
                "pi.runtime_invalid",
                PACKAGE_JSON,
                "package.json#pi.runtime.system.packages must contain only { id, version } objects",
                None::<String>,
            );
        }
    }
}

fn resource_patterns(
    key: &'static str,
    value: Option<&JsonValue>,
    required: bool,
    ctx: &mut CheckContext,
) -> ResourcePatterns {
    match value {
        Some(JsonValue::Array(items)) => {
            let mut patterns = Vec::with_capacity(items.len());
            let mut seen = BTreeSet::new();
            for (index, item) in items.iter().enumerate() {
                match string_value(Some(item)) {
                    Some(pattern) => {
                        if !seen.insert(pattern.clone()) {
                            ctx.error(
                                format!("pi.{key}_duplicate"),
                                PACKAGE_JSON,
                                format!(
                                    "package.json#pi.{key} contains duplicate entry '{pattern}'"
                                ),
                                Some("remove duplicate entries"),
                            );
                        }
                        patterns.push(pattern);
                    }
                    None => ctx.error(
                        format!("pi.{key}_invalid"),
                        PACKAGE_JSON,
                        format!("package.json#pi.{key}[{index}] must be a non-empty string"),
                        Some("remove the entry or replace it with a relative resource path"),
                    ),
                }
            }
            ResourcePatterns {
                explicit: true,
                patterns,
            }
        }
        Some(_) => {
            ctx.error(
                format!("pi.{key}_invalid"),
                PACKAGE_JSON,
                format!("package.json#pi.{key} must be an array of strings"),
                Some("use a list of relative resource paths"),
            );
            ResourcePatterns {
                explicit: true,
                patterns: Vec::new(),
            }
        }
        None => {
            let patterns = if required || key != "extensions" {
                if ctx.path_exists(key) {
                    vec![key.to_owned()]
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            };
            ResourcePatterns {
                explicit: false,
                patterns,
            }
        }
    }
}

fn resolve_resource_patterns(
    key: &'static str,
    patterns: &ResourcePatterns,
    required: bool,
    ctx: &mut CheckContext,
) -> Vec<String> {
    let mut resolved = BTreeSet::new();
    for pattern in &patterns.patterns {
        if let Err(message) = validate_relative_pattern(pattern) {
            ctx.error(
                format!("package.{key}_invalid"),
                PACKAGE_JSON,
                message,
                Some("use paths relative to the recipe directory"),
            );
            continue;
        }

        let matches = match_paths(ctx, pattern);
        if matches.is_empty() && (required || patterns.explicit) {
            ctx.error(
                format!("package.{key}_unmatched"),
                PACKAGE_JSON,
                format!("package.json#pi.{key} pattern '{pattern}' matched no files"),
                Some("update or remove the unmatched resource pattern"),
            );
        }
        for path in matches {
            if key == "extensions" {
                let entries = resolve_extension_entry(ctx, &path);
                if entries.is_empty() {
                    ctx.error(
                        "package.extensions_non_loadable",
                        path.clone(),
                        format!(
                            "package.json#pi.extensions pattern '{pattern}' matched no loadable extension modules"
                        ),
                        Some(
                            "point extension patterns at modules or directories with an index, direct modules, or indexed child directories",
                        ),
                    );
                }
                resolved.extend(entries);
            } else {
                resolved.insert(path);
            }
        }
    }

    if required && !patterns.explicit && patterns.patterns.is_empty() {
        ctx.error(
            "package.agents_missing",
            PACKAGE_JSON,
            "Recipe has no package.json#pi.agents and no conventional agents directory",
            Some("add agents/*.yaml or configure package.json#pi.agents"),
        );
    }

    resolved.into_iter().collect()
}

fn resolve_agents(
    resources: &HashMap<&'static str, Vec<String>>,
    ctx: &CheckContext,
) -> Vec<String> {
    let mut agents = BTreeSet::new();
    for path in resources.get("agents").into_iter().flatten() {
        if ctx.has_file(path) {
            if is_yaml_path(path) {
                agents.insert(path.clone());
            }
        } else if ctx.has_dir(path) {
            for child in ctx.child_files(path) {
                if is_yaml_path(child) {
                    agents.insert(child.to_owned());
                }
            }
        }
    }
    agents.into_iter().collect()
}

fn validate_agents(
    agent_paths: &[String],
    resources: &HashMap<&'static str, Vec<String>>,
    mcp_tool_policy: Option<&McpToolPolicy>,
    ctx: &mut CheckContext,
) {
    let mut sources = Vec::new();
    for path in agent_paths {
        if let Some(agent) = read_agent(path, ctx) {
            sources.push(agent);
        }
    }
    if sources.is_empty() {
        return;
    }

    validate_agent_names(&sources, ctx);

    let mut raw_by_name = HashMap::new();
    for source in &sources {
        raw_by_name.insert(source.name.clone(), source);
    }

    let mut unique_names: Vec<String> = raw_by_name.keys().cloned().collect();
    unique_names.sort();
    let skill_names = packaged_skill_names(
        resources
            .get("skills")
            .map(Vec::as_slice)
            .unwrap_or_default(),
        ctx,
    );
    for name in unique_names {
        validate_agent_inheritance(&name, &raw_by_name, ctx);
        for field in AgentField::REQUIRED {
            if !resolved_field_provided(&name, field, &raw_by_name, &mut Vec::new()) {
                let path = raw_by_name
                    .get(&name)
                    .map(|agent| agent.path.clone())
                    .unwrap_or_default();
                ctx.error(
                    format!("agent.{}_missing", field.label()),
                    path,
                    format!(
                        "Recipe agent '{name}' must declare {} directly or inherit it with from",
                        field.label()
                    ),
                    field.help(),
                );
            }
        }
        if let Some(agent) = raw_by_name.get(&name) {
            validate_declared_agent_references(agent, &raw_by_name, &skill_names, ctx);
        }
        validate_resolved_agent_mcp(&name, &raw_by_name, mcp_tool_policy, ctx);
    }
}

fn read_agent(path: &str, ctx: &mut CheckContext) -> Option<RawAgent> {
    let Some(content) = ctx.content(path).map(str::to_owned) else {
        ctx.error(
            "agent.unreadable",
            path,
            "Agent YAML content was not provided",
            Some("supply agent YAML content to the validator"),
        );
        return None;
    };
    let parsed: JsonValue = match serde_saphyr::from_str(&content) {
        Ok(value) => value,
        Err(err) => {
            let message = err.to_string();
            let span = span_from_message(&message);
            ctx.error_at(
                "agent.yaml_malformed",
                path,
                span,
                format!("Agent file is not valid YAML: {message}"),
                Some("fix the YAML syntax"),
            );
            return None;
        }
    };
    let Some(map) = parsed.as_object() else {
        ctx.error(
            "agent.invalid",
            path,
            "Agent file must contain a YAML object",
            Some("make the top-level YAML value a mapping"),
        );
        return None;
    };
    const AGENT_KEYS: &[&str] = &[
        "name",
        "from",
        "description",
        "model",
        "ai",
        "session",
        "tools",
        "mcp",
        "skills",
        "subagents",
        "system_instructions",
    ];
    for key in map.keys().filter(|key| !AGENT_KEYS.contains(&key.as_str())) {
        ctx.error(
            "agent.key_unknown",
            path,
            format!("Agent contains unknown field '{key}'"),
            Some(format!("supported fields: {}", AGENT_KEYS.join(", "))),
        );
    }

    let name = match map.get("name") {
        Some(JsonValue::String(name)) if !name.trim().is_empty() => name.clone(),
        Some(JsonValue::String(_)) | None => {
            ctx.error(
                "agent.name_missing",
                path,
                "Agent must declare a non-empty name",
                Some("set name to the stable identity used by references and telemetry"),
            );
            return None;
        }
        Some(_) => {
            ctx.error(
                "agent.name_invalid",
                path,
                "Agent name must be a string",
                Some("set name to the stable identity used by references and telemetry"),
            );
            return None;
        }
    };
    if !portable_agent_name(&name) {
        ctx.error(
            "agent.name_invalid",
            path,
            "Agent name must use lowercase kebab-case",
            Some("use lowercase letters and numbers separated by single hyphens"),
        );
    }

    if map.contains_key("description")
        && !matches!(map.get("description"), Some(JsonValue::String(_)))
    {
        ctx.error(
            "agent.description_invalid",
            path,
            "Agent description must be a string",
            Some("remove description or provide a string"),
        );
    }

    let from = match map.get("from") {
        Some(JsonValue::String(value)) if !value.trim().is_empty() => {
            let value = value.to_owned();
            if !portable_agent_name(&value) {
                ctx.error(
                    "agent.from_invalid",
                    path,
                    "Agent from must use lowercase kebab-case",
                    Some("reference an agent by its portable name"),
                );
            }
            Some(value)
        }
        Some(_) => {
            ctx.error(
                "agent.from_invalid",
                path,
                "Agent from must be a non-empty string",
                Some("remove the field or reference an existing agent"),
            );
            None
        }
        None => None,
    };

    let mut fields = HashSet::new();
    if map.contains_key("model") && map.contains_key("ai") {
        ctx.error(
            "agent.ai_model_conflict",
            path,
            "Agent must not declare both ai and model",
            Some("use ai; model is retained only for backwards compatibility"),
        );
    }
    validate_agent_model(map, path, &name, &mut fields, ctx);
    validate_agent_ai(map, path, &name, &mut fields, ctx);
    validate_agent_session(map, path, ctx);
    let tools = validate_agent_string_array(map, "tools", path, ctx);
    let reserved_tools = tools
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|tool| tool.as_str() == "agent")
        .cloned()
        .collect::<Vec<_>>();
    if !reserved_tools.is_empty() {
        ctx.error(
            "agent.tools_reserved",
            path,
            &format!(
                "Agent tools must not declare session-generated tools: {}",
                reserved_tools.join(", ")
            ),
            Some("remove the generated tool from the tools list"),
        );
    }
    let mcp = validate_agent_mcp(map, path, ctx);
    let skills = validate_agent_string_array(map, "skills", path, ctx);
    let subagents = validate_agent_string_array(map, "subagents", path, ctx);
    validate_agent_system_instructions(map, path, ctx);

    Some(RawAgent {
        name,
        path: path.to_owned(),
        from,
        fields,
        skills,
        subagents,
        mcp,
    })
}

fn validate_agent_model(
    map: &JsonMap,
    path: &str,
    name: &str,
    fields: &mut HashSet<AgentField>,
    ctx: &mut CheckContext,
) {
    let Some(value) = map.get("model") else {
        return;
    };
    let Some(model) = value.as_object() else {
        ctx.error(
            "agent.model_invalid",
            path,
            "Agent model must be an object",
            Some("make model a mapping of supported model settings"),
        );
        return;
    };
    const MODEL_KEYS: &[&str] = &[
        "name",
        "thinking_level",
        "temperature",
        "max_tokens",
        "cache_retention",
        "timeout_ms",
        "max_retries",
        "max_retry_delay_ms",
        "providers",
    ];
    for key in model
        .keys()
        .filter(|key| !MODEL_KEYS.contains(&key.as_str()))
    {
        ctx.error(
            "agent.model_key_unknown",
            path,
            format!("Agent model contains unknown field '{key}'"),
            Some(format!("supported fields: {}", MODEL_KEYS.join(", "))),
        );
    }

    if let Some(model_name) = obj_string(model, "name") {
        fields.insert(AgentField::ModelName);
        if !valid_model_spec(&model_name) {
            ctx.error(
                "agent.model.name_invalid",
                path,
                format!(
                    "Recipe agent '{name}' has invalid model.name '{model_name}' - expected '<provider>/<model_id>'"
                ),
                Some("use an available provider and model identifier"),
            );
        }
    } else if model.contains_key("name") {
        ctx.error(
            "agent.model.name_invalid",
            path,
            "Agent model.name must be a non-empty string",
            Some("set an available provider and model identifier"),
        );
    }

    if let Some(value) = model.get("thinking_level") {
        let valid = value.as_str().is_some_and(|level| {
            matches!(
                level,
                "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
            )
        });
        if !valid {
            ctx.error(
                "agent.model.thinking_level_invalid",
                path,
                "Agent model.thinking_level is unsupported",
                Some("use off, minimal, low, medium, high, xhigh, or max"),
            );
        }
    }
    validate_non_negative_number(model, "temperature", false, path, ctx);
    validate_non_negative_number(model, "max_tokens", true, path, ctx);
    validate_non_negative_number(model, "timeout_ms", true, path, ctx);
    validate_non_negative_number(model, "max_retries", false, path, ctx);
    validate_non_negative_number(model, "max_retry_delay_ms", false, path, ctx);
    if let Some(value) = model.get("cache_retention") {
        if !value
            .as_str()
            .is_some_and(|retention| matches!(retention, "none" | "short" | "long"))
        {
            ctx.error(
                "agent.model.cache_retention_invalid",
                path,
                "Agent model.cache_retention is unsupported",
                Some("use none, short, or long"),
            );
        }
    }
    validate_model_providers(model.get("providers"), path, ctx, false);
}

fn snake_case_key(value: &str) -> bool {
    let mut chars = value.chars();
    if !chars.next().is_some_and(|ch| ch.is_ascii_lowercase()) {
        return false;
    }
    let mut previous_underscore = false;
    for ch in chars {
        if ch == '_' {
            if previous_underscore {
                return false;
            }
            previous_underscore = true;
        } else if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            previous_underscore = false;
        } else {
            return false;
        }
    }
    !previous_underscore
}

fn validate_agent_ai(
    map: &JsonMap,
    path: &str,
    name: &str,
    fields: &mut HashSet<AgentField>,
    ctx: &mut CheckContext,
) {
    let Some(value) = map.get("ai") else { return };
    let Some(ai) = value.as_object() else {
        ctx.error(
            "agent.ai_invalid",
            path,
            "Agent ai must be an object",
            None::<String>,
        );
        return;
    };
    const AI_KEYS: &[&str] = &["model", "thinking_level", "options", "providers"];
    for key in ai.keys().filter(|key| !AI_KEYS.contains(&key.as_str())) {
        ctx.error(
            "agent.ai_key_unknown",
            path,
            format!("Agent ai contains unknown field '{key}'"),
            Some(format!("supported fields: {}", AI_KEYS.join(", "))),
        );
    }
    if let Some(model_name) = obj_string(ai, "model") {
        fields.insert(AgentField::ModelName);
        if !valid_model_spec(&model_name) {
            ctx.error(
                "agent.ai.model_invalid",
                path,
                format!("Recipe agent '{name}' has invalid ai.model '{model_name}' - expected '<provider>/<model_id>'"),
                Some("use an available provider and model identifier"),
            );
        }
    } else if ai.contains_key("model") {
        ctx.error(
            "agent.ai.model_invalid",
            path,
            "Agent ai.model must be a non-empty string",
            None::<String>,
        );
    }
    if let Some(value) = ai.get("thinking_level") {
        if !value.as_str().is_some_and(|level| {
            matches!(
                level,
                "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
            )
        }) {
            ctx.error(
                "agent.ai.thinking_level_invalid",
                path,
                "Agent ai.thinking_level is unsupported",
                Some("use off, minimal, low, medium, high, xhigh, or max"),
            );
        }
    }
    if let Some(value) = ai.get("options") {
        let Some(options) = value.as_object() else {
            ctx.error(
                "agent.ai.options_invalid",
                path,
                "Agent ai.options must be an object",
                None::<String>,
            );
            return;
        };
        const BLOCKED: &[&str] = &[
            "api_key",
            "azure_api_version",
            "azure_base_url",
            "azure_deployment_name",
            "azure_resource_name",
            "bearer_token",
            "client",
            "env",
            "fetch",
            "headers",
            "location",
            "on_payload",
            "on_response",
            "profile",
            "project",
            "reasoning",
            "region",
            "session_id",
            "signal",
            "telemetry_context",
            "transform_headers",
        ];
        for key in options.keys() {
            if !snake_case_key(key) {
                ctx.error(
                    "agent.ai.options_key_invalid",
                    path,
                    format!("Agent ai.options key '{key}' must use snake_case"),
                    None::<String>,
                );
            } else if BLOCKED.contains(&key.as_str()) {
                ctx.error(
                    "agent.ai.options_key_blocked",
                    path,
                    format!("Agent ai.options cannot configure host-owned option '{key}'"),
                    None::<String>,
                );
            }
        }
    }
    validate_model_providers(ai.get("providers"), path, ctx, true);
}

fn validate_agent_session(map: &JsonMap, path: &str, ctx: &mut CheckContext) {
    let Some(value) = map.get("session") else {
        return;
    };
    let Some(session) = value.as_object() else {
        ctx.error(
            "agent.session_invalid",
            path,
            "Agent session must be an object",
            None::<String>,
        );
        return;
    };
    const SESSION_KEYS: &[&str] = &[
        "steering_mode",
        "follow_up_mode",
        "tool_execution",
        "retry",
        "compaction",
        "images",
    ];
    for key in session
        .keys()
        .filter(|key| !SESSION_KEYS.contains(&key.as_str()))
    {
        ctx.error(
            "agent.session_key_unknown",
            path,
            format!("Agent session contains unknown field '{key}'"),
            Some(format!("supported fields: {}", SESSION_KEYS.join(", "))),
        );
    }
    for key in ["steering_mode", "follow_up_mode"] {
        if let Some(value) = session.get(key) {
            if !value
                .as_str()
                .is_some_and(|mode| matches!(mode, "all" | "one-at-a-time"))
            {
                ctx.error(
                    format!("agent.session.{key}_invalid"),
                    path,
                    format!("Agent session.{key} must be all or one-at-a-time"),
                    None::<String>,
                );
            }
        }
    }
    if let Some(value) = session.get("tool_execution") {
        if !value
            .as_str()
            .is_some_and(|mode| matches!(mode, "parallel" | "sequential"))
        {
            ctx.error(
                "agent.session.tool_execution_invalid",
                path,
                "Agent session.tool_execution must be parallel or sequential",
                None::<String>,
            );
        }
    }
    if let Some(value) = session.get("retry") {
        validate_session_retry(value, path, ctx);
    }
    if let Some(value) = session.get("compaction") {
        validate_session_settings_object(
            value,
            path,
            "compaction",
            &["enabled", "reserve_tokens", "keep_recent_tokens"],
            &["enabled"],
            &[("reserve_tokens", false), ("keep_recent_tokens", false)],
            ctx,
        );
    }
    if let Some(value) = session.get("images") {
        validate_session_settings_object(
            value,
            path,
            "images",
            &["auto_resize", "block_images"],
            &["auto_resize", "block_images"],
            &[],
            ctx,
        );
    }
}

fn validate_session_retry(value: &JsonValue, path: &str, ctx: &mut CheckContext) {
    let Some(retry) = validate_session_settings_object(
        value,
        path,
        "retry",
        &["enabled", "max_retries", "base_delay_ms", "provider"],
        &["enabled"],
        &[("max_retries", false), ("base_delay_ms", false)],
        ctx,
    ) else {
        return;
    };
    if let Some(provider) = retry.get("provider") {
        validate_session_settings_object(
            provider,
            path,
            "retry.provider",
            &["timeout_ms", "max_retries", "max_retry_delay_ms"],
            &[],
            &[
                ("timeout_ms", true),
                ("max_retries", false),
                ("max_retry_delay_ms", false),
            ],
            ctx,
        );
    }
}

fn validate_session_settings_object<'a>(
    value: &'a JsonValue,
    path: &str,
    section: &str,
    allowed_keys: &[&str],
    boolean_keys: &[&str],
    integer_keys: &[(&str, bool)],
    ctx: &mut CheckContext,
) -> Option<&'a JsonMap> {
    let prefix = format!("session.{section}");
    let Some(settings) = value.as_object() else {
        ctx.error(
            format!("agent.{prefix}_invalid"),
            path,
            format!("Agent {prefix} must be an object"),
            None::<String>,
        );
        return None;
    };
    for key in settings
        .keys()
        .filter(|key| !allowed_keys.contains(&key.as_str()))
    {
        ctx.error(
            format!("agent.{prefix}_key_unknown"),
            path,
            format!("Agent {prefix} contains unknown field '{key}'"),
            Some(format!("supported fields: {}", allowed_keys.join(", "))),
        );
    }
    for key in boolean_keys {
        if settings.get(*key).is_some_and(|value| !value.is_boolean()) {
            ctx.error(
                format!("agent.{prefix}.{key}_invalid"),
                path,
                format!("Agent {prefix}.{key} must be a boolean"),
                None::<String>,
            );
        }
    }
    for (key, strictly_positive) in integer_keys {
        let Some(value) = settings.get(*key) else {
            continue;
        };
        let minimum = if *strictly_positive { 1.0 } else { 0.0 };
        let valid = value.as_f64().is_some_and(|number| {
            number.is_finite()
                && number >= minimum
                && number <= 9_007_199_254_740_991.0
                && number.fract() == 0.0
        });
        if !valid {
            ctx.error(
                format!("agent.{prefix}.{key}_invalid"),
                path,
                format!(
                    "Agent {prefix}.{key} must be an integer >= {}",
                    minimum as u8
                ),
                None::<String>,
            );
        }
    }
    Some(settings)
}

fn validate_non_negative_number(
    model: &JsonMap,
    key: &str,
    strictly_positive: bool,
    path: &str,
    ctx: &mut CheckContext,
) {
    let Some(value) = model.get(key) else {
        return;
    };
    let valid = value.as_f64().is_some_and(|number| {
        number.is_finite()
            && if strictly_positive {
                number >= 1.0 && number.fract() == 0.0
            } else if key == "temperature" {
                number >= 0.0
            } else {
                number >= 0.0 && number.fract() == 0.0
            }
    });
    if !valid {
        ctx.error(
            format!("agent.model.{key}_invalid"),
            path,
            format!(
                "Agent model.{key} must be {}",
                if strictly_positive {
                    "an integer >= 1"
                } else if key == "temperature" {
                    "a number >= 0"
                } else {
                    "an integer >= 0"
                }
            ),
            None::<String>,
        );
    }
}

fn validate_model_providers(
    value: Option<&JsonValue>,
    path: &str,
    ctx: &mut CheckContext,
    transparent_provider_payloads: bool,
) {
    let Some(value) = value else {
        return;
    };
    let Some(providers) = value.as_object() else {
        ctx.error(
            "agent.model.providers_invalid",
            path,
            "Agent model.providers must be an object",
            None::<String>,
        );
        return;
    };
    for key in providers.keys().filter(|key| {
        !matches!(key.as_str(), "openrouter" | "anthropic")
            && !(transparent_provider_payloads && key.as_str() == "vercel_ai_gateway")
    }) {
        ctx.error(
            "agent.model.providers_key_unknown",
            path,
            format!("Agent model.providers contains unknown field '{key}'"),
            Some(if transparent_provider_payloads {
                "use only openrouter, anthropic, and vercel_ai_gateway"
            } else {
                "use only openrouter and anthropic"
            }),
        );
    }
    if let Some(value) = providers.get("openrouter") {
        let Some(openrouter) = value.as_object() else {
            ctx.error(
                "agent.model.providers.openrouter_invalid",
                path,
                "Agent model.providers.openrouter must be an object",
                None::<String>,
            );
            return;
        };
        for key in openrouter.keys().filter(|key| key.as_str() != "routing") {
            ctx.error(
                "agent.model.providers.openrouter_key_unknown",
                path,
                format!("Agent model.providers.openrouter contains unknown field '{key}'"),
                Some("use only routing"),
            );
        }
        if let Some(value) = openrouter.get("routing") {
            validate_openrouter_routing(value, path, ctx, transparent_provider_payloads);
        }
    }
    if let Some(value) = providers.get("anthropic") {
        let Some(anthropic) = value.as_object() else {
            ctx.error(
                "agent.model.providers.anthropic_invalid",
                path,
                "Agent model.providers.anthropic must be an object",
                None::<String>,
            );
            return;
        };
        for key in anthropic
            .keys()
            .filter(|key| !matches!(key.as_str(), "betas" | "context_management"))
        {
            ctx.error(
                "agent.model.providers.anthropic_key_unknown",
                path,
                format!("Agent model.providers.anthropic contains unknown field '{key}'"),
                Some("use only betas and context_management"),
            );
        }
        if let Some(value) = anthropic.get("betas") {
            if string_array(value).is_err() {
                ctx.error(
                    "agent.model.providers.anthropic_betas_invalid",
                    path,
                    "Agent model.providers.anthropic.betas must be an array of non-empty strings",
                    None::<String>,
                );
            }
        }
        if anthropic
            .get("context_management")
            .is_some_and(|value| !value.is_object())
        {
            ctx.error(
                "agent.model.providers.anthropic_context_management_invalid",
                path,
                "Agent model.providers.anthropic.context_management must be an object",
                None::<String>,
            );
        }
    }
    if transparent_provider_payloads {
        if let Some(value) = providers.get("vercel_ai_gateway") {
            let Some(vercel) = value.as_object() else {
                ctx.error(
                    "agent.ai.providers.vercel_ai_gateway_invalid",
                    path,
                    "Agent ai.providers.vercel_ai_gateway must be an object",
                    None::<String>,
                );
                return;
            };
            for key in vercel.keys().filter(|key| key.as_str() != "routing") {
                ctx.error(
                    "agent.ai.providers.vercel_ai_gateway_key_unknown",
                    path,
                    format!("Agent ai.providers.vercel_ai_gateway contains unknown field '{key}'"),
                    Some("use only routing"),
                );
            }
            if let Some(value) = vercel.get("routing") {
                let Some(routing) = value.as_object() else {
                    ctx.error(
                        "agent.ai.providers.vercel_ai_gateway.routing_invalid",
                        path,
                        "Agent ai.providers.vercel_ai_gateway.routing must be an object",
                        None::<String>,
                    );
                    return;
                };
                if routing.contains_key("byok") {
                    ctx.error(
                        "agent.ai.providers.vercel_ai_gateway.routing_key_blocked",
                        path,
                        "Agent ai.providers.vercel_ai_gateway.routing cannot configure host-owned field 'byok'",
                        None::<String>,
                    );
                }
            }
        }
    }
}

fn validate_openrouter_routing(
    value: &JsonValue,
    path: &str,
    ctx: &mut CheckContext,
    transparent: bool,
) {
    const ROUTING_KEYS: &[&str] = &[
        "allow_fallbacks",
        "require_parameters",
        "data_collection",
        "zdr",
        "enforce_distillable_text",
        "order",
        "only",
        "ignore",
        "quantizations",
        "sort",
        "max_price",
        "preferred_min_throughput",
        "preferred_max_latency",
    ];
    let Some(routing) = value.as_object() else {
        ctx.error(
            "agent.model.providers.openrouter.routing_invalid",
            path,
            "Agent model.providers.openrouter.routing must be an object",
            None::<String>,
        );
        return;
    };
    if transparent {
        return;
    }
    for key in routing
        .keys()
        .filter(|key| !ROUTING_KEYS.contains(&key.as_str()))
    {
        ctx.error(
            "agent.model.providers.openrouter.routing_key_unknown",
            path,
            format!("Agent OpenRouter routing contains unknown field '{key}'"),
            Some(format!("supported fields: {}", ROUTING_KEYS.join(", "))),
        );
    }
}

fn validate_agent_string_array(
    map: &JsonMap,
    key: &'static str,
    path: &str,
    ctx: &mut CheckContext,
) -> Option<Vec<String>> {
    let value = map.get(key)?;
    match string_array(value) {
        Ok(()) => {
            let values: Vec<String> = value
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(JsonValue::as_str)
                .map(str::trim)
                .map(str::to_owned)
                .collect();
            let unique: BTreeSet<&str> = values.iter().map(String::as_str).collect();
            if unique.len() != values.len() {
                ctx.error(
                    format!("agent.{key}_duplicate"),
                    path,
                    format!("Agent {key} must not contain duplicate entries"),
                    Some("remove duplicate entries"),
                );
            }
            Some(values)
        }
        Err(message) => {
            ctx.error(
                format!("agent.{key}_invalid"),
                path,
                message,
                Some("use a list containing only non-empty strings"),
            );
            None
        }
    }
}

fn validate_agent_mcp(map: &JsonMap, path: &str, ctx: &mut CheckContext) -> Option<AgentMcpConfig> {
    let value = map.get("mcp")?;
    let Some(mcp) = value.as_object() else {
        ctx.error(
            "agent.mcp_invalid",
            path,
            "Agent mcp must be an object",
            Some("remove mcp for no access, or declare server policies"),
        );
        return Some(AgentMcpConfig::default());
    };
    let mode = match mcp.get("mode") {
        Some(JsonValue::String(value)) if value == "cli" => Some(AgentMcpMode::Cli),
        Some(JsonValue::String(value)) if value == "tools" => Some(AgentMcpMode::Tools),
        Some(_) => {
            ctx.error(
                "agent.mcp_mode_invalid",
                path,
                "Agent mcp.mode must be 'cli' or 'tools'",
                Some("set mcp.mode to cli or tools"),
            );
            None
        }
        None => None,
    };
    let empty_servers = JsonMap::new();
    let servers = match mcp.get("servers") {
        Some(JsonValue::Object(servers)) => servers,
        Some(_) => {
            ctx.error(
                "agent.mcp_servers_invalid",
                path,
                "Agent mcp.servers must be an object",
                Some("move server selections under mcp.servers"),
            );
            return Some(AgentMcpConfig {
                mode,
                ..AgentMcpConfig::default()
            });
        }
        None => {
            ctx.error(
                "agent.mcp_servers_invalid",
                path,
                "Agent mcp.servers is required",
                Some("declare server selections under mcp.servers"),
            );
            &empty_servers
        }
    };
    for key in mcp
        .keys()
        .filter(|key| !matches!(key.as_str(), "mode" | "servers"))
    {
        ctx.error(
            "agent.mcp_key_unknown",
            path,
            format!("Unknown Agent mcp field '{key}'"),
            Some("use only mode and servers"),
        );
    }
    let mut parsed = BTreeMap::new();
    for (server_key, value) in servers {
        if server_key.trim().is_empty() {
            ctx.error(
                "agent.mcp_server_invalid",
                path,
                "Agent mcp server ids must be non-empty strings",
                Some("remove the entry or give the server a non-empty identifier"),
            );
            continue;
        }
        let server_id = server_key.as_str();
        let Some(server) = value.as_object() else {
            ctx.error(
                "agent.mcp_invalid",
                path,
                format!("Agent mcp server '{server_id}' must be an object"),
                Some("remove the server for no access, or declare its tool policy"),
            );
            continue;
        };
        for key in server
            .keys()
            .filter(|key| !matches!(key.as_str(), "include" | "exclude" | "defer" | "eager"))
        {
            ctx.error(
                "agent.mcp_key_unknown",
                path,
                format!("Agent mcp server '{server_id}' contains unknown field '{key}'"),
                Some("use only include, exclude, defer, and eager"),
            );
        }
        let mut selectors = McpToolSelectors::default();
        for key in ["include", "exclude", "defer", "eager"] {
            let Some(value) = server.get(key) else {
                continue;
            };
            if matches!(key, "defer" | "eager") && mode == Some(AgentMcpMode::Cli) {
                ctx.error(
                    "agent.mcp_activation_invalid",
                    path,
                    format!(
                        "Agent mcp server '{server_id}' {key} is only valid when mcp.mode is tools"
                    ),
                    Some("remove the activation selector or set mcp.mode to tools"),
                );
            }
            if let Err(message) = string_array(value) {
                ctx.error(
                    "agent.mcp_invalid",
                    path,
                    format!("mcp.{server_id}.{key}: {message}"),
                    Some("use a list containing only non-empty tool names"),
                );
                continue;
            }
            let Some(items) = value.as_array() else {
                continue;
            };
            let authored_values = items
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::trim)
                .collect::<Vec<_>>();
            if authored_values.iter().collect::<BTreeSet<_>>().len() != authored_values.len() {
                ctx.error(
                    "agent.mcp_selector_duplicate",
                    path,
                    format!("Agent mcp server '{server_id}' {key} must not contain duplicates"),
                    Some("remove duplicate selectors"),
                );
            }
            let values = items
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::trim)
                .map(str::to_owned)
                .collect::<BTreeSet<_>>();
            for selector in &values {
                let valid = match key {
                    "include" | "defer" | "eager" => {
                        !selector.is_empty() && (selector == "*" || !selector.contains('*'))
                    }
                    _ => !selector.is_empty() && !selector.contains('*'),
                };
                if !valid {
                    ctx.error(
                        "agent.mcp_selector_invalid",
                        path,
                        format!(
                            "Agent mcp server '{server_id}' {key} entry '{selector}' must be {}",
                            if matches!(key, "include" | "defer" | "eager") {
                                "an exact tool name or '*'"
                            } else {
                                "an exact tool name"
                            }
                        ),
                        None::<String>,
                    );
                }
            }
            if matches!(key, "defer" | "eager") && values.contains("*") && items.len() != 1 {
                ctx.error(
                    "agent.mcp_activation_selector_invalid",
                    path,
                    format!("Agent mcp server '{server_id}' {key} must use '*' by itself"),
                    None::<String>,
                );
            }
            match key {
                "include" => selectors.include = Some(values),
                "exclude" => selectors.exclude = Some(values),
                "defer" => selectors.defer = Some(values),
                "eager" => selectors.eager = Some(values),
                _ => unreachable!(),
            }
        }
        let normalized_server_id = safe_mcp_server_id(server_id);
        if parsed.contains_key(&normalized_server_id) {
            ctx.error(
                "agent.mcp_server_collision",
                path,
                format!(
                    "Agent mcp server '{server_id}' collides with another server after id normalization"
                ),
                Some("use server ids that remain unique after normalization"),
            );
            continue;
        }
        parsed.insert(normalized_server_id, selectors);
    }
    Some(AgentMcpConfig {
        mode,
        servers: parsed,
    })
}

fn validate_agent_system_instructions(map: &JsonMap, path: &str, ctx: &mut CheckContext) {
    let Some(value) = map.get("system_instructions") else {
        return;
    };
    let Some(system) = value.as_object() else {
        ctx.error(
            "agent.system_instructions_invalid",
            path,
            "Agent system_instructions must be an object",
            None::<String>,
        );
        return;
    };
    for key in system
        .keys()
        .filter(|key| !matches!(key.as_str(), "mode" | "content"))
    {
        ctx.error(
            "agent.system_instructions_key_unknown",
            path,
            format!("Agent system_instructions contains unknown field '{key}'"),
            Some("use only mode and content"),
        );
    }
    match system.get("content") {
        Some(JsonValue::String(_)) => {}
        Some(_) => ctx.error(
            "agent.system_instructions_invalid",
            path,
            "Agent system_instructions.content must be a string",
            None::<String>,
        ),
        None => ctx.error(
            "agent.system_instructions_invalid",
            path,
            "Agent system_instructions must declare content",
            None::<String>,
        ),
    }
    if let Some(mode) = system.get("mode") {
        match mode {
            JsonValue::String(value) if value == "append" || value == "replace" => {}
            JsonValue::String(_) => ctx.error(
                "agent.system_instructions_invalid",
                path,
                "Agent system_instructions.mode must be append or replace",
                None::<String>,
            ),
            _ => ctx.error(
                "agent.system_instructions_invalid",
                path,
                "Agent system_instructions.mode must be a string",
                None::<String>,
            ),
        }
    }
}

fn validate_agent_names(sources: &[RawAgent], ctx: &mut CheckContext) {
    let mut name_counts: HashMap<&str, usize> = HashMap::new();
    for source in sources {
        *name_counts.entry(source.name.as_str()).or_default() += 1;
    }
    for (name, count) in name_counts {
        if count > 1 {
            ctx.error(
                "agent.name_duplicate",
                "agents",
                format!("Recipe agent name '{name}' is declared by multiple files"),
                Some("choose unique agent names"),
            );
        }
    }
}

fn validate_agent_inheritance(
    name: &str,
    raw_by_name: &HashMap<String, &RawAgent>,
    ctx: &mut CheckContext,
) {
    let mut stack = Vec::new();
    let mut current = name.to_owned();
    loop {
        if stack.len() >= MAX_INHERITANCE_DEPTH {
            let path = raw_by_name
                .get(&current)
                .map(|agent| agent.path.clone())
                .unwrap_or_else(|| "agents".to_owned());
            ctx.error(
                "agent.from_depth",
                path,
                format!(
                    "Recipe agent '{name}' exceeds the maximum from depth of {MAX_INHERITANCE_DEPTH}"
                ),
                Some("flatten the inheritance chain"),
            );
            return;
        }
        let Some(agent) = raw_by_name.get(&current) else {
            return;
        };
        let Some(from) = &agent.from else {
            return;
        };
        let parent = from.to_owned();
        if stack.contains(&parent) || parent == current {
            ctx.error(
                "agent.from_cycle",
                agent.path.clone(),
                format!("Recipe agent '{}' has cyclic from chain", agent.name),
                Some("remove the inheritance cycle"),
            );
            return;
        }
        if !raw_by_name.contains_key(&parent) {
            ctx.error(
                "agent.from_missing",
                agent.path.clone(),
                format!(
                    "Recipe agent '{}' inherits from missing agent '{}'",
                    agent.name, from
                ),
                Some("update from to reference an existing agent"),
            );
            return;
        }
        stack.push(current);
        current = parent;
    }
}

fn resolved_field_provided(
    name: &str,
    field: AgentField,
    raw_by_name: &HashMap<String, &RawAgent>,
    stack: &mut Vec<String>,
) -> bool {
    if stack.iter().any(|item| item == name) || stack.len() >= MAX_INHERITANCE_DEPTH {
        return false;
    }
    let Some(agent) = raw_by_name.get(name) else {
        return false;
    };
    if agent.fields.contains(&field) {
        return true;
    }
    if let Some(parent) = &agent.from {
        stack.push(name.to_owned());
        return resolved_field_provided(parent, field, raw_by_name, stack);
    }
    false
}

fn packaged_skill_names(
    resource_paths: &[String],
    ctx: &CheckContext,
) -> BTreeMap<String, Vec<String>> {
    let mut skill_files = BTreeSet::new();
    for resource in resource_paths {
        if ctx.has_file(resource) {
            if resource.ends_with("/SKILL.md") || resource == "SKILL.md" {
                skill_files.insert(resource.clone());
            }
            continue;
        }
        discover_skill_files(resource, ctx, &mut skill_files);
    }
    let mut names = BTreeMap::<String, Vec<String>>::new();
    for path in skill_files {
        let name = skill_frontmatter_name(&path, ctx).unwrap_or_else(|| {
            Path::new(&path)
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                .unwrap_or("skill")
                .to_owned()
        });
        names.entry(name).or_default().push(path);
    }
    names
}

fn discover_skill_files(resource: &str, ctx: &CheckContext, skill_files: &mut BTreeSet<String>) {
    if !ctx.has_dir(resource) {
        return;
    }
    let direct = format!("{}/SKILL.md", resource.trim_end_matches('/'));
    if ctx.has_file(&direct) {
        skill_files.insert(direct);
        return;
    }
    let prefix = format!("{}/", resource.trim_end_matches('/'));
    let children = ctx
        .directories
        .iter()
        .filter(|path| path.starts_with(&prefix) && !path[prefix.len()..].contains('/'))
        .cloned()
        .collect::<Vec<_>>();
    for child in children {
        discover_skill_files(&child, ctx, skill_files);
    }
}

fn skill_frontmatter_name(path: &str, ctx: &CheckContext) -> Option<String> {
    let content = ctx.content(path)?;
    let normalized = content.replace("\r\n", "\n");
    let rest = normalized.strip_prefix("---\n")?;
    let end = rest
        .find("\n---\n")
        .or_else(|| rest.strip_suffix("\n---").map(str::len))?;
    let frontmatter = &rest[..end];
    let parsed: JsonValue = serde_saphyr::from_str(frontmatter).ok()?;
    obj_string(parsed.as_object()?, "name")
}

fn validate_declared_agent_references(
    agent: &RawAgent,
    raw_by_name: &HashMap<String, &RawAgent>,
    skill_names: &BTreeMap<String, Vec<String>>,
    ctx: &mut CheckContext,
) {
    let name = &agent.name;
    let path = &agent.path;
    for skill in agent.skills.as_deref().unwrap_or_default() {
        match skill_names.get(skill).map(Vec::len).unwrap_or_default() {
            0 => ctx.error(
                "agent.skill_missing",
                path,
                format!("Recipe agent '{name}' references missing packaged skill '{skill}'"),
                Some("declare the skill under package.json#pi.skills or remove the reference"),
            ),
            1 => {}
            count => ctx.error(
                "agent.skill_ambiguous",
                path,
                format!(
                    "Recipe agent '{name}' skill '{skill}' resolves to {count} packaged SKILL.md files"
                ),
                Some("give packaged skills unique frontmatter names"),
            ),
        }
    }
    for subagent in agent.subagents.as_deref().unwrap_or_default() {
        if !raw_by_name.contains_key(subagent) {
            ctx.error(
                "agent.subagent_missing",
                path,
                format!("Recipe agent '{name}' references missing subagent '{subagent}'"),
                Some("add the agent definition or remove the reference"),
            );
        }
    }
}

fn resolved_agent_mcp(
    name: &str,
    raw_by_name: &HashMap<String, &RawAgent>,
    stack: &mut Vec<String>,
) -> Option<AgentMcpConfig> {
    if stack.iter().any(|item| item == name) || stack.len() >= MAX_INHERITANCE_DEPTH {
        return None;
    }
    let agent = raw_by_name.get(name)?;
    stack.push(name.to_owned());
    let inherited = agent
        .from
        .as_deref()
        .and_then(|parent| resolved_agent_mcp(parent, raw_by_name, stack))
        .unwrap_or_default();
    stack.pop();

    let Some(child) = &agent.mcp else {
        return (!inherited.servers.is_empty() || inherited.mode.is_some()).then_some(inherited);
    };
    let mut merged = child.clone();
    if merged.mode == Some(AgentMcpMode::Cli) {
        for selection in merged.servers.values_mut() {
            selection.defer = None;
            selection.eager = None;
        }
    }
    Some(merged)
}

fn portable_agent_name(value: &str) -> bool {
    let mut parts = value.split('-');
    let valid_part = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    };
    parts.all(valid_part)
}

fn validate_resolved_agent_mcp(
    name: &str,
    raw_by_name: &HashMap<String, &RawAgent>,
    mcp_tool_policy: Option<&McpToolPolicy>,
    ctx: &mut CheckContext,
) {
    let Some(mcp) = resolved_agent_mcp(name, raw_by_name, &mut Vec::new()) else {
        return;
    };
    let path = raw_by_name
        .get(name)
        .map(|agent| agent.path.clone())
        .unwrap_or_default();

    if mcp.mode != Some(AgentMcpMode::Tools)
        && mcp
            .servers
            .values()
            .any(|selection| selection.defer.is_some() || selection.eager.is_some())
    {
        ctx.error(
            "agent.mcp_activation_invalid",
            path.clone(),
            format!(
                "Recipe agent '{name}' may use defer and eager only when its resolved mcp.mode is tools"
            ),
            Some("set mcp.mode to tools or remove defer and eager"),
        );
    }

    for (server_id, selection) in &mcp.servers {
        let Some(server_policy) = mcp_tool_policy.and_then(|policy| policy.get(server_id)) else {
            ctx.error(
                "agent.mcp_server_undeclared",
                path.clone(),
                format!("Recipe agent '{name}' references undeclared MCP server '{server_id}'"),
                Some("add the server to package.json#pi.mcp.servers or remove it from the agent"),
            );
            continue;
        };
        let Some(include) = &selection.include else {
            continue;
        };
        for tool in include.iter().filter(|tool| tool.as_str() != "*") {
            if mcp_package_policy_allows(server_policy, tool) {
                continue;
            }
            ctx.error(
                "agent.mcp_tool_undeclared",
                path.clone(),
                format!(
                    "Recipe agent '{name}' MCP tool '{server_id}/{tool}' is not included by the package policy"
                ),
                Some("include the tool in the package MCP policy or update the agent"),
            );
        }
    }
    for (server_id, selection) in &mcp.servers {
        for (kind, selectors) in [
            ("defer", selection.defer.as_ref()),
            ("eager", selection.eager.as_ref()),
        ] {
            let Some(selectors) = selectors else {
                continue;
            };
            for tool in selectors.iter().filter(|tool| tool.as_str() != "*") {
                if mcp_package_policy_allows(selection, tool) {
                    continue;
                }
                ctx.error(
                    "agent.mcp_activation_tool_unauthorized",
                    path.clone(),
                    format!(
                        "Recipe agent '{name}' {kind} selector '{server_id}/{tool}' is outside its mcp.servers authorization"
                    ),
                    Some(format!(
                        "authorize the tool under mcp.servers or remove it from {kind}"
                    )),
                );
            }
        }
    }
}

fn validate_mcp_config(value: Option<&JsonValue>, ctx: &mut CheckContext) {
    let Some(value) = value else {
        return;
    };
    match value {
        JsonValue::Object(map) => {
            for key in map
                .keys()
                .filter(|key| !matches!(key.as_str(), "manifests" | "servers"))
            {
                ctx.error(
                    "pi.mcp_invalid",
                    PACKAGE_JSON,
                    format!("package.json#pi.mcp contains unknown field '{key}'"),
                    Some("use only manifests and servers"),
                );
            }
            if let Some(manifests) = map.get("manifests") {
                match manifests {
                    JsonValue::Array(items) => {
                        let mut seen = BTreeSet::new();
                        for (index, item) in items.iter().enumerate() {
                            if let Some(path) = string_value(Some(item)) {
                                if !seen.insert(path.clone()) {
                                    ctx.error(
                                        "pi.mcp_invalid",
                                        PACKAGE_JSON,
                                        format!(
                                            "package.json#pi.mcp.manifests contains duplicate entry '{path}'"
                                        ),
                                        Some("remove duplicate MCP manifest declarations"),
                                    );
                                    continue;
                                }
                                validate_mcp_manifest_pattern(&path, ctx);
                            } else {
                                ctx.error(
                                    "pi.mcp_invalid",
                                    PACKAGE_JSON,
                                    format!("package.json#pi.mcp.manifests[{index}] must be a non-empty string"),
                                    Some("remove the entry or provide a relative manifest path"),
                                );
                            }
                        }
                    }
                    _ => ctx.error(
                        "pi.mcp_invalid",
                        PACKAGE_JSON,
                        "package.json#pi.mcp.manifests must be an array of strings",
                        Some("use a list of relative manifest paths"),
                    ),
                }
            }
            validate_mcp_servers(map.get("servers"), ctx);
        }
        _ => ctx.error(
            "pi.mcp_invalid",
            PACKAGE_JSON,
            "package.json#pi.mcp must be an object",
            Some("remove mcp for no access, or use manifests and servers"),
        ),
    }
}

fn validate_mcp_servers(value: Option<&JsonValue>, ctx: &mut CheckContext) {
    let Some(value) = value else {
        return;
    };
    let JsonValue::Array(servers) = value else {
        ctx.error(
            "pi.mcp_invalid",
            PACKAGE_JSON,
            "package.json#pi.mcp.servers must be an array",
            Some("use a list of MCP server declarations"),
        );
        return;
    };
    let mut seen_ids = BTreeSet::new();
    let mut seen_normalized_ids = BTreeSet::new();
    for (index, server) in servers.iter().enumerate() {
        let JsonValue::Object(server) = server else {
            ctx.error(
                "pi.mcp_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.mcp.servers[{index}] must be an object"),
                Some("remove the entry or make it a server declaration"),
            );
            continue;
        };
        for key in server
            .keys()
            .filter(|key| !matches!(key.as_str(), "id" | "required" | "tools"))
        {
            ctx.error(
                "pi.mcp_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.mcp.servers[{index}] contains unknown field '{key}'"),
                Some("use only id, required, and tools"),
            );
        }
        let server_id = string_value(server.get("id"));
        if server_id.is_none() {
            ctx.error(
                "pi.mcp_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.mcp.servers[{index}].id must be a non-empty string"),
                Some("give the server a non-empty identifier"),
            );
        } else if let Some(server_id) = server_id {
            let normalized = safe_mcp_server_id(&server_id);
            if !seen_ids.insert(server_id.clone()) {
                ctx.error(
                    "pi.mcp_invalid",
                    PACKAGE_JSON,
                    format!("package.json#pi.mcp contains duplicate server id '{server_id}'"),
                    Some("remove the duplicate server"),
                );
            }
            if !seen_normalized_ids.insert(normalized) {
                ctx.error(
                    "pi.mcp_invalid",
                    PACKAGE_JSON,
                    format!(
                        "package.json#pi.mcp server id '{server_id}' collides after normalization"
                    ),
                    Some("use server ids that remain unique after normalization"),
                );
            }
        }
        if let Some(required) = server.get("required") {
            if !required.is_boolean() {
                ctx.error(
                    "pi.mcp_invalid",
                    PACKAGE_JSON,
                    format!("package.json#pi.mcp.servers[{index}].required must be boolean"),
                    Some("remove required or set it to a boolean value"),
                );
            }
        }
        if let Some(tools) = server.get("tools") {
            let JsonValue::Object(tools) = tools else {
                ctx.error(
                    "pi.mcp_invalid",
                    PACKAGE_JSON,
                    format!("package.json#pi.mcp.servers[{index}].tools must be an object"),
                    Some("remove tools for no access, or declare a tool policy"),
                );
                continue;
            };
            for key in tools
                .keys()
                .filter(|key| !matches!(key.as_str(), "include" | "exclude"))
            {
                ctx.error(
                    "pi.mcp_invalid",
                    PACKAGE_JSON,
                    format!(
                        "package.json#pi.mcp.servers[{index}].tools contains unknown field '{key}'"
                    ),
                    Some("use only include and exclude"),
                );
            }
            for key in ["include", "exclude"] {
                let Some(selectors) = tools.get(key) else {
                    continue;
                };
                validate_json_string_array(
                    selectors,
                    &format!("package.json#pi.mcp.servers[{index}].tools.{key}"),
                    "pi.mcp_invalid",
                    ctx,
                );
                if let Some(selectors) = selectors.as_array() {
                    for selector in selectors
                        .iter()
                        .filter_map(JsonValue::as_str)
                        .map(str::trim)
                    {
                        let valid = if key == "include" {
                            !selector.is_empty() && (selector == "*" || !selector.contains('*'))
                        } else {
                            !selector.is_empty() && !selector.contains('*')
                        };
                        if !valid {
                            ctx.error(
                                "pi.mcp_selector_invalid",
                                PACKAGE_JSON,
                                format!(
                                    "package.json#pi.mcp.servers[{index}].tools.{key} entry '{selector}' must be {}",
                                    if key == "include" {
                                        "an exact tool name or '*'"
                                    } else {
                                        "an exact tool name"
                                    }
                                ),
                                None::<String>,
                            );
                        }
                    }
                }
            }
        }
    }
}

fn mcp_tool_policy(value: Option<&JsonValue>) -> Option<McpToolPolicy> {
    let JsonValue::Object(map) = value? else {
        return None;
    };
    let servers = map.get("servers")?;
    let JsonValue::Array(servers) = servers else {
        return None;
    };

    let mut policy: McpToolPolicy = BTreeMap::new();
    for server in servers {
        let JsonValue::Object(server) = server else {
            continue;
        };
        let Some(id) = string_value(server.get("id")) else {
            continue;
        };
        let tools = server.get("tools").and_then(JsonValue::as_object);
        let include = tools
            .and_then(|tools| tools.get("include"))
            .and_then(json_string_set);
        let exclude = tools.and_then(|tools| tools.get("exclude"));
        policy.insert(
            safe_mcp_server_id(&id),
            McpToolSelectors {
                include,
                exclude: exclude.and_then(json_string_set),
                defer: None,
                eager: None,
            },
        );
    }
    Some(policy)
}

fn validate_mcp_manifest_pattern(pattern: &str, ctx: &mut CheckContext) {
    if let Err(message) = validate_relative_pattern(pattern) {
        ctx.error(
            "pi.mcp_manifest_invalid",
            PACKAGE_JSON,
            message,
            Some("use manifest paths relative to the recipe directory"),
        );
        return;
    }
    let matches = match_paths(ctx, pattern);
    if matches.is_empty() {
        ctx.error(
            "pi.mcp_manifest_missing",
            PACKAGE_JSON,
            format!("MCP manifest pattern '{pattern}' matched no files"),
            Some("add the manifest file or update package.json#pi.mcp"),
        );
    }
}

fn validate_json_string_array(value: &JsonValue, label: &str, code: &str, ctx: &mut CheckContext) {
    let JsonValue::Array(items) = value else {
        ctx.error(
            code,
            PACKAGE_JSON,
            format!("{label} must be an array of strings"),
            Some("use a list containing only non-empty strings"),
        );
        return;
    };
    let mut seen = BTreeSet::new();
    for (index, item) in items.iter().enumerate() {
        if string_value(Some(item)).is_none() {
            ctx.error(
                code,
                PACKAGE_JSON,
                format!("{label}[{index}] must be a non-empty string"),
                Some("remove the entry or replace it with a non-empty string"),
            );
        } else if let Some(value) = string_value(Some(item)) {
            if !seen.insert(value.clone()) {
                ctx.error(
                    code,
                    PACKAGE_JSON,
                    format!("{label} contains duplicate entry '{value}'"),
                    Some("remove duplicate entries"),
                );
            }
        }
    }
}

fn match_paths(ctx: &CheckContext, pattern: &str) -> Vec<String> {
    let normalized = normalize_slashes(pattern.trim().trim_start_matches("./"));
    if !has_glob(&normalized) {
        return ctx
            .path_exists(&normalized)
            .then_some(normalized)
            .into_iter()
            .collect();
    }

    let mut matches = BTreeSet::new();
    for path in ctx
        .files
        .keys()
        .map(String::as_str)
        .chain(ctx.directories.iter().map(String::as_str))
    {
        if glob_matches(&normalized, path) {
            matches.insert(path.to_owned());
        }
    }
    matches.into_iter().collect()
}

fn glob_matches(pattern: &str, path: &str) -> bool {
    let pattern = normalize_slashes(pattern);
    let path = normalize_slashes(path);
    glob_match_parts(
        &pattern.split('/').collect::<Vec<_>>(),
        &path.split('/').collect::<Vec<_>>(),
    )
}

fn glob_match_parts(pattern: &[&str], path: &[&str]) -> bool {
    if pattern.is_empty() {
        return path.is_empty();
    }
    if pattern[0] == "**" {
        return glob_match_parts(&pattern[1..], path)
            || (!path.is_empty() && glob_match_parts(pattern, &path[1..]));
    }
    if path.is_empty() {
        return false;
    }
    segment_match(pattern[0], path[0]) && glob_match_parts(&pattern[1..], &path[1..])
}

fn segment_match(pattern: &str, text: &str) -> bool {
    let pattern = pattern.as_bytes();
    let text = text.as_bytes();
    let (mut pi, mut ti) = (0, 0);
    let mut star = None;
    let mut match_i = 0;
    while ti < text.len() {
        if pi < pattern.len() && (pattern[pi] == b'?' || pattern[pi] == text[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < pattern.len() && pattern[pi] == b'*' {
            star = Some(pi);
            match_i = ti;
            pi += 1;
        } else if let Some(star_i) = star {
            pi = star_i + 1;
            match_i += 1;
            ti = match_i;
        } else {
            return false;
        }
    }
    while pi < pattern.len() && pattern[pi] == b'*' {
        pi += 1;
    }
    pi == pattern.len()
}

fn validate_relative_pattern(pattern: &str) -> Result<(), String> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Err("resource pattern must be non-empty".to_owned());
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err(format!("resource pattern '{pattern}' must be relative"));
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) || trimmed
        .split(['/', '\\'])
        .any(|segment| segment == ".." || segment.is_empty())
    {
        return Err(format!(
            "resource pattern '{pattern}' escapes the recipe directory"
        ));
    }
    Ok(())
}

fn string_value(value: Option<&JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(value)) if !value.trim().is_empty() => Some(value.trim().to_owned()),
        _ => None,
    }
}

fn has_dependency_lockfile(ctx: &CheckContext) -> bool {
    [
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "yarn.lock",
    ]
    .iter()
    .any(|name| ctx.path_exists(name))
}

fn has_non_empty_object(value: Option<&JsonValue>) -> bool {
    matches!(value, Some(JsonValue::Object(map)) if !map.is_empty())
}

fn obj_string(map: &JsonMap, key: &str) -> Option<String> {
    match map.get(key) {
        Some(JsonValue::String(value)) if !value.trim().is_empty() => Some(value.trim().to_owned()),
        _ => None,
    }
}

fn string_array(value: &JsonValue) -> Result<(), String> {
    let Some(items) = value.as_array() else {
        return Err("field must be an array of strings".to_owned());
    };
    for (index, item) in items.iter().enumerate() {
        if !matches!(item, JsonValue::String(value) if !value.trim().is_empty()) {
            return Err(format!("item {index} must be a non-empty string"));
        }
    }
    Ok(())
}

fn valid_model_spec(value: &str) -> bool {
    let Some((provider, model)) = value.split_once('/') else {
        return false;
    };
    !provider.is_empty()
        && !model.is_empty()
        && !provider.chars().any(|ch| ch.is_whitespace() || ch == ':')
}

fn json_string_set(value: &JsonValue) -> Option<BTreeSet<String>> {
    let items = value.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| string_value(Some(item)))
            .collect(),
    )
}

fn mcp_package_policy_allows(policy: &McpToolSelectors, tool: &str) -> bool {
    let included = match &policy.include {
        Some(include) => include.contains("*") || include.contains(tool),
        None => false,
    };
    included
        && !policy
            .exclude
            .as_ref()
            .is_some_and(|exclude| exclude.contains(tool))
}

fn safe_mcp_server_id(value: &str) -> String {
    let mut id = String::new();
    let mut previous_dash = false;
    for ch in value.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            id.push(ch);
            previous_dash = false;
        } else if !previous_dash {
            id.push('-');
            previous_dash = true;
        }
    }
    let id = id.trim_matches('-').to_owned();
    if id.is_empty() {
        "mcp".to_owned()
    } else {
        id
    }
}

fn has_glob(value: &str) -> bool {
    value.chars().any(|ch| matches!(ch, '*' | '?'))
}

fn is_yaml_path(path: &str) -> bool {
    matches!(extension(path), Some("yaml" | "yml"))
}

fn is_loadable_extension_file(ctx: &CheckContext, path: &str) -> bool {
    ctx.has_file(path)
        && matches!(
            extension(path),
            Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs")
        )
}

fn resolve_extension_entry(ctx: &CheckContext, path: &str) -> Vec<String> {
    if is_loadable_extension_file(ctx, path) {
        return vec![path.to_owned()];
    }
    if !ctx.has_dir(path) {
        return Vec::new();
    }

    if let Some(index) = extension_index(ctx, path) {
        return vec![index];
    }

    let prefix = format!("{path}/");
    let mut entries = BTreeSet::new();
    for file in ctx.files.keys() {
        let Some(relative) = file.strip_prefix(&prefix) else {
            continue;
        };
        if !relative.contains('/') && is_loadable_extension_file(ctx, file) {
            entries.insert(file.clone());
            continue;
        }
        let Some((child, remainder)) = relative.split_once('/') else {
            continue;
        };
        if !remainder.contains('/')
            && remainder.starts_with("index.")
            && is_loadable_extension_file(ctx, file)
            && extension_index(ctx, &format!("{path}/{child}")).as_deref() == Some(file.as_str())
        {
            entries.insert(file.clone());
        }
    }
    entries.into_iter().collect()
}

fn extension_index(ctx: &CheckContext, directory: &str) -> Option<String> {
    ["ts", "tsx", "js", "jsx", "mjs", "cjs"]
        .into_iter()
        .map(|extension| format!("{directory}/index.{extension}"))
        .find(|path| ctx.has_file(path))
}

fn extension(path: &str) -> Option<&str> {
    let name = path.rsplit('/').next()?;
    let (stem, extension) = name.rsplit_once('.')?;
    (!stem.is_empty()).then_some(extension)
}

fn normalize_slashes(value: &str) -> String {
    value.replace('\\', "/")
}

fn normalize_relative(path: &str) -> String {
    let mut normalized = normalize_slashes(path.trim());
    while let Some(stripped) = normalized.strip_prefix("./") {
        normalized = stripped.to_owned();
    }
    normalized.trim_matches('/').to_owned()
}

fn ancestor_dirs(path: &str) -> Vec<String> {
    let mut ancestors = Vec::new();
    for (index, ch) in path.char_indices() {
        if ch == '/' {
            ancestors.push(path[..index].to_owned());
        }
    }
    ancestors
}

/// Best-effort extraction of "line N column M" from a parser error message.
fn span_from_message(message: &str) -> Option<Span> {
    fn number_after<'a>(message: &'a str, keyword: &str) -> Option<(usize, &'a str)> {
        let start = message.find(keyword)? + keyword.len();
        let rest = message[start..].trim_start();
        let digits_len = rest.chars().take_while(char::is_ascii_digit).count();
        if digits_len == 0 {
            return None;
        }
        let value = rest[..digits_len].parse().ok()?;
        Some((value, &rest[digits_len..]))
    }

    let (line, rest) = number_after(message, "line")?;
    let column = number_after(rest, "column").map(|(value, _)| value)?;
    Some(Span { line, column })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Deserialize)]
    struct ConformanceFixture {
        name: String,
        valid: bool,
        files: BTreeMap<String, String>,
    }

    #[test]
    fn shared_format_conformance_fixtures() {
        let fixtures: Vec<ConformanceFixture> = serde_json::from_str(include_str!(
            "../../../test/fixtures/format-conformance.json"
        ))
        .expect("shared conformance fixtures must parse");
        for fixture in fixtures {
            let input = RecipeFiles {
                files: fixture
                    .files
                    .into_iter()
                    .map(|(path, content)| RecipeFile::new(path, content))
                    .collect(),
                directories: Vec::new(),
            };
            let report = check_recipe_files(&input);
            assert_eq!(
                report.valid, fixture.valid,
                "{}: {:?}",
                fixture.name, report.diagnostics
            );
        }
    }

    fn recipe_files(files: &[(&str, &str)]) -> RecipeFiles {
        RecipeFiles {
            files: files
                .iter()
                .map(|(path, content)| RecipeFile::new(*path, *content))
                .collect(),
            directories: Vec::new(),
        }
    }

    fn selector_recipe(
        package_tools: JsonValue,
        agent_mcp: &str,
        include_bash: bool,
    ) -> RecipeFiles {
        let package = json!({
            "name": "mcp-selector-test",
            "version": "0.1.0",
            "pi": {
                "agents": ["agents/*.yaml"],
                "mcp": {
                    "servers": [{
                        "id": "salesforce",
                        "tools": package_tools
                    }]
                }
            }
        });
        let bash = if include_bash { "  - bash\n" } else { "" };
        let agent = format!(
            concat!(
                "name: agent\n",
                "description: Test agent\n",
                "model:\n",
                "  name: test/provider-model\n",
                "  thinking_level: low\n",
                "tools:\n",
                "  - read\n",
                "{}",
                "mcp:\n",
                "{}",
                "skills: []\n",
                "subagents: []\n",
                "system_instructions:\n",
                "  mode: append\n",
                "  content: Test instructions\n",
            ),
            bash, agent_mcp
        );
        recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/agent.yaml", &agent),
        ])
    }

    fn connector_recipe(agent_tools: &[&str]) -> RecipeFiles {
        let package = json!({
            "name": "connector-test",
            "version": "0.1.0",
            "dependencies": {
                "@introspection-ai/recipe-channel-slack": "0.1.0"
            },
            "pi": {
                "agents": ["agents/*.yaml"],
                "channels": [{
                    "provider": "slack"
                }]
            }
        });
        let tools = agent_tools
            .iter()
            .map(|tool| format!("  - {tool}\n"))
            .collect::<String>();
        let agent = format!(
            concat!(
                "name: agent\n",
                "model:\n",
                "  name: test/provider-model\n",
                "tools:\n",
                "{}",
            ),
            tools
        );
        recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"),
            ("agents/agent.yaml", &agent),
        ])
    }

    #[test]
    fn connector_requires_its_runtime_dependency() {
        let mut files = connector_recipe(&["slack_origin"]);
        let package_file = files
            .files
            .iter_mut()
            .find(|file| file.path == PACKAGE_JSON)
            .expect("package.json");
        let mut package: JsonValue =
            serde_json::from_str(package_file.content.as_deref().expect("package content"))
                .expect("parse package");
        package
            .as_object_mut()
            .expect("package object")
            .remove("dependencies");
        package_file.content = Some(serde_json::to_string_pretty(&package).expect("serialize"));

        let report = check_recipe_files(&files);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "pi.channels_invalid"
                && diagnostic.message.contains("recipe-channel-slack")
        }));

        for invalid_version in [JsonValue::Null, json!("")] {
            let mut files = connector_recipe(&["slack_origin"]);
            let package_file = files
                .files
                .iter_mut()
                .find(|file| file.path == PACKAGE_JSON)
                .expect("package.json");
            let mut package: JsonValue =
                serde_json::from_str(package_file.content.as_deref().expect("package content"))
                    .expect("parse package");
            package["dependencies"]["@introspection-ai/recipe-channel-slack"] = invalid_version;
            package_file.content = Some(serde_json::to_string_pretty(&package).expect("serialize"));

            let report = check_recipe_files(&files);

            assert!(report.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "pi.channels_invalid"
                    && diagnostic.message.contains("recipe-channel-slack")
            }));
        }
    }

    #[test]
    fn accepts_generic_connector_declarations() {
        let report =
            check_recipe_files(&connector_recipe(&["slack_origin", "slack_custom_report"]));

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn connector_command_allowlist_shape() {
        for (commands, valid) in [
            (json!(["read", "reply"]), true), (json!([]), true),
            (json!(["read", "read"]), false), (json!([""]), false),
            (json!("read"), false), (json!([42]), false),
        ] {
            let mut files = connector_recipe(&["channels"]);
            let package_file = files.files.iter_mut().find(|file| file.path == PACKAGE_JSON).unwrap();
            let mut package: JsonValue = serde_json::from_str(package_file.content.as_deref().unwrap()).unwrap();
            package["pi"]["channels"][0]["commands"] = commands;
            package_file.content = Some(serde_json::to_string(&package).unwrap());
            let report = check_recipe_files(&files);
            assert_eq!(!report.diagnostics.iter().any(|d| d.code == "pi.channels_invalid"), valid);
        }
    }

    #[test]
    fn connector_required_reply_shape() {
        for value in [json!(true), json!(false), json!("true"), json!(1), JsonValue::Null] {
            let mut files = connector_recipe(&["channels"]);
            let package_file = files.files.iter_mut().find(|file| file.path == PACKAGE_JSON).unwrap();
            let mut package: JsonValue = serde_json::from_str(package_file.content.as_deref().unwrap()).unwrap();
            package["pi"]["channels"][0]["requireReply"] = value.clone();
            package_file.content = Some(serde_json::to_string(&package).unwrap());
            let report = check_recipe_files(&files);
            assert_eq!(!report.diagnostics.iter().any(|d| d.code == "pi.channels_invalid"), value.is_boolean());
        }
    }

    #[test]
    fn connector_rejects_global_tool_configuration() {
        let mut files = connector_recipe(&["slack_origin"]);
        let package_file = files
            .files
            .iter_mut()
            .find(|file| file.path == PACKAGE_JSON)
            .expect("package.json");
        let mut package: JsonValue =
            serde_json::from_str(package_file.content.as_deref().expect("package content"))
                .expect("parse package");
        package["pi"]["channels"][0]["tools"] = json!({ "include": ["origin"] });
        package_file.content = Some(serde_json::to_string_pretty(&package).expect("serialize"));

        let report = check_recipe_files(&files);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "pi.channels_invalid"
                && diagnostic.message.contains("unknown field 'tools'")
        }));
    }

    #[test]
    fn accepts_package_and_agent_mcp_include_exclude_selectors() {
        let input = selector_recipe(
            json!({
                "include": ["*"],
                "exclude": ["delete_org"]
            }),
            concat!(
                "  mode: cli\n",
                "  servers:\n",
                "    salesforce:\n",
                "      include:\n",
                "        - '*'\n",
                "      exclude:\n",
                "        - export_all\n",
            ),
            true,
        );

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn accepts_structured_tools_mode_with_authorized_activation() {
        let input = selector_recipe(
            json!({ "include": ["search_profiles", "get_profile"] }),
            concat!(
                "  mode: tools\n",
                "  servers:\n",
                "    salesforce:\n",
                "      include:\n",
                "        - search_profiles\n",
                "        - get_profile\n",
                "      defer:\n",
                "        - '*'\n",
                "      eager:\n",
                "        - search_profiles\n",
            ),
            true,
        );

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn rejects_invalid_structured_mcp_mode_and_unknown_keys() {
        let input = selector_recipe(
            json!({ "include": ["search_profiles"] }),
            concat!(
                "  mode: deferred\n",
                "  servers:\n",
                "    salesforce:\n",
                "      include:\n",
                "        - search_profiles\n",
                "  initial_tools:\n",
                "    salesforce: search_profiles\n",
            ),
            true,
        );

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        for code in ["agent.mcp_mode_invalid", "agent.mcp_key_unknown"] {
            assert!(
                report
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == code),
                "missing {code}: {:?}",
                report.diagnostics
            );
        }
    }

    #[test]
    fn rejects_activation_outside_agent_authorization() {
        let input = selector_recipe(
            json!({ "include": ["search_profiles", "delete_profile"] }),
            concat!(
                "  mode: tools\n",
                "  servers:\n",
                "    salesforce:\n",
                "      include:\n",
                "        - search_profiles\n",
                "      eager:\n",
                "        - delete_profile\n",
            ),
            true,
        );

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.mcp_activation_tool_unauthorized"
                && diagnostic.message.contains("salesforce/delete_profile")
        }));
    }

    #[test]
    fn accepts_independent_mcp_modes_across_visible_agent_tree() {
        let package = json!({
            "name": "mcp-mode-conflict",
            "version": "0.1.0",
            "pi": {
                "agents": ["agents/*.yaml"],
                "mcp": {
                    "servers": [{
                        "id": "salesforce",
                        "tools": { "include": ["search_profiles"] }
                    }]
                }
            }
        });
        let root = concat!(
            "name: root\n",
            "model:\n",
            "  name: test/provider-model\n",
            "tools: []\n",
            "mcp:\n",
            "  mode: tools\n",
            "  servers:\n",
            "    salesforce:\n",
            "      include:\n",
            "        - search_profiles\n",
            "subagents:\n",
            "  - child\n",
            "system_instructions:\n",
            "  content: Root instructions\n",
        );
        let child = concat!(
            "name: child\n",
            "model:\n",
            "  name: test/provider-model\n",
            "tools: []\n",
            "mcp:\n",
            "  mode: cli\n",
            "  servers:\n",
            "    salesforce:\n",
            "      include:\n",
            "        - search_profiles\n",
            "subagents: []\n",
            "system_instructions:\n",
            "  content: Child instructions\n",
        );
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/root.yaml", root),
            ("agents/child.yaml", child),
        ]);

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn rejects_agent_exact_selector_excluded_by_package_policy() {
        let input = selector_recipe(
            json!({
                "include": ["*"],
                "exclude": ["delete_org"]
            }),
            "  mode: cli\n  servers:\n    salesforce:\n      include:\n        - delete_org\n",
            true,
        );

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.mcp_tool_undeclared"
                && diagnostic.message.contains("salesforce/delete_org")
        }));
    }

    #[test]
    fn rejects_agent_server_without_package_policy_or_include() {
        let input = selector_recipe(
            json!({ "include": ["*"] }),
            "  mode: cli\n  servers:\n    ghost: {}\n",
            true,
        );

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.mcp_server_undeclared" && diagnostic.message.contains("ghost")
        }));
    }

    #[test]
    fn rejects_duplicate_mcp_manifest_declarations() {
        let package = json!({
            "name": "duplicate-manifests",
            "pi": {
                "mcp": {
                    "manifests": ["mcp.json", "mcp.json"]
                }
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("mcp.json", "{}"),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "pi.mcp_invalid"
                && diagnostic.message.contains("duplicate entry 'mcp.json'")
        }));
    }

    #[test]
    fn rejects_malformed_agent_mcp_selectors() {
        let input = selector_recipe(
            json!({ "include": ["*"] }),
            "  mode: cli\n  servers:\n    salesforce:\n      include:\n        - search_*\n",
            true,
        );

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.mcp_selector_invalid"));
    }

    #[test]
    fn rejects_non_object_agent_mcp_blocks() {
        let package = json!({
            "name": "invalid-agent-mcp-shape",
            "description": "Test",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let agent = concat!(
            "name: agent\n",
            "description: Test agent\n",
            "model:\n",
            "  name: test/provider-model\n",
            "  thinking_level: low\n",
            "tools: []\n",
            "mcp: []\n",
            "system_instructions:\n",
            "  content: Test instructions\n",
        );
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/agent.yaml", agent),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.mcp_invalid"));
    }

    #[test]
    fn missing_agent_mcp_includes_are_silent_and_fail_closed() {
        let input = selector_recipe(
            json!({}),
            "  mode: cli\n  servers:\n    salesforce: {}\n",
            true,
        );

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
        assert!(!report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "pi.mcp_include_missing"));
        assert!(!report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.mcp_include_missing"));

        let empty_agent_mcp = selector_recipe(
            json!({ "include": ["*"] }),
            "  mode: cli\n  servers: {}\n",
            true,
        );
        let empty_report = check_recipe_files(&empty_agent_mcp);
        assert!(empty_report.valid, "{:?}", empty_report.diagnostics);
        assert!(!empty_report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.mcp_empty"));
    }

    #[test]
    fn minimal_agent_requires_only_name_and_model_without_diagnostics() {
        let package = json!({
            "name": "agent-defaults",
            "description": "Test",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
        assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);

        let unnamed = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/agent.yaml", "model:\n  name: test/provider-model\n"),
        ]);
        let unnamed_report = check_recipe_files(&unnamed);
        assert!(unnamed_report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.name_missing"));

        let non_string = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: 7\nmodel:\n  name: test/provider-model\n",
            ),
        ]);
        let non_string_report = check_recipe_files(&non_string);
        assert!(non_string_report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.name_invalid"));
    }

    #[test]
    fn rejects_session_generated_tool_names() {
        let package = json!({
            "name": "reserved-tools",
            "version": "0.1.0",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\ntools: [agent]\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.tools_reserved" && diagnostic.message.contains("agent")
        }));
    }

    #[test]
    fn accepts_extension_owned_tool_search() {
        let package = json!({
            "name": "extension-search",
            "version": "0.1.0",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\ntools: [tool_search]\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn accepts_ai_and_session_and_rejects_unsafe_ai_options() {
        let package = json!({
            "name": "agent-ai-session",
            "version": "0.1.0",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let manifest = serde_json::to_string_pretty(&package).expect("serialize package");
        let valid = recipe_files(&[
            ("package.json", &manifest),
            (
                "agents/agent.yaml",
                "name: agent\nai:\n  model: openai/gpt-5\n  thinking_level: high\n  options:\n    max_tokens: 4096\nsession:\n  steering_mode: one-at-a-time\n  follow_up_mode: all\n  tool_execution: parallel\n  retry:\n    max_retries: 3\n",
            ),
        ]);
        let report = check_recipe_files(&valid);
        assert!(report.valid, "{:?}", report.diagnostics);

        let unshipped_runtime_alias = recipe_files(&[
            ("package.json", &manifest),
            (
                "agents/agent.yaml",
                "name: agent\nai:\n  model: openai/gpt-5\nruntime:\n  tool_execution: parallel\n",
            ),
        ]);
        let report = check_recipe_files(&unshipped_runtime_alias);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.key_unknown"));

        let future_openrouter_routing = recipe_files(&[
            ("package.json", &manifest),
            (
                "agents/agent.yaml",
                "name: agent\nai:\n  model: openrouter/anthropic/claude-sonnet-4\n  providers:\n    openrouter:\n      routing:\n        future_router_policy:\n          mode: strict\n",
            ),
        ]);
        let report = check_recipe_files(&future_openrouter_routing);
        assert!(report.valid, "{:?}", report.diagnostics);

        let unsafe_options = recipe_files(&[
            ("package.json", &manifest),
            (
                "agents/agent.yaml",
                "name: agent\nai:\n  model: openai/gpt-5\n  options:\n    api_key: secret\n",
            ),
        ]);
        let report = check_recipe_files(&unsafe_options);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.ai.options_key_blocked"));
    }

    #[test]
    fn accepts_empty_pi_with_conventional_agents() {
        let package = json!({ "name": "minimal", "pi": {} });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn rejects_unknown_and_noncanonical_agent_keys() {
        let package = json!({ "name": "canonical", "pi": {} });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n  thinkingLevel: low\nprompt: legacy\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.model_key_unknown"));
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.key_unknown"));
    }

    #[test]
    fn rejects_whitespace_around_inherited_agent_names() {
        let package = json!({ "name": "canonical", "pi": {} });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/base.yaml",
                "name: base\nmodel:\n  name: test/provider-model\n",
            ),
            (
                "agents/child.yaml",
                "name: child\nfrom: \" base \"\nmodel:\n  name: test/provider-model\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.from_invalid"));
    }

    #[test]
    fn validates_only_declared_skill_and_subagent_references() {
        let package = json!({
            "name": "references",
            "pi": {
                "skills": ["skills"],
                "agents": ["agents"]
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\nskills: [missing]\nsubagents: [ghost]\n",
            ),
            (
                "skills/real/SKILL.md",
                "---\nname: real\ndescription: Real\n---\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.skill_missing"));
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.subagent_missing"));
    }

    #[test]
    fn accepts_resolved_references_and_package_extensions() {
        let package = json!({
            "name": "references",
            "pi": {
                "skills": ["skills"],
                "agents": ["agents"],
                "extensions": ["extensions/tools.ts"]
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\nskills: [public-skill]\nsubagents: [helper]\n",
            ),
            (
                "agents/helper.yaml",
                "name: helper\nmodel:\n  name: test/provider-model\n",
            ),
            (
                "skills/folder/SKILL.md",
                "---\nname: public-skill\ndescription: Real\n---\n",
            ),
            ("extensions/tools.ts", "export default () => {};\n"),
        ]);

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn rejects_unmatched_explicit_resource_patterns() {
        let package = json!({
            "name": "optional-resources",
            "pi": {
                "agents": ["agents/*.yaml"],
                "skills": ["skills/*"],
                "prompts": ["prompts/*.md"]
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid, "{:?}", report.diagnostics);
        for code in ["package.skills_unmatched", "package.prompts_unmatched"] {
            assert!(report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == code));
        }

        let direct_package = json!({
            "name": "missing-direct-resource",
            "pi": {
                "agents": ["agents/*.yaml"],
                "skills": ["skills/missing"]
            }
        });
        let direct_input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&direct_package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n",
            ),
        ]);
        let direct_report = check_recipe_files(&direct_input);
        assert!(direct_report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "package.skills_unmatched"));
    }

    #[test]
    fn skill_discovery_stops_at_the_first_skill_file() {
        let package = json!({
            "name": "nested-skills",
            "pi": { "agents": ["agents"], "skills": ["skills/root"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\nskills: [nested]\n",
            ),
            ("skills/root/SKILL.md", "---\nname: root\n---\n"),
            ("skills/root/nested/SKILL.md", "---\nname: nested\n---\n"),
        ]);

        let report = check_recipe_files(&input);

        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.skill_missing"));
    }

    #[test]
    fn malformed_skill_frontmatter_uses_the_directory_name() {
        let package = json!({
            "name": "skill-frontmatter",
            "pi": { "agents": ["agents"], "skills": ["skills"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\nskills: [fake]\n",
            ),
            (
                "skills/real/SKILL.md",
                "---\nname: fake\n---garbage\ncontent\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.skill_missing"));
    }

    #[test]
    fn inherited_reference_failures_are_reported_once_at_the_declaration() {
        let package = json!({
            "name": "inherited-reference",
            "pi": { "agents": ["agents"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/base.yaml",
                "name: base\nmodel:\n  name: test/provider-model\nsubagents: [missing]\n",
            ),
            ("agents/agent.yaml", "name: agent\nfrom: base\n"),
        ]);

        let report = check_recipe_files(&input);

        assert_eq!(
            report
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code == "agent.subagent_missing")
                .count(),
            1
        );
    }

    #[test]
    fn rejects_unknown_recipe_keys_generically() {
        let package = json!({
            "name": "unknown-key",
            "pi": {
                "agents": ["agents/*.yaml"],
                "future_key": {}
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n  thinking_level: low\ntools: []\nsystem_instructions:\n  content: Test\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "pi.unknown_key"));
    }

    #[test]
    fn validates_runtime_requirement_paths_and_shapes() {
        let package = json!({
            "name": "runtime-requirements",
            "pi": {
                "agents": ["agents/*.yaml"],
                "runtime": {
                    "python": {
                        "project": "python",
                        "lockfile": "python/uv.lock",
                        "version": ">=3.12,<3.15",
                        "imports": ["pandas", "openpyxl"]
                    },
                    "system": {
                        "packages": [
                            { "id": "document.pdf-tools", "version": "1" }
                        ]
                    }
                }
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n",
            ),
            ("python/pyproject.toml", "[project]\nname='controls'\n"),
            ("python/uv.lock", "version = 1\n"),
        ]);

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn rejects_agent_mcp_access_without_package_server_policy() {
        let mut input = selector_recipe(
            json!({ "include": ["search_profiles"] }),
            "  mode: cli\n  servers:\n    salesforce:\n      include:\n        - search_profiles\n",
            true,
        );
        let package = json!({
            "name": "mcp-policy-missing-test",
            "version": "0.1.0",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        input.files[0] = RecipeFile::new(
            "package.json",
            serde_json::to_string_pretty(&package).expect("serialize package"),
        );

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.mcp_server_undeclared"
                && diagnostic.message.contains("salesforce")
        }));
    }

    #[test]
    fn reports_missing_package_manifest() {
        let report = check_recipe_files(&RecipeFiles::default());

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "package.manifest_missing"));
    }

    #[test]
    fn reports_unread_file_content_as_unreadable() {
        let input = RecipeFiles {
            files: vec![RecipeFile::unread("package.json")],
            directories: Vec::new(),
        };

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "package.manifest_unreadable"));
    }

    #[test]
    fn malformed_package_json_has_span() {
        let input = recipe_files(&[("package.json", "{\n  \"name\": ,\n}\n")]);

        let report = check_recipe_files(&input);

        let diagnostic = report
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "package.manifest_malformed")
            .expect("malformed diagnostic");
        let span = diagnostic.span.expect("span");
        assert_eq!(span.line, 2);
    }

    #[test]
    fn resolves_agents_from_conventional_directory() {
        let package = json!({
            "name": "conventional-agents",
            "description": "Test",
            "pi": { "agents": ["agents"] }
        });
        let agent = concat!(
            "name: helper\n",
            "description: Helper agent\n",
            "model:\n",
            "  name: test/provider-model\n",
            "  thinking_level: low\n",
            "tools: []\n",
            "skills: []\n",
            "subagents: []\n",
            "system_instructions:\n",
            "  content: Test instructions\n",
        );
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/helper.yaml", agent),
            ("agents/notes.md", "not an agent\n"),
            ("agents/nested/inner.yaml", "name: inner\n"),
        ]);

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn malformed_agent_yaml_is_reported() {
        let package = json!({
            "name": "malformed-agent",
            "description": "Test",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/agent.yaml", "name: [unterminated\n"),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.yaml_malformed"));
    }

    #[test]
    fn runtime_dependencies_require_a_committed_lockfile() {
        let package = json!({
            "name": "dependency-recipe",
            "pi": {},
            "dependencies": { "example": "1.0.0" }
        });
        let mut input = recipe_files(&[(
            "package.json",
            &serde_json::to_string_pretty(&package).expect("serialize package"),
        )]);

        let missing = check_recipe_files(&input);
        assert!(missing
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "package.lockfile_missing"));

        input.files.push(RecipeFile::new(
            "pnpm-lock.yaml",
            "lockfileVersion: '9.0'\n",
        ));
        let locked = check_recipe_files(&input);
        assert!(!locked
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "package.lockfile_missing"));
    }

    #[test]
    fn rejects_local_capability_configuration_in_the_recipe_snapshot() {
        let package = json!({ "name": "local-config-recipe", "pi": {} });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (".pi/mcp.local.json", r#"{"servers":[]}"#),
        ]);

        let report = check_recipe_files(&input);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "package.local_config_present"));
    }

    #[test]
    fn validates_the_redacted_local_mcp_example() {
        let package = json!({ "name": "local-example-recipe", "pi": {} });
        let valid = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                ".pi/mcp.local.example.json",
                r#"{"servers":[{"id":"search","url":"https://example.test/mcp","headers":{"Authorization":"Bearer ${TOKEN}"}}]}"#,
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/model\n",
            ),
        ]);
        let valid_report = check_recipe_files(&valid);
        assert!(valid_report.valid, "{:?}", valid_report.diagnostics);

        let invalid = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                ".pi/mcp.local.example.json",
                r#"{"servers":[{"id":"","headers":{"Authorization":42}}]}"#,
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/model\n",
            ),
        ]);
        let report = check_recipe_files(&invalid);
        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "mcp.local_example_invalid"));
    }

    #[test]
    fn validates_npm_lockfile_identity_and_json() {
        let package = json!({
            "name": "owned-recipe",
            "version": "0.2.0",
            "pi": {}
        });
        let mismatched_lock = json!({
            "name": "upstream-recipe",
            "version": "0.1.0",
            "lockfileVersion": 3,
            "packages": {
                "": { "name": "upstream-recipe", "version": "0.1.0" }
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "package-lock.json",
                &serde_json::to_string_pretty(&mismatched_lock).expect("serialize lockfile"),
            ),
        ]);

        let report = check_recipe_files(&input);
        let codes = report
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<BTreeSet<_>>();
        assert!(codes.contains("package.lockfile_name_mismatch"));
        assert!(codes.contains("package.lockfile_version_mismatch"));

        let malformed = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("package-lock.json", "{"),
        ]);
        assert!(check_recipe_files(&malformed)
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "package.lockfile_malformed"));
    }
}
